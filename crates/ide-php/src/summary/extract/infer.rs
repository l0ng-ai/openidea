//! Summary-time types: what a file alone says about the type of a value
//! expression, and what a function-like body returns, as [`LazyType`]s.
//!
//! Only the file is known here, so anything that depends on another
//! declaration (a call, a member access, a constant) becomes a lazy recipe
//! for the resolver. Variables other than `$this` and the parameters are not
//! tracked (that is the flow analysis of a later phase): they are `mixed`.
//! Calls go through the local step of the built-in type providers
//! ([`TypeProviders::builtin`]), the core one giving the plain recipes.

use mago_syntax::cst::{
    Access, AnonymousClass, ArgumentList, ArrayElement, ArrowFunction, Assignment, AssignmentOperator, BinaryOperator,
    Block, Call, Class, ClassLikeConstantSelector, ClassLikeMemberSelector, Closure, Construct, Enum, Expression,
    Function, Interface, MagicConstant, MatchArm, Return, Trait, UnaryPrefixOperator, Variable, Yield,
};
use mago_syntax::walker::Walker;

use crate::names::{NameKind, NameScope, Resolution};
use crate::types::ops::{Op, is_int, is_string, literal_type, op_type, unary_type};
use crate::types::provider::{CallKind, CallSite, site_args};
use crate::types::{LazyType, Relative, Type, TypeProviders};

/// Infers types from expressions in one name scope.
pub(super) struct Infer<'s> {
    pub scope: &'s NameScope,
    /// The parameters in scope (name without `$`) and their declared types.
    pub params: Vec<(String, Type)>,
    /// Keep literal types (`'a'`, `1`) instead of widening them; used for
    /// constant values, where the literal is the value.
    pub literals: bool,
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn known(ty: Type) -> LazyType {
    LazyType::Known(ty)
}

impl Infer<'_> {
    /// The type of a value expression.
    pub fn expr(&self, expr: &Expression<'_>) -> LazyType {
        let ty = self.expr_inner(expr);
        if self.literals {
            return ty;
        }
        match ty {
            LazyType::Known(ty) => known(ty.widen()),
            LazyType::Union(members) => LazyType::union(members.into_iter().map(|member| match member {
                LazyType::Known(ty) => known(ty.widen()),
                other => other,
            })),
            other => other,
        }
    }

    fn expr_inner(&self, expr: &Expression<'_>) -> LazyType {
        match expr {
            Expression::Parenthesized(inner) => self.expr_inner(inner.expression),
            Expression::Literal(literal) => known(literal_type(literal)),
            Expression::CompositeString(_) => known(Type::string()),
            Expression::UnaryPrefix(unary) => self.unary(&unary.operator, unary.operand),
            Expression::UnaryPostfix(unary) => self.expr_inner(unary.operand),
            Expression::Binary(binary) => self.binary(&binary.operator, binary.lhs, binary.rhs),
            Expression::Conditional(conditional) => {
                let then = match conditional.then {
                    Some(then) => self.expr_inner(then),
                    None => self.expr_inner(conditional.condition),
                };
                LazyType::union([then, self.expr_inner(conditional.r#else)])
            }
            Expression::Match(r#match) => LazyType::union(r#match.arms.iter().map(|arm| match arm {
                MatchArm::Expression(arm) => self.expr_inner(arm.expression),
                MatchArm::Default(arm) => self.expr_inner(arm.expression),
            })),
            Expression::Clone(clone) => self.expr_inner(clone.object),
            Expression::Assignment(assignment) => match assignment.operator {
                AssignmentOperator::Assign(_) => self.expr_inner(assignment.rhs),
                _ => LazyType::mixed(),
            },
            Expression::Array(array) => self.array(array.elements.iter()),
            Expression::LegacyArray(array) => self.array(array.elements.iter()),
            Expression::AnonymousClass(_) => known(Type::Object),
            Expression::Closure(_) | Expression::ArrowFunction(_) => known(Type::Closure(None)),
            Expression::Variable(variable) => self.variable(variable),
            Expression::Construct(construct) => known(match construct {
                Construct::Isset(_) | Construct::Empty(_) => Type::Bool,
                Construct::Print(_) => Type::LiteralInt(1),
                Construct::Exit(_) | Construct::Die(_) => Type::Never,
                _ => Type::Mixed,
            }),
            Expression::Throw(_) => known(Type::Never),
            Expression::MagicConstant(MagicConstant::Line(_)) => known(Type::Int),
            Expression::MagicConstant(_) => known(Type::string()),
            Expression::Instantiation(instantiation) => match self.class_ref(instantiation.class) {
                LazyType::Known(ty @ (Type::Named { .. } | Type::Relative(_) | Type::Closure(_))) => known(ty),
                _ => known(Type::Object),
            },
            Expression::Call(call) => self.call(call),
            Expression::Access(access) => self.access(access),
            Expression::ConstantAccess(constant) => {
                match self.scope.resolve(NameKind::Constant, &lossy(constant.name.value())).resolution {
                    Resolution::Fqn(fqn) => LazyType::Constant { fqn, fallback: None },
                    Resolution::Fallback { namespaced, global } => {
                        LazyType::Constant { fqn: namespaced, fallback: Some(global) }
                    }
                    Resolution::Relative(_) => LazyType::mixed(),
                }
            }
            _ => LazyType::mixed(),
        }
    }

    fn unary(&self, operator: &UnaryPrefixOperator<'_>, operand: &Expression<'_>) -> LazyType {
        let value = self.expr_inner(operand);
        match unary_type(operator, value.known()) {
            Some(ty) => known(ty),
            None => value,
        }
    }

    fn binary(&self, operator: &BinaryOperator<'_>, lhs: &Expression<'_>, rhs: &Expression<'_>) -> LazyType {
        match Op::of_binary(operator) {
            Op::Coalesce => {
                let left = match self.expr_inner(lhs) {
                    LazyType::Known(ty) => known(ty.without_null()),
                    other => other,
                };
                LazyType::union([left, self.expr_inner(rhs)])
            }
            op @ (Op::Add | Op::Sub | Op::Mul | Op::Exp) => {
                let (left, right) = (self.expr_inner(lhs), self.expr_inner(rhs));
                known(op_type(op, left.known(), right.known()))
            }
            op => known(op_type(op, None, None)),
        }
    }

    fn array<'a, 'b: 'a>(&self, elements: impl Iterator<Item = &'a ArrayElement<'b>>) -> LazyType {
        let mut keys = Vec::new();
        let mut values = Vec::new();
        let mut list = true;
        let mut any = false;
        for element in elements {
            let (key, value) = match element {
                ArrayElement::KeyValue(element) => (Some(element.key), element.value),
                ArrayElement::Value(element) => (None, element.value),
                ArrayElement::Variadic(_) => return known(Type::array()),
                ArrayElement::Missing(_) => continue,
            };
            any = true;
            if let Some(key) = key {
                list = false;
                keys.push(match self.expr_inner(key) {
                    LazyType::Known(ty) if is_int(&ty) => Type::Int,
                    LazyType::Known(ty) if is_string(&ty) => Type::string(),
                    _ => Type::ArrayKey,
                });
            } else {
                keys.push(Type::Int);
            }
            values.push(match self.expr_inner(value) {
                LazyType::Known(ty) => ty.widen(),
                _ => Type::Mixed,
            });
        }
        if !any {
            return known(Type::array());
        }
        let value = Box::new(Type::union(values));
        known(if list {
            Type::List { value, non_empty: true }
        } else {
            Type::Array { key: Box::new(Type::union(keys)), value, non_empty: true }
        })
    }

    fn variable(&self, variable: &Variable<'_>) -> LazyType {
        let Variable::Direct(direct) = variable else { return LazyType::mixed() };
        let name = direct.name.strip_prefix(b"$").unwrap_or(direct.name);
        if name == b"this" {
            return known(Type::Relative(Relative::This));
        }
        let name = lossy(name);
        match self.params.iter().find(|(param, _)| *param == name) {
            Some((_, ty)) => known(ty.clone()),
            None => LazyType::mixed(),
        }
    }

    /// The class named before `::` or after `new`.
    fn class_ref(&self, expr: &Expression<'_>) -> LazyType {
        match expr {
            Expression::Identifier(identifier) => {
                match self.scope.resolve(NameKind::ClassLike, &lossy(identifier.value())).resolution {
                    Resolution::Relative(relative) => known(Type::Relative(relative.into())),
                    Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => {
                        if fqn.eq_ignore_ascii_case("Closure") {
                            known(Type::Closure(None))
                        } else {
                            known(Type::named(&fqn))
                        }
                    }
                }
            }
            Expression::Self_(_) => known(Type::Relative(Relative::Self_)),
            Expression::Static(_) => known(Type::Relative(Relative::Static)),
            Expression::Parent(_) => known(Type::Relative(Relative::Parent)),
            other => self.expr_inner(other),
        }
    }

    fn call(&self, call: &Call<'_>) -> LazyType {
        let method = |kind: CallKind,
                      receiver: LazyType,
                      selector: &ClassLikeMemberSelector<'_>,
                      arguments: &ArgumentList<'_>| match selector {
            ClassLikeMemberSelector::Identifier(name) => {
                let name = lossy(name.value);
                let core = || LazyType::MethodReturn { receiver: Box::new(receiver.clone()), name: name.clone() };
                let args = site_args(self.scope, arguments);
                let site = CallSite { kind, name: &name, receiver: Some(&receiver), args: &args, core: &core };
                TypeProviders::builtin().call(&site)
            }
            _ => LazyType::mixed(),
        };
        match call {
            Call::Function(call) => match call.function {
                Expression::Identifier(identifier) => {
                    let core = match self.scope.resolve(NameKind::Function, &lossy(identifier.value())).resolution {
                        Resolution::Fqn(fqn) => LazyType::FunctionReturn { fqn, fallback: None },
                        Resolution::Fallback { namespaced, global } => {
                            LazyType::FunctionReturn { fqn: namespaced, fallback: Some(global) }
                        }
                        Resolution::Relative(_) => return LazyType::mixed(),
                    };
                    let LazyType::FunctionReturn { fqn, .. } = &core else { return LazyType::mixed() };
                    let args = site_args(self.scope, &call.argument_list);
                    let core_fn = || core.clone();
                    let site =
                        CallSite { kind: CallKind::Function, name: fqn, receiver: None, args: &args, core: &core_fn };
                    TypeProviders::builtin().call(&site)
                }
                _ => LazyType::mixed(),
            },
            Call::Method(call) => {
                method(CallKind::Method, self.expr_inner(call.object), &call.method, &call.argument_list)
            }
            Call::NullSafeMethod(call) => LazyType::union([
                method(CallKind::Method, self.expr_inner(call.object), &call.method, &call.argument_list),
                known(Type::Null),
            ]),
            Call::StaticMethod(call) => {
                method(CallKind::StaticMethod, self.class_ref(call.class), &call.method, &call.argument_list)
            }
        }
    }

    fn access(&self, access: &Access<'_>) -> LazyType {
        let property = |receiver: LazyType, selector: &ClassLikeMemberSelector<'_>| match selector {
            ClassLikeMemberSelector::Identifier(name) => {
                LazyType::Property { receiver: Box::new(receiver), name: lossy(name.value) }
            }
            _ => LazyType::mixed(),
        };
        match access {
            Access::Property(access) => property(self.expr_inner(access.object), &access.property),
            Access::NullSafeProperty(access) => {
                LazyType::union([property(self.expr_inner(access.object), &access.property), known(Type::Null)])
            }
            Access::StaticProperty(access) => match &access.property {
                Variable::Direct(direct) => LazyType::Property {
                    receiver: Box::new(self.class_ref(access.class)),
                    name: lossy(direct.name.strip_prefix(b"$").unwrap_or(direct.name)),
                },
                _ => LazyType::mixed(),
            },
            Access::ClassConstant(access) => {
                let ClassLikeConstantSelector::Identifier(name) = &access.constant else {
                    return LazyType::mixed();
                };
                let class = self.class_ref(access.class);
                if name.value.eq_ignore_ascii_case(b"class") {
                    return known(Type::ClassString(class.known().cloned().map(Box::new)));
                }
                LazyType::ClassConstant { class: Box::new(class), name: lossy(name.value) }
            }
        }
    }
}

/// What a function-like body returns, from its `return` statements (not
/// those of nested closures, functions or classes):
///
/// - `Generator` when it `yield`s;
/// - `void` when no `return` gives a value;
/// - else the union of the returned values, with `null` for a bare
///   `return;`.
pub(super) fn body_return(infer: &Infer<'_>, body: &Block<'_>) -> LazyType {
    let mut returns = Returns { infer, values: Vec::new(), bare: false, generator: false };
    ReturnWalker.walk_block(body, &mut returns);
    if returns.generator {
        return known(Type::named("Generator"));
    }
    if returns.values.is_empty() {
        return known(Type::Void);
    }
    if returns.bare {
        returns.values.push(known(Type::Null));
    }
    LazyType::union(returns.values)
}

struct Returns<'i, 's> {
    infer: &'i Infer<'s>,
    values: Vec<LazyType>,
    bare: bool,
    generator: bool,
}

struct ReturnWalker;

impl<'ast, 'arena, 'i, 's> Walker<'ast, 'arena, Returns<'i, 's>> for ReturnWalker {
    fn walk_in_return(&self, node: &'ast Return<'arena>, cx: &mut Returns<'i, 's>) {
        match node.value {
            Some(value) => {
                let ty = cx.infer.expr(value);
                cx.values.push(ty);
            }
            None => cx.bare = true,
        }
    }

    fn walk_in_yield(&self, _: &'ast Yield<'arena>, cx: &mut Returns<'i, 's>) {
        cx.generator = true;
    }

    // Nested scopes return for themselves.
    fn walk_closure(&self, _: &'ast Closure<'arena>, _: &mut Returns<'i, 's>) {}
    fn walk_arrow_function(&self, _: &'ast ArrowFunction<'arena>, _: &mut Returns<'i, 's>) {}
    fn walk_anonymous_class(&self, _: &'ast AnonymousClass<'arena>, _: &mut Returns<'i, 's>) {}
    fn walk_function(&self, _: &'ast Function<'arena>, _: &mut Returns<'i, 's>) {}
    fn walk_class(&self, _: &'ast Class<'arena>, _: &mut Returns<'i, 's>) {}
    fn walk_interface(&self, _: &'ast Interface<'arena>, _: &mut Returns<'i, 's>) {}
    fn walk_trait(&self, _: &'ast Trait<'arena>, _: &mut Returns<'i, 's>) {}
    fn walk_enum(&self, _: &'ast Enum<'arena>, _: &mut Returns<'i, 's>) {}
}

/// The `$this->name = value` assignments in a method body (outside nested
/// functions and classes), with the property name.
pub(super) fn this_assignments<'ast, 'arena>(body: &'ast Block<'arena>) -> Vec<(String, &'ast Expression<'arena>)> {
    let mut found = Vec::new();
    AssignmentWalker.walk_block(body, &mut found);
    found
}

type Assignments<'ast, 'arena> = Vec<(String, &'ast Expression<'arena>)>;

struct AssignmentWalker;

impl<'ast, 'arena> Walker<'ast, 'arena, Assignments<'ast, 'arena>> for AssignmentWalker {
    fn walk_in_assignment(&self, node: &'ast Assignment<'arena>, cx: &mut Assignments<'ast, 'arena>) {
        if let AssignmentOperator::Assign(_) = node.operator
            && let Expression::Access(Access::Property(access)) = node.lhs
            && let Expression::Variable(Variable::Direct(object)) = access.object
            && object.name == b"$this"
            && let ClassLikeMemberSelector::Identifier(name) = &access.property
        {
            cx.push((lossy(name.value), node.rhs));
        }
    }

    fn walk_anonymous_class(&self, _: &'ast AnonymousClass<'arena>, _: &mut Assignments<'ast, 'arena>) {}
    fn walk_function(&self, _: &'ast Function<'arena>, _: &mut Assignments<'ast, 'arena>) {}
    fn walk_class(&self, _: &'ast Class<'arena>, _: &mut Assignments<'ast, 'arena>) {}
    fn walk_interface(&self, _: &'ast Interface<'arena>, _: &mut Assignments<'ast, 'arena>) {}
    fn walk_trait(&self, _: &'ast Trait<'arena>, _: &mut Assignments<'ast, 'arena>) {}
    fn walk_enum(&self, _: &'ast Enum<'arena>, _: &mut Assignments<'ast, 'arena>) {}
}
