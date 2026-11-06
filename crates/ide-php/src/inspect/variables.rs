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

use super::{Inspection, InspectionContext, Problems};
use crate::engine::{EngineState, is_meta_path};
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
        for found in cx.variables().iter() {
            match found.kind {
                Kind::Undefined => {
                    out.report(found.start, found.end, format!("Undefined variable '${}'", found.name));
                }
                Kind::MaybeUndefined => {
                    out.report(
                        found.start,
                        found.end,
                        format!("Variable '${}' might not have been defined", found.name),
                    )
                    .with_severity(Severity::Info);
                }
                Kind::Unused => {}
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
            out.report(found.start, found.end, format!("Unused local variable '${}'", found.name)).unnecessary();
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Undefined,
    MaybeUndefined,
    Unused,
}

/// A variable problem found in a file.
#[derive(Clone, Debug)]
pub(crate) struct Found {
    kind: Kind,
    /// Without `$`.
    name: String,
    start: u32,
    end: u32,
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
}

fn name_of<'a>(variable: &DirectVariable<'a>) -> &'a [u8] {
    variable.name.strip_prefix(b"$").unwrap_or(variable.name)
}

fn always_defined(name: &[u8]) -> bool {
    ALWAYS_DEFINED.contains(&name)
}

impl<'a> Scan<'a, '_> {
    fn enter(&mut self, frame: Frame<'a>, parameters: Option<&'a FunctionLikeParameterList<'a>>) {
        let arrow = matches!(frame, Frame::Arrow(_));
        self.frames.push(frame);
        // An arrow function at the top level sees the top level's variables,
        // which other files may provide.
        let off = arrow && self.scopes.last().is_none_or(|scope| scope.off);
        let flow = if self.cx.is_cancelled() { Flow::default() } else { self.types.flow(&self.frames) };
        let params = parameters
            .map(|list| list.parameters.iter().map(|p| name_of(&p.variable).to_vec()).collect())
            .unwrap_or_default();
        self.scopes.push(Scope {
            flow,
            arrow,
            off,
            opaque: false,
            params,
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
                if name.trim_start_matches('\\').eq_ignore_ascii_case("compact") {
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
        self.enter(Frame::Closure(closure), Some(&closure.parameter_list));
        for variable in &variables {
            if variable.ampersand.is_some() {
                self.bound(&variable.variable);
            }
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
        cx.enter(Frame::Function(node), Some(&node.parameter_list));
    }
    fn walk_out_function(&self, _: &'a Function<'a>, cx: &mut Scan<'a, 'r>) {
        cx.leave();
    }
    fn walk_in_method(&self, node: &'a Method<'a>, cx: &mut Scan<'a, 'r>) {
        let parameters = matches!(node.body, MethodBody::Concrete(_)).then_some(&node.parameter_list);
        cx.enter(Frame::Method(node), parameters);
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
        cx.enter(Frame::Arrow(node), Some(&node.parameter_list));
    }
    fn walk_out_arrow_function(&self, _: &'a ArrowFunction<'a>, cx: &mut Scan<'a, 'r>) {
        cx.leave();
    }
}
