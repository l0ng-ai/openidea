//! Local variables: undefined, possibly undefined and unused ones, from the
//! [flow](crate::types::Flow) of each function-like.
//!
//! - [`UndefinedVariable`] (`PhpUndefinedVariable`): a variable read where
//!   no path defines it ("Undefined variable '$x'", a warning), or only
//!   some do ("Variable '$x' might not have been defined", a weak
//!   warning). Reads that tolerate a missing variable aren't reads here:
//!   `isset`, `empty`, the left side of `??` and `??=`, `@`. Neither are
//!   by-reference bindings (`&$x`, `use (&$x)`, an argument for a
//!   by-reference parameter, which creates the variable) and arguments of
//!   calls whose signature isn't known (they may be by reference).
//! - [`UnusedVariable`] (`PhpUnusedLocalVariable`): a variable assigned
//!   (`=`, compound assignments, `++`/`--`, destructuring) that the
//!   function never reads; shown faded. Parameters (phase 4.6), `foreach`
//!   and `catch` variables aren't reported, nor variables bound by
//!   reference (`=&`, `&$x`, `use (&$x)`), declared `global` or `static`
//!   (their value outlives the call), read by a nested arrow function or a
//!   closure's `use`, or named in `compact('x')`.
//! - Unused parameters ([`super::unused::UnusedParameter`],
//!   `PhpUnusedParameter`) come from the same walk: a parameter of a
//!   function or concrete method that its body never reads. Not reported:
//!   closures and arrow functions (their signature is the caller's),
//!   by-reference, promoted and `$_` parameters, magic methods other than
//!   the constructor, methods with attributes, methods of traits,
//!   interfaces and anonymous classes, and methods whose signature is a
//!   contract: declared by a parent, interface or trait (or in a class
//!   whose ancestors aren't all known), or overridden in a subtype. Bodies
//!   calling `func_get_args`/`func_get_arg` are skipped too.
//!
//! Both are off for a function whose variables may appear where the flow
//! can't see: `$$name`, `${expr}`, `extract`, `get_defined_vars`,
//! `parse_str`, `eval`, `include`/`require`, and `compact` with a name that
//! isn't a literal (unused only). Superglobals, `$this`,
//! `$http_response_header` and `$php_errormsg` are always fine. The file's
//! top level isn't checked (other files include it and share its
//! variables), nor are arrow functions there. Closures see their `use`
//! variables as defined (the `use` clause is where a missing one is
//! reported). Nothing is reported in dumb mode, where `never`-returning
//! functions and by-reference parameters of other files aren't known yet,
//! or in `.phpstorm.meta.php` files.
//!
//! Quick-fixes ([`super::fixes`]): "Initialize variable" for undefined and
//! possibly undefined variables, "Remove unused variable" for unused ones.
//!
//! The ids follow PhpStorm's documented inspections ("Undefined variable",
//! "Unused local variable"); the rules are our own.

use std::collections::HashSet;

use ide_core::Severity;
use mago_span::HasSpan;
use mago_syntax::cst::{
    AnonymousClass, Argument, ArrayElement, ArrowFunction, Assignment, AssignmentOperator, BinaryOperator, Call, Class,
    Closure, Construct, DirectVariable, Enum, Expression, Function, FunctionLikeParameterList, Interface, Literal,
    Method, MethodBody, Statement, StaticItem, Trait, UnaryPostfix, UnaryPrefix, UnaryPrefixOperator, Variable,
};
use mago_syntax::walker::Walker;

use super::{Inspection, InspectionContext, Problems, fixes};
use crate::engine::{EngineState, is_meta_path};
use crate::navigate::hierarchy::Subtypes;
use crate::summary::{ClassKind, Visibility};
use crate::types::{Defined, ExprTypes, Flow, Frame};

/// `PhpUndefinedVariable`.
pub struct UndefinedVariable;

/// `PhpUnusedLocalVariable`.
pub struct UnusedVariable;

impl Inspection for UndefinedVariable {
    fn id(&self) -> &'static str {
        "PhpUndefinedVariable"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        let mut bodies = None;
        for found in cx.variables().iter() {
            let problem = match found.kind {
                Kind::Unused | Kind::UnusedParameter => continue,
                Kind::Undefined => out.report(found.start, found.end, format!("Undefined variable '${}'", found.name)),
                Kind::MaybeUndefined => out
                    .report(found.start, found.end, format!("Variable '${}' might not have been defined", found.name))
                    .with_severity(Severity::Info),
            };
            let bodies = bodies.get_or_insert_with(|| fixes::bodies(cx.parsed));
            if let Some(fix) = fixes::initialize_variable(cx, bodies, &found.name, found.start) {
                problem.with_fix(fix);
            }
        }
    }
}

impl Inspection for UnusedVariable {
    fn id(&self) -> &'static str {
        "PhpUnusedLocalVariable"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        for found in cx.variables().iter().filter(|found| found.kind == Kind::Unused) {
            let problem =
                out.report(found.start, found.end, format!("Unused local variable '${}'", found.name)).unnecessary();
            if let Some(fix) = fixes::remove_unused_variable(cx, &found.name, found.start) {
                problem.with_fix(fix);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Undefined,
    MaybeUndefined,
    Unused,
    UnusedParameter,
}

/// A variable problem found in a file.
#[derive(Clone, Debug)]
pub(crate) struct Found {
    pub(crate) kind: Kind,
    /// Without `$`.
    pub(crate) name: String,
    pub(crate) start: u32,
    pub(crate) end: u32,
}

/// Variables that always exist.
const ALWAYS_DEFINED: &[&[u8]] = &[
    b"this",
    b"GLOBALS",
    b"_SERVER",
    b"_GET",
    b"_POST",
    b"_FILES",
    b"_COOKIE",
    b"_SESSION",
    b"_REQUEST",
    b"_ENV",
    b"http_response_header",
    b"php_errormsg",
];

/// Every variable problem of the file (computed once for both
/// inspections), in source order.
pub(crate) fn find(cx: &InspectionContext<'_>) -> Vec<Found> {
    if cx.engine.status().state != EngineState::Ready || is_meta_path(cx.path) || !cx.text().contains('$') {
        return Vec::new();
    }
    let resolver = cx.resolver();
    let types = ExprTypes::new(cx.parsed, cx.names(), cx.summary(), &resolver);
    let mut scan = Scan {
        cx,
        types: &types,
        summary: cx.summary(),
        frames: Vec::new(),
        scopes: Vec::new(),
        quiet: Vec::new(),
        found: Vec::new(),
        subtypes: None,
    };
    ScanWalker.walk_program(cx.parsed.program(), &mut scan);
    if cx.is_cancelled() {
        return Vec::new();
    }
    let mut found = scan.found;
    found.sort_by_key(|found| (found.start, found.end));
    found.dedup_by_key(|found| (found.start, found.kind as u8));
    found
}

/// One function-like being walked.
struct Scope {
    flow: Flow,
    /// An arrow function: its reads also read the enclosing scope.
    arrow: bool,
    /// Nothing is checked (an arrow function at the file's top level).
    off: bool,
    /// `compact()` with a name that isn't a literal.
    opaque: bool,
    params: HashSet<Vec<u8>>,
    /// The parameters checked for use (none when the signature is a
    /// contract or the scope a closure).
    checked_params: Vec<Param>,
    /// Names read somewhere in the scope.
    reads: HashSet<Vec<u8>>,
    /// Names bound by reference, `global` or `static`.
    bound: HashSet<Vec<u8>>,
    /// Assignment targets: name, start, end.
    targets: Vec<(Vec<u8>, u32, u32)>,
}

struct Scan<'a, 'r> {
    cx: &'r InspectionContext<'a>,
    types: &'r ExprTypes<'a, 'r>,
    summary: &'a crate::summary::FileSummary,
    frames: Vec<Frame<'a>>,
    /// The function-likes around the walk, innermost last (empty at the
    /// top level).
    scopes: Vec<Scope>,
    /// Byte ranges where a missing variable is fine (`isset`, `??`, `@`).
    quiet: Vec<(u32, u32)>,
    found: Vec<Found>,
    /// The subtype finder, made for the first method checked.
    subtypes: Option<Subtypes>,
}

/// A parameter whose use is checked.
struct Param {
    name: Vec<u8>,
    start: u32,
    end: u32,
}

/// Functions that read the parameters without naming them.
const READS_ARGUMENTS: &[&str] = &["func_get_args", "func_get_arg"];

fn name_of<'a>(variable: &DirectVariable<'a>) -> &'a [u8] {
    variable.name.strip_prefix(b"$").unwrap_or(variable.name)
}

fn always_defined(name: &[u8]) -> bool {
    ALWAYS_DEFINED.contains(&name)
}

impl<'a> Scan<'a, '_> {
    fn enter(&mut self, frame: Frame<'a>, parameters: Option<&'a FunctionLikeParameterList<'a>>, check_params: bool) {
        let arrow = matches!(frame, Frame::Arrow(_));
        self.frames.push(frame);
        // An arrow function at the top level sees the top level's variables,
        // which other files may provide.
        let off = arrow && self.scopes.last().is_none_or(|scope| scope.off);
        let flow = if self.cx.is_cancelled() { Flow::default() } else { self.types.flow(&self.frames) };
        let params = parameters
            .map(|list| list.parameters.iter().map(|p| name_of(&p.variable).to_vec()).collect())
            .unwrap_or_default();
        let checked_params = match parameters {
            Some(list) if check_params => list
                .parameters
                .iter()
                .filter(|p| p.ampersand.is_none() && p.modifiers.is_empty() && p.hooks.is_none())
                .map(|p| Param {
                    name: name_of(&p.variable).to_vec(),
                    start: p.variable.span.start.offset,
                    end: p.variable.span.end.offset,
                })
                .filter(|p| p.name != b"_")
                .collect(),
            _ => Vec::new(),
        };
        self.scopes.push(Scope {
            flow,
            arrow,
            off,
            opaque: false,
            params,
            checked_params,
            reads: HashSet::new(),
            bound: HashSet::new(),
            targets: Vec::new(),
        });
    }

    fn leave(&mut self) {
        self.frames.pop();
        let Some(scope) = self.scopes.pop() else { return };
        if scope.arrow {
            // What an arrow function reads, its enclosing scope reads.
            if let Some(outer) = self.scopes.last_mut() {
                outer.reads.extend(scope.reads.into_iter().filter(|name| !scope.params.contains(name)));
            }
            return;
        }
        if scope.off || scope.opaque || scope.flow.is_dynamic() || self.cx.is_cancelled() {
            return;
        }
        for param in &scope.checked_params {
            if scope.reads.contains(&param.name) || scope.bound.contains(&param.name) {
                continue;
            }
            self.found.push(Found {
                kind: Kind::UnusedParameter,
                name: String::from_utf8_lossy(&param.name).into_owned(),
                start: param.start,
                end: param.end,
            });
        }
        for (name, start, end) in scope.targets {
            if scope.reads.contains(&name)
                || scope.bound.contains(&name)
                || scope.params.contains(&name)
                || always_defined(&name)
                || name == b"_"
            {
                continue;
            }
            self.found.push(Found {
                kind: Kind::Unused,
                name: String::from_utf8_lossy(&name).into_owned(),
                start,
                end,
            });
        }
    }

    fn class(&mut self, name_start: u32) {
        let fqn =
            self.summary.class_likes.iter().find(|class| class.name_loc.start == name_start).map(|c| c.fqn.clone());
        self.frames.push(Frame::Class(fqn));
    }

    fn is_quiet(&self, offset: u32) -> bool {
        self.quiet.iter().any(|&(start, end)| start <= offset && offset < end)
    }

    fn quiet(&mut self, expr: &Expression<'_>) {
        let span = expr.span();
        self.quiet.push((span.start.offset, span.end.offset));
    }

    /// A variable occurrence inside the current scope.
    fn variable(&mut self, variable: &'a DirectVariable<'a>) {
        let offset = variable.span.start.offset;
        let quiet = self.is_quiet(offset);
        let Some(scope) = self.scopes.last_mut() else { return };
        let name = name_of(variable);
        let read = scope.flow.read_at(offset).cloned();
        let written = scope.flow.written_at(offset).is_some();
        let Some(state) = read else { return };
        if !written {
            scope.reads.insert(name.to_vec());
        }
        if scope.off
            || quiet
            || scope.flow.is_dynamic()
            || scope.flow.is_binding(offset)
            || always_defined(name)
            || state.defined == Defined::Yes
        {
            return;
        }
        let kind = if state.defined == Defined::No { Kind::Undefined } else { Kind::MaybeUndefined };
        self.found.push(Found {
            kind,
            name: String::from_utf8_lossy(name).into_owned(),
            start: offset,
            end: variable.span.end.offset,
        });
    }

    fn expression(&mut self, expr: &'a Expression<'a>) {
        match expr {
            Expression::Construct(Construct::Isset(_) | Construct::Empty(_)) => self.quiet(expr),
            Expression::Binary(binary) if matches!(binary.operator, BinaryOperator::NullCoalesce(_)) => {
                self.quiet(binary.lhs)
            }
            Expression::UnaryPrefix(unary) => match &unary.operator {
                UnaryPrefixOperator::ErrorControl(_) => self.quiet(unary.operand),
                UnaryPrefixOperator::Reference(_) => self.bind(unary.operand),
                UnaryPrefixOperator::PreIncrement(_) | UnaryPrefixOperator::PreDecrement(_) => {
                    self.target(unary.operand)
                }
                _ => {}
            },
            Expression::UnaryPostfix(UnaryPostfix { operand, .. }) => self.target(operand),
            Expression::Assignment(assignment) => self.assignment(assignment),
            Expression::Call(Call::Function(call)) => {
                let Expression::Identifier(identifier) = call.function else { return };
                let name = String::from_utf8_lossy(identifier.value());
                let bare = name.trim_start_matches('\\');
                if READS_ARGUMENTS.iter().any(|f| bare.eq_ignore_ascii_case(f))
                    && let Some(scope) = self.scopes.last_mut()
                {
                    scope.checked_params.clear();
                }
                if bare.eq_ignore_ascii_case("compact") {
                    for argument in call.argument_list.arguments.iter() {
                        self.compact(argument_value(argument));
                    }
                }
            }
            _ => {}
        }
    }

    fn assignment(&mut self, assignment: &'a Assignment<'a>) {
        if matches!(assignment.operator, AssignmentOperator::Coalesce(_)) {
            self.quiet(assignment.lhs);
        }
        let by_reference = matches!(
            assignment.rhs,
            Expression::UnaryPrefix(UnaryPrefix { operator: UnaryPrefixOperator::Reference(_), .. })
        );
        if by_reference {
            self.bind(assignment.lhs);
        } else {
            self.target(assignment.lhs);
        }
    }

    /// Records the variables an assignment writes as targets.
    fn target(&mut self, target: &'a Expression<'a>) {
        match target {
            Expression::Parenthesized(inner) => self.target(inner.expression),
            Expression::Variable(Variable::Direct(variable)) => {
                let Some(scope) = self.scopes.last_mut() else { return };
                let span = variable.span;
                scope.targets.push((name_of(variable).to_vec(), span.start.offset, span.end.offset));
            }
            Expression::Array(array) => array.elements.iter().for_each(|element| self.element(element)),
            Expression::LegacyArray(array) => array.elements.iter().for_each(|element| self.element(element)),
            Expression::List(list) => list.elements.iter().for_each(|element| self.element(element)),
            _ => {}
        }
    }

    fn element(&mut self, element: &'a ArrayElement<'a>) {
        match element {
            ArrayElement::KeyValue(element) => self.target(element.value),
            ArrayElement::Value(element) => self.target(element.value),
            _ => {}
        }
    }

    /// The variable `expr` is (or destructures into) is bound by reference.
    fn bind(&mut self, expr: &'a Expression<'a>) {
        match expr {
            Expression::Parenthesized(inner) => self.bind(inner.expression),
            Expression::Variable(Variable::Direct(variable)) => self.bound(variable),
            Expression::Array(array) => array.elements.iter().for_each(|element| self.bind_element(element)),
            Expression::LegacyArray(array) => array.elements.iter().for_each(|element| self.bind_element(element)),
            Expression::List(list) => list.elements.iter().for_each(|element| self.bind_element(element)),
            _ => {}
        }
    }

    fn bind_element(&mut self, element: &'a ArrayElement<'a>) {
        match element {
            ArrayElement::KeyValue(element) => self.bind(element.value),
            ArrayElement::Value(element) => self.bind(element.value),
            _ => {}
        }
    }

    fn bound(&mut self, variable: &DirectVariable<'_>) {
        if let Some(scope) = self.scopes.last_mut() {
            scope.bound.insert(name_of(variable).to_vec());
        }
    }

    /// An argument of `compact()`: the names it reads.
    fn compact(&mut self, value: &'a Expression<'a>) {
        match value {
            Expression::Literal(Literal::String(string)) => {
                let name = string.value.map(<[u8]>::to_vec);
                if let Some(scope) = self.scopes.last_mut() {
                    match name {
                        Some(name) => {
                            scope.reads.insert(name);
                        }
                        None => scope.opaque = true,
                    }
                }
            }
            Expression::Array(array) => array.elements.iter().for_each(|element| self.compact_element(element)),
            Expression::LegacyArray(array) => array.elements.iter().for_each(|element| self.compact_element(element)),
            _ => {
                if let Some(scope) = self.scopes.last_mut() {
                    scope.opaque = true;
                }
            }
        }
    }

    fn compact_element(&mut self, element: &'a ArrayElement<'a>) {
        match element {
            ArrayElement::Value(element) => self.compact(element.value),
            ArrayElement::KeyValue(element) => self.compact(element.value),
            _ => {
                if let Some(scope) = self.scopes.last_mut() {
                    scope.opaque = true;
                }
            }
        }
    }

    fn statement(&mut self, statement: &'a Statement<'a>) {
        match statement {
            Statement::Global(global) => {
                for variable in global.variables.iter() {
                    if let Variable::Direct(direct) = variable {
                        self.bound(direct);
                    }
                }
            }
            Statement::Static(statement) => {
                for item in statement.items.iter() {
                    match item {
                        StaticItem::Concrete(item) => self.bound(&item.variable),
                        StaticItem::Abstract(item) => self.bound(&item.variable),
                    }
                }
            }
            _ => {}
        }
    }

    /// A closure's `use` clause belongs to the enclosing scope: it reads
    /// the captured variables there (and binds those taken by reference).
    fn closure(&mut self, closure: &'a Closure<'a>) {
        let variables: Vec<_> = closure.use_clause.iter().flat_map(|clause| clause.variables.iter()).collect();
        for variable in &variables {
            self.variable(&variable.variable);
            if variable.ampersand.is_some() {
                self.bound(&variable.variable);
            }
        }
        self.enter(Frame::Closure(closure), Some(&closure.parameter_list), false);
        for variable in &variables {
            if variable.ampersand.is_some() {
                self.bound(&variable.variable);
            }
        }
    }
}

impl Scan<'_, '_> {
    /// Whether the parameters of `method` (concrete, in the class being
    /// walked) are checked for use: its signature isn't a contract.
    fn method_params_checked(&mut self, method: &Method<'_>) -> bool {
        let name = String::from_utf8_lossy(method.name.value).into_owned();
        let constructor = name.eq_ignore_ascii_case("__construct");
        if (name.starts_with("__") && !constructor) || !method.attribute_lists.is_empty() {
            return false;
        }
        let Some(Frame::Class(Some(fqn))) = self.frames.last() else { return false };
        let fqn = fqn.clone();
        let Some(class) = self.summary.class_likes.iter().find(|c| c.fqn == fqn) else { return false };
        if !matches!(class.kind, ClassKind::Class | ClassKind::Enum) {
            return false;
        }
        let resolver = self.cx.resolver();
        // Every ancestor must be known, and none may declare the method.
        let direct =
            class.extends.iter().chain(&class.implements).chain(class.trait_uses.iter().flat_map(|u| &u.traits));
        for parent in direct {
            match resolver.class_model(parent) {
                Some(model) if model.method(&name).is_none() => {}
                _ => return false,
            }
        }
        // Overridden below: the subtypes' versions follow this signature.
        let declared = class.methods.iter().find(|m| m.name_loc.start == method.name.span.start.offset);
        let is_private = declared.is_some_and(|m| m.visibility == Visibility::Private);
        let is_final =
            declared.is_some_and(|m| m.is_final) || class.modifiers.is_final || class.kind == ClassKind::Enum;
        if is_private || is_final || constructor {
            return true;
        }
        let engine = self.cx.engine;
        let subtypes = self.subtypes.get_or_insert_with(|| Subtypes::new(engine));
        match subtypes.all(engine, &fqn, self.cx.cancel) {
            Ok(found) => !found.iter().any(|s| s.class.methods.iter().any(|m| m.name.eq_ignore_ascii_case(&name))),
            Err(_) => false,
        }
    }
}

fn argument_value<'a>(argument: &'a Argument<'a>) -> &'a Expression<'a> {
    match argument {
        Argument::Positional(argument) => argument.value,
        Argument::Named(argument) => argument.value,
    }
}

struct ScanWalker;

impl<'a, 'r> Walker<'a, 'a, Scan<'a, 'r>> for ScanWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Scan<'a, 'r>) {
        cx.expression(expr);
    }

    fn walk_in_statement(&self, statement: &'a Statement<'a>, cx: &mut Scan<'a, 'r>) {
        cx.statement(statement);
    }

    fn walk_in_direct_variable(&self, variable: &'a DirectVariable<'a>, cx: &mut Scan<'a, 'r>) {
        cx.variable(variable);
    }

    fn walk_in_class(&self, node: &'a Class<'a>, cx: &mut Scan<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_class(&self, _: &'a Class<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_interface(&self, node: &'a Interface<'a>, cx: &mut Scan<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_interface(&self, _: &'a Interface<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_trait(&self, node: &'a Trait<'a>, cx: &mut Scan<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_trait(&self, _: &'a Trait<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_enum(&self, node: &'a Enum<'a>, cx: &mut Scan<'a, 'r>) {
        cx.class(node.name.span.start.offset);
    }
    fn walk_out_enum(&self, _: &'a Enum<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.push(Frame::Class(None));
    }
    fn walk_out_anonymous_class(&self, _: &'a AnonymousClass<'a>, cx: &mut Scan<'a, 'r>) {
        cx.frames.pop();
    }
    fn walk_in_function(&self, node: &'a Function<'a>, cx: &mut Scan<'a, 'r>) {
        cx.enter(Frame::Function(node), Some(&node.parameter_list), true);
    }
    fn walk_out_function(&self, _: &'a Function<'a>, cx: &mut Scan<'a, 'r>) {
        cx.leave();
    }
    fn walk_in_method(&self, node: &'a Method<'a>, cx: &mut Scan<'a, 'r>) {
        let parameters = matches!(node.body, MethodBody::Concrete(_)).then_some(&node.parameter_list);
        let check = parameters.is_some() && cx.method_params_checked(node);
        cx.enter(Frame::Method(node), parameters, check);
    }
    fn walk_out_method(&self, _: &'a Method<'a>, cx: &mut Scan<'a, 'r>) {
        cx.leave();
    }
    fn walk_in_closure(&self, node: &'a Closure<'a>, cx: &mut Scan<'a, 'r>) {
        cx.closure(node);
    }
    fn walk_out_closure(&self, _: &'a Closure<'a>, cx: &mut Scan<'a, 'r>) {
        cx.leave();
    }
    fn walk_in_arrow_function(&self, node: &'a ArrowFunction<'a>, cx: &mut Scan<'a, 'r>) {
        cx.enter(Frame::Arrow(node), Some(&node.parameter_list), false);
    }
    fn walk_out_arrow_function(&self, _: &'a ArrowFunction<'a>, cx: &mut Scan<'a, 'r>) {
        cx.leave();
    }
}
