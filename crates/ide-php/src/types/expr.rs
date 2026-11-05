//! Expression types: the type of any expression in a file, from what the
//! file says locally and the project's declarations through the
//! [`Resolver`].
//!
//! [`type_at`] finds the innermost expression around a caret and infers its
//! type with an [`ExprTypes`]. It covers:
//!
//! - literals (array literals become shapes when every key is a literal),
//!   `new`, casts, arithmetic and string operators, comparisons,
//!   `instanceof`, the ternary, `?:` and `??` operators, `match`, `clone`,
//!   `print`/`isset`/`exit` and friends;
//! - function, method, static and nullsafe calls, calls of closures and
//!   invokable objects, the pipe operator, and first-class callables
//!   (`strlen(...)`, `$o->m(...)`, `Foo::m(...)`) as `Closure` with the
//!   callee's signature;
//! - property, static property, class constant and global constant access,
//!   `::class`, and array access on shapes, arrays, lists, strings and
//!   `ArrayAccess` objects (`offsetGet`);
//! - closures and arrow functions as `Closure(…): T` signatures, their
//!   return type from the hint or from the body;
//! - variables: `$this`, the parameters of the enclosing function-like
//!   (`@param` first, as the summaries do), closure `use` captures and the
//!   enclosing scope of arrow functions, and plain assignments.
//!
//! Local variables are approximated until the flow graph of phase 2.5: a
//! variable has the type of the last `$var = …` (or `$var op= …`) that ends
//! before the read in the same function-like, regardless of branches and
//! loops. `foreach`, `list()`, `catch`, `global` and `static` variables are
//! `mixed` until then.
//!
//! Literals are kept while inferring (so `$a['key']` finds the shape field
//! and `-1` stays an int); [`type_at`] widens the answer (`'a'` is shown as
//! `string`), as PhpStorm shows types.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use mago_span::HasSpan;
use mago_syntax::cst::{
    Access, AnonymousClass, ArrayElement, ArrowFunction, Assignment, Call, Class, ClassLikeConstantSelector,
    ClassLikeMemberSelector, Closure, Construct, Enum, Expression, Function, FunctionLikeParameterList, Interface,
    MagicConstant, MatchArm, Method, MethodBody, PartialApplication, PartialArgument, PartialArgumentList, Program,
    Return, Trait, Variable, Yield,
};
use mago_syntax::walker::Walker;

use super::ops::{Op, literal_type, op_type, unary_type};
use super::{Context, LazyType, Relative, Resolver, Shape, ShapeField, ShapeKey, Signature, SignatureParam, Type};
use crate::names::{FileNames, NameKind, NameScope, Resolution};
use crate::summary::{ClassLike, DocBlock, FileSummary, FunctionDecl, Param, type_hint};
use crate::syntax::ParsedFile;

/// How many variable assignments one inference follows before answering
/// `mixed`.
const MAX_DEPTH: usize = 64;

/// Array literals with more fields than this are `array<K, V>` / `list<V>`
/// rather than shapes.
const MAX_SHAPE_FIELDS: usize = 32;

/// The type of the innermost expression around byte `offset` (an
/// expression that starts or ends at the offset counts), widened for
/// display. `None` when there is no expression there.
pub fn type_at(file: &ParsedFile, resolver: &Resolver<'_>, offset: u32) -> Option<Type> {
    let names = FileNames::resolve(file);
    let summary = FileSummary::extract(file);
    let types = ExprTypes::new(file, &names, &summary, resolver);
    let (expr, frames) = types.find(offset)?;
    Some(types.type_of(expr, &frames).widen())
}

/// A scope an expression is nested in, outermost first.
#[derive(Clone, Debug)]
pub enum Frame<'a> {
    /// A class-like; `None` for an anonymous class.
    Class(Option<String>),
    Function(&'a Function<'a>),
    Method(&'a Method<'a>),
    Closure(&'a Closure<'a>),
    Arrow(&'a ArrowFunction<'a>),
}

impl Frame<'_> {
    fn is_function_like(&self) -> bool {
        !matches!(self, Self::Class(_))
    }

    /// The offset identifying the frame (its start).
    fn key(&self) -> u32 {
        match self {
            Self::Class(_) => u32::MAX,
            Self::Function(node) => node.span().start.offset,
            Self::Method(node) => node.span().start.offset,
            Self::Closure(node) => node.span().start.offset,
            Self::Arrow(node) => node.span().start.offset,
        }
    }
}

/// A plain assignment to a variable.
#[derive(Clone, Copy)]
struct Assign<'a> {
    /// Without the `$`.
    name: &'a [u8],
    lhs_start: u32,
    end: u32,
    node: &'a Assignment<'a>,
}

/// Infers expression types in one file.
pub struct ExprTypes<'a, 'r> {
    file: &'a ParsedFile,
    names: &'a FileNames,
    summary: &'a FileSummary,
    resolver: &'r Resolver<'r>,
    /// Assignments by frame key (`u32::MAX - 1` for the file's top level).
    assignments: RefCell<HashMap<u32, Rc<Vec<Assign<'a>>>>>,
    depth: Cell<usize>,
}

const TOP_LEVEL: u32 = u32::MAX - 1;

impl<'a, 'r> ExprTypes<'a, 'r> {
    pub fn new(
        file: &'a ParsedFile,
        names: &'a FileNames,
        summary: &'a FileSummary,
        resolver: &'r Resolver<'r>,
    ) -> Self {
        Self { file, names, summary, resolver, assignments: RefCell::new(HashMap::new()), depth: Cell::new(0) }
    }

    fn program(&self) -> &'a Program<'a> {
        self.file.program()
    }

    /// The innermost expression around `offset` and the scopes it is in.
    /// Bare names (`Foo` in `Foo::bar()`, `strlen` in `strlen($s)`) and
    /// `self`/`static`/`parent` are not expressions of their own here: the
    /// expression around them is.
    pub fn find(&self, offset: u32) -> Option<(&'a Expression<'a>, Vec<Frame<'a>>)> {
        let mut finder = Finder { offset, summary: self.summary, frames: Vec::new(), best: None };
        FindWalker.walk_program(self.program(), &mut finder);
        finder.best
    }

    /// What `self`, `parent` and `static` mean in `frames`.
    fn context(&self, frames: &[Frame<'a>]) -> Context {
        match frames.iter().rev().find_map(|frame| match frame {
            Frame::Class(fqn) => Some(fqn),
            _ => None,
        }) {
            Some(Some(fqn)) => Context::in_class(fqn),
            _ => Context::default(),
        }
    }

    fn scope(&self, offset: u32) -> &'a NameScope {
        self.names.scope_at(offset)
    }

    /// The type of `expr` inside `frames`, with `self` and `parent` bound
    /// and literals kept.
    pub fn type_of(&self, expr: &'a Expression<'a>, frames: &[Frame<'a>]) -> Type {
        let ty = self.expr(expr, frames);
        self.resolver.resolve(&LazyType::Known(ty), &self.context(frames))
    }

    fn expr(&self, expr: &'a Expression<'a>, frames: &[Frame<'a>]) -> Type {
        match expr {
            Expression::Parenthesized(inner) => self.expr(inner.expression, frames),
            Expression::Literal(literal) => literal_type(literal),
            Expression::CompositeString(_) => Type::string(),
            Expression::UnaryPrefix(unary) => {
                let operand = self.expr(unary.operand, frames);
                unary_type(&unary.operator, Some(&operand)).unwrap_or(operand)
            }
            Expression::UnaryPostfix(unary) => self.expr(unary.operand, frames),
            Expression::Binary(binary) => {
                let left = self.expr(binary.lhs, frames);
                let right = self.expr(binary.rhs, frames);
                op_type(Op::of_binary(&binary.operator), Some(&left), Some(&right))
            }
            Expression::Conditional(conditional) => {
                let then = match conditional.then {
                    Some(then) => self.expr(then, frames),
                    // `a ?: b`: `a` when it is truthy.
                    None => falsy_removed(&self.expr(conditional.condition, frames)),
                };
                Type::union([then, self.expr(conditional.r#else, frames)])
            }
            Expression::Match(r#match) => Type::union(r#match.arms.iter().map(|arm| match arm {
                MatchArm::Expression(arm) => self.expr(arm.expression, frames),
                MatchArm::Default(arm) => self.expr(arm.expression, frames),
            })),
            Expression::Clone(clone) => self.expr(clone.object, frames),
            Expression::Assignment(assignment) => self.assignment(assignment, frames),
            Expression::Array(array) => self.array(array.elements.iter(), frames),
            Expression::LegacyArray(array) => self.array(array.elements.iter(), frames),
            Expression::ArrayAccess(access) => {
                let base = self.expr(access.array, frames);
                let key = self.expr(access.index, frames);
                self.element(&base, &key, frames)
            }
            Expression::AnonymousClass(_) => Type::Object,
            Expression::Closure(closure) => self.closure(closure, frames),
            Expression::ArrowFunction(arrow) => self.arrow(arrow, frames),
            Expression::Variable(Variable::Direct(direct)) => {
                let name = direct.name.strip_prefix(b"$").unwrap_or(direct.name);
                self.variable(name, direct.span.start.offset, frames)
            }
            Expression::ConstantAccess(constant) => {
                let name = String::from_utf8_lossy(constant.name.value());
                let resolved = self.scope(constant.name.span().start.offset).resolve(NameKind::Constant, &name);
                resolved.resolution.candidates().find_map(|fqn| self.resolver.constant_type(fqn)).unwrap_or(Type::Mixed)
            }
            Expression::Construct(construct) => match construct {
                Construct::Isset(_) | Construct::Empty(_) => Type::Bool,
                Construct::Print(_) => Type::LiteralInt(1),
                Construct::Exit(_) | Construct::Die(_) => Type::Never,
                _ => Type::Mixed,
            },
            Expression::Throw(_) => Type::Never,
            Expression::MagicConstant(MagicConstant::Line(_)) => Type::Int,
            Expression::MagicConstant(_) => Type::string(),
            Expression::Instantiation(instantiation) => match self.class_ref(instantiation.class, frames) {
                Type::Named { fqn, .. } if fqn.eq_ignore_ascii_case("Closure") => Type::Closure(None),
                ty @ (Type::Named { .. } | Type::Relative(_)) => ty,
                _ => Type::Object,
            },
            Expression::Call(call) => self.call(call, frames),
            Expression::PartialApplication(partial) => self.partial(partial, frames),
            Expression::Access(access) => self.access(access, frames),
            Expression::Pipe(pipe) => {
                let callable = self.expr(pipe.callable, frames);
                self.invoke(&callable, frames)
            }
            _ => Type::Mixed,
        }
    }

    // ---------------------------------------------------------- variables

    /// The type of `$name` read at `at` inside `frames`.
    fn variable(&self, name: &[u8], at: u32, frames: &[Frame<'a>]) -> Type {
        self.lookup(name, at, frames, true)
    }

    /// The type of `$name` at `at`; `here` includes an assignment whose
    /// left side starts at `at` (the read is the assigned variable itself).
    fn lookup(&self, name: &[u8], at: u32, frames: &[Frame<'a>], here: bool) -> Type {
        if name == b"this" {
            return if frames.iter().any(|frame| matches!(frame, Frame::Class(_))) {
                Type::Relative(Relative::This)
            } else {
                Type::Mixed
            };
        }
        let function = frames.iter().rposition(Frame::is_function_like);
        let key = function.map_or(TOP_LEVEL, |i| frames[i].key());
        let scope_frames = &frames[..function.map_or(0, |i| i + 1)];
        let assignments = self.assignments(key, function.map(|i| &frames[i]));
        let last = assignments
            .iter()
            .rev()
            .find(|assign| assign.name == name && (assign.end <= at || (here && assign.lhs_start == at)))
            .copied();
        if let Some(assign) = last {
            if self.depth.get() >= MAX_DEPTH {
                return Type::Mixed;
            }
            self.depth.set(self.depth.get() + 1);
            let ty = self.assignment(assign.node, scope_frames);
            self.depth.set(self.depth.get() - 1);
            return ty;
        }
        let Some(i) = function else { return Type::Mixed };
        if let Some(ty) = self.parameter(&frames[i], name) {
            return ty;
        }
        match &frames[i] {
            Frame::Closure(closure) => {
                let captured = closure.use_clause.iter().flat_map(|clause| clause.variables.iter()).any(|variable| {
                    variable.variable.name.strip_prefix(b"$").unwrap_or(variable.variable.name) == name
                });
                if captured { self.variable(name, closure.span().start.offset, &frames[..i]) } else { Type::Mixed }
            }
            Frame::Arrow(arrow) => self.variable(name, arrow.span().start.offset, &frames[..i]),
            _ => Type::Mixed,
        }
    }

    /// The plain assignments of a function-like body (or of the top level),
    /// not those of nested function-likes and classes, in source order.
    fn assignments(&self, key: u32, frame: Option<&Frame<'a>>) -> Rc<Vec<Assign<'a>>> {
        if let Some(hit) = self.assignments.borrow().get(&key) {
            return hit.clone();
        }
        let mut found = Vec::new();
        let walker = AssignWalker;
        match frame {
            None => walker.walk_program(self.program(), &mut found),
            Some(Frame::Function(function)) => walker.walk_block(&function.body, &mut found),
            Some(Frame::Method(method)) => {
                if let MethodBody::Concrete(body) = &method.body {
                    walker.walk_block(body, &mut found);
                }
            }
            Some(Frame::Closure(closure)) => walker.walk_block(&closure.body, &mut found),
            Some(Frame::Arrow(arrow)) => walker.walk_expression(arrow.expression, &mut found),
            Some(Frame::Class(_)) => {}
        }
        found.sort_by_key(|assign| assign.end);
        let found = Rc::new(found);
        self.assignments.borrow_mut().insert(key, found.clone());
        found
    }

    /// The type an assignment expression has (and gives its variable).
    fn assignment(&self, assignment: &'a Assignment<'a>, frames: &[Frame<'a>]) -> Type {
        let right = self.expr(assignment.rhs, frames);
        match Op::of_assignment(&assignment.operator) {
            None => right,
            Some(op) => {
                let left = match assignment.lhs {
                    // The variable's value before this assignment.
                    Expression::Variable(Variable::Direct(direct)) => self.lookup(
                        direct.name.strip_prefix(b"$").unwrap_or(direct.name),
                        direct.span.start.offset,
                        frames,
                        false,
                    ),
                    lhs => self.expr(lhs, frames),
                };
                op_type(op, Some(&left), Some(&right))
            }
        }
    }

    /// The declared type of parameter `$name` of a function-like.
    fn parameter(&self, frame: &Frame<'a>, name: &[u8]) -> Option<Type> {
        let name = String::from_utf8_lossy(name);
        let declared = |params: &[Param], doc: Option<&DocBlock>, templates: Vec<&str>| {
            let param = params.iter().find(|param| param.name == name)?;
            let ty = match (doc.and_then(|doc| doc.param_type(&param.name)), &param.type_hint) {
                (Some(ty), _) => Type::from_doc(ty, &templates),
                (None, Some(hint)) => Type::from_hint(hint),
                (None, None) => Type::Mixed,
            };
            Some(if param.variadic { Type::list_of(ty) } else { ty })
        };
        match frame {
            Frame::Function(function) => {
                let decl = self.function_decl(function)?;
                let doc = decl.doc.as_deref();
                declared(&decl.params, doc, doc.iter().flat_map(|doc| doc.local_type_names()).collect())
            }
            Frame::Method(method) => {
                let start = method.name.span.start.offset;
                let (class, decl) = self
                    .summary
                    .class_likes
                    .iter()
                    .find_map(|class| Some((class, class.methods.iter().find(|m| m.name_loc.start == start)?)))?;
                let doc = decl.doc.as_deref();
                let mut templates: Vec<&str> = class_templates(class);
                templates.extend(doc.iter().flat_map(|doc| doc.local_type_names()));
                declared(&decl.params, doc, templates)
            }
            Frame::Closure(closure) => self.ast_parameter(&closure.parameter_list, &name),
            Frame::Arrow(arrow) => self.ast_parameter(&arrow.parameter_list, &name),
            Frame::Class(_) => None,
        }
    }

    fn function_decl(&self, function: &Function<'_>) -> Option<&'a FunctionDecl> {
        let start = function.name.span.start.offset;
        self.summary.functions.iter().find(|decl| decl.name_loc.start == start)
    }

    /// A closure or arrow function parameter's native type.
    fn ast_parameter(&self, list: &FunctionLikeParameterList<'_>, name: &str) -> Option<Type> {
        let parameter = list.parameters.iter().find(|parameter| {
            parameter.variable.name.strip_prefix(b"$").unwrap_or(parameter.variable.name) == name.as_bytes()
        })?;
        let ty = match &parameter.hint {
            Some(hint) => Type::from_hint(&type_hint(self.scope(parameter.span().start.offset), hint)),
            None => Type::Mixed,
        };
        Some(if parameter.ellipsis.is_some() { Type::list_of(ty) } else { ty })
    }

    // ------------------------------------------------------------- arrays

    /// An array literal: a shape when every key is a literal (PHP's
    /// numbering for keyless values), else `array<K, V>` / `list<V>`.
    fn array<'b>(&self, elements: impl Iterator<Item = &'b ArrayElement<'a>>, frames: &[Frame<'a>]) -> Type
    where
        'a: 'b,
    {
        let mut fields: Vec<ShapeField> = Vec::new();
        let mut keys = Vec::new();
        let mut values = Vec::new();
        let mut shape = true;
        let mut list = true;
        let mut next: i64 = 0;
        for element in elements {
            let (key, value) = match element {
                ArrayElement::KeyValue(element) => (Some(self.expr(element.key, frames)), element.value),
                ArrayElement::Value(element) => (None, element.value),
                ArrayElement::Variadic(element) => {
                    // A spread: its values, under unknown keys.
                    shape = false;
                    let spread = self.expr(element.value, frames);
                    values.push(iterable_value(&spread));
                    keys.push(Type::ArrayKey);
                    continue;
                }
                ArrayElement::Missing(_) => continue,
            };
            let value = self.expr(value, frames);
            let key = match key {
                None => {
                    let key = ShapeKey::Int(next);
                    next = next.saturating_add(1);
                    Some(key)
                }
                Some(key) => {
                    list = false;
                    match shape_key(&key) {
                        Some(ShapeKey::Int(int)) => {
                            next = next.max(int.saturating_add(1));
                            Some(ShapeKey::Int(int))
                        }
                        Some(key) => Some(key),
                        None => {
                            keys.push(if key.members().iter().all(super::ops::is_int) {
                                Type::Int
                            } else if key.members().iter().all(super::ops::is_string) {
                                Type::string()
                            } else {
                                Type::ArrayKey
                            });
                            None
                        }
                    }
                }
            };
            match key {
                Some(key) => {
                    keys.push(key.as_type().widen());
                    fields.retain(|field| field.key != key);
                    fields.push(ShapeField { key, ty: value.clone(), optional: false });
                }
                None => shape = false,
            }
            values.push(value);
        }
        if values.is_empty() {
            return Type::array();
        }
        if shape && fields.len() <= MAX_SHAPE_FIELDS {
            let list = list && fields.iter().enumerate().all(|(i, field)| field.key == ShapeKey::Int(i as i64));
            return Type::Shape(Box::new(Shape { list, fields, rest: None }));
        }
        let value = Box::new(Type::union(values.iter().map(Type::widen)));
        if list && keys.iter().all(|key| *key == Type::Int) && shape {
            Type::List { value, non_empty: true }
        } else {
            Type::Array { key: Box::new(Type::union(keys)), value, non_empty: true }
        }
    }

    /// `base[key]`, member by member.
    fn element(&self, base: &Type, key: &Type, frames: &[Frame<'a>]) -> Type {
        let context = self.context(frames);
        let literal = shape_key(key);
        let mut answers = Vec::new();
        for member in base.members() {
            let answer = match member {
                Type::Shape(shape) => match literal.as_ref().and_then(|key| shape.field(key)) {
                    Some(field) => field.ty.clone(),
                    None if literal.is_some() => match &shape.rest {
                        Some((_, value)) => value.clone(),
                        None => continue,
                    },
                    None => shape.value_type(),
                },
                Type::Array { value, .. } | Type::List { value, .. } | Type::Iterable { value, .. } => {
                    (**value).clone()
                }
                Type::String(_) | Type::LiteralString(_) => Type::string(),
                Type::Null | Type::Void | Type::Never => continue,
                Type::Named { .. } | Type::Relative(_) | Type::Intersection(_) => {
                    self.resolver.method_return(member, "offsetGet", &context)
                }
                _ => Type::Mixed,
            };
            answers.push(answer);
        }
        if answers.is_empty() { Type::Mixed } else { Type::union(answers) }
    }

    // ----------------------------------------------------------- closures

    fn closure(&self, closure: &'a Closure<'a>, frames: &[Frame<'a>]) -> Type {
        let inner = with(frames, Frame::Closure(closure));
        let return_type = match &closure.return_type_hint {
            Some(hint) => Type::from_hint(&type_hint(self.scope(closure.span().start.offset), &hint.hint)),
            None => {
                let mut returns = Returns::default();
                ReturnWalker.walk_block(&closure.body, &mut returns);
                if returns.generator {
                    Type::named("Generator")
                } else if returns.values.is_empty() {
                    Type::Void
                } else {
                    let mut types: Vec<Type> =
                        returns.values.iter().map(|value| self.expr(value, &inner).widen()).collect();
                    if returns.bare {
                        types.push(Type::Null);
                    }
                    Type::union(types)
                }
            }
        };
        Type::Closure(Some(Box::new(self.signature(&closure.parameter_list, closure.span().start.offset, return_type))))
    }

    fn arrow(&self, arrow: &'a ArrowFunction<'a>, frames: &[Frame<'a>]) -> Type {
        let inner = with(frames, Frame::Arrow(arrow));
        let return_type = match &arrow.return_type_hint {
            Some(hint) => Type::from_hint(&type_hint(self.scope(arrow.span().start.offset), &hint.hint)),
            None => self.expr(arrow.expression, &inner).widen(),
        };
        Type::Closure(Some(Box::new(self.signature(&arrow.parameter_list, arrow.span().start.offset, return_type))))
    }

    fn signature(&self, list: &FunctionLikeParameterList<'_>, at: u32, return_type: Type) -> Signature {
        let scope = self.scope(at);
        let params = list
            .parameters
            .iter()
            .map(|parameter| SignatureParam {
                ty: parameter.hint.as_ref().map_or(Type::Mixed, |hint| Type::from_hint(&type_hint(scope, hint))),
                name: Some(
                    String::from_utf8_lossy(
                        parameter.variable.name.strip_prefix(b"$").unwrap_or(parameter.variable.name),
                    )
                    .into_owned(),
                ),
                by_ref: parameter.ampersand.is_some(),
                optional: parameter.default_value.is_some(),
                variadic: parameter.ellipsis.is_some(),
            })
            .collect();
        Signature { params, return_type: Some(return_type) }
    }

    // -------------------------------------------------------------- calls

    /// The class named before `::` or after `new`.
    fn class_ref(&self, expr: &'a Expression<'a>, frames: &[Frame<'a>]) -> Type {
        match expr {
            Expression::Identifier(identifier) => {
                let name = String::from_utf8_lossy(identifier.value());
                match self.scope(identifier.span().start.offset).resolve(NameKind::ClassLike, &name).resolution {
                    Resolution::Relative(relative) => Type::Relative(relative.into()),
                    Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => Type::named(&fqn),
                }
            }
            Expression::Self_(_) => Type::Relative(Relative::Self_),
            Expression::Static(_) => Type::Relative(Relative::Static),
            Expression::Parent(_) => Type::Relative(Relative::Parent),
            other => {
                // `new $class`, `$object::method()`.
                let ty = self.expr(other, frames);
                Type::union(ty.members().iter().map(|member| match member {
                    Type::ClassString(Some(class)) => (**class).clone(),
                    Type::LiteralString(name) => Type::named(name),
                    Type::Named { .. } | Type::Relative(_) | Type::Closure(_) | Type::Intersection(_) => member.clone(),
                    _ => Type::Mixed,
                }))
            }
        }
    }

    fn call(&self, call: &'a Call<'a>, frames: &[Frame<'a>]) -> Type {
        let context = self.context(frames);
        match call {
            Call::Function(call) => match call.function {
                Expression::Identifier(identifier) => {
                    let name = String::from_utf8_lossy(identifier.value());
                    let resolved = self.scope(identifier.span().start.offset).resolve(NameKind::Function, &name);
                    resolved
                        .resolution
                        .candidates()
                        .find_map(|fqn| self.resolver.function_return(fqn))
                        .unwrap_or(Type::Mixed)
                }
                callee => {
                    let callable = self.expr(callee, frames);
                    self.invoke(&callable, frames)
                }
            },
            Call::Method(call) => match &call.method {
                ClassLikeMemberSelector::Identifier(name) => {
                    let receiver = self.expr(call.object, frames);
                    self.resolver.method_return(&receiver, &lossy(name.value), &context)
                }
                _ => Type::Mixed,
            },
            Call::NullSafeMethod(call) => match &call.method {
                ClassLikeMemberSelector::Identifier(name) => {
                    let receiver = self.expr(call.object, frames);
                    let ty = self.resolver.method_return(&receiver.without_null(), &lossy(name.value), &context);
                    if receiver.is_nullable() { ty.nullable() } else { ty }
                }
                _ => Type::Mixed,
            },
            Call::StaticMethod(call) => match &call.method {
                ClassLikeMemberSelector::Identifier(name) => {
                    let class = self.class_ref(call.class, frames);
                    self.resolver.method_return(&class, &lossy(name.value), &context)
                }
                _ => Type::Mixed,
            },
        }
    }

    /// What calling a value of type `callable` returns: a closure's or
    /// callable's declared return, an object's `__invoke()`.
    fn invoke(&self, callable: &Type, frames: &[Frame<'a>]) -> Type {
        let context = self.context(frames);
        let mut answers = Vec::new();
        for member in callable.members() {
            match member {
                Type::Closure(Some(signature)) | Type::Callable(Some(signature)) => {
                    answers.push(signature.return_type.clone().unwrap_or(Type::Mixed));
                }
                Type::Named { .. } | Type::Relative(_) => {
                    answers.push(self.resolver.method_return(member, "__invoke", &context));
                }
                Type::Null => {}
                _ => answers.push(Type::Mixed),
            }
        }
        if answers.is_empty() { Type::Mixed } else { Type::union(answers) }
    }

    /// `f(...)`, `$o->m(...)`, `Foo::m(...)`: a `Closure` with the callee's
    /// signature. Other partial applications are plain closures.
    fn partial(&self, partial: &'a PartialApplication<'a>, frames: &[Frame<'a>]) -> Type {
        let (arguments, signature) = match partial {
            PartialApplication::Function(partial) => {
                let signature = match partial.function {
                    Expression::Identifier(identifier) => {
                        let name = String::from_utf8_lossy(identifier.value());
                        let resolved = self.scope(identifier.span().start.offset).resolve(NameKind::Function, &name);
                        resolved.resolution.candidates().find_map(|fqn| self.function_signature(fqn))
                    }
                    callee => match self.expr(callee, frames) {
                        Type::Closure(signature) | Type::Callable(signature) => signature.map(|s| *s),
                        _ => None,
                    },
                };
                (&partial.argument_list, signature)
            }
            PartialApplication::Method(partial) => {
                let receiver = self.expr(partial.object, frames);
                (&partial.argument_list, self.method_signature(&receiver, &partial.method, frames))
            }
            PartialApplication::StaticMethod(partial) => {
                let class = self.class_ref(partial.class, frames);
                (&partial.argument_list, self.method_signature(&class, &partial.method, frames))
            }
        };
        if is_first_class_callable(arguments) { Type::Closure(signature.map(Box::new)) } else { Type::Closure(None) }
    }

    fn function_signature(&self, fqn: &str) -> Option<Signature> {
        let return_type = self.resolver.function_return(fqn)?;
        let function = self.resolver.declarations().function(fqn)?;
        let doc = function.doc.as_deref();
        let templates: Vec<&str> = doc.iter().flat_map(|doc| doc.local_type_names()).collect();
        Some(Signature { params: signature_params(&function.params, doc, &templates), return_type: Some(return_type) })
    }

    fn method_signature(
        &self,
        receiver: &Type,
        selector: &ClassLikeMemberSelector<'_>,
        frames: &[Frame<'a>],
    ) -> Option<Signature> {
        let ClassLikeMemberSelector::Identifier(name) = selector else { return None };
        let name = lossy(name.value);
        let context = self.context(frames);
        let return_type = self.resolver.method_return(receiver, &name, &context);
        let model = self.resolver.class_models(receiver, &context).into_iter().next()?;
        let method = model.method(&name)?;
        let params = match method.declared() {
            Some(declared) => {
                let doc = declared.doc.as_deref();
                let mut templates = class_templates(&method.declaring);
                templates.extend(doc.iter().flat_map(|doc| doc.local_type_names()));
                let params = signature_params(&declared.params, doc, &templates);
                let method_context = Context::in_class(&method.self_class);
                params
                    .into_iter()
                    .map(|param| SignatureParam {
                        ty: self.resolver.resolve(&LazyType::Known(param.ty.clone()), &method_context),
                        ..param
                    })
                    .collect()
            }
            None => Vec::new(),
        };
        Some(Signature { params, return_type: Some(return_type) })
    }

    // ------------------------------------------------------------- access

    fn access(&self, access: &'a Access<'a>, frames: &[Frame<'a>]) -> Type {
        let context = self.context(frames);
        match access {
            Access::Property(access) => match &access.property {
                ClassLikeMemberSelector::Identifier(name) => {
                    let receiver = self.expr(access.object, frames);
                    self.resolver.property_type(&receiver, &lossy(name.value), &context)
                }
                _ => Type::Mixed,
            },
            Access::NullSafeProperty(access) => match &access.property {
                ClassLikeMemberSelector::Identifier(name) => {
                    let receiver = self.expr(access.object, frames);
                    let ty = self.resolver.property_type(&receiver.without_null(), &lossy(name.value), &context);
                    if receiver.is_nullable() { ty.nullable() } else { ty }
                }
                _ => Type::Mixed,
            },
            Access::StaticProperty(access) => match &access.property {
                Variable::Direct(direct) => {
                    let class = self.class_ref(access.class, frames);
                    let name = direct.name.strip_prefix(b"$").unwrap_or(direct.name);
                    self.resolver.property_type(&class, &lossy(name), &context)
                }
                _ => Type::Mixed,
            },
            Access::ClassConstant(access) => {
                let ClassLikeConstantSelector::Identifier(name) = &access.constant else {
                    return Type::Mixed;
                };
                let class = self.class_ref(access.class, frames);
                if name.value.eq_ignore_ascii_case(b"class") {
                    return match class {
                        Type::Mixed => Type::ClassString(None),
                        class => Type::ClassString(Some(Box::new(class))),
                    };
                }
                self.resolver.class_constant_type(&class, &lossy(name.value), &context)
            }
        }
    }
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `frames` with one more scope inside.
fn with<'a>(frames: &[Frame<'a>], frame: Frame<'a>) -> Vec<Frame<'a>> {
    let mut out = frames.to_vec();
    out.push(frame);
    out
}

fn class_templates(class: &ClassLike) -> Vec<&str> {
    class.doc.iter().flat_map(|doc| doc.local_type_names()).collect()
}

/// The parameters of a declared function-like as a signature: `@param`
/// types first, then native hints.
fn signature_params(params: &[Param], doc: Option<&DocBlock>, templates: &[&str]) -> Vec<SignatureParam> {
    params
        .iter()
        .map(|param| SignatureParam {
            ty: match (doc.and_then(|doc| doc.param_type(&param.name)), &param.type_hint) {
                (Some(ty), _) => Type::from_doc(ty, templates),
                (None, Some(hint)) => Type::from_hint(hint),
                (None, None) => Type::Mixed,
            },
            name: Some(param.name.clone()),
            by_ref: param.by_ref,
            optional: param.default.is_some(),
            variadic: param.variadic,
        })
        .collect()
}

/// `(...)`: the only argument is the variadic placeholder.
fn is_first_class_callable(arguments: &PartialArgumentList<'_>) -> bool {
    let mut arguments = arguments.arguments.iter();
    matches!((arguments.next(), arguments.next()), (Some(PartialArgument::VariadicPlaceholder(_)), None))
}

/// The shape key a literal key type stands for (PHP casts numeric strings
/// such as `'1'` to ints, and bools to `0`/`1`).
fn shape_key(key: &Type) -> Option<ShapeKey> {
    match key {
        Type::LiteralInt(value) => Some(ShapeKey::Int(*value)),
        Type::LiteralString(value) => match value.parse::<i64>() {
            Ok(int) if int.to_string() == *value => Some(ShapeKey::Int(int)),
            _ => Some(ShapeKey::String(value.clone())),
        },
        Type::LiteralBool(value) => Some(ShapeKey::Int(i64::from(*value))),
        _ => None,
    }
}

/// The values of a spread (`...$x`) or of what `foreach` iterates.
fn iterable_value(ty: &Type) -> Type {
    Type::union(ty.members().iter().map(|member| match member {
        Type::Array { value, .. } | Type::List { value, .. } | Type::Iterable { value, .. } => (**value).clone(),
        Type::Shape(shape) => shape.value_type(),
        _ => Type::Mixed,
    }))
}

/// The truthy part of a type (for `a ?: b`): without `null` and `false`.
fn falsy_removed(ty: &Type) -> Type {
    match ty {
        Type::Bool => Type::LiteralBool(true),
        Type::Union(members) => Type::union(
            members
                .iter()
                .filter(|member| !matches!(member, Type::Null | Type::LiteralBool(false)))
                .map(|member| if *member == Type::Bool { Type::LiteralBool(true) } else { member.clone() }),
        ),
        Type::Null | Type::LiteralBool(false) => Type::Never,
        other => other.clone(),
    }
}

// ----------------------------------------------------------------- walkers

/// Finds the innermost expression around an offset, tracking scopes.
struct Finder<'a> {
    offset: u32,
    summary: &'a FileSummary,
    frames: Vec<Frame<'a>>,
    best: Option<(&'a Expression<'a>, Vec<Frame<'a>>)>,
}

impl Finder<'_> {
    fn class(&mut self, name_start: u32) {
        let fqn =
            self.summary.class_likes.iter().find(|class| class.name_loc.start == name_start).map(|c| c.fqn.clone());
        self.frames.push(Frame::Class(fqn));
    }
}

struct FindWalker;

impl<'a> Walker<'a, 'a, Finder<'a>> for FindWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Finder<'a>) {
        if matches!(
            expr,
            Expression::Identifier(_)
                | Expression::Self_(_)
                | Expression::Static(_)
                | Expression::Parent(_)
                | Expression::Error(_)
        ) {
            return;
        }
        let span = expr.span();
        if span.start.offset <= cx.offset && cx.offset <= span.end.offset {
            cx.best = Some((expr, cx.frames.clone()));
        }
    }

    fn walk_in_class(&self, node: &'a Class<'a>, cx: &mut Finder<'a>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_class(&self, _: &'a Class<'a>, cx: &mut Finder<'a>) {
        cx.frames.pop();
    }
    fn walk_in_interface(&self, node: &'a Interface<'a>, cx: &mut Finder<'a>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_interface(&self, _: &'a Interface<'a>, cx: &mut Finder<'a>) {
        cx.frames.pop();
    }
    fn walk_in_trait(&self, node: &'a Trait<'a>, cx: &mut Finder<'a>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_trait(&self, _: &'a Trait<'a>, cx: &mut Finder<'a>) {
        cx.frames.pop();
    }
    fn walk_in_enum(&self, node: &'a Enum<'a>, cx: &mut Finder<'a>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_enum(&self, _: &'a Enum<'a>, cx: &mut Finder<'a>) {
        cx.frames.pop();
    }
    fn walk_in_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Finder<'a>) {
        cx.frames.push(Frame::Class(None));
    }
    fn walk_out_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Finder<'a>) {
        cx.frames.pop();
    }
    fn walk_in_function(&self, node: &'a Function<'a>, cx: &mut Finder<'a>) {
        cx.frames.push(Frame::Function(node));
    }
    fn walk_out_function(&self, _: &'a Function<'a>, cx: &mut Finder<'a>) {
        cx.frames.pop();
    }
    fn walk_in_method(&self, node: &'a Method<'a>, cx: &mut Finder<'a>) {
        cx.frames.push(Frame::Method(node));
    }
    fn walk_out_method(&self, _: &'a Method<'a>, cx: &mut Finder<'a>) {
        cx.frames.pop();
    }
    fn walk_in_closure(&self, node: &'a Closure<'a>, cx: &mut Finder<'a>) {
        cx.frames.push(Frame::Closure(node));
    }
    fn walk_out_closure(&self, _: &'a Closure<'a>, cx: &mut Finder<'a>) {
        cx.frames.pop();
    }
    fn walk_in_arrow_function(&self, node: &'a ArrowFunction<'a>, cx: &mut Finder<'a>) {
        cx.frames.push(Frame::Arrow(node));
    }
    fn walk_out_arrow_function(&self, _: &'a ArrowFunction<'a>, cx: &mut Finder<'a>) {
        cx.frames.pop();
    }
}

/// Collects the plain assignments of one scope.
struct AssignWalker;

impl<'a> Walker<'a, 'a, Vec<Assign<'a>>> for AssignWalker {
    fn walk_in_assignment(&self, node: &'a Assignment<'a>, cx: &mut Vec<Assign<'a>>) {
        if let Expression::Variable(Variable::Direct(direct)) = node.lhs {
            cx.push(Assign {
                name: direct.name.strip_prefix(b"$").unwrap_or(direct.name),
                lhs_start: direct.span.start.offset,
                end: node.span().end.offset,
                node,
            });
        }
    }

    // Nested scopes have their own variables.
    fn walk_closure(&self, _: &'a Closure<'a>, _: &mut Vec<Assign<'a>>) {}
    fn walk_arrow_function(&self, _: &'a ArrowFunction<'a>, _: &mut Vec<Assign<'a>>) {}
    fn walk_anonymous_class(&self, _: &'a AnonymousClass<'a>, _: &mut Vec<Assign<'a>>) {}
    fn walk_function(&self, _: &'a Function<'a>, _: &mut Vec<Assign<'a>>) {}
    fn walk_class(&self, _: &'a Class<'a>, _: &mut Vec<Assign<'a>>) {}
    fn walk_interface(&self, _: &'a Interface<'a>, _: &mut Vec<Assign<'a>>) {}
    fn walk_trait(&self, _: &'a Trait<'a>, _: &mut Vec<Assign<'a>>) {}
    fn walk_enum(&self, _: &'a Enum<'a>, _: &mut Vec<Assign<'a>>) {}
}

/// The `return`s and `yield`s of one closure body.
#[derive(Default)]
struct Returns<'a> {
    values: Vec<&'a Expression<'a>>,
    bare: bool,
    generator: bool,
}

struct ReturnWalker;

impl<'a> Walker<'a, 'a, Returns<'a>> for ReturnWalker {
    fn walk_in_return(&self, node: &'a Return<'a>, cx: &mut Returns<'a>) {
        match node.value {
            Some(value) => cx.values.push(value),
            None => cx.bare = true,
        }
    }

    fn walk_in_yield(&self, _: &'a Yield<'a>, cx: &mut Returns<'a>) {
        cx.generator = true;
    }

    fn walk_closure(&self, _: &'a Closure<'a>, _: &mut Returns<'a>) {}
    fn walk_arrow_function(&self, _: &'a ArrowFunction<'a>, _: &mut Returns<'a>) {}
    fn walk_anonymous_class(&self, _: &'a AnonymousClass<'a>, _: &mut Returns<'a>) {}
    fn walk_function(&self, _: &'a Function<'a>, _: &mut Returns<'a>) {}
    fn walk_class(&self, _: &'a Class<'a>, _: &mut Returns<'a>) {}
    fn walk_interface(&self, _: &'a Interface<'a>, _: &mut Returns<'a>) {}
    fn walk_trait(&self, _: &'a Trait<'a>, _: &mut Returns<'a>) {}
    fn walk_enum(&self, _: &'a Enum<'a>, _: &mut Returns<'a>) {}
}

#[cfg(test)]
mod tests;
