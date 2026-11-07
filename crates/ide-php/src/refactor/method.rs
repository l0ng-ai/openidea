//! Extract method / function (`refactor.extract.method`,
//! `refactor.extract.function`, IDEA's Extract Method).
//!
//! The selection is either a run of whole statements of one statement list
//! or one expression, inside a method of a class, trait or enum (the new
//! code becomes a `private` method after it, `static` in a static method,
//! called as `$this->name()` / `self::name()`), a function or the file's
//! top level (a new function after the enclosing function or top-level
//! statement, called as `name()`).
//!
//! What goes in and out comes from the [flow](crate::types::Flow):
//!
//! - **Parameters:** the variables the selection uses that hold a value
//!   where it starts (the flow's environment at a probe placed there),
//!   unless the selection first assigns them outright (`$x = …;` as one of
//!   its own statements, the value not reading `$x`). Typed with the type
//!   they have there, when it can be written natively.
//! - **Results:** the variables the selection writes that are read after
//!   it (or anywhere in a loop around it, which runs it again). One is
//!   returned and assigned back (`$x = name(…);`); several are returned as
//!   an array and taken apart (`[$a, $b] = name(…);`, `list()` before PHP
//!   7.1). The return type is the result's type at the selection's end,
//!   `void` without results, `array` for several.
//! - **Expressions** are returned (`return …;`, typed with the
//!   expression's type) and replaced by the call; they must not write.
//!
//! Refused: `return` anywhere but as the last statement of the function's
//! own body (an early return; the last one is kept, the call returned),
//! `break`/`continue` leaving the selection, `yield`, `goto`, references
//! (`&`), `global`/`static`, declarations, `$$name`, `$this` outside a
//! method, closures and arrow functions as the enclosing scope, a result
//! that might not be defined at the end, and functions whose variables the
//! flow can't follow (`extract`, `compact`, …).
//!
//! The new name is `extracted` (numbered when taken); the editor renames it
//! in place afterwards. The rules are our own, after IntelliJ's documented
//! Extract Method behaviour.

use std::collections::BTreeMap;
use std::path::Path;

use ide_core::TextEdit;
use mago_span::HasSpan;
use mago_syntax::cst::{
    ArrowFunction, Assignment, AssignmentOperator, Expression, Function, Literal, Method, MethodBody, Modifier, Node,
    NodeKind, Statement, Variable,
};

use super::{chosen, contains, expression, in_write_context, is_statement_list, is_trivial, names, span_of};
use crate::engine::PhpEngine;
use crate::imports::{ImportAction, file_edit};
use crate::inspect::fixes::{indent_unit, line_indent, native_type, newline};
use crate::names::{FileNames, NameKind};
use crate::navigate::enclosing_class;
use crate::stubs::PhpVersion;
use crate::summary::{ClassKind, FileSummary};
use crate::syntax::ParsedFile;
use crate::types::{Context, Defined, ExprTypes, Frame, LazyType, PROBE_VARIABLE, Type, VarState};

/// The code action kind of Extract function (in functions and top-level
/// code).
pub const EXTRACT_FUNCTION: &str = "refactor.extract.function";
/// The code action kind of Extract method (in methods).
pub const EXTRACT_METHOD: &str = "refactor.extract.method";

const NEW_NAME: &str = "extracted";

/// The variables of a scope at one point.
type Env = BTreeMap<Vec<u8>, VarState>;

/// Variables every scope has.
pub(super) const SUPERGLOBALS: &[&str] =
    &["GLOBALS", "_SERVER", "_GET", "_POST", "_FILES", "_COOKIE", "_SESSION", "_REQUEST", "_ENV"];

/// Where the selection is.
#[derive(Clone, Copy)]
pub(super) enum Scope<'a> {
    Method(&'a Method<'a>),
    Function(&'a Function<'a>),
    TopLevel,
}

/// One use of a variable.
#[derive(Clone)]
pub(super) struct Occurrence<'a> {
    /// Without `$`.
    pub(super) name: String,
    /// The `$`.
    pub(super) offset: u32,
    /// The arrow functions it is inside (their flows record it).
    pub(super) arrows: Vec<&'a ArrowFunction<'a>>,
}

/// What a walk over some code found.
#[derive(Default)]
pub(super) struct Walk<'a> {
    pub(super) occurrences: Vec<Occurrence<'a>>,
    pub(super) uses_this: bool,
    /// Spans of `return` statements.
    pub(super) returns: Vec<(u32, u32)>,
    /// Something that can't move into another function.
    pub(super) refused: bool,
    /// Assignments, `++`/`--`.
    pub(super) writes: bool,
    /// Spans of string literals (their lines aren't re-indented).
    pub(super) strings: Vec<(u32, u32)>,
}

pub(super) fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn loop_level(level: Option<&Expression<'_>>) -> Option<u64> {
    match level {
        None => Some(1),
        Some(Expression::Literal(Literal::Integer(integer))) => integer.value,
        Some(_) => None,
    }
}

impl<'a> Walk<'a> {
    pub(super) fn of(nodes: impl IntoIterator<Item = Node<'a, 'a>>) -> Self {
        let mut walk = Walk::default();
        for node in nodes {
            walk.node(node, 0, &mut Vec::new());
        }
        walk
    }

    fn children(&mut self, node: Node<'a, 'a>, loops: u64, arrows: &mut Vec<&'a ArrowFunction<'a>>) {
        for child in node.children() {
            self.node(child, loops, arrows);
        }
    }

    fn node(&mut self, node: Node<'a, 'a>, loops: u64, arrows: &mut Vec<&'a ArrowFunction<'a>>) {
        match node {
            Node::DirectVariable(variable) => {
                let name = lossy(variable.name.strip_prefix(b"$").unwrap_or(variable.name));
                if name == "this" {
                    self.uses_this = true;
                    return;
                }
                let parameter = arrows
                    .iter()
                    .any(|arrow| arrow.parameter_list.parameters.iter().any(|p| p.variable.name == variable.name));
                if parameter || SUPERGLOBALS.contains(&name.as_str()) {
                    return;
                }
                self.occurrences.push(Occurrence { name, offset: variable.span.start.offset, arrows: arrows.clone() });
            }
            Node::IndirectVariable(_) | Node::NestedVariable(_) => self.refused = true,
            Node::Closure(closure) => {
                // Only the captures belong to this scope.
                if let Some(clause) = &closure.use_clause {
                    for captured in clause.variables.iter() {
                        if captured.ampersand.is_some() {
                            self.refused = true;
                        }
                        self.node(Node::DirectVariable(&captured.variable), loops, arrows);
                    }
                }
                if closure.r#static.is_none() {
                    let mut inner = Walk::default();
                    inner.node(Node::Block(&closure.body), 0, &mut Vec::new());
                    self.uses_this |= inner.uses_this;
                }
            }
            Node::ArrowFunction(arrow) => {
                arrows.push(arrow);
                self.node(Node::Expression(arrow.expression), loops, arrows);
                arrows.pop();
            }
            Node::Function(_)
            | Node::Class(_)
            | Node::Interface(_)
            | Node::Trait(_)
            | Node::Enum(_)
            | Node::AnonymousClass(_)
            | Node::Goto(_)
            | Node::Label(_)
            | Node::Global(_)
            | Node::Static(_)
            | Node::HaltCompiler(_)
            | Node::Inline(_)
            | Node::OpeningTag(_)
            | Node::ClosingTag(_)
            | Node::EchoTag(_)
            | Node::Yield(_) => self.refused = true,
            Node::Namespace(_) | Node::Use(_) | Node::Constant(_) | Node::Declare(_) => {
                self.refused = true;
                self.children(node, loops, arrows);
            }
            Node::Return(_) => {
                self.returns.push(span_of(&node));
                self.children(node, loops, arrows);
            }
            Node::Break(jump) => {
                if loop_level(jump.level).is_none_or(|level| level > loops) {
                    self.refused = true;
                }
            }
            Node::Continue(jump) => {
                if loop_level(jump.level).is_none_or(|level| level > loops) {
                    self.refused = true;
                }
            }
            Node::While(_) | Node::DoWhile(_) | Node::For(_) | Node::Foreach(_) | Node::Switch(_) => {
                self.children(node, loops + 1, arrows);
            }
            Node::UnaryPrefix(unary) => {
                if unary.operator.is_reference() {
                    self.refused = true;
                }
                if unary.operator.is_increment_or_decrement() {
                    self.writes = true;
                }
                self.children(node, loops, arrows);
            }
            Node::UnaryPostfix(_) | Node::Assignment(_) => {
                self.writes = true;
                self.children(node, loops, arrows);
            }
            Node::Expression(Expression::Literal(Literal::String(_)) | Expression::CompositeString(_)) => {
                self.strings.push(span_of(&node));
                self.children(node, loops, arrows);
            }
            _ => self.children(node, loops, arrows),
        }
    }
}

/// The enclosing scope and its index in `nodes`; `None` inside closures,
/// arrow functions, anonymous classes and interfaces.
pub(super) fn scope_of<'a>(nodes: &[Node<'a, 'a>]) -> Option<(Scope<'a>, usize)> {
    for (i, node) in nodes.iter().enumerate().rev() {
        match node {
            Node::Closure(_) | Node::ArrowFunction(_) | Node::AnonymousClass(_) => return None,
            Node::Method(method) => {
                let class = nodes[..i].iter().rev().find(|n| {
                    matches!(
                        n.kind(),
                        NodeKind::Class
                            | NodeKind::Interface
                            | NodeKind::Trait
                            | NodeKind::Enum
                            | NodeKind::AnonymousClass
                    )
                })?;
                return matches!(class.kind(), NodeKind::Class | NodeKind::Trait | NodeKind::Enum)
                    .then_some((Scope::Method(method), i));
            }
            Node::Function(function) => return Some((Scope::Function(function), i)),
            _ => {}
        }
    }
    Some((Scope::TopLevel, 0))
}

/// The statements of the innermost statement list around the selection
/// whose run spans it exactly: the list's index in `nodes` and the
/// statements.
fn selected_statements<'a>(
    nodes: &[Node<'a, 'a>],
    from: usize,
    selection: (u32, u32),
) -> Option<(usize, Vec<&'a Statement<'a>>)> {
    let j = (from..nodes.len()).rev().find(|&j| is_statement_list(nodes[j].kind()))?;
    let statements: Vec<&'a Statement<'a>> = nodes[j]
        .children()
        .into_iter()
        .filter_map(|child| match child {
            Node::Statement(statement) => Some(statement),
            _ => None,
        })
        .collect();
    let first = statements.iter().position(|s| s.span().start.offset == selection.0)?;
    let last = statements.iter().position(|s| s.span().end.offset == selection.1)?;
    (first <= last).then(|| (j, statements[first..=last].to_vec()))
}

/// `$x = …;` assigning the whole variable with `=`: its name.
pub(super) fn plain_assignment<'a>(statement: &'a Statement<'a>) -> Option<(&'a [u8], &'a Assignment<'a>)> {
    let Statement::Expression(statement) = statement else { return None };
    let Expression::Assignment(assignment) = statement.expression else { return None };
    let Expression::Variable(Variable::Direct(variable)) = assignment.lhs else { return None };
    matches!(assignment.operator, AssignmentOperator::Assign(_)).then_some((variable.name, assignment))
}

pub(super) fn is_static(method: &Method<'_>) -> bool {
    method.modifiers.iter().any(|modifier| matches!(modifier, Modifier::Static(_)))
}

/// The names in first-use order, once each.
pub(super) fn first_use_order<'o>(occurrences: impl IntoIterator<Item = &'o Occurrence<'o>>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for occurrence in occurrences {
        if !out.contains(&occurrence.name) {
            out.push(occurrence.name.clone());
        }
    }
    out
}

/// `text[start..end]` re-indented from the indentation of the line it
/// starts on to `indent` (the first line gets `indent` too). Lines inside
/// strings and lines not starting with the old indentation stay as they
/// are.
pub(super) fn reindent(text: &str, start: u32, end: u32, indent: &str, strings: &[(u32, u32)]) -> String {
    let old = line_indent(text, start);
    let mut out = String::from(indent);
    let mut at = start as usize;
    for (i, line) in text[start as usize..end as usize].split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
            let in_string = strings.iter().any(|&(s, e)| (s as usize) < at && at < e as usize);
            if in_string {
                out.push_str(line);
            } else if line.trim().is_empty() {
                out.push_str(line.trim_start_matches([' ', '\t']));
            } else if let Some(rest) = line.strip_prefix(old) {
                out.push_str(indent);
                out.push_str(rest);
            } else {
                out.push_str(line);
            }
        } else {
            out.push_str(line);
        }
        at += line.len() + 1;
    }
    out
}

/// The variables at the start and the end of the statements `start..end`,
/// from probes placed there.
fn environments(engine: &PhpEngine, parsed: &ParsedFile, start: u32, end: u32) -> Option<(Env, Env)> {
    let text = parsed.text();
    let probe = format!("${};", String::from_utf8_lossy(PROBE_VARIABLE));
    let first = format!("{probe} ");
    let second = format!(" {probe}");
    let probed = format!(
        "{}{first}{}{second}{}",
        &text[..start as usize],
        &text[start as usize..end as usize],
        &text[end as usize..]
    );
    let probed = ParsedFile::parse("extract.php", probed);
    let names = FileNames::resolve(&probed);
    let summary = FileSummary::extract(&probed);
    let resolver = engine.resolver();
    let types = ExprTypes::new(&probed, &names, &summary, &resolver);
    let at = |offset: u32| {
        let located = types.locate(offset);
        let (_, frames) = located.variable.filter(|(v, _)| v.span.start.offset == offset)?;
        types.flow(&frames).variables_at(offset).cloned()
    };
    let before = at(start)?;
    let after = at(end + first.len() as u32 + 1)?;
    Some((before, after))
}

/// The Extract method / function action for the selection, if it can be
/// extracted.
pub(super) fn extract_method(
    engine: &PhpEngine,
    parsed: &ParsedFile,
    path: &Path,
    summary: &FileSummary,
    nodes: &[Node<'_, '_>],
    selection: (u32, u32),
) -> Option<ImportAction> {
    if selection.0 == selection.1 {
        return None;
    }
    let text = parsed.text();
    let (scope, scope_at) = scope_of(nodes)?;
    let level = engine.language_level();
    let file_names = FileNames::resolve(parsed);
    let names_scope = file_names.scope_at(selection.0);
    let resolver = engine.resolver();
    let class = match scope {
        Scope::Method(method) => Some(enclosing_class(summary, method.span().start.offset)?),
        _ => None,
    };
    if class.is_some_and(|c| !matches!(c.kind, ClassKind::Class | ClassKind::Trait | ClassKind::Enum)) {
        return None;
    }
    let context = class.map(|c| Context::in_class(&c.fqn)).unwrap_or_default();
    let frames: Vec<Frame<'_>> = match scope {
        Scope::Method(method) => vec![Frame::Class(class.map(|c| c.fqn.clone())), Frame::Method(method)],
        Scope::Function(function) => vec![Frame::Function(function)],
        Scope::TopLevel => Vec::new(),
    };
    let types = ExprTypes::new(parsed, &file_names, summary, &resolver);
    let flow = types.flow(&frames);
    if flow.is_dynamic() {
        return None;
    }
    let resolved = |ty: &Type| resolver.resolve(&LazyType::Known(ty.clone()), &context).widen();
    let hint = |ty: &Type| -> Option<String> {
        if level < PhpVersion::new(7, 0) || matches!(ty, Type::Mixed) {
            return None;
        }
        native_type(ty, names_scope, level)
    };

    let list_from = if matches!(scope, Scope::TopLevel) { 0 } else { scope_at + 1 };
    let statements = selected_statements(nodes, list_from, selection);

    // What goes in, what comes out, the body and the call.
    let mut params: Vec<(String, Option<String>)> = Vec::new();
    let body: String;
    let return_type: Option<String>;
    let call_form: CallForm;
    let walk;
    let nl = newline(text);
    let unit = indent_unit(text);

    // Where the new declaration goes and its indentation.
    let (insert_at, decl_indent) = match scope {
        Scope::Method(method) => (method.span().end.offset, line_indent(text, method.span().start.offset).to_owned()),
        Scope::Function(function) => {
            (function.span().end.offset, line_indent(text, function.span().start.offset).to_owned())
        }
        Scope::TopLevel => {
            let mut top = nodes.iter().position(|n| matches!(n, Node::Statement(_)));
            if let Some(i) = top
                && let Node::Statement(Statement::Namespace(_)) = nodes[i]
            {
                top = nodes.iter().skip(i + 1).position(|n| matches!(n, Node::Statement(_))).map(|p| p + i + 1);
            }
            match top {
                Some(i) => {
                    let (start, end) = span_of(&nodes[i]);
                    (end, line_indent(text, start).to_owned())
                }
                None => (selection.1, line_indent(text, selection.0).to_owned()),
            }
        }
    };
    let body_indent = format!("{decl_indent}{unit}");

    if let Some((list_at, statements)) = statements {
        walk = Walk::of(statements.iter().map(|s| Node::Statement(s)));
        if walk.refused || (walk.uses_this && class.is_none()) {
            return None;
        }
        // Only a last `return` of the function's own body stays.
        let last = statements[statements.len() - 1];
        let keeps_return = match walk.returns.as_slice() {
            [] => false,
            [only] => {
                let body_list = matches!(
                    (scope, nodes[list_at - 1]),
                    (Scope::Method(_), Node::MethodBody(MethodBody::Concrete(_)))
                        | (Scope::Function(_), Node::Function(_))
                );
                let valued = matches!(last, Statement::Return(r) if r.value.is_some());
                if !(body_list && valued && *only == span_of(&Node::Statement(last))) {
                    return None;
                }
                true
            }
            _ => return None,
        };
        let (before, after) = environments(engine, parsed, selection.0, selection.1)?;
        let state = |env: &Env, name: &str| {
            env.get(name.as_bytes()).cloned().unwrap_or(VarState { ty: Type::Mixed, defined: Defined::No })
        };

        // Variables the selection assigns outright before using them.
        let mut killed: Vec<String> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        for statement in &statements {
            let (from, to) = span_of(&Node::Statement(statement));
            if let Some((name, assignment)) = plain_assignment(statement) {
                let name = lossy(name.strip_prefix(b"$").unwrap_or(name));
                let value = span_of(&Node::Expression(assignment.rhs));
                let reads_itself =
                    walk.occurrences.iter().any(|o| o.name == name && value.0 <= o.offset && o.offset < value.1);
                if !seen.contains(&name) && !reads_itself {
                    killed.push(name);
                }
            }
            for o in walk.occurrences.iter().filter(|o| from <= o.offset && o.offset < to) {
                if !seen.contains(&o.name) {
                    seen.push(o.name.clone());
                }
            }
        }

        // Reads after the selection, or anywhere in a loop around it.
        let scope_node = match scope {
            Scope::Method(method) => Node::MethodBody(&method.body),
            Scope::Function(function) => Node::Block(&function.body),
            Scope::TopLevel => nodes[0],
        };
        let around = Walk::of([scope_node]);
        let loop_span = nodes[scope_at..list_at]
            .iter()
            .find(|n| matches!(n.kind(), NodeKind::While | NodeKind::DoWhile | NodeKind::For | NodeKind::Foreach))
            .map(span_of);
        let read_later = |name: &str| {
            around.occurrences.iter().any(|o| {
                let outside = !(selection.0 <= o.offset && o.offset < selection.1);
                let later =
                    o.offset >= selection.1 || loop_span.is_some_and(|span| contains(span, (o.offset, o.offset)));
                o.name == name
                    && outside
                    && later
                    && (!o.arrows.is_empty() || flow.read_at(o.offset).is_some() || flow.is_binding(o.offset))
            })
        };

        let used = first_use_order(&walk.occurrences);
        let mut outputs: Vec<(String, Type)> = Vec::new();
        for name in &used {
            let defined_before = state(&before, name).defined != Defined::No;
            let input = defined_before && !killed.contains(name);
            if input {
                params.push((name.clone(), hint(&resolved(&state(&before, name).ty))));
            }
            let written = walk
                .occurrences
                .iter()
                .any(|o| &o.name == name && o.arrows.is_empty() && flow.written_at(o.offset).is_some());
            if written && read_later(name) {
                let end = state(&after, name);
                if end.defined != Defined::Yes && !input {
                    return None;
                }
                outputs.push((name.clone(), resolved(&end.ty)));
            }
        }
        if keeps_return && !outputs.is_empty() {
            return None;
        }

        let mut text_body = reindent(text, selection.0, selection.1, &body_indent, &walk.strings);
        match outputs.as_slice() {
            [] => {}
            [(name, _)] => text_body.push_str(&format!("{nl}{nl}{body_indent}return ${name};")),
            many => {
                let list: Vec<String> = many.iter().map(|(n, _)| format!("${n}")).collect();
                text_body.push_str(&format!("{nl}{nl}{body_indent}return [{}];", list.join(", ")));
            }
        }
        body = text_body;
        let typed = level >= PhpVersion::new(7, 0);
        return_type = if keeps_return {
            let hint = match scope {
                Scope::Method(method) => method.return_type_hint.as_ref(),
                Scope::Function(function) => function.return_type_hint.as_ref(),
                Scope::TopLevel => None,
            };
            hint.map(|h| {
                let (s, e) = (h.hint.span().start.offset, h.hint.span().end.offset);
                text[s as usize..e as usize].to_owned()
            })
        } else {
            match outputs.as_slice() {
                [] => (level >= PhpVersion::new(7, 1)).then(|| "void".to_owned()),
                [(_, ty)] => hint(ty),
                _ => typed.then(|| "array".to_owned()),
            }
        };
        call_form = if keeps_return {
            CallForm::Return
        } else {
            match outputs.as_slice() {
                [] => CallForm::Statement,
                [(name, _)] => CallForm::Assign(format!("${name}")),
                many => {
                    let list: Vec<String> = many.iter().map(|(n, _)| format!("${n}")).collect();
                    let list = list.join(", ");
                    CallForm::Assign(if level >= PhpVersion::new(7, 1) {
                        format!("[{list}]")
                    } else {
                        format!("list({list})")
                    })
                }
            }
        };
    } else {
        // One expression.
        let accept = |i: usize| {
            let expr = expression(&nodes[i]);
            i > scope_at
                && !is_trivial(expr)
                && !matches!(expr, Expression::Assignment(_))
                && nodes[scope_at + 1..i].iter().any(|n| matches!(n, Node::Statement(_)))
                && !nodes[scope_at + 1..i].iter().any(|n| {
                    matches!(
                        n.kind(),
                        NodeKind::FunctionLikeParameter
                            | NodeKind::Static
                            | NodeKind::Global
                            | NodeKind::Constant
                            | NodeKind::Declare
                    )
                })
                && !in_write_context(nodes, i, scope_at)
        };
        let i = chosen(nodes, selection, accept)?;
        let expr = expression(&nodes[i]);
        walk = Walk::of([nodes[i]]);
        if walk.refused || walk.writes || !walk.returns.is_empty() || (walk.uses_this && class.is_none()) {
            return None;
        }
        let state_of = |o: &Occurrence<'_>| -> Option<VarState> {
            if o.arrows.is_empty() {
                return flow.read_at(o.offset).cloned();
            }
            let mut inner = frames.clone();
            inner.extend(o.arrows.iter().map(|a| Frame::Arrow(a)));
            types.flow(&inner).read_at(o.offset).cloned()
        };
        for name in first_use_order(&walk.occurrences) {
            let found = walk
                .occurrences
                .iter()
                .filter(|o| o.name == name)
                .filter_map(&state_of)
                .find(|s| s.defined != Defined::No);
            if let Some(found) = found {
                params.push((name, hint(&resolved(&found.ty))));
            }
        }
        let ty = types.type_of(expr, &frames).widen();
        if matches!(ty, Type::Void | Type::Never) {
            return None;
        }
        let (start, end) = span_of(&nodes[i]);
        let value = reindent(text, start, end, &body_indent, &walk.strings);
        body = format!("{body_indent}return {};", value.trim_start());
        return_type = hint(&resolved(&ty));
        call_form = CallForm::Expression;
    }

    // The name.
    let (name, kind, title, header) = match scope {
        Scope::Method(method) => {
            let class = class?;
            let model = resolver.class_model(&class.fqn);
            let name = names::unique(&[NEW_NAME.to_owned()], |n| {
                class.methods.iter().any(|m| m.name.eq_ignore_ascii_case(n))
                    || model.as_ref().is_some_and(|m| m.method(n).is_some())
            });
            let static_ = is_static(method);
            let modifiers = if static_ { "private static function" } else { "private function" };
            (name, EXTRACT_METHOD, "Extract method", (modifiers, if static_ { "self::" } else { "$this->" }))
        }
        Scope::Function(_) | Scope::TopLevel => {
            let namespace = names_scope.namespace().to_owned();
            let name = names::unique(&[NEW_NAME.to_owned()], |n| {
                let fqn = if namespace.is_empty() { n.to_owned() } else { format!("{namespace}\\{n}") };
                summary.functions.iter().any(|f| f.fqn.trim_start_matches('\\').eq_ignore_ascii_case(&fqn))
                    || engine.declares(NameKind::Function, &fqn)
            });
            (name, EXTRACT_FUNCTION, "Extract function", ("function", ""))
        }
    };
    let (modifiers, receiver) = header;

    let params_text: Vec<String> = params
        .iter()
        .map(|(n, ty)| match ty {
            Some(ty) => format!("{ty} ${n}"),
            None => format!("${n}"),
        })
        .collect();
    let args: Vec<String> = params.iter().map(|(n, _)| format!("${n}")).collect();
    let call = format!("{receiver}{name}({})", args.join(", "));
    let call = match call_form {
        CallForm::Expression => call,
        CallForm::Statement => format!("{call};"),
        CallForm::Assign(target) => format!("{target} = {call};"),
        CallForm::Return => format!("return {call};"),
    };
    let return_text = return_type.map(|ty| format!(": {ty}")).unwrap_or_default();
    let declaration = format!(
        "{nl}{nl}{decl_indent}{modifiers} {name}({}){return_text}{nl}{decl_indent}{{{nl}{body}{nl}{decl_indent}}}",
        params_text.join(", ")
    );
    let index = parsed.line_index();
    let edits = if insert_at == selection.1 {
        vec![TextEdit { range: index.range(selection.0, selection.1), new_text: format!("{call}{declaration}") }]
    } else {
        vec![
            TextEdit { range: index.range(selection.0, selection.1), new_text: call },
            TextEdit { range: index.range(insert_at, insert_at), new_text: declaration },
        ]
    };
    Some(ImportAction { title: title.into(), kind, preferred: false, edit: file_edit(path, edits) })
}

/// How the call replaces the selection.
enum CallForm {
    /// An expression: the call alone.
    Expression,
    /// `name(…);`
    Statement,
    /// `$x = name(…);` / `[$a, $b] = name(…);`
    Assign(String),
    /// `return name(…);`
    Return,
}
