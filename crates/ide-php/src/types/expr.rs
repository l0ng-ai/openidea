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
//!   callee's signature; calls go through the resolver's type providers
//!   (the core one answering with the above);
//! - property, static property, class constant and global constant access,
//!   `::class`, and array access on shapes, arrays, lists, strings and
//!   `ArrayAccess` objects (`offsetGet`);
//! - closures and arrow functions as `Closure(…): T` signatures, their
//!   types from their own docblock (`@template`s staying templates, bound
//!   when the closure is called or passed), the hint or the body;
//! - variables: `$this`, and everything else from the [`Flow`] of the
//!   enclosing function-like ([`flow`]): parameters (`@param` first, as the
//!   summaries do), closure `use` captures and the enclosing scope of arrow
//!   functions, assignments and destructuring, `foreach`, `catch`, `global`
//!   and `static` variables, merged over branches and loops and narrowed by
//!   conditions.
//!
//! Literals are kept while inferring (so `$a['key']` finds the shape field
//! and `-1` stays an int); [`type_at`] widens the answer (`'a'` is shown as
//! `string`), as PhpStorm shows types.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use mago_span::HasSpan;
use mago_syntax::cst::{
    Access, AnonymousClass, Argument, ArgumentList, ArrayElement, ArrowFunction, Assignment, Call, Class,
    ClassLikeConstantSelector, ClassLikeMember, ClassLikeMemberSelector, Closure, Construct, DirectVariable, Enum,
    Expression, Function, FunctionLikeParameterList, Hint, Interface, MagicConstant, MatchArm, Method,
    PartialApplication, PartialArgument, PartialArgumentList, Program, Property, PropertyItem, Return, Trait, Variable,
    Yield,
};
use mago_syntax::walker::Walker;

use super::ops::{Op, literal_type, op_type, unary_type};
use super::provider::{CallKind, CallSite, NO_NEXT, ParameterSite, site_args};
use super::resolve::{Bindings, CallArg, declared_params};
use super::{Context, LazyType, Relative, Resolver, Shape, ShapeField, ShapeKey, Signature, SignatureParam, Type};
use crate::names::{FileNames, NameKind, NameScope, Resolution};
use crate::summary::{ClassLike, DocBlock, DocType, FileSummary, FunctionDecl, Param, type_hint};
use crate::syntax::ParsedFile;

mod flow;

pub use flow::{Defined, Flow, PROBE_VARIABLE, VarState};

/// How deeply flows may be nested in their building (a closure's flow
/// needs the enclosing function's) before an empty flow is used.
const MAX_DEPTH: usize = 64;

/// Call chains longer than this aren't typed where only a hint is wanted
/// (whether a call statement returns `never`; the undefined-member
/// inspection): typing a chain goes through every link recursively, and
/// fluent builders (Symfony's configuration trees) chain hundreds of calls.
pub(crate) const MAX_CHAIN: usize = 32;

/// How many member accesses, calls and array accesses `expr` is made of.
pub(crate) fn chain_depth(mut expr: &Expression<'_>) -> usize {
    let mut depth = 0;
    loop {
        expr = match expr {
            Expression::Call(Call::Method(call)) => call.object,
            Expression::Call(Call::NullSafeMethod(call)) => call.object,
            Expression::Call(Call::StaticMethod(call)) => call.class,
            Expression::Access(Access::Property(access)) => access.object,
            Expression::Access(Access::NullSafeProperty(access)) => access.object,
            Expression::ArrayAccess(access) => access.array,
            Expression::Parenthesized(inner) => inner.expression,
            _ => return depth,
        };
        depth += 1;
    }
}

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

/// Infers expression types in one file.
pub struct ExprTypes<'a, 'r> {
    file: &'a ParsedFile,
    names: &'a FileNames,
    summary: &'a FileSummary,
    resolver: &'r Resolver<'r>,
    /// The flows built so far (or being built), by scope key: the start of
    /// the function-like, [`TOP_LEVEL`] for the file's top level.
    flows: RefCell<HashMap<u32, Rc<RefCell<Flow>>>>,
    /// Flows being built, nested.
    depth: Cell<usize>,
    /// By the start of a closure or arrow function passed as an argument:
    /// the parameter types of the callable the parameter it is passed to
    /// expects (recorded by the enclosing scope's flow).
    expected: RefCell<HashMap<u32, Vec<Type>>>,
    /// The file's path, when known ([`Self::at_path`]): for what Pest binds
    /// its test closures to.
    path: Option<std::path::PathBuf>,
    /// The starts of the file's Pest test closures, and the class they are
    /// bound to; computed on first use.
    pest: std::cell::OnceCell<(Vec<u32>, Option<String>)>,
}

const TOP_LEVEL: u32 = u32::MAX - 1;

impl<'a, 'r> ExprTypes<'a, 'r> {
    pub fn new(
        file: &'a ParsedFile,
        names: &'a FileNames,
        summary: &'a FileSummary,
        resolver: &'r Resolver<'r>,
    ) -> Self {
        Self {
            file,
            names,
            summary,
            resolver,
            flows: RefCell::new(HashMap::new()),
            depth: Cell::new(0),
            expected: RefCell::new(HashMap::new()),
            path: None,
            pest: std::cell::OnceCell::new(),
        }
    }

    /// The same, for the file at `path`: the closures of a Pest test file
    /// (`test('…', function () { $this->… })`) are bound to its test case.
    pub fn at_path(mut self, path: Option<&std::path::Path>) -> Self {
        self.path = path.map(std::path::Path::to_path_buf);
        self
    }

    /// The class `$this` is in the closures of `frames` when the outermost
    /// function-like is a Pest test closure (`test()`, `it()`,
    /// `beforeEach()`, `afterEach()`, `todo()`, and the closures of
    /// `describe()` blocks), outside any class.
    fn pest_class(&self, frames: &[Frame<'a>]) -> Option<&str> {
        let path = self.path.as_deref()?;
        let outer = frames.iter().find(|frame| frame.is_function_like())?;
        let start = match outer {
            Frame::Closure(closure) => closure.span().start.offset,
            Frame::Arrow(arrow) => arrow.span().start.offset,
            _ => return None,
        };
        if frames.iter().any(|frame| matches!(frame, Frame::Class(_))) {
            return None;
        }
        let (closures, class) = self.pest.get_or_init(|| {
            let mut closures = Vec::new();
            pest_closures(self.file.program().statements.iter(), &mut closures);
            let class = if closures.is_empty() { None } else { self.resolver.pest_test_case(path) };
            (closures, class)
        });
        closures.contains(&start).then_some(class.as_deref()?)
    }

    /// The flow of the scope `frames` end in: their innermost function-like,
    /// or the file's top level when there is none.
    pub fn flow(&self, frames: &[Frame<'a>]) -> Flow {
        self.flow_cell(flow::outer_scope(frames)).borrow().clone()
    }

    /// The flow of `scope` (frames ending with a function-like, or none),
    /// built on first use. A flow being built is returned as far as it got:
    /// a read is recorded before its type is asked for.
    fn flow_cell(&self, scope: &[Frame<'a>]) -> Rc<RefCell<Flow>> {
        let key = flow::scope_key(scope);
        if let Some(flow) = self.flows.borrow().get(&key) {
            return flow.clone();
        }
        let flow = Rc::new(RefCell::new(Flow::default()));
        if self.depth.get() >= MAX_DEPTH {
            return flow;
        }
        self.flows.borrow_mut().insert(key, flow.clone());
        self.depth.set(self.depth.get() + 1);
        flow::Builder::run(self, scope, flow.clone());
        self.depth.set(self.depth.get() - 1);
        flow
    }

    /// The file's resolved names.
    pub fn names(&self) -> &'a FileNames {
        self.names
    }

    /// The file's declarations.
    pub fn summary(&self) -> &'a FileSummary {
        self.summary
    }

    fn program(&self) -> &'a Program<'a> {
        self.file.program()
    }

    /// The innermost expression around `offset` and the scopes it is in.
    /// Bare names (`Foo` in `Foo::bar()`, `strlen` in `strlen($s)`) and
    /// `self`/`static`/`parent` are not expressions of their own here: the
    /// expression around them is.
    pub fn find(&self, offset: u32) -> Option<(&'a Expression<'a>, Vec<Frame<'a>>)> {
        self.locate(offset).expression
    }

    /// The innermost expression around `offset` (as [`ExprTypes::find`])
    /// and the innermost direct variable around it, anywhere it is written
    /// (expressions, parameters, closure `use` lists, `global` and `static`
    /// statements, property declarations), each with the scopes it is in.
    pub fn locate(&self, offset: u32) -> Located<'a> {
        let mut finder = Finder { offset, summary: self.summary, frames: Vec::new(), best: None, variable: None };
        FindWalker.walk_program(self.program(), &mut finder);
        Located { expression: finder.best, variable: finder.variable }
    }

    /// The type of variable `$name` (without `$`) written or read at byte
    /// `at` inside `frames`, as [`ExprTypes::type_of`] gives it.
    pub fn variable_type(&self, name: &[u8], at: u32, frames: &[Frame<'a>]) -> Type {
        let ty = self.lookup(name, at, frames, true);
        self.resolver.resolve(&LazyType::Known(ty), &self.context(frames))
    }

    /// What `self`, `parent` and `static` mean in `frames`.
    pub fn context(&self, frames: &[Frame<'a>]) -> Context {
        match frames.iter().rev().find_map(|frame| match frame {
            Frame::Class(fqn) => Some(fqn),
            _ => None,
        }) {
            Some(Some(fqn)) => Context::in_class(fqn),
            Some(None) => Context::default(),
            None => self.pest_class(frames).map_or_else(Context::default, Context::in_class),
        }
    }

    /// The named class-like of this file whose body `frames` are in (`None`
    /// outside one or in an anonymous class).
    fn frame_class(&self, frames: &[Frame<'a>]) -> Option<&'a ClassLike> {
        let fqn = frames.iter().rev().find_map(|frame| match frame {
            Frame::Class(fqn) => Some(fqn),
            _ => None,
        })?;
        let fqn = fqn.as_deref()?;
        self.summary.class_likes.iter().find(|class| class.fqn == fqn)
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

    /// The type of `expr`. It recurses once per level of the expression:
    /// each level runs through [`crate::syntax::stack::deep`].
    fn expr(&self, expr: &'a Expression<'a>, frames: &[Frame<'a>]) -> Type {
        crate::syntax::stack::deep(|| self.expr_level(expr, frames))
    }

    fn expr_level(&self, expr: &'a Expression<'a>, frames: &[Frame<'a>]) -> Type {
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
                Type::Named { fqn, args } if args.is_empty() => {
                    let args = || match &instantiation.argument_list {
                        Some(list) => self.call_args(list, frames),
                        None => Vec::new(),
                    };
                    self.resolver.instantiate(&fqn, &args)
                }
                ty @ (Type::Named { .. } | Type::Relative(_)) => ty,
                _ => Type::Object,
            },
            Expression::Call(call) => self.call(call, frames),
            Expression::PartialApplication(partial) => self.partial(partial, frames),
            Expression::Access(access) => self.access(access, frames),
            Expression::Pipe(pipe) => {
                let callable = self.expr(pipe.callable, frames);
                let args = || vec![CallArg { name: None, ty: self.expr(pipe.input, frames), spread: false }];
                self.invoke(&callable, &args, frames)
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
            return if frames.iter().any(|frame| matches!(frame, Frame::Class(_))) || self.pest_class(frames).is_some() {
                Type::Relative(Relative::This)
            } else {
                Type::Mixed
            };
        }
        // Superglobals exist everywhere, as arrays (writes into them don't
        // make them local).
        if matches!(
            name,
            b"GLOBALS" | b"_SERVER" | b"_GET" | b"_POST" | b"_FILES" | b"_COOKIE" | b"_SESSION" | b"_REQUEST" | b"_ENV"
        ) {
            return Type::array();
        }
        let scope = flow::outer_scope(frames);
        let flow = self.flow_cell(scope);
        let state = {
            let flow = flow.borrow();
            if here { flow.variable_at(at).cloned() } else { flow.read_at(at).cloned() }
        };
        match state {
            // An undefined variable reads as `null` (`$x ??= …`, `$x .= …`);
            // shown on its own, it is unknown.
            Some(VarState { defined: Defined::No, .. }) => {
                if here {
                    Type::Mixed
                } else {
                    Type::Null
                }
            }
            Some(state) => state.ty,
            // Somewhere the flow doesn't visit (a parameter's default value).
            None => self.parameter(scope, name).unwrap_or(Type::Mixed),
        }
    }

    /// Whether `ty` is an object of known classes that aren't `Traversable`
    /// (with every ancestor known, so none can be).
    fn is_plain_object(&self, ty: &Type, context: &Context) -> bool {
        let models = self.resolver.class_models(ty, context);
        !models.is_empty()
            && models.iter().all(|model| {
                !model.is_subclass_of("Traversable")
                    && model.method("current").is_none()
                    && model.method("getIterator").is_none()
                    && model.parents.iter().chain(&model.interfaces).all(|a| self.resolver.class_model(a).is_some())
            })
    }

    /// What `foreach` over a value of type `ty` gives as keys and values.
    pub(crate) fn iteration_types(&self, ty: &Type, frames: &[Frame<'a>]) -> (Type, Type) {
        let context = self.context(frames);
        let mut keys = Vec::new();
        let mut values = Vec::new();
        for member in ty.members() {
            let (key, value) = match member {
                Type::Array { key, value, .. } | Type::Iterable { key, value } => ((**key).clone(), (**value).clone()),
                Type::List { value, .. } => (Type::int_range(Some(0), None), (**value).clone()),
                Type::Shape(shape) => (shape.key_type(), shape.value_type()),
                // Not iterable (`foreach` warns and skips): `explode()`'s
                // `string[]|false` iterates over strings.
                Type::Null | Type::Void | Type::Never | Type::LiteralBool(_) | Type::Bool => continue,
                Type::Named { .. } if let Some(args) = self.resolver.iteration_args(member) => args,
                // A plain object iterates over its visible properties.
                Type::Named { .. } | Type::Relative(_) if self.is_plain_object(member, &context) => {
                    (Type::string(), Type::Mixed)
                }
                Type::Named { .. } | Type::Relative(_) | Type::Intersection(_) => {
                    // An `Iterator`, else an `IteratorAggregate`'s iterator.
                    let mut receiver = member.clone();
                    let mut found = (Type::Mixed, Type::Mixed);
                    for _ in 0..2 {
                        let has = |name: &str| {
                            self.resolver
                                .class_models(&receiver, &context)
                                .iter()
                                .any(|model| model.method(name).is_some())
                        };
                        if has("current") {
                            found = (
                                self.resolver.method_return(&receiver, "key", &context),
                                self.resolver.method_return(&receiver, "current", &context),
                            );
                            break;
                        }
                        if !has("getIterator") {
                            break;
                        }
                        receiver = self.resolver.method_return(&receiver, "getIterator", &context);
                    }
                    found
                }
                _ => (Type::Mixed, Type::Mixed),
            };
            keys.push(key);
            values.push(value);
        }
        if values.is_empty() {
            return (Type::Mixed, Type::Mixed);
        }
        (Type::union(keys), Type::union(values))
    }

    /// The type an assignment expression has (and gives its variable).
    fn assignment(&self, assignment: &'a Assignment<'a>, frames: &[Frame<'a>]) -> Type {
        // The result of a call to a `void` function is `null` once stored.
        // Only at the top: `Closure(): void` stays.
        let right = match self.expr(assignment.rhs, frames) {
            Type::Void => Type::Null,
            Type::Union(members) => {
                Type::union(members.into_iter().map(|ty| if ty == Type::Void { Type::Null } else { ty }))
            }
            ty => ty,
        };
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

    /// The declared type of parameter `$name` of the function-like ending
    /// `frames`.
    fn parameter(&self, frames: &[Frame<'a>], name: &[u8]) -> Option<Type> {
        let frame = frames.last()?;
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
                let ty = declared(&decl.params, doc, doc.iter().flat_map(|doc| doc.local_type_names()).collect())?;
                Some(self.resolver.finish(&ty, &Context::default()))
            }
            Frame::Method(method) => {
                let start = method.name.span.start.offset;
                let found = self
                    .summary
                    .class_likes
                    .iter()
                    .find_map(|class| Some((class, class.methods.iter().find(|m| m.name_loc.start == start)?)));
                // Methods of anonymous classes aren't in the summary: their
                // native hints.
                let Some((class, decl)) = found else { return self.ast_parameter(&method.parameter_list, &name) };
                let doc = decl.doc.as_deref();
                if doc.and_then(|doc| doc.param_type(&name)).is_none()
                    && let Some(param) = decl.params.iter().find(|param| param.name == name)
                    && let Some(inherited) = self.resolver.inherited_param(&class.fqn, &decl.name, &name)
                {
                    return Some(if param.variadic { Type::list_of(inherited) } else { inherited });
                }
                let mut templates: Vec<&str> = class_templates(class);
                templates.extend(doc.iter().flat_map(|doc| doc.local_type_names()));
                let ty = declared(&decl.params, doc, templates)?;
                let ty = self.resolver.expand_aliases(&ty, class);
                let ty = self.resolver.finish(&ty, &Context::in_class(&class.fqn));
                let index = decl.params.iter().position(|param| param.name == name)?;
                let site = ParameterSite { class: &class.fqn, method: decl, index, declared: &ty };
                Some(self.resolver.providers().parameter(&site, self.resolver).unwrap_or(ty))
            }
            Frame::Closure(closure) => self.function_parameter(&closure.parameter_list, frames, &name),
            Frame::Arrow(arrow) => self.function_parameter(&arrow.parameter_list, frames, &name),
            Frame::Class(_) => None,
        }
    }

    /// The docblock of the closure or arrow function starting at `start`
    /// inside `frames` (which don't include it), when it has `@template`,
    /// `@param` or `@return` tags: the one directly in front of it, else the
    /// one in front of the statement `$f = function …` or `return fn …`
    /// holding it (Psalm and PHPStan read both).
    fn closure_doc(&self, start: u32, frames: &[Frame<'a>]) -> Option<ClosureDoc<'a>> {
        let class = self.frame_class(frames);
        let outer: Vec<String> = class.iter().flat_map(|class| class_templates(class)).map(str::to_owned).collect();
        let scope = self.scope(start);
        let doc = crate::summary::doc_before(self.file, scope, start, &outer).or_else(|| {
            let at = statement_start(self.file.text(), start as usize)?;
            crate::summary::doc_before(self.file, scope, at as u32, &outer)
        })?;
        if doc.templates.is_empty() && doc.params.is_empty() && doc.return_type.is_none() {
            return None;
        }
        let mut names = outer;
        names.extend(doc.local_type_names().map(str::to_owned));
        Some(ClosureDoc { doc, names, class, context: self.context(frames) })
    }

    fn function_decl(&self, function: &Function<'_>) -> Option<&'a FunctionDecl> {
        let start = function.name.span.start.offset;
        self.summary.functions.iter().find(|decl| decl.name_loc.start == start)
    }

    /// A closure or arrow function parameter's type: its native type, else
    /// the type the callable it is passed to expects there (bidirectional
    /// inference, as PHPStan and Psalm do for closures passed as arguments).
    ///
    /// Its own docblock's `@param` comes first (with its `@template`s).
    fn function_parameter(
        &self,
        list: &FunctionLikeParameterList<'_>,
        frames: &[Frame<'a>],
        name: &str,
    ) -> Option<Type> {
        let (frame, outer) = frames.split_last()?;
        let key = frame.key();
        let declared = self.ast_parameter(list, name)?;
        let position = list.parameters.iter().position(|parameter| {
            parameter.variable.name.strip_prefix(b"$").unwrap_or(parameter.variable.name) == name.as_bytes()
        })?;
        let parameter = list.parameters.get(position)?;
        if let Some(doc) = self.closure_doc(key, outer)
            && let Some(ty) = doc.doc.param_type(name)
        {
            let ty = doc.ty(ty, self.resolver);
            return Some(if parameter.ellipsis.is_some() { Type::list_of(ty) } else { ty });
        }
        if parameter.hint.is_some() || parameter.ellipsis.is_some() {
            return Some(declared);
        }
        // The enclosing scope's flow records what the call expects.
        let expected = self.expected.borrow().get(&key).and_then(|types| types.get(position).cloned());
        Some(expected.filter(|ty| *ty != Type::Mixed).unwrap_or(declared))
    }

    /// A closure, arrow function or anonymous class method parameter's
    /// native type.
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

    /// A closure's type, `Closure(…): …`. A docblock's `@param` and
    /// `@return` types come before native hints and the inferred return; its
    /// `@template`s stay templates in the signature, bound when the closure
    /// is called or passed (`Resolver::infer_args`).
    fn closure(&self, closure: &'a Closure<'a>, frames: &[Frame<'a>]) -> Type {
        let inner = with(frames, Frame::Closure(closure));
        let start = closure.span().start.offset;
        let doc = self.closure_doc(start, frames);
        let documented = doc.as_ref().and_then(|doc| Some(doc.ty(doc.doc.return_type.as_ref()?, self.resolver)));
        let return_type = match (documented, &closure.return_type_hint) {
            (Some(ty), _) => ty,
            (None, Some(hint)) => Type::from_hint(&type_hint(self.scope(start), &hint.hint)),
            (None, None) => {
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
        Type::Closure(Some(Box::new(self.signature(&closure.parameter_list, start, doc.as_ref(), return_type))))
    }

    fn arrow(&self, arrow: &'a ArrowFunction<'a>, frames: &[Frame<'a>]) -> Type {
        let inner = with(frames, Frame::Arrow(arrow));
        let start = arrow.span().start.offset;
        let doc = self.closure_doc(start, frames);
        let documented = doc.as_ref().and_then(|doc| Some(doc.ty(doc.doc.return_type.as_ref()?, self.resolver)));
        let return_type = match (documented, &arrow.return_type_hint) {
            (Some(ty), _) => ty,
            (None, Some(hint)) => Type::from_hint(&type_hint(self.scope(start), &hint.hint)),
            (None, None) => self.expr(arrow.expression, &inner).widen(),
        };
        Type::Closure(Some(Box::new(self.signature(&arrow.parameter_list, start, doc.as_ref(), return_type))))
    }

    fn signature(
        &self,
        list: &FunctionLikeParameterList<'_>,
        at: u32,
        doc: Option<&ClosureDoc<'_>>,
        return_type: Type,
    ) -> Signature {
        let scope = self.scope(at);
        let params = list
            .parameters
            .iter()
            .map(|parameter| {
                let name = String::from_utf8_lossy(
                    parameter.variable.name.strip_prefix(b"$").unwrap_or(parameter.variable.name),
                )
                .into_owned();
                let documented = doc.and_then(|doc| Some(doc.ty(doc.doc.param_type(&name)?, self.resolver)));
                let ty = match (documented, &parameter.hint) {
                    (Some(ty), _) => ty,
                    (None, Some(hint)) => Type::from_hint(&type_hint(scope, hint)),
                    (None, None) => Type::Mixed,
                };
                SignatureParam {
                    ty,
                    name: Some(name),
                    by_ref: parameter.ampersand.is_some(),
                    optional: parameter.default_value.is_some(),
                    variadic: parameter.ellipsis.is_some(),
                }
            })
            .collect();
        Signature { params, return_type: Some(return_type) }
    }

    // -------------------------------------------------------------- calls

    /// The class named before `::` or after `new`.
    pub fn class_ref(&self, expr: &'a Expression<'a>, frames: &[Frame<'a>]) -> Type {
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
                    let args = || self.call_args(&call.argument_list, frames);
                    let core = || {
                        resolved
                            .resolution
                            .candidates()
                            .find_map(|fqn| self.resolver.function_call(fqn, &args))
                            .unwrap_or(Type::Mixed)
                    };
                    let Some(fqn) = resolved.resolution.candidates().next() else { return core() };
                    self.provided(CallKind::Function, fqn, None, &call.argument_list, &core, frames)
                }
                callee => {
                    let callable = self.expr(callee, frames);
                    let args = || self.call_args(&call.argument_list, frames);
                    self.invoke(&callable, &args, frames)
                }
            },
            Call::Method(call) => match &call.method {
                ClassLikeMemberSelector::Identifier(name) => {
                    let name = lossy(name.value);
                    if is_this(call.object)
                        && let Some(class) = self.anonymous_class(frames)
                    {
                        return self.anonymous_method_return(class, &name);
                    }
                    let receiver = self.expr(call.object, frames);
                    let args = || self.call_args(&call.argument_list, frames);
                    let core = || self.resolver.method_call(&receiver, &name, &args, &context);
                    self.provided(CallKind::Method, &name, Some(&receiver), &call.argument_list, &core, frames)
                }
                _ => Type::Mixed,
            },
            Call::NullSafeMethod(call) => match &call.method {
                ClassLikeMemberSelector::Identifier(name) => {
                    let receiver = self.expr(call.object, frames);
                    let object = receiver.without_null();
                    let name = lossy(name.value);
                    let args = || self.call_args(&call.argument_list, frames);
                    let core = || self.resolver.method_call(&object, &name, &args, &context);
                    let ty = self.provided(CallKind::Method, &name, Some(&object), &call.argument_list, &core, frames);
                    if receiver.is_nullable() { ty.nullable() } else { ty }
                }
                _ => Type::Mixed,
            },
            Call::StaticMethod(call) => match &call.method {
                ClassLikeMemberSelector::Identifier(name) => {
                    let class = self.class_ref(call.class, frames);
                    let name = lossy(name.value);
                    let args = || self.call_args(&call.argument_list, frames);
                    let core = || self.resolver.method_call(&class, &name, &args, &context);
                    self.provided(CallKind::StaticMethod, &name, Some(&class), &call.argument_list, &core, frames)
                }
                _ => Type::Mixed,
            },
        }
    }

    /// A call's type from the type providers, in order; `core` is what the
    /// resolver says on its own.
    fn provided(
        &self,
        kind: CallKind,
        name: &str,
        receiver: Option<&Type>,
        arguments: &'a ArgumentList<'a>,
        core: &dyn Fn() -> Type,
        frames: &[Frame<'a>],
    ) -> Type {
        let context = &self.context(frames);
        let receiver = receiver.map(|receiver| LazyType::Known(receiver.clone()));
        let args = site_args(self.scope(arguments.span().start.offset), arguments);
        let core = || LazyType::Known(core());
        let arg_types = || self.call_args(arguments, frames).into_iter().map(|arg| LazyType::Known(arg.ty)).collect();
        let site = CallSite {
            kind,
            name,
            receiver: receiver.as_ref(),
            args: &args,
            arg_types: &arg_types,
            stored: false,
            core: &core,
            next: NO_NEXT,
        };
        match self.resolver.providers().call(&site) {
            LazyType::Known(ty) => ty,
            lazy => self.resolver.resolve(&lazy, context),
        }
    }

    /// The arguments of a call, typed.
    fn call_args(&self, list: &'a ArgumentList<'a>, frames: &[Frame<'a>]) -> Vec<CallArg> {
        list.arguments
            .iter()
            .map(|argument| match argument {
                Argument::Positional(argument) => {
                    CallArg { name: None, ty: self.expr(argument.value, frames), spread: argument.ellipsis.is_some() }
                }
                Argument::Named(argument) => CallArg {
                    name: Some(lossy(argument.name.value)),
                    ty: self.expr(argument.value, frames),
                    spread: false,
                },
            })
            .collect()
    }

    /// What calling a value of type `callable` with `args` returns: a
    /// closure's or callable's declared return (the templates of a generic
    /// closure, `Closure(T $x): T`, inferred from the arguments), an
    /// object's `__invoke()`.
    fn invoke(&self, callable: &Type, args: &dyn Fn() -> Vec<CallArg>, frames: &[Frame<'a>]) -> Type {
        let context = self.context(frames);
        let mut answers = Vec::new();
        for member in callable.members() {
            match member {
                Type::Closure(Some(signature)) | Type::Callable(Some(signature)) => {
                    let ty = signature.return_type.clone().unwrap_or(Type::Mixed);
                    let names = super::resolve::signature_templates(signature);
                    if names.is_empty() {
                        answers.push(ty);
                        continue;
                    }
                    let mut bindings = Bindings::new();
                    self.resolver.infer_args(&signature.params, &args(), &names, &mut bindings);
                    answers.push(self.resolver.finish(&super::resolve::substitute(&ty, &bindings), &context));
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
        Some(Signature { params: declared_params(&function.params, doc, &templates), return_type: Some(return_type) })
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
        let params = self.resolver.method_params_on(receiver, &name, &context)?;
        Some(Signature { params, return_type: Some(return_type) })
    }

    /// The arguments of a call for inferring the callee's own templates; a
    /// closure or arrow function counts as nothing (`never`), since its
    /// parameters are what the templates then type.
    fn template_args(&self, list: &'a ArgumentList<'a>, frames: &[Frame<'a>]) -> Vec<CallArg> {
        list.arguments
            .iter()
            .map(|argument| {
                let (name, value, spread) = match argument {
                    Argument::Positional(argument) => (None, argument.value, argument.ellipsis.is_some()),
                    Argument::Named(argument) => (Some(lossy(argument.name.value)), argument.value, false),
                };
                let ty = if is_closure_value(value) { Type::Never } else { self.expr(value, frames) };
                CallArg { name, ty, spread }
            })
            .collect()
    }

    /// The own templates of method `selector` called on `receiver` with
    /// `list` (see [`Self::template_args`]).
    fn method_call_bindings(
        &self,
        receiver: &Type,
        selector: &ClassLikeMemberSelector<'_>,
        list: &'a ArgumentList<'a>,
        frames: &[Frame<'a>],
    ) -> Bindings {
        let ClassLikeMemberSelector::Identifier(name) = selector else { return Bindings::new() };
        let context = self.context(frames);
        let args = || self.template_args(list, frames);
        self.resolver.method_call_bindings(receiver, &lossy(name.value), &args, &context)
    }

    /// The anonymous class `$this` stands for inside `frames`: the innermost
    /// class frame is anonymous and a method of it is the next frame.
    /// Anonymous classes aren't in the summary, so their members are read
    /// from the syntax tree.
    fn anonymous_class(&self, frames: &[Frame<'a>]) -> Option<&'a AnonymousClass<'a>> {
        let at = frames.iter().rposition(|frame| matches!(frame, Frame::Class(_)))?;
        let (Frame::Class(None), Some(Frame::Method(method))) = (&frames[at], frames.get(at + 1)) else {
            return None;
        };
        let start = method.span().start.offset;
        let mut classes = Vec::new();
        AnonymousClasses.walk_program(self.program(), &mut classes);
        classes.into_iter().find(|class| {
            class
                .members
                .iter()
                .any(|member| matches!(member, ClassLikeMember::Method(own) if own.span().start.offset == start))
        })
    }

    /// The class anonymous `class` extends, resolved.
    fn anonymous_parent(&self, class: &AnonymousClass<'_>) -> Option<String> {
        let parent = class.extends.as_ref()?.types.first()?;
        let name = String::from_utf8_lossy(parent.value());
        let resolved = self.scope(parent.span().start.offset).resolve(NameKind::ClassLike, &name);
        resolved.resolution.candidates().next().map(str::to_owned)
    }

    /// The type of `$this->name` in anonymous `class`: its own property's
    /// native type (promoted constructor parameters included), else the
    /// parent's.
    fn anonymous_property(&self, class: &'a AnonymousClass<'a>, name: &str) -> Type {
        let variable = format!("${name}");
        let hinted = |hint: Option<&Hint<'_>>, at: u32| {
            hint.map_or(Type::Mixed, |hint| Type::from_hint(&type_hint(self.scope(at), hint)))
        };
        for member in class.members.iter() {
            match member {
                ClassLikeMember::Property(property) => {
                    let (hint, items): (Option<&Hint<'_>>, Vec<&PropertyItem<'_>>) = match property {
                        Property::Plain(plain) => (plain.hint.as_ref(), plain.items.iter().collect()),
                        Property::Hooked(hooked) => (hooked.hint.as_ref(), vec![&hooked.item]),
                    };
                    if items.iter().any(|item| item.variable().name == variable.as_bytes()) {
                        return hinted(hint, property.span().start.offset);
                    }
                }
                ClassLikeMember::Method(method) if method.name.value.eq_ignore_ascii_case(b"__construct") => {
                    let promoted = method.parameter_list.parameters.iter().find(|parameter| {
                        !parameter.modifiers.is_empty() && parameter.variable.name == variable.as_bytes()
                    });
                    if let Some(parameter) = promoted {
                        return hinted(parameter.hint.as_ref(), parameter.span().start.offset);
                    }
                }
                _ => {}
            }
        }
        match self.anonymous_parent(class) {
            Some(parent) => self.resolver.property_type(&Type::named(&parent), name, &Context::in_class(&parent)),
            None => Type::Mixed,
        }
    }

    /// What `$this->name()` returns in anonymous `class`: its own method's
    /// native return type, else the parent's.
    fn anonymous_method_return(&self, class: &'a AnonymousClass<'a>, name: &str) -> Type {
        let own = class.members.iter().find_map(|member| match member {
            ClassLikeMember::Method(method) if method.name.value.eq_ignore_ascii_case(name.as_bytes()) => Some(method),
            _ => None,
        });
        if let Some(method) = own {
            return method.return_type_hint.as_ref().map_or(Type::Mixed, |hint| {
                Type::from_hint(&type_hint(self.scope(hint.hint.span().start.offset), &hint.hint))
            });
        }
        match self.anonymous_parent(class) {
            Some(parent) => self.resolver.method_return(&Type::named(&parent), name, &Context::in_class(&parent)),
            None => Type::Mixed,
        }
    }

    /// The own templates of function `fqn` called with `list`.
    fn function_call_bindings(&self, fqn: &str, list: &'a ArgumentList<'a>, frames: &[Frame<'a>]) -> Bindings {
        let args = || self.template_args(list, frames);
        self.resolver.function_call_bindings(fqn, &args)
    }

    // ------------------------------------------------------------- access

    fn access(&self, access: &'a Access<'a>, frames: &[Frame<'a>]) -> Type {
        let context = self.context(frames);
        match access {
            Access::Property(access) => match &access.property {
                ClassLikeMemberSelector::Identifier(name) => {
                    if is_this(access.object)
                        && let Some(class) = self.anonymous_class(frames)
                    {
                        return self.anonymous_property(class, &lossy(name.value));
                    }
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

/// A closure's or arrow function's own docblock ([`ExprTypes::closure_doc`]).
struct ClosureDoc<'a> {
    doc: Box<DocBlock>,
    /// The names its types use as templates or aliases: its own and the
    /// enclosing class's.
    names: Vec<String>,
    /// The named class it is in, whose type aliases it sees.
    class: Option<&'a ClassLike>,
    context: Context,
}

impl ClosureDoc<'_> {
    /// A type written in the docblock.
    fn ty(&self, ty: &DocType, resolver: &Resolver<'_>) -> Type {
        let names: Vec<&str> = self.names.iter().map(String::as_str).collect();
        let mut ty = Type::from_doc(ty, &names);
        if let Some(class) = self.class {
            ty = resolver.expand_aliases(&ty, class);
        }
        resolver.finish(&ty, &self.context)
    }
}

/// Where the statement holding the closure starting at byte `start` of
/// `text` starts, when it is `$name = <closure>` or `return <closure>`.
fn statement_start(text: &str, start: usize) -> Option<usize> {
    let before = text.get(..start)?.trim_end();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_' || !c.is_ascii();
    if let Some(rest) = before.strip_suffix("return")
        && !rest.ends_with(is_word)
        && !rest.ends_with(['$', '>', ':'])
    {
        return Some(rest.len());
    }
    let rest = before.strip_suffix('=')?.trim_end();
    let name = rest.trim_end_matches(is_word);
    if name.len() == rest.len() || !name.ends_with('$') {
        return None;
    }
    Some(name.len() - 1)
}

/// `(...)`: the only argument is the variadic placeholder.
/// A closure or arrow function, maybe parenthesized.
/// `$this`, maybe parenthesized.
fn is_this(expr: &Expression<'_>) -> bool {
    match expr {
        Expression::Parenthesized(inner) => is_this(inner.expression),
        Expression::Variable(Variable::Direct(direct)) => direct.name == b"$this",
        _ => false,
    }
}

/// Collects a file's anonymous classes.
struct AnonymousClasses;

impl<'a> Walker<'a, 'a, Vec<&'a AnonymousClass<'a>>> for AnonymousClasses {
    fn walk_in_anonymous_class(&self, node: &'a AnonymousClass<'a>, found: &mut Vec<&'a AnonymousClass<'a>>) {
        found.push(node);
    }
}

fn is_closure_value(expr: &Expression<'_>) -> bool {
    match expr {
        Expression::Parenthesized(inner) => is_closure_value(inner.expression),
        Expression::Closure(_) | Expression::ArrowFunction(_) => true,
        _ => false,
    }
}

fn is_first_class_callable(arguments: &PartialArgumentList<'_>) -> bool {
    let mut arguments = arguments.arguments.iter();
    matches!((arguments.next(), arguments.next()), (Some(PartialArgument::VariadicPlaceholder(_)), None))
}

/// The shape key a literal key type stands for (PHP casts numeric strings
/// such as `'1'` to ints, and bools to `0`/`1`).
pub(crate) fn shape_key(key: &Type) -> Option<ShapeKey> {
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
pub(crate) fn iterable_value(ty: &Type) -> Type {
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

/// What [`ExprTypes::locate`] finds around an offset.
pub struct Located<'a> {
    pub expression: Option<(&'a Expression<'a>, Vec<Frame<'a>>)>,
    pub variable: Option<(&'a DirectVariable<'a>, Vec<Frame<'a>>)>,
}

/// Finds the innermost expression and variable around an offset, tracking
/// scopes.
struct Finder<'a> {
    offset: u32,
    summary: &'a FileSummary,
    frames: Vec<Frame<'a>>,
    best: Option<(&'a Expression<'a>, Vec<Frame<'a>>)>,
    variable: Option<(&'a DirectVariable<'a>, Vec<Frame<'a>>)>,
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

    fn walk_in_direct_variable(&self, variable: &'a DirectVariable<'a>, cx: &mut Finder<'a>) {
        if variable.span.start.offset <= cx.offset && cx.offset <= variable.span.end.offset {
            cx.variable = Some((variable, cx.frames.clone()));
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

/// Pest's functions taking a test closure bound to the test case.
const PEST_FUNCTIONS: &[&str] = &["test", "it", "todo", "beforeeach", "aftereach", "describe"];

/// The starts of the closures passed to Pest's functions in `statements`
/// (the file's top level, namespaces, and `describe()` closures), through
/// chained calls (`test(…)->with([…])`).
fn pest_closures<'s>(statements: impl Iterator<Item = &'s mago_syntax::cst::Statement<'s>>, out: &mut Vec<u32>) {
    use mago_syntax::cst::{Argument, Statement};
    for statement in statements {
        match statement {
            Statement::Expression(statement) => {
                let mut expr = statement.expression;
                while let Expression::Call(Call::Method(call)) = expr {
                    expr = call.object;
                }
                let Expression::Call(Call::Function(call)) = expr else { continue };
                let Expression::Identifier(function) = call.function else { continue };
                let name = String::from_utf8_lossy(function.value()).to_ascii_lowercase();
                let name = name.rsplit('\\').next().unwrap_or_default();
                if !PEST_FUNCTIONS.contains(&name) {
                    continue;
                }
                for argument in call.argument_list.arguments.iter() {
                    let value = match argument {
                        Argument::Positional(argument) => argument.value,
                        Argument::Named(argument) => argument.value,
                    };
                    match value {
                        Expression::Closure(closure) => {
                            out.push(closure.span().start.offset);
                            if name == "describe" {
                                pest_closures(closure.body.statements.iter(), out);
                            }
                        }
                        Expression::ArrowFunction(arrow) => out.push(arrow.span().start.offset),
                        _ => {}
                    }
                }
            }
            Statement::Namespace(namespace) => pest_closures(namespace.statements().iter(), out),
            _ => {}
        }
    }
}
