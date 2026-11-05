//! Summary-time types: what a file alone says about the type of a value
//! expression, and what a function-like body returns, as [`LazyType`]s.
//!
//! Only the file is known here, so anything that depends on another
//! declaration (a call, a member access, a constant) becomes a lazy recipe
//! for the resolver. Variables other than `$this` and the parameters are not
//! tracked (that is the flow analysis of a later phase): they are `mixed`.

use mago_syntax::cst::{
    Access, AnonymousClass, ArrayElement, ArrowFunction, AssignmentOperator, BinaryOperator, Block, Call, Class,
    ClassLikeConstantSelector, ClassLikeMemberSelector, Closure, Construct, Enum, Expression, Function, Interface,
    Literal, MagicConstant, MatchArm, Return, Trait, UnaryPrefixOperator, Variable, Yield,
};
use mago_syntax::walker::Walker;

use crate::names::{NameKind, NameScope, Resolution};
use crate::types::{LazyType, Relative, Type};

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
        use UnaryPrefixOperator as Op;
        known(match operator {
            Op::ArrayCast(..) => Type::array(),
            Op::BoolCast(..) | Op::BooleanCast(..) | Op::Not(..) => Type::Bool,
            Op::DoubleCast(..) | Op::RealCast(..) | Op::FloatCast(..) => Type::Float,
            Op::IntCast(..) | Op::IntegerCast(..) | Op::BitwiseNot(..) => Type::Int,
            Op::ObjectCast(..) => Type::Object,
            Op::StringCast(..) | Op::BinaryCast(..) => Type::string(),
            Op::UnsetCast(..) | Op::VoidCast(..) => Type::Null,
            Op::Negation(..) | Op::Plus(..) => {
                let negate = matches!(operator, Op::Negation(..));
                match self.expr_inner(operand) {
                    LazyType::Known(Type::LiteralInt(value)) if negate => Type::LiteralInt(value.wrapping_neg()),
                    LazyType::Known(Type::LiteralFloat(text)) if negate => Type::LiteralFloat(format!("-{text}")),
                    LazyType::Known(ty) if is_int(&ty) || is_float(&ty) => ty,
                    _ => Type::union([Type::Int, Type::Float]),
                }
            }
            _ => return self.expr_inner(operand),
        })
    }

    fn binary(&self, operator: &BinaryOperator<'_>, lhs: &Expression<'_>, rhs: &Expression<'_>) -> LazyType {
        use BinaryOperator as Op;
        match operator {
            Op::StringConcat(..) => known(Type::string()),
            Op::NullCoalesce(..) => {
                let left = match self.expr_inner(lhs) {
                    LazyType::Known(ty) => known(ty.without_null()),
                    other => other,
                };
                LazyType::union([left, self.expr_inner(rhs)])
            }
            Op::Addition(..) | Op::Subtraction(..) | Op::Multiplication(..) | Op::Exponentiation(..) => {
                let (left, right) = (self.expr_inner(lhs), self.expr_inner(rhs));
                let (Some(left), Some(right)) = (left.known(), right.known()) else {
                    return known(Type::union([Type::Int, Type::Float]));
                };
                let numeric = |ty: &Type| is_int(ty) || is_float(ty);
                known(if matches!(operator, Op::Addition(..)) && is_array(left) && is_array(right) {
                    Type::array()
                } else if is_int(left) && is_int(right) && !matches!(operator, Op::Exponentiation(..)) {
                    Type::Int
                } else if numeric(left) && numeric(right) && (is_float(left) || is_float(right)) {
                    Type::Float
                } else {
                    Type::union([Type::Int, Type::Float])
                })
            }
            Op::Division(..) => known(Type::union([Type::Int, Type::Float])),
            Op::Modulo(..)
            | Op::BitwiseAnd(..)
            | Op::BitwiseOr(..)
            | Op::BitwiseXor(..)
            | Op::LeftShift(..)
            | Op::RightShift(..)
            | Op::Spaceship(..) => known(Type::Int),
            _ => known(Type::Bool),
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
        let method = |receiver: LazyType, selector: &ClassLikeMemberSelector<'_>| match selector {
            ClassLikeMemberSelector::Identifier(name) => {
                LazyType::MethodReturn { receiver: Box::new(receiver), name: lossy(name.value) }
            }
            _ => LazyType::mixed(),
        };
        match call {
            Call::Function(call) => match call.function {
                Expression::Identifier(identifier) => {
                    match self.scope.resolve(NameKind::Function, &lossy(identifier.value())).resolution {
                        Resolution::Fqn(fqn) => LazyType::FunctionReturn { fqn, fallback: None },
                        Resolution::Fallback { namespaced, global } => {
                            LazyType::FunctionReturn { fqn: namespaced, fallback: Some(global) }
                        }
                        Resolution::Relative(_) => LazyType::mixed(),
                    }
                }
                _ => LazyType::mixed(),
            },
            Call::Method(call) => method(self.expr_inner(call.object), &call.method),
            Call::NullSafeMethod(call) => {
                LazyType::union([method(self.expr_inner(call.object), &call.method), known(Type::Null)])
            }
            Call::StaticMethod(call) => method(self.class_ref(call.class), &call.method),
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

fn literal_type(literal: &Literal<'_>) -> Type {
    match literal {
        Literal::String(string) => match string.value {
            Some(value) => Type::LiteralString(lossy(value)),
            None => Type::string(),
        },
        Literal::Integer(integer) => match integer.value.and_then(|value| i64::try_from(value).ok()) {
            Some(value) => Type::LiteralInt(value),
            None => Type::Int,
        },
        Literal::Float(float) => Type::LiteralFloat(lossy(float.raw)),
        Literal::True(_) => Type::LiteralBool(true),
        Literal::False(_) => Type::LiteralBool(false),
        Literal::Null(_) => Type::Null,
    }
}

fn is_int(ty: &Type) -> bool {
    matches!(ty, Type::Int | Type::LiteralInt(_) | Type::IntRange { .. })
}

fn is_float(ty: &Type) -> bool {
    matches!(ty, Type::Float | Type::LiteralFloat(_))
}

fn is_string(ty: &Type) -> bool {
    matches!(ty, Type::String(_) | Type::LiteralString(_))
}

fn is_array(ty: &Type) -> bool {
    matches!(ty, Type::Array { .. } | Type::List { .. } | Type::Shape(_))
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
