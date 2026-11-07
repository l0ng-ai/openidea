//! Control flow: code no path reaches, and returns that don't fit the
//! function's native return type, from the [flow](crate::types::Flow) of
//! each function-like.
//!
//! - [`UnreachableStatement`] (`PhpUnreachableStatement`): the first
//!   statement of each run that follows a `return`, `throw`, `exit`,
//!   `break`/`continue`, `goto`, an endless loop or a call returning
//!   `never` (shown faded). Only code after a statement that runs counts:
//!   the body of `if (false) { … }` or `while (false) { … }` is a constant
//!   condition, not dead code. Declarations (functions, classes, `use`)
//!   are hoisted and never unreachable. The file's top level is checked
//!   too.
//! - [`MissingReturn`] (`PhpMissingReturnStatement`): a function with a
//!   native return type other than `void`/`never` whose end some path
//!   reaches ("Missing return statement" on the closing brace, a warning:
//!   PHP throws a `TypeError` when that path runs, `mixed` and nullable
//!   types included), and `return;` without a value in such a function
//!   (an error: PHP refuses to compile it). Generators (a body with
//!   `yield`) return when they end and aren't checked.
//! - [`VoidReturn`] (`PhpVoidFunctionReturnsValue`): `return <value>;` in a
//!   `void` function (`return null;` too), a compile error.
//! - [`NeverReturn`] (`PhpNeverFunctionReturns`): any `return` in a
//!   `never` function (a compile error), and an end some path reaches (a
//!   warning: PHP throws a `TypeError` when the function returns
//!   implicitly).
//!
//! Only native return types are checked; docblock `@return` types say
//! nothing about what PHP enforces. Functions, methods and closures are
//! checked; arrow functions return their expression. Calls are `never`
//! by their declared or inferred return type (`exit`-only functions,
//! `.phpstorm.meta.php` `exitPoint`s), which other files declare, so
//! nothing is reported in dumb mode, or in `.phpstorm.meta.php` files.
//! The flow approximates `goto`: a label may be reached from anywhere.
//!
//! The rules follow PHP's own compile-time and runtime checks; the ids
//! follow PhpStorm's naming.

use ide_core::Severity;
use mago_span::HasSpan;
use mago_syntax::cst::{
    AnonymousClass, ArrowFunction, Class, Closure, Enum, Expression, Function, FunctionLikeReturnTypeHint, Hint,
    Interface, Method, MethodBody, Return, Trait,
};
use mago_syntax::walker::Walker;

use super::{Inspection, InspectionContext, Problems};
use crate::engine::{EngineState, is_meta_path};
use crate::types::{ExprTypes, Flow, Frame};

/// `PhpUnreachableStatement`.
pub struct UnreachableStatement;

/// `PhpMissingReturnStatement`.
pub struct MissingReturn;

/// `PhpVoidFunctionReturnsValue`.
pub struct VoidReturn;

/// `PhpNeverFunctionReturns`.
pub struct NeverReturn;

impl Inspection for UnreachableStatement {
    fn id(&self) -> &'static str {
        "PhpUnreachableStatement"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        for found in cx.control().iter().filter(|found| found.kind == Kind::Unreachable) {
            out.report(found.start, found.end, "Unreachable statement").unnecessary();
        }
    }
}

impl Inspection for MissingReturn {
    fn id(&self) -> &'static str {
        "PhpMissingReturnStatement"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        for found in cx.control().iter() {
            match found.kind {
                Kind::MissingReturn => {
                    out.report(found.start, found.end, "Missing return statement");
                }
                Kind::MissingValue => {
                    out.report(found.start, found.end, "A function with a return type must return a value")
                        .with_severity(Severity::Error);
                }
                _ => {}
            }
        }
    }
}

impl Inspection for VoidReturn {
    fn id(&self) -> &'static str {
        "PhpVoidFunctionReturnsValue"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        for found in cx.control().iter().filter(|found| found.kind == Kind::VoidValue) {
            out.report(found.start, found.end, "A void function must not return a value");
        }
    }
}

impl Inspection for NeverReturn {
    fn id(&self) -> &'static str {
        "PhpNeverFunctionReturns"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn check(&self, cx: &InspectionContext<'_>, out: &mut Problems) {
        for found in cx.control().iter() {
            match found.kind {
                Kind::NeverReturn => {
                    out.report(found.start, found.end, "A never-returning function must not return");
                }
                Kind::NeverImplicit => {
                    out.report(found.start, found.end, "A never-returning function must not implicitly return")
                        .with_severity(Severity::Warning);
                }
                _ => {}
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// The first statement of an unreachable run.
    Unreachable,
    /// The end of a function with a return type is reachable (the closing
    /// brace).
    MissingReturn,
    /// `return;` in a function with a return type.
    MissingValue,
    /// `return <value>;` in a `void` function.
    VoidValue,
    /// `return` in a `never` function.
    NeverReturn,
    /// The end of a `never` function is reachable (the closing brace).
    NeverImplicit,
}

/// A control-flow problem found in a file.
#[derive(Clone, Debug)]
pub(crate) struct Found {
    pub(crate) kind: Kind,
    pub(crate) start: u32,
    pub(crate) end: u32,
}

/// Every control-flow problem of the file (computed once for the four
/// inspections), in source order.
pub(crate) fn find(cx: &InspectionContext<'_>) -> Vec<Found> {
    if cx.engine.status().state != EngineState::Ready || is_meta_path(cx.path) {
        return Vec::new();
    }
    let types = cx.types();
    let mut scan = Scan { cx, types, summary: cx.summary(), frames: Vec::new(), scopes: Vec::new(), found: Vec::new() };
    // The top level.
    let flow = types.flow(&[]);
    scan.unreachable(&flow);
    ScanWalker.walk_program(cx.parsed.program(), &mut scan);
    if cx.is_cancelled() {
        return Vec::new();
    }
    let mut found = scan.found;
    found.sort_by_key(|found| (found.start, found.end));
    found.dedup_by_key(|found| (found.start, found.end, found.kind as u8));
    found
}

/// What a function-like's native return type demands of its returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Returns {
    /// No native type (or an arrow function): nothing is checked.
    Unchecked,
    Void,
    Never,
    /// Any other type: a value on every path.
    Value,
}

fn returns_of(hint: Option<&FunctionLikeReturnTypeHint<'_>>) -> Returns {
    match hint.map(|hint| &hint.hint) {
        None => Returns::Unchecked,
        Some(Hint::Void(_)) => Returns::Void,
        Some(Hint::Never(_)) => Returns::Never,
        Some(_) => Returns::Value,
    }
}

/// One function-like being walked.
struct Scope {
    flow: Flow,
    returns: Returns,
    /// The closing brace of the body (none for abstract methods and arrow
    /// functions).
    close: Option<(u32, u32)>,
    /// The body yields: a generator.
    generator: bool,
    /// `return` statements: start, end, whether a value is given.
    statements: Vec<(u32, u32, bool)>,
}

struct Scan<'a, 'r> {
    cx: &'r InspectionContext<'a>,
    types: &'r ExprTypes<'a, 'r>,
    summary: &'a crate::summary::FileSummary,
    frames: Vec<Frame<'a>>,
    /// The function-likes around the walk, innermost last.
    scopes: Vec<Scope>,
    found: Vec<Found>,
}

impl<'a> Scan<'a, '_> {
    fn unreachable(&mut self, flow: &Flow) {
        for range in flow.unreachable() {
            self.found.push(Found { kind: Kind::Unreachable, start: range.start, end: range.end });
        }
    }

    fn enter(&mut self, frame: Frame<'a>, returns: Returns, close: Option<(u32, u32)>) {
        self.frames.push(frame);
        let flow = if self.cx.is_cancelled() { Flow::default() } else { self.types.flow(&self.frames) };
        self.unreachable(&flow);
        self.scopes.push(Scope { flow, returns, close, generator: false, statements: Vec::new() });
    }

    fn leave(&mut self) {
        self.frames.pop();
        let Some(scope) = self.scopes.pop() else { return };
        if self.cx.is_cancelled() {
            return;
        }
        let ends = scope.flow.falls_through();
        match scope.returns {
            Returns::Unchecked => {}
            Returns::Value => {
                if scope.generator {
                    return;
                }
                for &(start, end, value) in &scope.statements {
                    if !value {
                        self.found.push(Found { kind: Kind::MissingValue, start, end });
                    }
                }
                if let (true, Some((start, end))) = (ends, scope.close) {
                    self.found.push(Found { kind: Kind::MissingReturn, start, end });
                }
            }
            Returns::Void => {
                for &(start, end, value) in &scope.statements {
                    if value {
                        self.found.push(Found { kind: Kind::VoidValue, start, end });
                    }
                }
            }
            Returns::Never => {
                for &(start, end, _) in &scope.statements {
                    self.found.push(Found { kind: Kind::NeverReturn, start, end });
                }
                if let (true, Some((start, end))) = (ends, scope.close) {
                    self.found.push(Found { kind: Kind::NeverImplicit, start, end });
                }
            }
        }
    }

    fn class(&mut self, name_start: u32) {
        let fqn =
            self.summary.class_likes.iter().find(|class| class.name_loc.start == name_start).map(|c| c.fqn.clone());
        self.frames.push(Frame::Class(fqn));
    }

    fn r#return(&mut self, node: &Return<'_>) {
        let span = node.span();
        if let Some(scope) = self.scopes.last_mut() {
            scope.statements.push((span.start.offset, span.end.offset, node.value.is_some()));
        }
    }

    fn expression(&mut self, expr: &Expression<'_>) {
        if let Expression::Yield(_) = expr
            && let Some(scope) = self.scopes.last_mut()
        {
            scope.generator = true;
        }
    }
}

fn brace(span: mago_span::Span) -> Option<(u32, u32)> {
    Some((span.start.offset, span.end.offset))
}

struct ScanWalker;

impl<'a, 'r> Walker<'a, 'a, Scan<'a, 'r>> for ScanWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Scan<'a, 'r>) {
        cx.expression(expr);
    }

    fn walk_in_return(&self, node: &'a Return<'a>, cx: &mut Scan<'a, 'r>) {
        cx.r#return(node);
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
        let returns = returns_of(node.return_type_hint.as_ref());
        cx.enter(Frame::Function(node), returns, brace(node.body.right_brace));
    }
    fn walk_out_function(&self, _: &'a Function<'a>, cx: &mut Scan<'a, 'r>) {
        cx.leave();
    }
    fn walk_in_method(&self, node: &'a Method<'a>, cx: &mut Scan<'a, 'r>) {
        let (returns, close) = match &node.body {
            MethodBody::Concrete(body) => (returns_of(node.return_type_hint.as_ref()), brace(body.right_brace)),
            MethodBody::Abstract(_) => (Returns::Unchecked, None),
        };
        cx.enter(Frame::Method(node), returns, close);
    }
    fn walk_out_method(&self, _: &'a Method<'a>, cx: &mut Scan<'a, 'r>) {
        cx.leave();
    }
    fn walk_in_closure(&self, node: &'a Closure<'a>, cx: &mut Scan<'a, 'r>) {
        let returns = returns_of(node.return_type_hint.as_ref());
        cx.enter(Frame::Closure(node), returns, brace(node.body.right_brace));
    }
    fn walk_out_closure(&self, _: &'a Closure<'a>, cx: &mut Scan<'a, 'r>) {
        cx.leave();
    }
    fn walk_in_arrow_function(&self, node: &'a ArrowFunction<'a>, cx: &mut Scan<'a, 'r>) {
        cx.enter(Frame::Arrow(node), Returns::Unchecked, None);
    }
    fn walk_out_arrow_function(&self, _: &'a ArrowFunction<'a>, cx: &mut Scan<'a, 'r>) {
        cx.leave();
    }
}
