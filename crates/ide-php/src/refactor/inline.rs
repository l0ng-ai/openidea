//! Inline (`refactor.inline.*`, IDEA's Inline Variable and Inline Method).
//!
//! - **Inline variable** (`refactor.inline.variable`): with the caret on a
//!   local variable assigned exactly once, by a statement `$x = …;` of its
//!   own, every read of it is replaced by the value (in parentheses where
//!   the context needs them) and the assignment is removed. Refused when
//!   the variable is a parameter or written anywhere else (`+=`, `++`,
//!   `foreach`, `list()`, `&`, by-reference arguments, `global`/`static`),
//!   when a read is written to or must stay a variable (`isset`, `unset`,
//!   `$x[] =`, `$x->p =`, a closure's `use`, string interpolation), might
//!   see no value or comes before the assignment, when a variable the value
//!   reads is written after the assignment, and in functions whose variables
//!   the flow can't follow (`extract`, `$$name`, `compact`, …) or inside
//!   closures and arrow functions. A value that isn't
//!   [stable](is_stable) (calls, `new`, property reads, …) is inlined only
//!   into a single read in the next statement that is evaluated exactly once
//!   there (not in a loop, a branch, the right of `&&`/`||`/`??`, …), so it
//!   still runs once and in the same place relative to other statements.
//! - **Inline method / function** (`refactor.inline.method`,
//!   `refactor.inline.function`): with the caret on the name in a call, the
//!   call is replaced by the callee's body:
//!   - a body that is only `return value;` replaces the call by the value
//!     anywhere;
//!   - a body ending in its only `return value;` (or with no `return`, or a
//!     last bare `return;`) replaces a call that is a whole statement:
//!     `name(…);`, `$x = name(…);` or `return name(…);` (a body without a
//!     value only in the first form).
//!
//!   Arguments that are [stable](is_stable) and parameters that are only
//!   read are substituted into the body; otherwise the argument goes into a
//!   variable first (`$param = argument;`, in argument order; every
//!   argument once one of them isn't stable). Missing arguments take the
//!   parameter's default. The callee's local variables are renamed when the
//!   caller uses their names, and class, function and constant names are
//!   written fully qualified when the caller's namespace or imports would
//!   read them differently. Refused: callees from the stubs, by-reference
//!   or variadic parameters, spread or extra arguments, a by-reference
//!   return, recursion, generators, other `return`s, `static`/`global`
//!   variables, nested declarations, `func_get_args()` and the like,
//!   `__FUNCTION__`/`__METHOD__`, nullsafe calls and receivers that would
//!   have to be evaluated (`$a->b()->c()`); `$this`, `self`, `static` and
//!   `parent` only when the caller is in the declaring class (with `$this`
//!   as the receiver for `$this`); interface and trait methods; and methods
//!   called polymorphically (`$obj->`, `static::`) that a subclass
//!   overrides, unless they are private or final.
//!
//! The rules are our own, after IntelliJ's documented Inline Variable and
//! Inline Method behaviour.

use std::collections::HashSet;
use std::path::Path;

use ide_core::{CancellationToken, TextEdit};
use mago_span::HasSpan;
use mago_syntax::cst::{
    Access, ArrayElement, Assignment, AssignmentOperator, Call, ClassLikeMemberSelector, Expression, Function,
    MagicConstant, Method, MethodBody, Modifier, Node, NodeKind, Statement, Variable,
};

use super::method::{Occurrence, SUPERGLOBALS, Scope, Walk, lossy, plain_assignment, reindent, scope_of};
use super::{
    contains, in_write_context, is_statement_list, names, path_to, span_of, trimmed, variable_anchor, variables_in,
    visit,
};
use crate::engine::PhpEngine;
use crate::imports::{ImportAction, file_edit, removal, wanted};
use crate::inspect::fixes::{line_indent, newline, starts_line};
use crate::names::{FileNames, NameKind, NameRole, Resolution, fqn_eq};
use crate::navigate::enclosing_class;
use crate::navigate::hierarchy::Subtypes;
use crate::navigate::symbol::{Decl, MemberKind, Subject, file_text};
use crate::summary::{ClassKind, FileSummary};
use crate::syntax::ParsedFile;
use crate::types::{Defined, ExprTypes, Flow, Frame};

/// The code action kind of Inline variable.
pub const INLINE_VARIABLE: &str = "refactor.inline.variable";
/// The code action kind of Inline method.
pub const INLINE_METHOD: &str = "refactor.inline.method";
/// The code action kind of Inline function.
pub const INLINE_FUNCTION: &str = "refactor.inline.function";

/// The Inline actions for the caret (or selection start) at bytes
/// `start..end` of an open document, filtered by `only`.
pub(crate) fn inline_actions(
    engine: &PhpEngine,
    parsed: &ParsedFile,
    path: &Path,
    start: u32,
    end: u32,
    only: &[String],
) -> Vec<ImportAction> {
    let want_variable = wanted(only, INLINE_VARIABLE);
    let want_call = wanted(only, INLINE_METHOD) || wanted(only, INLINE_FUNCTION);
    if !want_variable && !want_call {
        return Vec::new();
    }
    let summary = FileSummary::extract(parsed);
    if summary.has_errors {
        return Vec::new();
    }
    let (start, end) = (start.min(end), start.max(end));
    let (at, _) = trimmed(parsed.text(), start, end);
    let mut out = Vec::new();
    if want_variable && let Some(action) = inline_variable(engine, parsed, path, &summary, at) {
        out.push(action);
    }
    if want_call
        && let Some(action) = inline_call(engine, parsed, path, &summary, at)
        && wanted(only, action.kind)
    {
        out.push(action);
    }
    out
}

// ------------------------------------------------------------ expressions

/// Evaluating it twice, or later, gives the same value and does nothing
/// else (as long as the variables it reads keep their values): literals,
/// variables, constants, and arrays, array reads and operators over them.
pub(super) fn is_stable(expr: &Expression<'_>) -> bool {
    match expr {
        Expression::Literal(_)
        | Expression::Variable(Variable::Direct(_))
        | Expression::ConstantAccess(_)
        | Expression::MagicConstant(_)
        | Expression::Access(Access::ClassConstant(_)) => true,
        Expression::Parenthesized(inner) => is_stable(inner.expression),
        Expression::Array(array) => array.elements.iter().all(stable_element),
        Expression::LegacyArray(array) => array.elements.iter().all(stable_element),
        Expression::ArrayAccess(access) => is_stable(access.array) && is_stable(access.index),
        Expression::UnaryPrefix(unary) => {
            !unary.operator.is_increment_or_decrement() && !unary.operator.is_reference() && is_stable(unary.operand)
        }
        Expression::Binary(binary) => is_stable(binary.lhs) && is_stable(binary.rhs),
        Expression::Conditional(conditional) => {
            is_stable(conditional.condition) && conditional.then.is_none_or(is_stable) && is_stable(conditional.r#else)
        }
        _ => false,
    }
}

fn stable_element(element: &ArrayElement<'_>) -> bool {
    match element {
        ArrayElement::KeyValue(element) => is_stable(element.key) && is_stable(element.value),
        ArrayElement::Value(element) => is_stable(element.value),
        _ => false,
    }
}

/// Binds tighter than any operator around it.
fn is_atomic(expr: &Expression<'_>) -> bool {
    matches!(
        expr,
        Expression::Literal(_)
            | Expression::CompositeString(_)
            | Expression::Variable(_)
            | Expression::ConstantAccess(_)
            | Expression::Identifier(_)
            | Expression::MagicConstant(_)
            | Expression::Access(_)
            | Expression::ArrayAccess(_)
            | Expression::Call(_)
            | Expression::Array(_)
            | Expression::LegacyArray(_)
            | Expression::Parenthesized(_)
    )
}

/// Whether `value`, put where the expression `path[i]` stands, needs
/// parentheses.
fn needs_parens(value: &Expression<'_>, path: &[Node<'_, '_>], i: usize) -> bool {
    if is_atomic(value) {
        return false;
    }
    let low = matches!(value, Expression::Binary(binary) if binary.operator.is_low_precedence())
        || matches!(value, Expression::Assignment(_) | Expression::Yield(_));
    let target = span_of(&path[i]);
    let safe = match path[i - 1] {
        Node::PositionalArgument(_)
        | Node::NamedArgument(_)
        | Node::ValueArrayElement(_)
        | Node::KeyValueArrayElement(_)
        | Node::Return(_)
        | Node::Echo(_)
        | Node::ExpressionStatement(_)
        | Node::Parenthesized(_) => true,
        Node::Assignment(assignment) => span_of(&Node::Expression(assignment.rhs)) == target,
        _ => false,
    };
    !safe || (low && !matches!(path[i - 1], Node::Parenthesized(_)))
}

fn wrapped(value: &str, parens: bool) -> String {
    if parens { format!("({value})") } else { value.to_owned() }
}

/// Whether the expression at `path[to]` runs exactly once each time
/// `path[from]` does: not in a loop body or condition, a branch, the right
/// of `&&`/`||`/`??`, a ternary or `match` arm, or a function body.
fn runs_once(path: &[Node<'_, '_>], from: usize, to: usize) -> bool {
    let target = span_of(&path[to]);
    let within = |expr: &Expression<'_>| contains(span_of(&Node::Expression(expr)), target);
    path[from..to].iter().all(|node| match node {
        Node::If(node) => within(node.condition),
        Node::Switch(node) => within(node.expression),
        Node::Foreach(node) => within(node.expression),
        Node::For(node) => node.initializations.iter().any(|e| within(e)),
        Node::While(_) | Node::DoWhile(_) => false,
        Node::Try(node) => contains(span_of(&Node::Block(&node.block)), target),
        Node::Binary(binary) if binary.operator.is_logical() || binary.operator.is_null_coalesce() => {
            within(binary.lhs)
        }
        Node::Conditional(node) => within(node.condition),
        Node::Match(node) => within(node.expression),
        Node::Closure(_) | Node::ArrowFunction(_) | Node::Function(_) | Node::Method(_) => false,
        _ => true,
    })
}

/// The index in `path` of the expression node of the variable at its end.
fn variable_expression(path: &[Node<'_, '_>]) -> Option<usize> {
    (0..path.len()).rev().find(|&j| matches!(path[j], Node::Expression(Expression::Variable(_))))
}

/// `global`, `static` or `compact()` somewhere in the scope.
fn has_hidden_variables(scope: Node<'_, '_>) -> bool {
    let mut found = false;
    visit(scope, &mut |node| {
        found |= matches!(node, Node::Global(_) | Node::Static(_));
        if let Node::FunctionCall(call) = node
            && let Expression::Identifier(name) = call.function
        {
            let name = name.value();
            let short = name.rsplit(|&b| b == b'\\').next().unwrap_or(name);
            found |= short.eq_ignore_ascii_case(b"compact");
        }
    });
    found
}

fn scope_node<'a>(scope: Scope<'a>, program: Node<'a, 'a>) -> Node<'a, 'a> {
    match scope {
        Scope::Method(method) => Node::MethodBody(&method.body),
        Scope::Function(function) => Node::Block(&function.body),
        Scope::TopLevel => program,
    }
}

fn frames_of<'a>(scope: Scope<'a>, class: Option<String>) -> Vec<Frame<'a>> {
    match scope {
        Scope::Method(method) => vec![Frame::Class(class), Frame::Method(method)],
        Scope::Function(function) => vec![Frame::Function(function)],
        Scope::TopLevel => Vec::new(),
    }
}

// ------------------------------------------------------------ variable

fn inline_variable(
    engine: &PhpEngine,
    parsed: &ParsedFile,
    path: &Path,
    summary: &FileSummary,
    offset: u32,
) -> Option<ImportAction> {
    let text = parsed.text();
    let program = Node::Program(parsed.program());
    let (nodes, name) = [offset, offset.saturating_sub(1)].into_iter().find_map(|at| {
        let nodes = path_to(program, at, at);
        match nodes.last() {
            Some(Node::DirectVariable(variable)) => Some((nodes.clone(), variable.name)),
            _ => None,
        }
    })?;
    let bare = lossy(name.strip_prefix(b"$").unwrap_or(name));
    if bare == "this" || SUPERGLOBALS.contains(&bare.as_str()) {
        return None;
    }
    let (scope, scope_at) = scope_of(&nodes)?;
    let parameters = match scope {
        Scope::Method(method) => Some(&method.parameter_list),
        Scope::Function(function) => Some(&function.parameter_list),
        Scope::TopLevel => None,
    };
    if parameters.is_some_and(|list| list.parameters.iter().any(|p| p.variable.name == name)) {
        return None;
    }
    let scope_root = scope_node(scope, program);
    if has_hidden_variables(scope_root) {
        return None;
    }
    let file_names = FileNames::resolve(parsed);
    let resolver = engine.resolver();
    let class = match scope {
        Scope::Method(method) => Some(enclosing_class(summary, method.span().start.offset)?.fqn.clone()),
        _ => None,
    };
    let frames = frames_of(scope, class);
    let types = ExprTypes::new(parsed, &file_names, summary, &resolver);
    let flow = types.flow(&frames);
    if flow.is_dynamic() {
        return None;
    }
    let walk = Walk::of([scope_root]);
    let mine: Vec<&Occurrence<'_>> = walk.occurrences.iter().filter(|o| o.name == bare).collect();
    // Arrow functions capture by value: they never write it.
    let writes: Vec<&&Occurrence<'_>> =
        mine.iter().filter(|o| o.arrows.is_empty() && flow.written_at(o.offset).is_some()).collect();
    let [write] = writes.as_slice() else { return None };

    // The assignment, a statement of its own in a statement list.
    let write_path = path_to(program, write.offset, write.offset);
    let at = (1..write_path.len())
        .rev()
        .find(|&j| matches!(write_path[j], Node::Statement(_)) && is_statement_list(write_path[j - 1].kind()))?;
    let Node::Statement(statement) = write_path[at] else { return None };
    let (assigned, assignment) = plain_assignment(statement)?;
    if assigned != name || assignment.lhs.span().start.offset != write.offset {
        return None;
    }
    let value = assignment.rhs;
    let value_walk = Walk::of([Node::Expression(value)]);
    if value_walk.refused || matches!(value, Expression::UnaryPrefix(unary) if unary.operator.is_reference()) {
        return None;
    }
    let (statement_start, statement_end) = span_of(&write_path[at]);

    // What the value reads keeps its value.
    for read in &value_walk.occurrences {
        let changed = walk.occurrences.iter().any(|o| {
            o.name == read.name
                && o.offset >= statement_end
                && (flow.written_at(o.offset).is_some() || flow.is_binding(o.offset))
        });
        if changed {
            return None;
        }
    }
    let reads: Vec<&Occurrence<'_>> = mine.iter().copied().filter(|o| o.offset != write.offset).collect();
    if reads.is_empty() {
        return None;
    }
    if !is_stable(value) {
        // One read, in the next statement, run once there.
        let [read] = reads.as_slice() else { return None };
        let read_path = path_to(program, read.offset, read.offset);
        let statements: Vec<(u32, u32)> =
            write_path[at - 1].children().iter().filter(|c| matches!(c, Node::Statement(_))).map(span_of).collect();
        let index = statements.iter().position(|&s| s == (statement_start, statement_end))?;
        let next = *statements.get(index + 1)?;
        let i = variable_expression(&read_path)?;
        if read_path.get(at).map(span_of) != Some(next) || !runs_once(&read_path, at, i) {
            return None;
        }
    }
    let read_edits = variable_reads(parsed, &flow, scope_at, value, statement_end, &reads)?;
    let index = parsed.line_index();
    let (from, to) = removal(text, statement_start, statement_end);
    let mut edits = vec![TextEdit { range: index.range(from, to), new_text: String::new() }];
    edits.extend(read_edits);
    Some(ImportAction {
        title: format!("Inline variable '${bare}'"),
        kind: INLINE_VARIABLE,
        preferred: false,
        edit: file_edit(path, edits),
    })
}

/// The edits replacing each read by the value; `None` when a read can't
/// take it.
fn variable_reads(
    parsed: &ParsedFile,
    flow: &Flow,
    scope_at: usize,
    value: &Expression<'_>,
    statement_end: u32,
    reads: &[&Occurrence<'_>],
) -> Option<Vec<TextEdit>> {
    let text = parsed.text();
    let program = Node::Program(parsed.program());
    let index = parsed.line_index();
    let (value_start, value_end) = span_of(&Node::Expression(value));
    let value_text = &text[value_start as usize..value_end as usize];
    let mut edits = Vec::new();
    for read in reads {
        if read.offset < statement_end || (!read.arrows.is_empty() && !is_stable(value)) {
            return None;
        }
        if read.arrows.is_empty() {
            let state = flow.read_at(read.offset)?;
            if state.defined != Defined::Yes || flow.is_binding(read.offset) {
                return None;
            }
        }
        let read_path = path_to(program, read.offset, read.offset);
        let i = variable_expression(&read_path)?;
        if in_write_context(&read_path, i, scope_at) {
            return None;
        }
        let hidden = read_path[scope_at + 1..i]
            .iter()
            .any(|n| matches!(n, Node::Closure(_) | Node::Expression(Expression::CompositeString(_))));
        if hidden {
            return None;
        }
        let (start, end) = span_of(&read_path[i]);
        let new_text = wrapped(value_text, needs_parens(value, &read_path, i));
        edits.push(TextEdit { range: index.range(start, end), new_text });
    }
    Some(edits)
}

// ------------------------------------------------------------ call

/// The callee's declaration.
#[derive(Clone, Copy)]
enum Callee<'a> {
    Function(&'a Function<'a>),
    Method(&'a Method<'a>),
}

/// How the call stands in its statement.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Context {
    /// `name(…);` (the statement's index in the path).
    Statement(usize),
    /// `$x = name(…);`
    Assign(usize),
    /// `return name(…);`
    Return(usize),
    /// Anywhere else in an expression.
    Expression,
}

/// What the callee's body is.
enum Shape<'a> {
    /// Statements and a final `return value;` (the statements may be none).
    Tail(Vec<&'a Statement<'a>>, &'a Expression<'a>),
    /// Statements and no value.
    Void(Vec<&'a Statement<'a>>),
}

/// A text replacement in the callee's file.
struct Splice {
    start: u32,
    end: u32,
    text: String,
}

/// `text` with the splices applied, and a map from old offsets to new ones.
fn spliced(text: &str, mut splices: Vec<Splice>) -> (String, impl Fn(u32) -> u32) {
    splices.sort_by_key(|s| s.start);
    let mut out = String::with_capacity(text.len());
    let mut at = 0usize;
    let mut shifts: Vec<(u32, i64)> = Vec::new();
    let mut shift = 0i64;
    for splice in &splices {
        if (splice.start as usize) < at {
            continue;
        }
        out.push_str(&text[at..splice.start as usize]);
        out.push_str(&splice.text);
        at = splice.end as usize;
        shift += splice.text.len() as i64 - (splice.end - splice.start) as i64;
        shifts.push((splice.end, shift));
    }
    out.push_str(&text[at..]);
    let map = move |offset: u32| {
        let before = shifts.partition_point(|&(end, _)| end <= offset);
        let delta = if before == 0 { 0 } else { shifts[before - 1].1 };
        (offset as i64 + delta) as u32
    };
    (out, map)
}

fn call_name_span(call: &Call<'_>) -> Option<(u32, u32)> {
    match call {
        Call::Function(call) => match call.function {
            Expression::Identifier(name) => Some(span_of(&Node::Identifier(name))),
            _ => None,
        },
        Call::Method(call) => match &call.method {
            ClassLikeMemberSelector::Identifier(name) => Some((name.span.start.offset, name.span.end.offset)),
            _ => None,
        },
        Call::StaticMethod(call) => match &call.method {
            ClassLikeMemberSelector::Identifier(name) => Some((name.span.start.offset, name.span.end.offset)),
            _ => None,
        },
        Call::NullSafeMethod(_) => None,
    }
}

fn inline_call(
    engine: &PhpEngine,
    parsed: &ParsedFile,
    path: &Path,
    summary: &FileSummary,
    offset: u32,
) -> Option<ImportAction> {
    let text = parsed.text();
    let program = Node::Program(parsed.program());
    let (nodes, ci, call, name_at) = [offset, offset.saturating_sub(1)].into_iter().find_map(|at| {
        let nodes = path_to(program, at, at);
        let ci = (0..nodes.len()).rev().find(|&j| {
            matches!(nodes[j], Node::Expression(Expression::Call(call))
                if call_name_span(call).is_some_and(|(s, e)| s <= at && at <= e))
        })?;
        let Node::Expression(Expression::Call(call)) = nodes[ci] else { return None };
        let name_at = call_name_span(call)?.0;
        Some((nodes, ci, call, name_at))
    })?;

    // The declaration.
    let resolver = engine.resolver();
    let found = engine.at_caret(parsed, summary, &resolver, name_at)?;
    let Subject::Decls(decls) = found.subject else { return None };
    let [decl] = decls.as_slice() else { return None };
    let (kind, title) = match decl {
        Decl::Function(_) => (INLINE_FUNCTION, "Inline function"),
        Decl::Member(member) if member.kind == MemberKind::Method => (INLINE_METHOD, "Inline method"),
        _ => return None,
    };
    let [target] = engine.decl_targets(decl, path, summary).try_into().ok()?;
    if target.path.starts_with(engine.stub_dir()) {
        return None;
    }
    let same_file = target.path == path;
    let other = if same_file {
        None
    } else {
        Some(ParsedFile::parse(&target.path.to_string_lossy(), file_text(engine, &target.path)?))
    };
    let decl_parsed = other.as_ref().unwrap_or(parsed);
    let decl_text = decl_parsed.text();
    let decl_summary = if same_file { summary.clone() } else { FileSummary::extract(decl_parsed) };
    if decl_summary.has_errors {
        return None;
    }
    let name_offset = decl_parsed.line_index().byte(target.range.start);
    let mut callee = None;
    visit(Node::Program(decl_parsed.program()), &mut |node| match node {
        Node::Function(function) if function.name.span.start.offset == name_offset => {
            callee = Some(Callee::Function(function));
        }
        Node::Method(method) if method.name.span.start.offset == name_offset => {
            callee = Some(Callee::Method(method));
        }
        _ => {}
    });
    let callee = callee?;
    let (parameter_list, statements, by_ref, callee_name) = match callee {
        Callee::Function(function) => (
            &function.parameter_list,
            function.body.statements.iter().collect::<Vec<_>>(),
            function.ampersand,
            function.name.value,
        ),
        Callee::Method(method) => {
            let MethodBody::Concrete(body) = &method.body else { return None };
            (&method.parameter_list, body.statements.iter().collect::<Vec<_>>(), method.ampersand, method.name.value)
        }
    };
    if by_ref.is_some() || parameter_list.parameters.iter().any(|p| p.ampersand.is_some() || p.ellipsis.is_some()) {
        return None;
    }

    // The callee's class and how the call reaches it.
    let decl_class = match callee {
        Callee::Method(method) => Some(enclosing_class(&decl_summary, method.span().start.offset)?),
        Callee::Function(_) => None,
    };
    if decl_class.is_some_and(|c| !matches!(c.kind, ClassKind::Class | ClassKind::Enum)) {
        return None;
    }
    let caller_class = enclosing_class(summary, name_at);
    let same_class = match (decl_class, caller_class) {
        (Some(d), Some(c)) => fqn_eq(NameKind::ClassLike, &d.fqn, &c.fqn),
        _ => false,
    };
    let (receiver_is_this, receiver_droppable, polymorphic) = match call {
        Call::Function(_) => (false, true, false),
        Call::Method(call) => {
            let this = matches!(call.object, Expression::Variable(Variable::Direct(v)) if v.name == b"$this");
            let droppable = matches!(call.object, Expression::Variable(Variable::Direct(_)));
            (this, droppable, true)
        }
        Call::StaticMethod(call) => {
            let droppable = matches!(
                call.class,
                Expression::Identifier(_) | Expression::Self_(_) | Expression::Static(_) | Expression::Parent(_)
            );
            (false, droppable, matches!(call.class, Expression::Static(_)))
        }
        Call::NullSafeMethod(_) => return None,
    };
    if !receiver_droppable {
        return None;
    }
    if let (Callee::Method(method), Some(class)) = (callee, decl_class) {
        let sealed = class.modifiers.is_final
            || class.kind == ClassKind::Enum
            || method.modifiers.iter().any(|m| matches!(m, Modifier::Private(_) | Modifier::Final(_)));
        if polymorphic && !sealed {
            let subtypes = Subtypes::new(engine);
            let all = subtypes.all(engine, &class.fqn, &CancellationToken::new()).ok()?;
            let name = lossy(callee_name);
            if all.iter().any(|sub| sub.class.methods.iter().any(|m| m.name.eq_ignore_ascii_case(&name))) {
                return None;
            }
        }
    }

    // The body.
    let walk = Walk::of(statements.iter().map(|s| Node::Statement(s)));
    if walk.refused {
        return None;
    }
    let body_span = match (statements.first(), statements.last()) {
        (Some(first), Some(last)) => (first.span().start.offset, last.span().end.offset),
        _ => (name_offset, name_offset),
    };
    let mut uses_class = walk.uses_this;
    let mut refused = false;
    let mut recursive = false;
    for statement in &statements {
        visit(Node::Statement(statement), &mut |node| match node {
            Node::Expression(Expression::Self_(_) | Expression::Static(_) | Expression::Parent(_)) => uses_class = true,
            Node::Expression(Expression::MagicConstant(constant)) => match constant {
                MagicConstant::Function(_) | MagicConstant::Method(_) | MagicConstant::Property(_) => refused = true,
                MagicConstant::Class(_) | MagicConstant::Trait(_) => uses_class = true,
                MagicConstant::File(_) | MagicConstant::Directory(_) | MagicConstant::Namespace(_) => {
                    refused |= !same_file;
                }
                MagicConstant::Line(_) => {}
            },
            Node::MethodCall(call) => {
                if let ClassLikeMemberSelector::Identifier(name) = &call.method {
                    recursive |= matches!(callee, Callee::Method(_)) && name.value.eq_ignore_ascii_case(callee_name);
                }
            }
            Node::NullSafeMethodCall(call) => {
                if let ClassLikeMemberSelector::Identifier(name) = &call.method {
                    recursive |= matches!(callee, Callee::Method(_)) && name.value.eq_ignore_ascii_case(callee_name);
                }
            }
            Node::StaticMethodCall(call) => {
                if let ClassLikeMemberSelector::Identifier(name) = &call.method {
                    recursive |= matches!(callee, Callee::Method(_)) && name.value.eq_ignore_ascii_case(callee_name);
                }
            }
            _ => {}
        });
    }
    let decl_names = FileNames::resolve(decl_parsed);
    for name in decl_names.names() {
        if !(body_span.0 <= name.start && name.end <= body_span.1) || name.role != NameRole::Reference {
            continue;
        }
        if matches!(name.resolution, Resolution::Relative(_)) {
            uses_class = true;
        }
        if name.kind == NameKind::Function {
            let short = name.text.rsplit('\\').next().unwrap_or(&name.text).to_ascii_lowercase();
            refused |= ["func_get_args", "func_get_arg", "func_num_args"].contains(&short.as_str());
            if let (Decl::Function(fqn), Callee::Function(_)) = (decl, callee) {
                recursive |= name.resolution.matches(NameKind::Function, fqn);
            }
        }
    }
    if refused || recursive {
        return None;
    }
    if uses_class && !same_class {
        return None;
    }
    if walk.uses_this && !receiver_is_this {
        return None;
    }

    let shape = match statements.as_slice() {
        [] => Shape::Void(Vec::new()),
        [rest @ .., last] => match (walk.returns.as_slice(), last) {
            ([], _) => Shape::Void(statements.clone()),
            ([only], Statement::Return(r)) if *only == span_of(&Node::Statement(last)) => match r.value {
                Some(value) => Shape::Tail(rest.to_vec(), value),
                None => Shape::Void(rest.to_vec()),
            },
            _ => return None,
        },
    };

    // How the call stands.
    let statement_at = |j: usize| j >= 1 && matches!(nodes[j], Node::Statement(_));
    let context = match nodes[ci - 1] {
        Node::ExpressionStatement(_) if statement_at(ci - 2) => Context::Statement(ci - 2),
        Node::Return(_) if statement_at(ci - 2) => Context::Return(ci - 2),
        Node::Assignment(Assignment { lhs, operator: AssignmentOperator::Assign(_), rhs, .. })
            if span_of(&Node::Expression(rhs)) == span_of(&nodes[ci])
                && matches!(lhs, Expression::Variable(Variable::Direct(_)))
                && matches!(nodes[ci - 3], Node::ExpressionStatement(_))
                && statement_at(ci - 4) =>
        {
            Context::Assign(ci - 4)
        }
        _ => Context::Expression,
    };
    let leading = match &shape {
        Shape::Tail(rest, _) | Shape::Void(rest) => !rest.is_empty(),
    };
    match (&shape, context) {
        (Shape::Void(_), Context::Assign(_) | Context::Return(_) | Context::Expression) => return None,
        (Shape::Tail(..), Context::Expression) if leading => return None,
        _ => {}
    }

    // The callee's flow, for how parameters are used.
    let decl_resolver = engine.resolver();
    let decl_frames: Vec<Frame<'_>> = match callee {
        Callee::Function(function) => vec![Frame::Function(function)],
        Callee::Method(method) => vec![Frame::Class(decl_class.map(|c| c.fqn.clone())), Frame::Method(method)],
    };
    let decl_types = ExprTypes::new(decl_parsed, &decl_names, &decl_summary, &decl_resolver);
    let decl_flow = decl_types.flow(&decl_frames);
    if decl_flow.is_dynamic() {
        return None;
    }
    let decl_program = Node::Program(decl_parsed.program());
    let decl_scope_at = path_to(decl_program, body_span.0, body_span.0)
        .iter()
        .rposition(|n| matches!(n, Node::Function(_) | Node::Method(_)))?;

    // Arguments to parameters.
    let arguments: Vec<_> = match call {
        Call::Function(call) => call.argument_list.arguments.iter().collect(),
        Call::Method(call) => call.argument_list.arguments.iter().collect(),
        Call::StaticMethod(call) => call.argument_list.arguments.iter().collect(),
        Call::NullSafeMethod(_) => return None,
    };
    let parameters: Vec<_> = parameter_list.parameters.iter().collect();
    let mut given: Vec<Option<&Expression<'_>>> = vec![None; parameters.len()];
    for (i, argument) in arguments.iter().enumerate() {
        match argument {
            mago_syntax::cst::Argument::Positional(argument) => {
                if argument.ellipsis.is_some() || i >= parameters.len() {
                    return None;
                }
                given[i] = Some(argument.value);
            }
            mago_syntax::cst::Argument::Named(argument) => {
                let j = parameters.iter().position(|p| &p.variable.name[1..] == argument.name.value)?;
                if given[j].is_some() {
                    return None;
                }
                given[j] = Some(argument.value);
            }
        }
    }
    let all_temps = given.iter().flatten().any(|arg| !is_stable(arg));

    // Names the caller's scope already uses.
    let scope_span = nodes[..ci]
        .iter()
        .rev()
        .find(|n| {
            matches!(n.kind(), NodeKind::Function | NodeKind::Method | NodeKind::Closure | NodeKind::ArrowFunction)
        })
        .map_or((0, text.len() as u32), span_of);
    let mut taken: HashSet<String> = variables_in(text, scope_span.0, scope_span.1).into_iter().collect();
    taken.insert("this".into());
    let locals: Vec<String> = super::method::first_use_order(&walk.occurrences)
        .into_iter()
        .filter(|n| !parameters.iter().any(|p| p.variable.name[1..] == *n.as_bytes()))
        .collect();
    taken.extend(locals.iter().cloned());

    // Name rewrites, for a caller that reads names differently.
    let caller_names = FileNames::resolve(parsed);
    let caller_scope = caller_names.scope_at(name_at);
    let mut splices: Vec<Splice> = Vec::new();
    let qualify = |start: u32, end: u32, splices: &mut Vec<Splice>| {
        for name in decl_names.names() {
            if name.start < start
                || name.end > end
                || name.role != NameRole::Reference
                || name.kind == NameKind::Namespace
            {
                continue;
            }
            let there = caller_scope.resolve(name.kind, &name.text);
            let target = match &name.resolution {
                Resolution::Relative(_) => continue,
                resolution if *resolution == there.resolution => continue,
                Resolution::Fqn(fqn) => fqn.clone(),
                Resolution::Fallback { namespaced, global } => {
                    if engine.declares(name.kind, namespaced) {
                        namespaced.clone()
                    } else {
                        global.clone()
                    }
                }
            };
            splices.push(Splice { start: name.start, end: name.end, text: format!("\\{target}") });
        }
    };
    qualify(body_span.0, body_span.1, &mut splices);

    // Locals that clash with the caller's variables get new names.
    let caller_vars: HashSet<String> = variables_in(text, scope_span.0, scope_span.1).into_iter().collect();
    let mut renamed: Vec<(String, String)> = Vec::new();
    for local in &locals {
        if caller_vars.contains(local) {
            let new = names::unique(std::slice::from_ref(local), |n| taken.contains(n));
            taken.insert(new.clone());
            renamed.push((local.clone(), new));
        }
    }

    // Parameters: substituted, or a variable assigned first.
    let mut temps: Vec<String> = Vec::new();
    let mut parameter_text: Vec<(String, String, &Expression<'_>)> = Vec::new();
    for (i, parameter) in parameters.iter().enumerate() {
        let pname = lossy(&parameter.variable.name[1..]);
        let uses: Vec<&Occurrence<'_>> = walk.occurrences.iter().filter(|o| o.name == pname).collect();
        let (arg_text, arg_expr, from_caller) = match given[i] {
            Some(arg) => {
                let (s, e) = span_of(&Node::Expression(arg));
                (text[s as usize..e as usize].to_owned(), arg, true)
            }
            None => {
                let default = parameter.default_value.as_ref()?.value;
                let (s, e) = span_of(&Node::Expression(default));
                let mut own = Vec::new();
                qualify(s, e, &mut own);
                let (rendered, map) = spliced(decl_text, own);
                (rendered[map(s) as usize..map(e) as usize].to_owned(), default, false)
            }
        };
        let only_read = uses.iter().all(|o| {
            if !o.arrows.is_empty() {
                return true;
            }
            if decl_flow.read_at(o.offset).is_none() || decl_flow.is_binding(o.offset) {
                return false;
            }
            let p = path_to(decl_program, o.offset, o.offset);
            let Some(j) = variable_expression(&p) else { return false };
            !in_write_context(&p, j, decl_scope_at)
                && !p[decl_scope_at..j].iter().any(|n| matches!(n, Node::Closure(_)))
        });
        let in_string = |o: &&Occurrence<'_>| {
            let p = path_to(decl_program, o.offset, o.offset);
            p.iter().any(|n| matches!(n, Node::Expression(Expression::CompositeString(_))))
        };
        let plain_variable = matches!(arg_expr, Expression::Variable(Variable::Direct(_))) && from_caller;
        let substitute = only_read
            && is_stable(arg_expr)
            && !(all_temps
                && from_caller
                && !matches!(arg_expr, Expression::Literal(_) | Expression::ConstantAccess(_)))
            && (plain_variable || !uses.iter().any(in_string));
        if substitute {
            parameter_text.push((pname, arg_text, arg_expr));
        } else if uses.is_empty() {
            if !is_stable(arg_expr) {
                temps.push(format!("{arg_text};"));
            }
        } else {
            let new = names::unique(std::slice::from_ref(&pname), |n| taken.contains(n));
            taken.insert(new.clone());
            temps.push(format!("${new} = {arg_text};"));
            renamed.push((pname, new));
        }
    }

    // The body's variables.
    for occurrence in &walk.occurrences {
        let len = occurrence.name.len() as u32 + 1;
        if let Some((_, new)) = renamed.iter().find(|(old, _)| *old == occurrence.name) {
            splices.push(Splice { start: occurrence.offset, end: occurrence.offset + len, text: format!("${new}") });
        } else if let Some((_, arg, expr)) = parameter_text.iter().find(|(p, ..)| *p == occurrence.name) {
            let parens = if occurrence.arrows.is_empty() {
                let p = path_to(decl_program, occurrence.offset, occurrence.offset);
                let j = variable_expression(&p)?;
                needs_parens(expr, &p, j)
            } else {
                !is_atomic(expr)
            };
            splices.push(Splice { start: occurrence.offset, end: occurrence.offset + len, text: wrapped(arg, parens) });
        }
    }
    let strings = walk.strings.clone();
    let (rendered, map) = spliced(decl_text, splices);
    let mapped_strings: Vec<(u32, u32)> = strings.iter().map(|&(s, e)| (map(s), map(e))).collect();

    let nl = newline(text);
    let index = parsed.line_index();
    let render_value = |value: &Expression<'_>, indent: &str| {
        let (s, e) = span_of(&Node::Expression(value));
        reindent(&rendered, map(s), map(e), indent, &mapped_strings).trim_start().to_owned()
    };

    let edits = match context {
        Context::Expression => {
            let Shape::Tail(_, value) = shape else { return None };
            let (call_start, call_end) = span_of(&nodes[ci]);
            let indent = line_indent(text, call_start).to_owned();
            let value_text = wrapped(&render_value(value, &indent), needs_parens(value, &nodes, ci));
            let mut edits = Vec::new();
            if !temps.is_empty() {
                let anchor = variable_anchor(&nodes, ci)?;
                let (anchor_start, _) = span_of(&nodes[anchor]);
                let prefix = if starts_line(text, anchor_start) {
                    let indent = line_indent(text, anchor_start);
                    temps.iter().map(|t| format!("{t}{nl}{indent}")).collect::<String>()
                } else {
                    temps.iter().map(|t| format!("{t} ")).collect::<String>()
                };
                edits.push(TextEdit { range: index.range(anchor_start, anchor_start), new_text: prefix });
            }
            edits.push(TextEdit { range: index.range(call_start, call_end), new_text: value_text });
            edits
        }
        Context::Statement(at) | Context::Assign(at) | Context::Return(at) => {
            let (statement_start, statement_end) = span_of(&nodes[at]);
            let in_list = is_statement_list(nodes[at - 1].kind());
            let indent = line_indent(text, statement_start).to_owned();
            let mut pieces: Vec<String> = temps.clone();
            let (rest, value) = match &shape {
                Shape::Tail(rest, value) => (rest, Some(*value)),
                Shape::Void(rest) => (rest, None),
            };
            if let (Some(first), Some(last)) = (rest.first(), rest.last()) {
                let (s, e) = (first.span().start.offset, last.span().end.offset);
                pieces.push(reindent(&rendered, map(s), map(e), &indent, &mapped_strings).trim_start().to_owned());
            }
            if let Some(value) = value {
                let value_text = render_value(value, &indent);
                match context {
                    Context::Statement(_) => {
                        if !is_stable(value) {
                            pieces.push(format!("{value_text};"));
                        }
                    }
                    Context::Assign(_) => {
                        let Node::Assignment(assignment) = nodes[ci - 1] else { return None };
                        let (ls, le) = span_of(&Node::Expression(assignment.lhs));
                        let low = matches!(value, Expression::Binary(b) if b.operator.is_low_precedence())
                            || matches!(value, Expression::Assignment(_) | Expression::Yield(_));
                        pieces.push(format!("{} = {};", &text[ls as usize..le as usize], wrapped(&value_text, low)));
                    }
                    Context::Return(_) => pieces.push(format!("return {value_text};")),
                    Context::Expression => unreachable!("handled above"),
                }
            }
            if pieces.len() > 1 && !in_list {
                return None;
            }
            if pieces.is_empty() {
                if !in_list {
                    return None;
                }
                let (from, to) = removal(text, statement_start, statement_end);
                vec![TextEdit { range: index.range(from, to), new_text: String::new() }]
            } else {
                let joined = pieces.join(&format!("{nl}{indent}"));
                vec![TextEdit { range: index.range(statement_start, statement_end), new_text: joined }]
            }
        }
    };
    Some(ImportAction {
        title: format!("{title} '{}'", lossy(callee_name)),
        kind,
        preferred: false,
        edit: file_edit(path, edits),
    })
}
