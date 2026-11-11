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
//! (or closure's) own body (an early return; the last one is kept, the call
//! returned), `break`/`continue` leaving the selection, `yield`, `goto`,
//! references (`&`), `global`/`static`, declarations, `$$name`, `$this`
//! outside a method or in a static context, anonymous classes around the
//! code, a result that might not be defined at the end, and functions whose
//! variables the flow can't follow (`extract`, `compact`, …).
//!
//! **Closures and arrow functions** can be the scope the code is taken
//! from: their variables (parameters, `use` captures) are the inputs, and
//! the new method goes after the method around them (the new function after
//! the function or top-level statement), static when a static closure is in
//! between. An arrow function's body is an expression, so only expressions
//! are taken from it.
//!
//! The new name is `extracted` (numbered when taken). The code action
//! applies the defaults and the editor renames it in place afterwards; the
//! editor's Extract Method dialog ([`ExtractMethod`], resolved by
//! [`PhpEngine::extract_method_edit`]) chooses the name, the parameters
//! (renamed, reordered, excluded), the visibility, `static` and the return
//! type, and whether **duplicates** are replaced: other copies of the code
//! in the class (the file, for a function) that are the same code with the
//! variables renamed one to one and that take the same parameters and give
//! the same results, replaced by the call with their own variables. The
//! rules are our own, after IntelliJ's documented Extract Method behaviour.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use ide_core::{DocId, IdeError, IdeResult, Range, TextEdit, WorkspaceEdit};
use mago_span::HasSpan;
use mago_syntax::cst::{
    ArrowFunction, Assignment, AssignmentOperator, Closure, Expression, Function, Literal, Method, MethodBody,
    Modifier, Node, NodeKind, Statement, Variable,
};
use serde::{Deserialize, Serialize};

use super::inline::{Splice, spliced};
use super::{
    chosen, contains, expression, in_write_context, is_statement_list, is_trivial, names, path_to, span_of, trimmed,
    visit,
};
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

// ------------------------------------------------------------ the dialog

/// The code action kind of the Extract Method dialog's action: it carries
/// an [`ExtractMethod`] as its data and no edit, and the editor's dialog
/// has it resolved with the choice.
pub const EXTRACT_METHOD_DIALOG: &str = "refactor.extract.method.dialog";

/// One parameter of the new method or function.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtractParameter {
    /// The variable it is in the selection, without `$`.
    pub old_name: String,
    /// Its name in the new declaration, without `$`.
    pub name: String,
    /// The type as written; empty for none.
    #[serde(rename = "type")]
    pub ty: String,
    /// Passed (an excluded one is left undefined in the new body).
    pub included: bool,
}

/// What the dialog chose.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtractChoice {
    pub name: String,
    /// In the new order.
    pub parameters: Vec<ExtractParameter>,
    /// As written; empty for none.
    pub return_type: String,
    /// `private`, `protected` or `public` (methods).
    pub visibility: String,
    /// A static method (methods).
    #[serde(rename = "static")]
    pub is_static: bool,
    /// Also replace the duplicates of the code.
    pub replace_duplicates: bool,
}

/// The `data` of the Extract Method dialog's action: the defaults, and the
/// choice the dialog fills in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractMethod {
    /// The selection.
    pub range: Range,
    /// A function (no visibility or `static`), not a method.
    pub function: bool,
    /// The class the method goes in (`Shop`), empty for a function.
    pub class_name: String,
    /// The defaults.
    pub defaults: ExtractChoice,
    /// The method has to be static (a static method or closure around the
    /// code).
    pub static_required: bool,
    /// The method can't be static (the code uses `$this`).
    pub uses_this: bool,
    /// How many duplicates of the code the class (the file, for a
    /// function) holds.
    pub duplicates: u32,
    /// Filled in by the dialog.
    #[serde(default)]
    pub change: Option<ExtractChoice>,
}

// ------------------------------------------------------------ the plan

/// A closure or arrow function around the selection.
#[derive(Clone, Copy)]
enum Inner<'a> {
    Closure(&'a Closure<'a>),
    Arrow(&'a ArrowFunction<'a>),
}

/// Where the selection is: the declaration the new code goes after, and
/// the closures and arrow functions between it and the selection.
struct Place<'a> {
    host: Scope<'a>,
    host_at: usize,
    chain: Vec<(usize, Inner<'a>)>,
    class_at: Option<usize>,
}

fn place_of<'a>(nodes: &[Node<'a, 'a>], selection: (u32, u32)) -> Option<Place<'a>> {
    let mut place = Place { host: Scope::TopLevel, host_at: 0, chain: Vec::new(), class_at: None };
    for (i, node) in nodes.iter().enumerate() {
        // The selected code itself isn't a scope around it.
        if i > 0 && span_of(node) == selection {
            break;
        }
        match node {
            Node::AnonymousClass(_) | Node::Interface(_) => return None,
            Node::Class(_) | Node::Trait(_) | Node::Enum(_) => place.class_at = Some(i),
            Node::Method(method) => {
                place.host = Scope::Method(method);
                place.host_at = i;
                place.chain.clear();
            }
            Node::Function(function) => {
                place.host = Scope::Function(function);
                place.host_at = i;
                place.chain.clear();
            }
            Node::Closure(closure) => place.chain.push((i, Inner::Closure(closure))),
            Node::ArrowFunction(arrow) => place.chain.push((i, Inner::Arrow(arrow))),
            _ => {}
        }
    }
    if matches!(place.host, Scope::Method(_)) && place.class_at.is_none() {
        return None;
    }
    Some(place)
}

/// How the call replaces the selection.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CallForm {
    /// An expression: the call alone.
    Expression,
    /// `name(…);`
    Statement,
    /// `$x = name(…);` / `[$a, $b] = name(…);`
    Assign,
    /// `return name(…);`
    Return,
}

/// What Extract method found for one selection.
struct Plan {
    kind: &'static str,
    title: &'static str,
    function: bool,
    class_fqn: Option<String>,
    namespace: String,
    /// The bytes the call replaces.
    selection: (u32, u32),
    /// How many statements are selected (0 for an expression).
    statements: usize,
    params: Vec<(String, Option<String>)>,
    outputs: Vec<String>,
    return_type: Option<String>,
    call_form: CallForm,
    /// `[$a, $b] = …` rather than `list($a, $b) = …`.
    short_list: bool,
    static_only: bool,
    uses_this: bool,
    insert_at: u32,
    decl_indent: String,
    body_indent: String,
    nl: &'static str,
    strings: Vec<(u32, u32)>,
    /// The variables of the selection and where they are.
    occurrences: Vec<(String, u32)>,
    name: String,
    /// Where duplicates are looked for.
    region: (u32, u32),
}

/// Another copy of the selected code.
struct Duplicate {
    span: (u32, u32),
    /// The selection's variables to the copy's.
    names: Vec<(String, String)>,
    static_only: bool,
}

/// The analysis of the selection, `None` when it can't be extracted.
fn analyze(
    engine: &PhpEngine,
    parsed: &ParsedFile,
    summary: &FileSummary,
    nodes: &[Node<'_, '_>],
    selection: (u32, u32),
) -> Option<Plan> {
    if selection.0 == selection.1 {
        return None;
    }
    let text = parsed.text();
    let place = place_of(nodes, selection)?;
    let scope = place.host;
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
    let mut frames: Vec<Frame<'_>> = match scope {
        Scope::Method(method) => vec![Frame::Class(class.map(|c| c.fqn.clone())), Frame::Method(method)],
        Scope::Function(function) => vec![Frame::Function(function)],
        Scope::TopLevel => Vec::new(),
    };
    for (_, inner) in &place.chain {
        frames.push(match inner {
            Inner::Closure(closure) => Frame::Closure(closure),
            Inner::Arrow(arrow) => Frame::Arrow(arrow),
        });
    }
    let static_only = matches!(scope, Scope::Method(method) if is_static(method))
        || place.chain.iter().any(|(_, inner)| match inner {
            Inner::Closure(closure) => closure.r#static.is_some(),
            Inner::Arrow(arrow) => arrow.r#static.is_some(),
        });
    let (inner_at, inner) = match place.chain.last() {
        Some(&(at, inner)) => (at, Some(inner)),
        None => (place.host_at, None),
    };
    let types = ExprTypes::new(parsed, &file_names, summary, &resolver);
    let flow = types.flow(&frames);
    if flow.is_dynamic() {
        return None;
    }
    let typed = level >= PhpVersion::new(7, 0);
    let resolved = |ty: &Type| resolver.resolve(&LazyType::Known(ty.clone()), &context).widen();
    let hint = |ty: &Type| -> Option<String> {
        if !typed || matches!(ty, Type::Mixed) {
            return None;
        }
        native_type(ty, names_scope, level)
    };

    let list_from = if matches!(scope, Scope::TopLevel) && inner.is_none() { 0 } else { inner_at + 1 };
    let statements =
        if matches!(inner, Some(Inner::Arrow(_))) { None } else { selected_statements(nodes, list_from, selection) };

    let mut params: Vec<(String, Option<String>)> = Vec::new();
    let mut outputs: Vec<String> = Vec::new();
    let return_type: Option<String>;
    let call_form: CallForm;
    let walk;
    let replaced: (u32, u32);
    let statement_count;
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
        if walk.refused || (walk.uses_this && (class.is_none() || static_only)) {
            return None;
        }
        replaced = selection;
        statement_count = statements.len();
        // Only a last `return` of the function's own body stays.
        let last = statements[statements.len() - 1];
        let keeps_return = match walk.returns.as_slice() {
            [] => false,
            [only] => {
                let body_list = match (inner, nodes[list_at - 1]) {
                    (Some(Inner::Closure(_)), Node::Closure(_)) => true,
                    (None, Node::MethodBody(MethodBody::Concrete(_))) => matches!(scope, Scope::Method(_)),
                    (None, Node::Function(_)) => matches!(scope, Scope::Function(_)),
                    _ => false,
                };
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
        let scope_node = match inner {
            Some(Inner::Closure(closure)) => Node::Block(&closure.body),
            Some(Inner::Arrow(_)) => return None,
            None => match scope {
                Scope::Method(method) => Node::MethodBody(&method.body),
                Scope::Function(function) => Node::Block(&function.body),
                Scope::TopLevel => nodes[0],
            },
        };
        let around = Walk::of([scope_node]);
        let loop_span = nodes[inner_at..list_at]
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
        let mut typed_outputs: Vec<(String, Type)> = Vec::new();
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
                typed_outputs.push((name.clone(), resolved(&end.ty)));
            }
        }
        if keeps_return && !typed_outputs.is_empty() {
            return None;
        }
        return_type = if keeps_return {
            let hint = match (inner, scope) {
                (Some(Inner::Closure(closure)), _) => closure.return_type_hint.as_ref(),
                (_, Scope::Method(method)) => method.return_type_hint.as_ref(),
                (_, Scope::Function(function)) => function.return_type_hint.as_ref(),
                _ => None,
            };
            hint.map(|h| {
                let (s, e) = (h.hint.span().start.offset, h.hint.span().end.offset);
                text[s as usize..e as usize].to_owned()
            })
        } else {
            match typed_outputs.as_slice() {
                [] => (level >= PhpVersion::new(7, 1)).then(|| "void".to_owned()),
                [(_, ty)] => hint(ty),
                _ => typed.then(|| "array".to_owned()),
            }
        };
        call_form = if keeps_return {
            CallForm::Return
        } else if typed_outputs.is_empty() {
            CallForm::Statement
        } else {
            CallForm::Assign
        };
        outputs = typed_outputs.into_iter().map(|(n, _)| n).collect();
    } else {
        // One expression.
        let accept = |i: usize| {
            let expr = expression(&nodes[i]);
            let in_body = i > inner_at
                && match inner {
                    Some(Inner::Arrow(arrow)) => {
                        contains(span_of(&Node::Expression(arrow.expression)), span_of(&nodes[i]))
                    }
                    _ => nodes[inner_at + 1..i].iter().any(|n| matches!(n, Node::Statement(_))),
                };
            in_body
                && !is_trivial(expr)
                && !matches!(expr, Expression::Assignment(_))
                && !nodes[inner_at + 1..i].iter().any(|n| {
                    matches!(
                        n.kind(),
                        NodeKind::FunctionLikeParameter
                            | NodeKind::Static
                            | NodeKind::Global
                            | NodeKind::Constant
                            | NodeKind::Declare
                    )
                })
                && !in_write_context(nodes, i, inner_at)
        };
        let i = chosen(nodes, selection, accept)?;
        let expr = expression(&nodes[i]);
        walk = Walk::of([nodes[i]]);
        if walk.refused
            || walk.writes
            || !walk.returns.is_empty()
            || (walk.uses_this && (class.is_none() || static_only))
        {
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
        replaced = span_of(&nodes[i]);
        statement_count = 0;
        return_type = hint(&resolved(&ty));
        call_form = CallForm::Expression;
    }

    let function = !matches!(scope, Scope::Method(_));
    let region = match place.class_at {
        Some(at) if !function => span_of(&nodes[at]),
        _ => (0, text.len() as u32),
    };
    let mut plan = Plan {
        kind: if function { EXTRACT_FUNCTION } else { EXTRACT_METHOD },
        title: if function { "Extract function" } else { "Extract method" },
        function,
        class_fqn: class.map(|c| c.fqn.clone()),
        namespace: names_scope.namespace().to_owned(),
        selection: replaced,
        statements: statement_count,
        params,
        outputs,
        return_type,
        call_form,
        short_list: level >= PhpVersion::new(7, 1),
        static_only,
        uses_this: walk.uses_this,
        insert_at,
        decl_indent,
        body_indent,
        nl,
        strings: walk.strings.clone(),
        occurrences: walk.occurrences.iter().map(|o| (o.name.clone(), o.offset)).collect(),
        name: String::new(),
        region,
    };
    plan.name = names::unique(&[NEW_NAME.to_owned()], |n| plan.name_taken(engine, summary, n));
    Some(plan)
}

/// One included parameter of a checked choice.
struct CheckedParameter<'c> {
    old_name: &'c str,
    name: String,
    ty: &'c str,
}

/// A checked [`ExtractChoice`]: only the included parameters, trimmed.
struct Checked<'c> {
    name: String,
    parameters: Vec<CheckedParameter<'c>>,
    /// Every parameter's new name, by old name (excluded ones keep theirs).
    renames: Vec<(String, String)>,
    return_type: &'c str,
    visibility: &'c str,
    is_static: bool,
    replace_duplicates: bool,
}

impl Checked<'_> {
    fn renamed(&self, name: &str) -> String {
        self.renames.iter().find(|(old, _)| old == name).map_or_else(|| name.to_owned(), |(_, new)| new.clone())
    }
}

impl Plan {
    /// Whether the class (or namespace) already has a method (function)
    /// named `name`.
    fn name_taken(&self, engine: &PhpEngine, summary: &FileSummary, name: &str) -> bool {
        match &self.class_fqn {
            Some(fqn) => {
                let class = summary.class_likes.iter().find(|c| c.fqn == *fqn);
                class.is_some_and(|c| c.methods.iter().any(|m| m.name.eq_ignore_ascii_case(name)))
                    || engine.resolver().class_model(fqn).is_some_and(|m| m.method(name).is_some())
            }
            None => {
                let fqn =
                    if self.namespace.is_empty() { name.to_owned() } else { format!("{}\\{name}", self.namespace) };
                summary.functions.iter().any(|f| f.fqn.trim_start_matches('\\').eq_ignore_ascii_case(&fqn))
                    || engine.declares(NameKind::Function, &fqn)
            }
        }
    }

    /// What the quick action does: the defaults, without the duplicates.
    fn defaults(&self) -> ExtractChoice {
        ExtractChoice {
            name: self.name.clone(),
            parameters: self
                .params
                .iter()
                .map(|(name, ty)| ExtractParameter {
                    old_name: name.clone(),
                    name: name.clone(),
                    ty: ty.clone().unwrap_or_default(),
                    included: true,
                })
                .collect(),
            return_type: self.return_type.clone().unwrap_or_default(),
            visibility: if self.function { String::new() } else { "private".to_owned() },
            is_static: !self.function && self.static_only,
            replace_duplicates: false,
        }
    }

    /// Checks `choice` against the plan.
    fn check<'c>(
        &self,
        engine: &PhpEngine,
        summary: &FileSummary,
        choice: &'c ExtractChoice,
    ) -> IdeResult<Checked<'c>> {
        let invalid = |message: String| Err(IdeError::invalid(message));
        let name = choice.name.trim();
        if !names::is_identifier(name) || (self.function && names::is_keyword(name)) {
            return invalid(format!("'{name}' is not a valid name"));
        }
        if self.name_taken(engine, summary, name) {
            return invalid(if self.function {
                format!("A function named '{name}' already exists")
            } else {
                format!("The class already has a method named '{name}'")
            });
        }
        let mut old: Vec<&str> = choice.parameters.iter().map(|p| p.old_name.as_str()).collect();
        let mut wanted: Vec<&str> = self.params.iter().map(|(n, _)| n.as_str()).collect();
        old.sort_unstable();
        wanted.sort_unstable();
        if old != wanted {
            return invalid("The parameters don't match the selection; open the dialog again".to_owned());
        }
        let mut parameters: Vec<CheckedParameter<'c>> = Vec::new();
        let mut renames: Vec<(String, String)> = Vec::new();
        for p in choice.parameters.iter().filter(|p| p.included) {
            let param = p.name.trim().trim_start_matches('$');
            if !names::is_identifier(param) || param == "this" {
                return invalid(format!("'${param}' is not a valid parameter name"));
            }
            if parameters.iter().any(|q| q.name == param) {
                return invalid(format!("There are two parameters named '${param}'"));
            }
            if param != p.old_name && self.occurrences.iter().any(|(n, _)| n == param) {
                return invalid(format!("'${param}' is already used by the extracted code"));
            }
            renames.push((p.old_name.clone(), param.to_owned()));
            parameters.push(CheckedParameter { old_name: &p.old_name, name: param.to_owned(), ty: p.ty.trim() });
        }
        let visibility = if self.function {
            ""
        } else {
            match choice.visibility.trim() {
                v @ ("private" | "protected" | "public") => v,
                other => return invalid(format!("'{other}' is not a visibility")),
            }
        };
        let is_static = !self.function && choice.is_static;
        if is_static && self.uses_this {
            return invalid("The extracted code uses $this, so the method can't be static".to_owned());
        }
        if !self.function && !is_static && self.static_only {
            return invalid("The code is in a static context, so the method must be static".to_owned());
        }
        Ok(Checked {
            name: name.to_owned(),
            parameters,
            renames,
            return_type: choice.return_type.trim(),
            visibility,
            is_static,
            replace_duplicates: choice.replace_duplicates,
        })
    }

    /// The call replacing code whose variables `rename` names.
    fn call(&self, choice: &Checked<'_>, rename: impl Fn(&str) -> String) -> String {
        let receiver = if self.function {
            ""
        } else if choice.is_static {
            "self::"
        } else {
            "$this->"
        };
        let args: Vec<String> = choice.parameters.iter().map(|p| format!("${}", rename(p.old_name))).collect();
        let call = format!("{receiver}{}({})", choice.name, args.join(", "));
        match self.call_form {
            CallForm::Expression => call,
            CallForm::Statement => format!("{call};"),
            CallForm::Return => format!("return {call};"),
            CallForm::Assign => {
                let list: Vec<String> = self.outputs.iter().map(|n| format!("${}", rename(n))).collect();
                let target = match list.as_slice() {
                    [one] => one.clone(),
                    _ if self.short_list => format!("[{}]", list.join(", ")),
                    _ => format!("list({})", list.join(", ")),
                };
                format!("{target} = {call};")
            }
        }
    }

    /// The new declaration's body.
    fn body(&self, text: &str, choice: &Checked<'_>) -> String {
        let splices: Vec<Splice> = self
            .occurrences
            .iter()
            .filter(|(name, _)| choice.renamed(name) != *name)
            .map(|(name, at)| Splice {
                start: *at,
                end: at + name.len() as u32 + 1,
                text: format!("${}", choice.renamed(name)),
            })
            .collect();
        let (rendered, map) = spliced(text, splices);
        let strings: Vec<(u32, u32)> = self.strings.iter().map(|&(s, e)| (map(s), map(e))).collect();
        let indent = &self.body_indent;
        let code = reindent(&rendered, map(self.selection.0), map(self.selection.1), indent, &strings);
        if self.call_form == CallForm::Expression {
            return format!("{indent}return {};", code.trim_start());
        }
        let nl = self.nl;
        match self.outputs.as_slice() {
            [] => code,
            [name] => format!("{code}{nl}{nl}{indent}return ${};", choice.renamed(name)),
            many => {
                let list: Vec<String> = many.iter().map(|n| format!("${}", choice.renamed(n))).collect();
                format!("{code}{nl}{nl}{indent}return [{}];", list.join(", "))
            }
        }
    }

    /// The edits for `choice`.
    fn render(&self, parsed: &ParsedFile, choice: &Checked<'_>, duplicates: &[Duplicate]) -> Vec<TextEdit> {
        let text = parsed.text();
        let nl = self.nl;
        let decl_indent = &self.decl_indent;
        let params_text: Vec<String> = choice
            .parameters
            .iter()
            .map(|p| if p.ty.is_empty() { format!("${}", p.name) } else { format!("{} ${}", p.ty, p.name) })
            .collect();
        let modifiers = if self.function {
            "function".to_owned()
        } else if choice.is_static {
            format!("{} static function", choice.visibility)
        } else {
            format!("{} function", choice.visibility)
        };
        let return_text =
            if choice.return_type.is_empty() { String::new() } else { format!(": {}", choice.return_type) };
        let declaration = format!(
            "{nl}{nl}{decl_indent}{modifiers} {}({}){return_text}{nl}{decl_indent}{{{nl}{}{nl}{decl_indent}}}",
            choice.name,
            params_text.join(", "),
            self.body(text, choice)
        );
        let call = self.call(choice, |n| n.to_owned());
        let index = parsed.line_index();
        let mut edits = if self.insert_at == self.selection.1 {
            vec![TextEdit {
                range: index.range(self.selection.0, self.selection.1),
                new_text: format!("{call}{declaration}"),
            }]
        } else {
            vec![
                TextEdit { range: index.range(self.selection.0, self.selection.1), new_text: call },
                TextEdit { range: index.range(self.insert_at, self.insert_at), new_text: declaration },
            ]
        };
        if choice.replace_duplicates {
            for duplicate in duplicates {
                if duplicate.static_only && !choice.is_static && !self.function {
                    continue;
                }
                let call = self.call(choice, |n| {
                    duplicate
                        .names
                        .iter()
                        .find(|(from, _)| from == n)
                        .map_or_else(|| n.to_owned(), |(_, to)| to.clone())
                });
                edits.push(TextEdit { range: index.range(duplicate.span.0, duplicate.span.1), new_text: call });
            }
        }
        edits
    }
}

// ------------------------------------------------------------ duplicates

/// The code of `span` with its variables numbered by first use and blank
/// space outside strings collapsed, and the variables in that order.
fn fingerprint(
    text: &str,
    span: (u32, u32),
    occurrences: &[(String, u32)],
    strings: &[(u32, u32)],
) -> (String, Vec<String>) {
    let mut occurrences: Vec<&(String, u32)> =
        occurrences.iter().filter(|(_, at)| span.0 <= *at && *at < span.1).collect();
    occurrences.sort_by_key(|(_, at)| *at);
    let mut order: Vec<String> = Vec::new();
    let mut out = String::new();
    let mut at = span.0 as usize;
    let mut next = 0;
    let mut space = false;
    while at < span.1 as usize {
        if let Some((name, offset)) = occurrences.get(next)
            && *offset as usize == at
        {
            let index = match order.iter().position(|n| n == name) {
                Some(index) => index,
                None => {
                    order.push(name.clone());
                    order.len() - 1
                }
            };
            if space {
                out.push(' ');
                space = false;
            }
            out.push_str(&format!("${index}"));
            at += name.len() + 1;
            next += 1;
            continue;
        }
        let Some(c) = text[at..].chars().next() else { break };
        let in_string = strings.iter().any(|&(s, e)| (s as usize) < at && at < e as usize);
        if c.is_whitespace() && !in_string {
            space = !out.is_empty();
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
        at += c.len_utf8();
    }
    (out, order)
}

/// The copies of the plan's code in its region (the class, or the file for
/// a function) that the same call can replace: the same code with the
/// variables renamed one to one, taking the same parameters and giving the
/// same results.
fn duplicates(engine: &PhpEngine, parsed: &ParsedFile, summary: &FileSummary, plan: &Plan) -> Vec<Duplicate> {
    let text = parsed.text();
    let program = Node::Program(parsed.program());
    let (wanted, order) = fingerprint(text, plan.selection, &plan.occurrences, &plan.strings);
    let overlaps = |a: (u32, u32), b: (u32, u32)| a.0 < b.1 && b.0 < a.1;
    let candidate = |span: (u32, u32)| contains(plan.region, span) && !overlaps(span, plan.selection);
    let selected_kind = (plan.statements == 0)
        .then(|| {
            let nodes = path_to(program, plan.selection.0, plan.selection.1);
            nodes
                .iter()
                .rev()
                .find(|n| matches!(n, Node::Expression(_)) && span_of(n) == plan.selection)
                .map(|n| n.kind())
        })
        .flatten();
    // Each candidate with the nodes its variables are found in.
    let mut spans: Vec<(u32, u32)> = Vec::new();
    visit(program, &mut |node| {
        if plan.statements == 0 {
            if matches!(node, Node::Expression(_)) && Some(node.kind()) == selected_kind && candidate(span_of(&node)) {
                spans.push(span_of(&node));
            }
        } else if is_statement_list(node.kind()) {
            let statements: Vec<(u32, u32)> =
                node.children().iter().filter(|c| matches!(c, Node::Statement(_))).map(span_of).collect();
            for window in statements.windows(plan.statements) {
                let span = (window[0].0, window[window.len() - 1].1);
                if candidate(span) {
                    spans.push(span);
                }
            }
        }
    });
    let mut out: Vec<Duplicate> = Vec::new();
    for span in spans {
        if out.iter().any(|d| overlaps(d.span, span)) {
            continue;
        }
        let nodes = path_to(program, span.0, span.1);
        let parts: Vec<Node<'_, '_>> = if plan.statements == 0 {
            nodes
                .iter()
                .rev()
                .find(|n| matches!(n, Node::Expression(_)) && span_of(n) == span)
                .copied()
                .into_iter()
                .collect()
        } else {
            let Some(list) = nodes.iter().rev().find(|n| is_statement_list(n.kind())) else { continue };
            list.children()
                .into_iter()
                .filter(|c| matches!(c, Node::Statement(_)) && contains(span, span_of(c)))
                .collect()
        };
        let walk = Walk::of(parts);
        let occurrences: Vec<(String, u32)> = walk.occurrences.iter().map(|o| (o.name.clone(), o.offset)).collect();
        let (found, their_order) = fingerprint(text, span, &occurrences, &walk.strings);
        if found != wanted || their_order.len() != order.len() {
            continue;
        }
        let Some(theirs) = analyze(engine, parsed, summary, &nodes, span) else { continue };
        let names: Vec<(String, String)> = order.iter().cloned().zip(their_order).collect();
        let map = |n: &str| names.iter().find(|(from, _)| from == n).map(|(_, to)| to.clone());
        let mut mine: Vec<Option<String>> = plan.params.iter().map(|(n, _)| map(n)).collect();
        let mut their: Vec<Option<String>> = theirs.params.iter().map(|(n, _)| Some(n.clone())).collect();
        mine.sort();
        their.sort();
        let outputs: Vec<Option<String>> = plan.outputs.iter().map(|n| map(n)).collect();
        let their_outputs: Vec<Option<String>> = theirs.outputs.iter().cloned().map(Some).collect();
        if theirs.function != plan.function
            || theirs.class_fqn != plan.class_fqn
            || theirs.call_form != plan.call_form
            || mine != their
            || outputs != their_outputs
        {
            continue;
        }
        out.push(Duplicate { span, names, static_only: theirs.static_only });
    }
    out
}

// ------------------------------------------------------------ entry points

/// The Extract method / function action for the selection, if it can be
/// extracted, with the defaults (the dialog's action is separate).
pub(super) fn extract_method(
    engine: &PhpEngine,
    parsed: &ParsedFile,
    path: &Path,
    summary: &FileSummary,
    nodes: &[Node<'_, '_>],
    selection: (u32, u32),
) -> Option<ImportAction> {
    let plan = analyze(engine, parsed, summary, nodes, selection)?;
    let defaults = plan.defaults();
    let choice = plan.check(engine, summary, &defaults).ok()?;
    let edits = plan.render(parsed, &choice, &[]);
    Some(ImportAction {
        title: plan.title.into(),
        kind: plan.kind,
        preferred: false,
        edit: file_edit(path, edits),
        open: None,
    })
}

impl PhpEngine {
    /// The plan for a selection of an open document, with the file.
    fn extract_plan(&self, doc: DocId, range: Range) -> Option<(Arc<ParsedFile>, FileSummary, Plan)> {
        let parsed = self.parsed_document(doc)?;
        let summary = FileSummary::extract(&parsed);
        if summary.has_errors {
            return None;
        }
        let (start, end) = parsed.line_index().byte_range(range);
        let (start, end) = (start.min(end), start.max(end));
        let selection = trimmed(parsed.text(), start, end);
        let plan = {
            let nodes = path_to(Node::Program(parsed.program()), selection.0, selection.1);
            analyze(self, &parsed, &summary, &nodes, selection)?
        };
        Some((parsed, summary, plan))
    }

    /// The Extract Method dialog's data for a selection of an open
    /// document: the defaults and how many duplicates there are. `None`
    /// when the selection can't be extracted.
    pub fn extract_method_info(&self, doc: DocId, range: Range) -> Option<ExtractMethod> {
        let (parsed, summary, plan) = self.extract_plan(doc, range)?;
        let found = duplicates(self, &parsed, &summary, &plan);
        let class_name = plan.class_fqn.as_deref().map(|f| f.rsplit('\\').next().unwrap_or(f).to_owned());
        Some(ExtractMethod {
            range,
            function: plan.function,
            class_name: class_name.unwrap_or_default(),
            defaults: ExtractChoice { replace_duplicates: !found.is_empty(), ..plan.defaults() },
            static_required: !plan.function && plan.static_only,
            uses_this: plan.uses_this,
            duplicates: found.len() as u32,
            change: None,
        })
    }

    /// The edit extracting the selection of `data` as its `change` says.
    /// `None` when the engine doesn't hold the document.
    pub fn extract_method_edit(&self, doc: DocId, data: &ExtractMethod) -> Option<IdeResult<WorkspaceEdit>> {
        let path = self.document_path(doc)?;
        let Some(change) = &data.change else {
            return Some(Err(IdeError::invalid("Choose the new method's name and parameters first")));
        };
        let Some((parsed, summary, plan)) = self.extract_plan(doc, data.range) else {
            return Some(Err(IdeError::invalid("The selection can no longer be extracted")));
        };
        let choice = match plan.check(self, &summary, change) {
            Ok(choice) => choice,
            Err(e) => return Some(Err(e)),
        };
        let found = if choice.replace_duplicates { duplicates(self, &parsed, &summary, &plan) } else { Vec::new() };
        Some(Ok(file_edit(&path, plan.render(&parsed, &choice, &found))))
    }
}
