//! Change signature (`refactor.rewrite.changeSignature`, IDEA's Change
//! Signature): add, remove, reorder and rename the parameters of a function
//! or method, change their types and defaults and the return type, and
//! update every declaration in the hierarchy and every call.
//!
//! The editor asks in two steps. The code action (offered on the name of a
//! function or method, at a call of it, or anywhere in its header) carries
//! the current [`Signature`] as `data` and no edit; the editor's dialog
//! fills in the new one ([`ChangeSignature::change`]) and resolves the
//! action, which computes the edit ([`PhpEngine::change_signature`]):
//!
//! - **Declarations:** the function, or the method with every declaration
//!   above it it overrides and every overriding one below them (as rename
//!   does, see [`crate::navigate::rename`]); private methods and
//!   constructors alone. Each parameter list is rewritten; a parameter left
//!   as it was keeps its text (attributes, modifiers, comments), a changed
//!   type, default or flag is applied where the declaration had the old one
//!   (an override with a wider type keeps it), parameters only an override
//!   adds stay at its end.
//! - **Bodies:** a renamed parameter is renamed in its function's body
//!   (find usages of the variable, so closures without `use` are left
//!   alone) and in its docblocks (`@param`, `@var`); the `@param` line of a
//!   removed parameter goes.
//! - **Calls:** the arguments of every call found by find usages (`f(…)`,
//!   `->m(…)`, `?->m(…)`, `::m(…)`, `parent::__construct(…)`, and `new C(…)`
//!   of the class and the subclasses inheriting its constructor) are
//!   reordered to match; a removed parameter's argument goes, a new one
//!   gets its "value at call sites"; an argument that is now missing in the
//!   middle makes the following ones named (PHP 8.0) or is filled with the
//!   parameter's default (before 8.0). Named arguments follow their
//!   parameter's new name. Calls in the changed bodies and nested calls are
//!   rewritten together.
//!
//! Refused: built-in and `vendor/` declarations (and methods overriding
//! them), magic methods other than `__construct`, invalid or duplicate
//! names, a variadic parameter that isn't last, a new required parameter
//! without a value for the calls, a name already used in a body, renaming
//! or removing a promoted constructor parameter (that changes a property),
//! and calls that unpack arguments (`...$args`) or pass more arguments
//! than there are parameters. The rules are our own, after IntelliJ's
//! documented Change Signature behaviour.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use ide_core::{CancellationToken, DocId, FileEdit, IdeError, IdeResult, Pos, Range, TextEdit, WorkspaceEdit};
use mago_span::HasSpan;
use mago_syntax::cst::{
    Argument, ArgumentList, Block, Call, ClassLikeMemberSelector, Expression, Function, FunctionLikeParameter,
    FunctionLikeParameterList, FunctionLikeReturnTypeHint, Method, MethodBody, Node, TriviaKind,
};
use serde::{Deserialize, Serialize};

use super::method::lossy;
use super::{span_of, variables_in, visit};
use crate::engine::PhpEngine;
use crate::index::path_key;
use crate::names::{NameKind, fqn_eq};
use crate::navigate::hierarchy::Subtypes;
use crate::navigate::references::{Sought, UsageKind};
use crate::navigate::rename::{doc_variable_names, is_identifier};
use crate::navigate::symbol::{Decl, MemberKind, Subject, file_text};
use crate::stubs::PhpVersion;
use crate::summary::{FileSummary, Visibility};
use crate::syntax::{LineIndex, ParsedFile};

/// The code action kind of Change signature.
pub const CHANGE_SIGNATURE: &str = "refactor.rewrite.changeSignature";

/// One parameter of a [`Signature`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SignatureParameter {
    /// Its position in the current signature; `None` for a new parameter.
    pub old_index: Option<u32>,
    /// Without the `$`.
    pub name: String,
    /// The type as written; empty for none.
    #[serde(rename = "type")]
    pub ty: String,
    /// The default value as written; empty for none.
    pub default_value: String,
    /// For a new parameter: the argument existing calls pass (empty: none,
    /// the default value applies).
    pub call_value: String,
    pub by_ref: bool,
    pub variadic: bool,
    /// A promoted constructor parameter (it can't be renamed or removed).
    pub promoted: bool,
}

/// A function's or method's parameters and return type.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Signature {
    /// `name`, `Class::name` (not changed by the refactoring).
    pub name: String,
    pub parameters: Vec<SignatureParameter>,
    /// The return type as written; empty for none.
    pub return_type: String,
    /// A constructor (it has no return type).
    pub constructor: bool,
}

/// The `data` of a Change signature code action.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSignature {
    /// Where the action was offered (what it changes).
    pub position: Pos,
    /// The signature now.
    pub signature: Signature,
    /// The signature wanted, filled in by the editor's dialog.
    #[serde(default)]
    pub change: Option<Signature>,
}

/// A function or method declaration in the syntax tree.
#[derive(Clone, Copy)]
enum FnNode<'a> {
    Function(&'a Function<'a>),
    Method(&'a Method<'a>),
}

impl<'a> FnNode<'a> {
    fn params(self) -> &'a FunctionLikeParameterList<'a> {
        match self {
            FnNode::Function(f) => &f.parameter_list,
            FnNode::Method(m) => &m.parameter_list,
        }
    }

    fn return_hint(self) -> Option<&'a FunctionLikeReturnTypeHint<'a>> {
        match self {
            FnNode::Function(f) => f.return_type_hint.as_ref(),
            FnNode::Method(m) => m.return_type_hint.as_ref(),
        }
    }

    fn body(self) -> Option<&'a Block<'a>> {
        match self {
            FnNode::Function(f) => Some(&f.body),
            FnNode::Method(m) => match &m.body {
                MethodBody::Concrete(block) => Some(block),
                MethodBody::Abstract(_) => None,
            },
        }
    }

    fn name_start(self) -> u32 {
        match self {
            FnNode::Function(f) => f.name.span.start.offset,
            FnNode::Method(m) => m.name.span.start.offset,
        }
    }

    fn start(self) -> u32 {
        match self {
            FnNode::Function(f) => f.span().start.offset,
            FnNode::Method(m) => m.span().start.offset,
        }
    }

    fn end(self) -> u32 {
        match self {
            FnNode::Function(f) => f.span().end.offset,
            FnNode::Method(m) => m.span().end.offset,
        }
    }

    /// From the start to the body (or the end of an abstract method).
    fn header(self) -> (u32, u32) {
        let end = self.body().map_or(self.end(), |body| body.left_brace.start.offset);
        (self.start(), end)
    }
}

/// The function or method whose name starts at byte `name_start`.
fn function_at(parsed: &ParsedFile, name_start: u32) -> Option<FnNode<'_>> {
    let mut found = None;
    visit(Node::Program(parsed.program()), &mut |node| match node {
        Node::Function(f) if f.name.span.start.offset == name_start => found = Some(FnNode::Function(f)),
        Node::Method(m) if m.name.span.start.offset == name_start => found = Some(FnNode::Method(m)),
        _ => {}
    });
    found
}

/// The innermost function or method whose header holds byte `offset`.
fn header_at(parsed: &ParsedFile, offset: u32) -> Option<FnNode<'_>> {
    let mut found = None;
    visit(Node::Program(parsed.program()), &mut |node| {
        let f = match node {
            Node::Function(f) => FnNode::Function(f),
            Node::Method(m) => FnNode::Method(m),
            _ => return,
        };
        let (start, end) = f.header();
        if start <= offset && offset <= end {
            found = Some(f);
        }
    });
    found
}

fn slice(text: &str, start: u32, end: u32) -> &str {
    &text[start as usize..end as usize]
}

fn spanned<'t>(text: &'t str, node: &impl HasSpan) -> &'t str {
    let span = node.span();
    slice(text, span.start.offset, span.end.offset)
}

fn param_name(param: &FunctionLikeParameter<'_>) -> String {
    let name = lossy(param.variable.name);
    name.strip_prefix('$').unwrap_or(&name).to_owned()
}

fn param_type(text: &str, param: &FunctionLikeParameter<'_>) -> String {
    param.hint.as_ref().map(|hint| spanned(text, hint).to_owned()).unwrap_or_default()
}

fn param_default(text: &str, param: &FunctionLikeParameter<'_>) -> String {
    param.default_value.as_ref().map(|d| spanned(text, d.value).to_owned()).unwrap_or_default()
}

fn signature_of(text: &str, node: FnNode<'_>, name: String, constructor: bool) -> Signature {
    let parameters = node
        .params()
        .parameters
        .iter()
        .enumerate()
        .map(|(i, param)| SignatureParameter {
            old_index: Some(i as u32),
            name: param_name(param),
            ty: param_type(text, param),
            default_value: param_default(text, param),
            call_value: String::new(),
            by_ref: param.ampersand.is_some(),
            variadic: param.ellipsis.is_some(),
            promoted: !param.modifiers.is_empty(),
        })
        .collect();
    let return_type = node.return_hint().map(|hint| spanned(text, &hint.hint).to_owned()).unwrap_or_default();
    Signature { name, parameters, return_type, constructor }
}

/// Whether `ty` looks like a type (names, `?`, `|`, `&`, parentheses).
fn is_type_text(ty: &str) -> bool {
    !ty.is_empty()
        && ty.chars().all(|c| c.is_alphanumeric() || !c.is_ascii() || " _\\?|&()".contains(c))
        && ty.chars().any(|c| c.is_alphanumeric() || c == '_')
}

/// Whether `value` parses as one PHP expression.
fn is_expression(value: &str) -> bool {
    if value.contains(';') || value.contains("?>") {
        return false;
    }
    !ParsedFile::parse("value.php", format!("<?php\n$__v = {value};\n")).has_errors()
}

/// The new signature, checked and normalized (names without `$`, text
/// trimmed).
fn checked(old: &Signature, change: &Signature) -> IdeResult<Signature> {
    let invalid = |message: String| Err(IdeError::invalid(message));
    let mut out = change.clone();
    let mut names = HashSet::new();
    let mut used = HashSet::new();
    let count = out.parameters.len();
    for (i, param) in out.parameters.iter_mut().enumerate() {
        param.name = param.name.trim().trim_start_matches('$').to_owned();
        param.ty = param.ty.trim().to_owned();
        param.default_value = param.default_value.trim().to_owned();
        param.call_value = param.call_value.trim().to_owned();
        let name = &param.name;
        if !is_identifier(name) {
            return invalid(format!("'{name}' is not a valid parameter name"));
        }
        if name == "this" {
            return invalid("'$this' can't be a parameter".into());
        }
        if !names.insert(name.clone()) {
            return invalid(format!("There are two parameters named '${name}'"));
        }
        if !param.ty.is_empty() && !is_type_text(&param.ty) {
            return invalid(format!("'{}' is not a valid type", param.ty));
        }
        if param.variadic && i + 1 != count {
            return invalid(format!("The variadic parameter '${name}' must be the last one"));
        }
        if param.variadic && !param.default_value.is_empty() {
            return invalid(format!("The variadic parameter '${name}' can't have a default value"));
        }
        for value in [&param.default_value, &param.call_value] {
            if !value.is_empty() && !is_expression(value) {
                return invalid(format!("'{value}' is not a valid expression"));
            }
        }
        match param.old_index {
            Some(j) => {
                let Some(before) = old.parameters.get(j as usize) else {
                    return invalid(format!("Parameter '${name}' doesn't exist any more; open the dialog again"));
                };
                if !used.insert(j) {
                    return invalid(format!("Parameter '${}' is listed twice", before.name));
                }
                if before.promoted && before.name != param.name {
                    return invalid(format!("'${}' is a promoted property: rename the property instead", before.name));
                }
                param.promoted = before.promoted;
                param.call_value.clear();
            }
            None => {
                param.promoted = false;
                if param.call_value.is_empty() && param.default_value.is_empty() && !param.variadic {
                    return invalid(format!(
                        "The new parameter '${name}' needs a default value or a value for the existing calls"
                    ));
                }
            }
        }
    }
    for (j, before) in old.parameters.iter().enumerate() {
        if before.promoted && !used.contains(&(j as u32)) {
            return invalid(format!("'${}' is a promoted property and can't be removed here", before.name));
        }
    }
    out.return_type = out.return_type.trim().to_owned();
    if !out.return_type.is_empty() && !is_type_text(&out.return_type) {
        return invalid(format!("'{}' is not a valid return type", out.return_type));
    }
    if old.constructor && !out.return_type.is_empty() {
        return invalid("A constructor has no return type".into());
    }
    out.name = old.name.clone();
    out.constructor = old.constructor;
    Ok(out)
}

// ------------------------------------------------------------ rewrites

/// A piece of new text: literal, or a range of the old text (with the
/// rewrites inside it applied).
#[derive(Clone, Debug)]
enum Piece {
    Text(String),
    Source(u32, u32),
}

/// Bytes `start..end` of a file become `pieces`.
#[derive(Clone, Debug)]
struct Rewrite {
    start: u32,
    end: u32,
    pieces: Vec<Piece>,
}

impl Rewrite {
    fn text(start: u32, end: u32, text: impl Into<String>) -> Self {
        Rewrite { start, end, pieces: vec![Piece::Text(text.into())] }
    }
}

/// `text[start..end]` with the outermost rewrites inside it applied (each
/// rendered with the rewrites inside its kept pieces). `skip` is the
/// rewrite being rendered.
fn render_range(text: &str, start: u32, end: u32, rewrites: &[Rewrite], skip: Option<usize>) -> String {
    let mut out = String::new();
    let mut at = start;
    for (i, rewrite) in rewrites.iter().enumerate() {
        if Some(i) == skip || rewrite.start < at || rewrite.end > end || rewrite.start < start {
            continue;
        }
        out.push_str(slice(text, at, rewrite.start));
        out.push_str(&render(text, i, rewrites));
        at = rewrite.end;
    }
    out.push_str(slice(text, at, end));
    out
}

fn render(text: &str, i: usize, rewrites: &[Rewrite]) -> String {
    rewrites[i]
        .pieces
        .iter()
        .map(|piece| match piece {
            Piece::Text(text) => text.clone(),
            Piece::Source(start, end) => render_range(text, *start, *end, rewrites, Some(i)),
        })
        .collect()
}

/// The text edits of a file's rewrites: one per outermost rewrite.
fn text_edits(text: &str, mut rewrites: Vec<Rewrite>) -> Vec<TextEdit> {
    // Outer before inner at the same start; of two over the same bytes, the
    // one keeping text (a list) holds the other (a rename).
    let keeps = |r: &Rewrite| r.pieces.iter().any(|p| matches!(p, Piece::Source(..)));
    rewrites.sort_by_key(|r| (r.start, std::cmp::Reverse(r.end), !keeps(r)));
    let index = LineIndex::new(text);
    let mut out = Vec::new();
    let mut at = None;
    for (i, rewrite) in rewrites.iter().enumerate() {
        if at.is_some_and(|at| rewrite.start < at) {
            continue;
        }
        let new_text = render(text, i, &rewrites);
        if new_text != slice(text, rewrite.start, rewrite.end) {
            out.push(TextEdit { range: index.range(rewrite.start, rewrite.end), new_text });
        }
        at = Some(rewrite.end);
    }
    out
}

/// The layout of a parenthesized list: what comes before the first item,
/// between items and after the last one.
struct Layout {
    lead: String,
    separator: String,
    tail: String,
}

/// The layout of the items `spans` between `open` (after `(`) and `close`
/// (before `)`): one per line when the first item starts a line.
fn layout(text: &str, open: u32, close: u32, spans: &[(u32, u32)], fallback_indent: &str) -> Layout {
    let (Some(first), Some(last)) = (spans.first(), spans.last()) else {
        let inner = slice(text, open, close);
        if inner.contains('\n') {
            let nl = crate::inspect::fixes::newline(text);
            let close_indent = inner.rsplit('\n').next().unwrap_or("");
            return Layout {
                lead: format!("{nl}{fallback_indent}"),
                separator: format!(",{nl}{fallback_indent}"),
                tail: format!("{nl}{close_indent}"),
            };
        }
        return Layout { lead: String::new(), separator: ", ".into(), tail: String::new() };
    };
    let lead = slice(text, open, first.0).to_owned();
    let tail = slice(text, last.1, close).to_owned();
    if lead.contains('\n') {
        let indent = lead.rsplit('\n').next().unwrap_or("");
        let nl = crate::inspect::fixes::newline(text);
        return Layout { separator: format!(",{nl}{indent}"), lead, tail };
    }
    Layout { lead, separator: ", ".into(), tail }
}

/// The rewrite of a list's inside as `items`.
fn list_rewrite(open: u32, close: u32, layout: Layout, items: Vec<Vec<Piece>>) -> Rewrite {
    let mut pieces = Vec::new();
    if items.is_empty() {
        return Rewrite { start: open, end: close, pieces };
    }
    pieces.push(Piece::Text(layout.lead));
    for (i, item) in items.into_iter().enumerate() {
        if i > 0 {
            pieces.push(Piece::Text(layout.separator.clone()));
        }
        pieces.extend(item);
    }
    pieces.push(Piece::Text(layout.tail));
    Rewrite { start: open, end: close, pieces }
}

fn param_text(prefix: &str, ty: &str, by_ref: bool, variadic: bool, name: &str, default: &str) -> String {
    let mut out = prefix.to_owned();
    if !ty.is_empty() {
        out.push_str(ty);
        out.push(' ');
    }
    if by_ref {
        out.push('&');
    }
    if variadic {
        out.push_str("...");
    }
    out.push('$');
    out.push_str(name);
    if !default.is_empty() {
        out.push_str(" = ");
        out.push_str(default);
    }
    out
}

/// Attributes and modifiers in front of a parameter's type, as written.
fn param_prefix<'t>(text: &'t str, param: &FunctionLikeParameter<'_>) -> &'t str {
    let start = param.span().start.offset;
    let typed = param
        .hint
        .as_ref()
        .map(|h| h.span().start.offset)
        .into_iter()
        .chain(param.ampersand.map(|s| s.start.offset))
        .chain(param.ellipsis.map(|s| s.start.offset))
        .chain([param.variable.span.start.offset])
        .min()
        .unwrap_or(start);
    slice(text, start, typed)
}

/// The renames of one declaration: old parameter name → new.
type Renames = Vec<(String, String)>;

/// The rewrites of one declaration's parameter list and return type, and
/// its parameter renames.
fn declaration_rewrites(
    text: &str,
    node: FnNode<'_>,
    old: &Signature,
    new: &Signature,
    display: &str,
) -> IdeResult<(Vec<Rewrite>, Renames, Vec<String>)> {
    let list = node.params();
    let params: Vec<&FunctionLikeParameter<'_>> = list.parameters.iter().collect();
    if params.len() < old.parameters.len() {
        return Err(IdeError::invalid(format!(
            "A declaration of {display} has fewer parameters than the one changed; fix it first"
        )));
    }
    let mut items = Vec::new();
    let mut renames = Vec::new();
    let mut kept = HashSet::new();
    for param in &new.parameters {
        let Some(j) = param.old_index else {
            items.push(vec![Piece::Text(param_text(
                "",
                &param.ty,
                param.by_ref,
                param.variadic,
                &param.name,
                &param.default_value,
            ))]);
            continue;
        };
        let j = j as usize;
        kept.insert(j);
        let before = &old.parameters[j];
        let here = params[j];
        let own_name = param_name(here);
        let own_type = param_type(text, here);
        let own_default = param_default(text, here);
        // A changed type or default where this declaration had the old one.
        let pick = |new: &str, old: &str, own: String| if new != old && own == old { new.to_owned() } else { own };
        let name = if param.name != before.name { param.name.clone() } else { own_name.clone() };
        let ty = pick(&param.ty, &before.ty, own_type.clone());
        let default = pick(&param.default_value, &before.default_value, own_default.clone());
        let by_ref = if param.by_ref != before.by_ref { param.by_ref } else { here.ampersand.is_some() };
        let variadic = if param.variadic != before.variadic { param.variadic } else { here.ellipsis.is_some() };
        if name != own_name {
            if !here.modifiers.is_empty() {
                return Err(IdeError::invalid(format!(
                    "'${own_name}' is a promoted property: rename the property instead"
                )));
            }
            renames.push((own_name.clone(), name.clone()));
        }
        let unchanged = name == own_name
            && ty == own_type
            && default == own_default
            && by_ref == here.ampersand.is_some()
            && variadic == here.ellipsis.is_some();
        let (start, end) = (here.span().start.offset, here.span().end.offset);
        items.push(vec![if unchanged {
            Piece::Source(start, end)
        } else {
            Piece::Text(param_text(param_prefix(text, here), &ty, by_ref, variadic, &name, &default))
        }]);
    }
    let mut removed = Vec::new();
    for (j, param) in params.iter().enumerate() {
        if j >= old.parameters.len() {
            // Only this override has it: it stays last.
            let (start, end) = (param.span().start.offset, param.span().end.offset);
            items.push(vec![Piece::Source(start, end)]);
        } else if !kept.contains(&j) {
            if !param.modifiers.is_empty() {
                return Err(IdeError::invalid(format!(
                    "'${}' is a promoted property and can't be removed here",
                    param_name(param)
                )));
            }
            removed.push(param_name(param));
        }
    }
    let open = list.left_parenthesis.end.offset;
    let close = list.right_parenthesis.start.offset;
    let spans: Vec<(u32, u32)> = params.iter().map(|p| (p.span().start.offset, p.span().end.offset)).collect();
    let indent = format!("{}    ", crate::inspect::fixes::line_indent(text, node.start()));
    let mut rewrites = vec![list_rewrite(open, close, layout(text, open, close, &spans, &indent), items)];

    // The return type, where it was the changed declaration's.
    if new.return_type != old.return_type {
        let own = node.return_hint().map(|h| spanned(text, &h.hint).to_owned()).unwrap_or_default();
        if own == old.return_type {
            let after = list.right_parenthesis.end.offset;
            match node.return_hint() {
                Some(hint) if new.return_type.is_empty() => {
                    rewrites.push(Rewrite::text(after, hint.hint.span().end.offset, ""));
                }
                Some(hint) => {
                    let (start, end) = (hint.hint.span().start.offset, hint.hint.span().end.offset);
                    rewrites.push(Rewrite::text(start, end, new.return_type.clone()));
                }
                None => rewrites.push(Rewrite::text(after, after, format!(": {}", new.return_type))),
            }
        }
    }
    Ok((rewrites, renames, removed))
}

/// The docblock right in front of the declaration starting at `start`.
fn docblock_before(parsed: &ParsedFile, start: u32) -> Option<(u32, u32)> {
    let text = parsed.text();
    parsed
        .program()
        .trivia
        .iter()
        .filter(|trivia| trivia.kind == TriviaKind::DocBlockComment)
        .map(|trivia| (trivia.span.start.offset, trivia.span.end.offset))
        .rfind(|&(_, end)| end <= start && slice(text, end, start).trim().is_empty())
}

/// The `@param … $name` lines of a docblock, whole lines.
fn param_doc_lines(text: &str, doc: (u32, u32), name: &str) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    let wanted = format!("${name}");
    let mut line_start = doc.0;
    for line in slice(text, doc.0, doc.1).split_inclusive('\n') {
        let end = line_start + line.len() as u32;
        if line.contains("@param")
            && line.match_indices(&wanted).any(|(at, _)| {
                !line[at + wanted.len()..].chars().next().is_some_and(|c| c == '_' || c.is_alphanumeric())
            })
            && line.ends_with('\n')
        {
            out.push((line_start, end));
        }
        line_start = end;
    }
    out
}

// ------------------------------------------------------------ calls

/// What an old parameter receives at a call.
enum Passed {
    Missing,
    /// The value's bytes; named.
    Value(u32, u32, bool),
    /// The arguments of a variadic parameter.
    Rest(Vec<(u32, u32)>),
}

/// The new inside of a call's argument list (`args` between bytes `open`
/// and `close`), `None` when it stays.
fn call_rewrite(
    text: &str,
    args: &[&Argument<'_>],
    (open, close): (u32, u32),
    old: &Signature,
    new: &Signature,
    named_ok: bool,
) -> Result<Option<Rewrite>, String> {
    let variadic = old.parameters.last().is_some_and(|p| p.variadic);
    let mut passed: Vec<Passed> = old.parameters.iter().map(|_| Passed::Missing).collect();
    for (k, arg) in args.iter().enumerate() {
        match arg {
            Argument::Positional(arg) => {
                if arg.ellipsis.is_some() {
                    return Err("unpacks its arguments".into());
                }
                let (start, end) = span_of(&Node::Expression(arg.value));
                if variadic && k + 1 >= old.parameters.len() {
                    let last = passed.len() - 1;
                    match &mut passed[last] {
                        Passed::Rest(values) => values.push((start, end)),
                        slot => *slot = Passed::Rest(vec![(start, end)]),
                    }
                } else if k < passed.len() {
                    passed[k] = Passed::Value(start, end, false);
                } else {
                    return Err("passes more arguments than there are parameters".into());
                }
            }
            Argument::Named(arg) => {
                let name = lossy(arg.name.value);
                let Some(j) = old.parameters.iter().position(|p| p.name == name && !p.variadic) else {
                    return Err(format!("has the unknown named argument '{name}'"));
                };
                let (start, end) = span_of(&Node::Expression(arg.value));
                passed[j] = Passed::Value(start, end, true);
            }
        }
    }

    // What each new parameter gets.
    enum Gets {
        Default(String),
        Value(u32, u32, bool),
        Rest(Vec<(u32, u32)>),
        New(String),
    }
    let mut gets: Vec<Gets> = Vec::new();
    for param in &new.parameters {
        gets.push(match param.old_index {
            Some(j) => {
                let before = &old.parameters[j as usize];
                match std::mem::replace(&mut passed[j as usize], Passed::Missing) {
                    Passed::Value(start, end, _) if param.variadic => Gets::Rest(vec![(start, end)]),
                    Passed::Value(start, end, named) => Gets::Value(start, end, named),
                    Passed::Rest(values) if param.variadic => Gets::Rest(values),
                    Passed::Rest(values) => match values.as_slice() {
                        [] => Gets::Default(before.default_value.clone()),
                        [(start, end)] => Gets::Value(*start, *end, false),
                        _ => return Err("passes several arguments to a parameter that is no longer variadic".into()),
                    },
                    Passed::Missing => Gets::Default(before.default_value.clone()),
                }
            }
            None if !param.call_value.is_empty() => Gets::New(param.call_value.clone()),
            None => Gets::Default(param.default_value.clone()),
        });
    }
    let last = gets.iter().rposition(|g| match g {
        Gets::Default(_) => false,
        Gets::Rest(values) => !values.is_empty(),
        _ => true,
    });
    let mut items: Vec<Vec<Piece>> = Vec::new();
    let mut named = false;
    for (i, get) in gets.iter().enumerate().take(last.map_or(0, |l| l + 1)) {
        let name = &new.parameters[i].name;
        match get {
            Gets::Default(default) => {
                if named_ok {
                    named = true;
                } else if !default.is_empty() {
                    items.push(vec![Piece::Text(default.clone())]);
                } else {
                    return Err(format!("passes no value for '${name}'"));
                }
            }
            Gets::Value(start, end, was_named) => {
                named |= *was_named;
                let mut item = Vec::new();
                if named {
                    item.push(Piece::Text(format!("{name}: ")));
                }
                item.push(Piece::Source(*start, *end));
                items.push(item);
            }
            Gets::New(value) => {
                let value = if named { format!("{name}: {value}") } else { value.clone() };
                items.push(vec![Piece::Text(value)]);
            }
            Gets::Rest(values) => {
                if named && !values.is_empty() {
                    return Err(format!("would pass the variadic '${name}' after named arguments"));
                }
                items.extend(values.iter().map(|&(start, end)| vec![Piece::Source(start, end)]));
            }
        }
    }

    // Unchanged: the same values in the same order, written the same way.
    let before: Vec<(u32, u32, bool)> = args
        .iter()
        .map(|arg| match arg {
            Argument::Positional(arg) => {
                let (s, e) = span_of(&Node::Expression(arg.value));
                (s, e, false)
            }
            Argument::Named(arg) => {
                let (s, e) = span_of(&Node::Expression(arg.value));
                (s, e, true)
            }
        })
        .collect();
    let named_args: Vec<String> = args
        .iter()
        .filter_map(|arg| match arg {
            Argument::Named(arg) => Some(lossy(arg.name.value)),
            Argument::Positional(_) => None,
        })
        .collect();
    let after: Vec<(u32, u32, bool)> = items
        .iter()
        .filter_map(|item| match item.as_slice() {
            [Piece::Source(s, e)] => Some((*s, *e, false)),
            [Piece::Text(label), Piece::Source(s, e)] => {
                let label = label.trim_end_matches(": ");
                named_args.iter().any(|n| n == label).then_some((*s, *e, true))
            }
            _ => None,
        })
        .collect();
    if after.len() == items.len() && after == before {
        return Ok(None);
    }

    let spans: Vec<(u32, u32)> = args.iter().map(|arg| arg.span()).map(|s| (s.start.offset, s.end.offset)).collect();
    let indent = format!("{}    ", crate::inspect::fixes::line_indent(text, open));
    Ok(Some(list_rewrite(open, close, layout(text, open, close, &spans, &indent), items)))
}

/// The rewrite of one call's arguments.
fn site_rewrite(
    text: &str,
    site: &CallSite<'_>,
    old: &Signature,
    new: &Signature,
    named_ok: bool,
) -> Result<Option<Rewrite>, String> {
    match site.list {
        Some(list) => {
            let args: Vec<&Argument<'_>> = list.arguments.iter().collect();
            let bounds = (list.left_parenthesis.end.offset, list.right_parenthesis.start.offset);
            call_rewrite(text, &args, bounds, old, new, named_ok)
        }
        // `new C`: `(…)` after the class when there are arguments now.
        None => {
            let at = site.after_class;
            Ok(call_rewrite(text, &[], (at, at), old, new, named_ok)?.map(|mut rewrite| {
                rewrite.pieces.insert(0, Piece::Text("(".into()));
                rewrite.pieces.push(Piece::Text(")".into()));
                rewrite
            }))
        }
    }
}

fn selector_span(selector: &ClassLikeMemberSelector<'_>) -> Option<(u32, u32)> {
    match selector {
        ClassLikeMemberSelector::Identifier(name) => Some((name.span.start.offset, name.span.end.offset)),
        _ => None,
    }
}

/// The calls in `parsed` whose name (or instantiated class) holds one of
/// `starts`: the name's span and the argument list (`None` for `new C`).
fn calls_at<'a>(parsed: &'a ParsedFile, starts: &[u32], constructor: bool) -> Vec<CallSite<'a>> {
    let mut out = Vec::new();
    let hit = |span: Option<(u32, u32)>| span.is_some_and(|(s, e)| starts.iter().any(|&at| s <= at && at < e));
    visit(Node::Program(parsed.program()), &mut |node| {
        let Node::Expression(expr) = node else { return };
        match expr {
            Expression::Call(call) => {
                let (span, list) = match call {
                    Call::Function(call) => (Some(span_of(&Node::Expression(call.function))), &call.argument_list),
                    Call::Method(call) => (selector_span(&call.method), &call.argument_list),
                    Call::NullSafeMethod(call) => (selector_span(&call.method), &call.argument_list),
                    Call::StaticMethod(call) => (selector_span(&call.method), &call.argument_list),
                };
                if hit(span) {
                    out.push(CallSite { list: Some(list), after_class: 0 });
                }
            }
            Expression::Instantiation(new) if constructor => {
                let span = span_of(&Node::Expression(new.class));
                if hit(Some(span)) {
                    out.push(CallSite { list: new.argument_list.as_ref(), after_class: span.1 });
                }
            }
            _ => {}
        }
    });
    out
}

struct CallSite<'a> {
    list: Option<&'a ArgumentList<'a>>,
    /// For `new C` without arguments: where `(…)` goes.
    after_class: u32,
}

// ------------------------------------------------------------ the target

/// A file the edit changes.
struct Work {
    path: PathBuf,
    text: String,
    rewrites: Vec<Rewrite>,
}

/// One declaration of the changed function or method.
struct Declaration {
    path: PathBuf,
    /// Its name.
    name: Range,
}

/// What a Change signature at the caret changes.
struct Target {
    display: String,
    constructor: bool,
    /// The changed declaration first.
    declarations: Vec<Declaration>,
    /// Its calls (and, for a constructor, the classes instantiated with it).
    sought: Vec<Sought>,
}

/// Methods PHP calls itself, with a fixed signature.
fn is_magic(name: &str) -> bool {
    name.starts_with("__") && !name.eq_ignore_ascii_case("__construct")
}

fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

impl PhpEngine {
    /// The Change signature action's data for a caret or selection in an
    /// open document: the signature of the function or method there. `None`
    /// when there is none (or the engine doesn't hold the document).
    pub fn change_signature_info(&self, doc: DocId, range: Range) -> Option<ChangeSignature> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let here = FileSummary::extract(&parsed);
        if here.has_errors {
            return None;
        }
        let offset = parsed.line_index().byte(range.start);
        let cancel = CancellationToken::new();
        let target = self.signature_target(&parsed, &path, &here, offset, false, &cancel).ok()?;
        let signature = self.current_signature(&target, &path, &parsed).ok()?;
        Some(ChangeSignature { position: range.start, signature, change: None })
    }

    /// The edit changing the signature of the function or method at `pos`
    /// in an open document to `change` (see the module docs). `None` when
    /// the engine doesn't hold the document.
    pub fn change_signature(
        &self,
        doc: DocId,
        pos: Pos,
        change: &Signature,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<WorkspaceEdit>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        Some(self.change_signature_edit(&parsed, &path, pos, change, cancel))
    }

    fn signature_target(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        here: &FileSummary,
        offset: u32,
        hierarchy: bool,
        cancel: &CancellationToken,
    ) -> IdeResult<Target> {
        let resolver = self.resolver();
        let callable = |at: u32| {
            let found = self.at_caret(parsed, here, &resolver, at)?;
            let Subject::Decls(decls) = found.subject else { return None };
            let [decl] = <[Decl; 1]>::try_from(decls).ok()?;
            match &decl {
                Decl::Function(_) => Some(decl),
                Decl::Member(member) if member.kind == MemberKind::Method => Some(decl),
                _ => None,
            }
        };
        let decl = callable(offset)
            .or_else(|| header_at(parsed, offset).and_then(|f| callable(f.name_start())))
            .ok_or_else(|| IdeError::invalid("The caret should be on the name of a function or method"))?;
        let library = || IdeError::invalid("Built-in and library functions can't be changed");
        match &decl {
            Decl::Function(fqn) => {
                let [target] = <[_; 1]>::try_from(self.decl_targets(&decl, path, here)).map_err(|_| library())?;
                if self.is_library(&target.path) {
                    return Err(library());
                }
                Ok(Target {
                    display: fqn.trim_start_matches('\\').to_owned(),
                    constructor: false,
                    declarations: vec![Declaration { path: target.path, name: target.range }],
                    sought: vec![Sought::Name { kind: NameKind::Function, fqn: fqn.clone() }],
                })
            }
            Decl::Member(member) => {
                let info = member.info().ok_or_else(library)?;
                let name = member.name.clone();
                let declaring = info.declaring.fqn.clone();
                if is_magic(&name) {
                    return Err(IdeError::invalid(format!("PHP calls {name} itself: its signature is fixed")));
                }
                let constructor = name.eq_ignore_ascii_case("__construct");
                let private = info.visibility == Visibility::Private;
                let mut family = vec![declaring.clone()];
                if !private && !constructor {
                    if self.member_roots(&resolver, MemberKind::Method, &name, &declaring).iter().any(|(_, lib)| *lib) {
                        return Err(IdeError::invalid(format!("{name} overrides a library method")));
                    }
                    if hierarchy {
                        let subtypes = Subtypes::new(self);
                        family = self.member_family(&subtypes, MemberKind::Method, &name, &declaring, cancel)?;
                    }
                }
                let mut declarations = Vec::new();
                let mut sought = Vec::new();
                for fqn in &family {
                    let model = self.class_model(fqn).ok_or_else(library)?;
                    let method = model.method(&name).ok_or_else(library)?;
                    let declared = method.declared().ok_or_else(library)?;
                    let file = self.class_path(&method.declaring, path, here).ok_or_else(library)?;
                    if self.is_library(&file) {
                        return Err(library());
                    }
                    declarations.push(Declaration { path: file, name: declared.name_loc.range });
                    sought.push(Sought::Member {
                        kind: MemberKind::Method,
                        name: name.clone(),
                        declaring: method.declaring.fqn.clone(),
                        private,
                    });
                }
                if constructor && hierarchy {
                    // `new C(…)` of the class and the subclasses inheriting it.
                    sought.push(Sought::Name { kind: NameKind::ClassLike, fqn: declaring.clone() });
                    for subtype in Subtypes::new(self).all(self, &declaring, cancel)? {
                        let inherits = self.class_model(&subtype.class.fqn).is_some_and(|model| {
                            model
                                .method("__construct")
                                .is_some_and(|m| fqn_eq(NameKind::ClassLike, &m.declaring.fqn, &declaring))
                        });
                        if inherits {
                            sought.push(Sought::Name { kind: NameKind::ClassLike, fqn: subtype.class.fqn.clone() });
                        }
                    }
                }
                Ok(Target { display: format!("{}::{name}", short(&declaring)), constructor, declarations, sought })
            }
            _ => unreachable!("a function or method"),
        }
    }

    /// The changed declaration's signature.
    fn current_signature(&self, target: &Target, here: &Path, parsed: &ParsedFile) -> IdeResult<Signature> {
        let first = &target.declarations[0];
        let other;
        let decl_parsed = if first.path == here {
            parsed
        } else {
            let text = file_text(self, &first.path).ok_or_else(|| IdeError::not_found("the declaring file"))?;
            other = ParsedFile::parse(&path_key(&first.path), text);
            &other
        };
        let start = decl_parsed.line_index().byte(first.name.start);
        let node = function_at(decl_parsed, start).ok_or_else(|| IdeError::not_found("the declaration"))?;
        Ok(signature_of(decl_parsed.text(), node, target.display.clone(), target.constructor))
    }

    fn change_signature_edit(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        pos: Pos,
        change: &Signature,
        cancel: &CancellationToken,
    ) -> IdeResult<WorkspaceEdit> {
        let here = FileSummary::extract(parsed);
        if here.has_errors {
            return Err(IdeError::invalid("Fix the syntax errors first"));
        }
        let offset = parsed.line_index().byte(pos);
        let target = self.signature_target(parsed, path, &here, offset, true, cancel)?;
        let old = self.current_signature(&target, path, parsed)?;
        let new = checked(&old, change)?;
        let named_ok = self.language_level() >= PhpVersion::new(8, 0);

        let mut files: BTreeMap<String, Work> = BTreeMap::new();
        let load = |files: &mut BTreeMap<String, Work>, file: &Path| -> IdeResult<String> {
            let key = path_key(file);
            if !files.contains_key(&key) {
                let text = file_text(self, file).ok_or_else(|| IdeError::not_found(format!("{}", file.display())))?;
                files.insert(key.clone(), Work { path: file.to_path_buf(), text, rewrites: Vec::new() });
            }
            Ok(key)
        };

        // The declarations, and the variables their renamed parameters are.
        let mut variables: Vec<Sought> = Vec::new();
        // (file, body span, old → new)
        let mut bodies: Vec<(String, (u32, u32), Renames)> = Vec::new();
        for declaration in &target.declarations {
            let key = load(&mut files, &declaration.path)?;
            let work = files.get_mut(&key).expect("loaded");
            let decl_parsed = ParsedFile::parse(&key, work.text.as_str());
            let text = decl_parsed.text();
            let start = decl_parsed.line_index().byte(declaration.name.start);
            let node = function_at(&decl_parsed, start).ok_or_else(|| IdeError::not_found("a declaration"))?;
            let (rewrites, renames, removed) = declaration_rewrites(text, node, &old, &new, &target.display)?;
            work.rewrites.extend(rewrites);

            // A parameter name new to the function, already used in its body.
            let params: Vec<String> = node.params().parameters.iter().map(param_name).collect();
            if let Some(body) = node.body() {
                let taken = variables_in(text, body.span().start.offset, body.span().end.offset);
                let introduced = renames
                    .iter()
                    .map(|(_, new)| new.as_str())
                    .chain(new.parameters.iter().filter(|p| p.old_index.is_none()).map(|p| p.name.as_str()))
                    .filter(|name| !params.iter().any(|p| p == name));
                for name in introduced {
                    if taken.iter().any(|t| t == name) {
                        return Err(IdeError::invalid(format!("'${name}' is already used in {}", target.display)));
                    }
                }
            }

            let index = decl_parsed.line_index();
            for (old_name, new_name) in &renames {
                let Some(param) = node.params().parameters.iter().find(|p| param_name(p) == *old_name) else {
                    continue;
                };
                let declared = index.span_range(param.variable.span);
                variables.push(Sought::Variable { file: key.clone(), name: old_name.clone(), declaration: declared });
                for (start, end) in doc_variable_names(text, &key, old_name, declared) {
                    work.rewrites.push(Rewrite::text(start, end, new_name.clone()));
                }
            }
            if let Some(doc) = docblock_before(&decl_parsed, node.start()) {
                for name in &removed {
                    for (start, end) in param_doc_lines(text, doc, name) {
                        work.rewrites.push(Rewrite::text(start, end, ""));
                    }
                }
            }
            if let Some(body) = node.body() {
                bodies.push((key.clone(), (body.span().start.offset, body.span().end.offset), renames));
            }
        }

        // The renamed parameters in the bodies.
        if !variables.is_empty() {
            let here = FileSummary::extract(parsed);
            for usage in self.find_usages(&variables, path, &here, false, cancel)? {
                let key = path_key(&usage.path);
                let Some(work) = files.get_mut(&key) else { continue };
                let index = LineIndex::new(&work.text);
                let (start, end) = index.byte_range(usage.range);
                let written = slice(&work.text, start, end);
                let bare = written.strip_prefix('$').unwrap_or(written);
                let name_start = end - bare.len() as u32;
                let Some((_, _, renames)) =
                    bodies.iter().find(|(file, body, _)| *file == key && body.0 <= start && end <= body.1)
                else {
                    continue;
                };
                if let Some((_, new_name)) = renames.iter().find(|(old, _)| old == bare) {
                    work.rewrites.push(Rewrite::text(name_start, end, new_name.clone()));
                }
            }
        }

        // The calls.
        let here = FileSummary::extract(parsed);
        let usages = self.find_usages(&target.sought, path, &here, false, cancel)?;
        let mut by_file: BTreeMap<String, (PathBuf, Vec<Range>)> = BTreeMap::new();
        for usage in usages.into_iter().filter(|u| u.kind == UsageKind::Code) {
            if self.is_library(&usage.path) {
                continue;
            }
            by_file
                .entry(path_key(&usage.path))
                .or_insert_with(|| (usage.path.clone(), Vec::new()))
                .1
                .push(usage.range);
        }
        for (_, (file, ranges)) in by_file {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let key = load(&mut files, &file)?;
            let work = files.get_mut(&key).expect("loaded");
            let call_parsed = ParsedFile::parse(&key, work.text.as_str());
            let index = call_parsed.line_index();
            let starts: Vec<u32> = ranges.iter().map(|r| index.byte(r.start)).collect();
            for site in calls_at(&call_parsed, &starts, target.constructor) {
                match site_rewrite(call_parsed.text(), &site, &old, &new, named_ok) {
                    Ok(Some(rewrite)) => work.rewrites.push(rewrite),
                    Ok(None) => {}
                    Err(why) => {
                        let line = index.pos(site.list.map_or(site.after_class, |l| l.left_parenthesis.start.offset));
                        let name = file.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
                        return Err(IdeError::invalid(format!(
                            "The call in {name} at line {} {why}; change it by hand first",
                            line.line + 1
                        )));
                    }
                }
            }
        }

        let mut edit = WorkspaceEdit::default();
        for (_, work) in files {
            let edits = text_edits(&work.text, work.rewrites);
            if !edits.is_empty() {
                edit.files.push(FileEdit::Edit { path: work.path.into(), edits, version: None });
            }
        }
        Ok(edit)
    }
}
