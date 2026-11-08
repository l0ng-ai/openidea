//! String references: completion, goto, find usages, rename and document
//! highlights for string literals in known places (`config('app.name')`,
//! later `route('home')`, `view('posts.index')`, …).
//!
//! The design follows the public description of IntelliJ's reference
//! contributors (IntelliJ Community, Apache-2.0): a **place pattern**
//! ([`PlacePattern`]) says where a string sits (an argument of a function,
//! of a method of a class or its subclasses, of `new`; by position or by
//! name; the string itself or a key or value of an array argument, nested
//! or not), and a **reference kind** ([`ReferenceKind`]) says what such a
//! string names and supplies completion items, targets, usages, rename and
//! validation. Kinds are listed in [`kinds`]; so far `configKey`
//! ([`config_key`]).
//!
//! The string at the caret is found in the document's parse, or, while it
//! is being typed and isn't closed yet, in a copy of the file with a closed
//! probe string in its place (as completion does), so a partial string
//! (`config('app.na`) works too. Find usages goes through the word index
//! (the words of the value and the kind's words) and checks each candidate
//! string against the patterns again.
//!
//! Everything is off unless the project is a Laravel project
//! ([`PhpEngine::laravel`]).

pub mod config_key;
#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ide_core::{CancellationToken, DocId, FileEdit, IdeError, IdeResult, Pos, Range, TextEdit, WorkspaceEdit};
use mago_span::{HasSpan, Span};
use mago_syntax::cst::{Argument, ArgumentList, ArrayElement, Call, ClassLikeMemberSelector, Expression, Literal};
use mago_syntax::walker::Walker;

use super::LaravelProject;
use crate::complete::{Completion, CompletionKind, Completions};
use crate::engine::PhpEngine;
use crate::names::{FileNames, NameKind, fqn_eq};
use crate::navigate::{Target, Usage, UsageKind};
use crate::signature::Callee;
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;
use crate::types::{ExprTypes, Resolver, Type};

pub use config_key::ConfigKey;

// --------------------------------------------------------------- patterns

/// The call a [`PlacePattern`] is about.
#[derive(Clone, Copy, Debug)]
pub enum CalleePattern {
    /// A function, by FQN without the leading `\` (`config`).
    Function(&'static str),
    /// One of `names` (any case) called on one of `classes`, a subclass or
    /// an implementation of one (FQNs; `new` is `__construct`).
    Method { classes: &'static [&'static str], names: &'static [&'static str] },
}

/// Where in the argument the string sits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    /// The argument is the string.
    Argument,
    /// A key of the array argument.
    ArrayKey,
    /// A value of the array argument.
    ArrayValue,
    /// A value without a key of the array argument (a list item).
    ListValue,
    /// The value under this key of the array argument.
    ValueOfKey(&'static str),
}

/// A place a string literal can sit in; see the module documentation.
#[derive(Clone, Copy, Debug)]
pub struct PlacePattern {
    pub callee: CalleePattern,
    /// The parameter: its position and its name (for named arguments).
    pub index: usize,
    pub name: &'static str,
    pub position: Position,
    /// The array position also holds in arrays nested in the argument at
    /// any depth (as values).
    pub nested: bool,
}

impl PlacePattern {
    /// The string itself is argument `index` (named `name`) of `callee`.
    pub const fn argument(callee: CalleePattern, index: usize, name: &'static str) -> Self {
        Self { callee, index, name, position: Position::Argument, nested: false }
    }

    pub const fn at(self, position: Position) -> Self {
        Self { position, ..self }
    }

    pub const fn nested(self) -> Self {
        Self { nested: true, ..self }
    }

    /// The function or method names the pattern is about (for a quick
    /// look at a call before its types are worked out).
    fn names(&self) -> Vec<&'static str> {
        match self.callee {
            CalleePattern::Function(fqn) => vec![fqn.rsplit('\\').next().unwrap_or(fqn)],
            CalleePattern::Method { names, .. } => names.to_vec(),
        }
    }

    /// Whether `site` is in this place.
    pub fn matches(&self, site: &StringSite, resolver: &Resolver<'_>) -> bool {
        let argument = match &site.argument_name {
            Some(name) => name == self.name,
            None => site.index == Some(self.index),
        };
        argument && self.position_matches(&site.steps) && self.callee_matches(&site.target, resolver)
    }

    fn position_matches(&self, steps: &[ArrayStep]) -> bool {
        let Some((last, outer)) = steps.split_last() else { return self.position == Position::Argument };
        let last_matches = match (self.position, last) {
            (Position::Argument, _) => false,
            (Position::ArrayKey, ArrayStep::Key) => true,
            (Position::ArrayValue, ArrayStep::Value(_)) => true,
            (Position::ListValue, ArrayStep::Value(None)) => true,
            (Position::ValueOfKey(wanted), ArrayStep::Value(Some(key))) => key == wanted,
            _ => false,
        };
        last_matches
            && (outer.is_empty() || (self.nested && outer.iter().all(|step| matches!(step, ArrayStep::Value(_)))))
    }

    fn callee_matches(&self, target: &CallTarget, resolver: &Resolver<'_>) -> bool {
        match (self.callee, target) {
            (CalleePattern::Function(wanted), CallTarget::Function(candidates)) => {
                candidates.iter().any(|fqn| fqn_eq(NameKind::Function, fqn.trim_start_matches('\\'), wanted))
            }
            (CalleePattern::Method { classes, names }, CallTarget::Method { classes: receivers, name }) => {
                names.iter().any(|wanted| wanted.eq_ignore_ascii_case(name))
                    && receivers.iter().any(|receiver| {
                        classes.iter().any(|class| fqn_eq(NameKind::ClassLike, receiver, class))
                            || resolver.class_model(receiver).is_some_and(|model| {
                                classes.iter().any(|class| class.contains('\\') && model.is_subclass_of(class))
                            })
                    })
            }
            _ => false,
        }
    }
}

// ------------------------------------------------------------------ sites

/// The call a string literal is an argument of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallTarget {
    /// A function: the FQNs the name may mean (the namespaced one, then
    /// the global one for an unqualified name).
    Function(Vec<String>),
    /// A method of the receiver's classes (FQNs).
    Method { classes: Vec<String>, name: String },
}

/// One step from an argument into the arrays around the string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArrayStep {
    Key,
    /// A value, with its string key when it has one.
    Value(Option<String>),
}

/// A string literal argument of a call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StringSite {
    /// The byte range of the content, inside the quotes.
    pub start: u32,
    pub end: u32,
    /// The content as written.
    pub value: String,
    pub target: CallTarget,
    /// The position among the positional arguments; `None` for a named
    /// argument.
    pub index: Option<usize>,
    pub argument_name: Option<String>,
    /// From the argument down to the string.
    pub steps: Vec<ArrayStep>,
}

/// Helpers that return a service when called without arguments, as
/// Laravel's `helpers.php` documents them (`config()` is the repository).
const HELPER_INSTANCES: &[(&str, &str)] = &[("config", "Illuminate\\Config\\Repository")];

/// A string literal argument before its call is resolved.
struct RawSite<'a> {
    call: &'a Expression<'a>,
    span: Span,
    index: Option<usize>,
    argument_name: Option<String>,
    steps: Vec<ArrayStep>,
}

struct Collect<'a, 'n> {
    /// Only the literal starting at this offset.
    want: Option<u32>,
    /// The function and method names asked about, lower case.
    names: &'n HashSet<String>,
    out: Vec<RawSite<'a>>,
}

struct SiteWalker;

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn member_name(selector: &ClassLikeMemberSelector<'_>) -> Option<String> {
    match selector {
        ClassLikeMemberSelector::Identifier(name) => Some(lossy(name.value)),
        _ => None,
    }
}

/// The name of what `expr` calls and its arguments.
fn call_parts<'a>(expr: &'a Expression<'a>) -> Option<(String, &'a ArgumentList<'a>)> {
    match expr {
        Expression::Call(Call::Function(call)) => match call.function {
            Expression::Identifier(identifier) => {
                let name = lossy(identifier.value());
                let short = name.rsplit('\\').next().unwrap_or(&name).to_owned();
                Some((short, &call.argument_list))
            }
            _ => None,
        },
        Expression::Call(Call::Method(call)) => Some((member_name(&call.method)?, &call.argument_list)),
        Expression::Call(Call::NullSafeMethod(call)) => Some((member_name(&call.method)?, &call.argument_list)),
        Expression::Call(Call::StaticMethod(call)) => Some((member_name(&call.method)?, &call.argument_list)),
        Expression::Instantiation(instantiation) => {
            Some(("__construct".to_owned(), instantiation.argument_list.as_ref()?))
        }
        _ => None,
    }
}

impl<'a> Collect<'a, '_> {
    fn strings(
        &mut self,
        call: &'a Expression<'a>,
        value: &'a Expression<'a>,
        at: (Option<usize>, Option<&str>),
        steps: &mut Vec<ArrayStep>,
    ) {
        match value {
            Expression::Literal(Literal::String(string)) => {
                let span = string.span();
                if self.want.is_none_or(|want| want == span.start.offset) {
                    self.out.push(RawSite {
                        call,
                        span,
                        index: at.0,
                        argument_name: at.1.map(str::to_owned),
                        steps: steps.clone(),
                    });
                }
            }
            Expression::Parenthesized(inner) => self.strings(call, inner.expression, at, steps),
            Expression::Array(_) | Expression::LegacyArray(_) => {
                let elements: Vec<&ArrayElement<'_>> = match value {
                    Expression::Array(array) => array.elements.iter().collect(),
                    Expression::LegacyArray(array) => array.elements.iter().collect(),
                    _ => Vec::new(),
                };
                for element in elements {
                    match element {
                        ArrayElement::KeyValue(element) => {
                            steps.push(ArrayStep::Key);
                            self.strings(call, element.key, at, steps);
                            steps.pop();
                            let key = match element.key {
                                Expression::Literal(Literal::String(string)) => string.value.map(lossy),
                                _ => None,
                            };
                            steps.push(ArrayStep::Value(key));
                            self.strings(call, element.value, at, steps);
                            steps.pop();
                        }
                        ArrayElement::Value(element) => {
                            steps.push(ArrayStep::Value(None));
                            self.strings(call, element.value, at, steps);
                            steps.pop();
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

impl<'a> Walker<'a, 'a, Collect<'a, '_>> for SiteWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Collect<'a, '_>) {
        let Some((name, list)) = call_parts(expr) else { return };
        if !cx.names.contains(&name.to_ascii_lowercase()) {
            return;
        }
        let mut positional = 0;
        for argument in list.arguments.iter() {
            let mut steps = Vec::new();
            match argument {
                Argument::Positional(argument) => {
                    cx.strings(expr, argument.value, (Some(positional), None), &mut steps);
                    positional += 1;
                }
                Argument::Named(argument) => {
                    let name = lossy(argument.name.value);
                    cx.strings(expr, argument.value, (None, Some(&name)), &mut steps);
                }
            }
        }
    }
}

/// The string literal arguments of `parsed` (only the one starting at
/// `want` when given) in calls named like a pattern of `kinds`, with their
/// calls resolved.
pub fn sites(
    parsed: &ParsedFile,
    resolver: &Resolver<'_>,
    kinds: &[&dyn ReferenceKind],
    want: Option<u32>,
) -> Vec<StringSite> {
    let names: HashSet<String> = kinds
        .iter()
        .flat_map(|kind| kind.patterns().iter().flat_map(PlacePattern::names))
        .map(str::to_ascii_lowercase)
        .collect();
    let mut collect = Collect { want, names: &names, out: Vec::new() };
    SiteWalker.walk_program(parsed.program(), &mut collect);
    if collect.out.is_empty() {
        return Vec::new();
    }
    let file_names = FileNames::resolve(parsed);
    let summary = FileSummary::extract(parsed);
    let types = ExprTypes::new(parsed, &file_names, &summary, resolver);
    let text = parsed.text();
    collect
        .out
        .into_iter()
        .filter_map(|raw| {
            let target = call_target(&types, &file_names, resolver, raw.call)?;
            let start = raw.span.start.offset + 1;
            let end = raw.span.end.offset.saturating_sub(1).max(start);
            Some(StringSite {
                start,
                end,
                value: text.get(start as usize..end as usize).unwrap_or_default().to_owned(),
                target,
                index: raw.index,
                argument_name: raw.argument_name,
                steps: raw.steps,
            })
        })
        .collect()
}

fn call_target<'a>(
    types: &ExprTypes<'a, '_>,
    names: &FileNames,
    resolver: &Resolver<'_>,
    call: &'a Expression<'a>,
) -> Option<CallTarget> {
    if let Expression::Call(Call::Function(function)) = call {
        let Expression::Identifier(identifier) = function.function else { return None };
        let name = lossy(identifier.value());
        let resolved = names.scope_at(identifier.span().start.offset).resolve(NameKind::Function, &name);
        return Some(CallTarget::Function(resolved.resolution.candidates().map(str::to_owned).collect()));
    }
    let frames = types.locate(call.span().start.offset).expression.map(|(_, frames)| frames).unwrap_or_default();
    let Callee::Method { receiver, name } = crate::signature::callee(types, names, resolver, call, &frames)? else {
        return None;
    };
    let mut classes: Vec<String> = receiver
        .members()
        .iter()
        .filter_map(|member| match member {
            Type::Named { fqn, .. } => Some(fqn.trim_start_matches('\\').to_owned()),
            _ => None,
        })
        .collect();
    let object = match call {
        Expression::Call(Call::Method(method)) => Some(method.object),
        Expression::Call(Call::NullSafeMethod(method)) => Some(method.object),
        _ => None,
    };
    if let Some(class) = object.and_then(helper_instance) {
        classes.push(class.to_owned());
    }
    Some(CallTarget::Method { classes, name })
}

/// `config()`: the service a helper returns without arguments.
fn helper_instance(object: &Expression<'_>) -> Option<&'static str> {
    let Expression::Call(Call::Function(call)) = object else { return None };
    let Expression::Identifier(identifier) = call.function else { return None };
    if !call.argument_list.arguments.is_empty() {
        return None;
    }
    let name = identifier.value();
    let name = name.strip_prefix(b"\\").unwrap_or(name);
    HELPER_INSTANCES.iter().find(|(helper, _)| helper.as_bytes().eq_ignore_ascii_case(name)).map(|(_, class)| *class)
}

// ------------------------------------------------------------------ kinds

/// What [`ReferenceKind`] methods get.
pub struct RefContext<'e> {
    pub engine: &'e PhpEngine,
    pub project: Arc<LaravelProject>,
}

/// A completion item of a kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefItem {
    pub label: String,
    /// The text inserted (usually the label).
    pub insert: String,
    pub detail: Option<String>,
    /// The byte range of the value the item replaces: from `from` to the
    /// caret, and to `to` on Tab.
    pub from: usize,
    pub to: usize,
}

/// A part of a value that can be renamed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenameTarget {
    /// The value usages must have (or start with, see
    /// [`ReferenceKind::renames_with`]).
    pub key: String,
    /// The byte range of `key` that the new name replaces.
    pub range: (usize, usize),
    /// The declaration renamed with it: its file and the range replaced.
    pub declaration: Option<(PathBuf, Range)>,
}

/// A kind of string reference; see the module documentation.
pub trait ReferenceKind: Send + Sync {
    /// The kind's id (`configKey`).
    fn id(&self) -> &'static str;

    /// The places strings of this kind sit in.
    fn patterns(&self) -> &'static [PlacePattern];

    /// Completion items for the string `value` with the caret at its byte
    /// `at` (the text before it is what was typed).
    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem>;

    /// What `value` names, the caret at byte `at` of it (a kind with
    /// segments may resolve the segment at the caret).
    fn resolve(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<Target>;

    /// Words (lower case) every file holding a usage of `value` has, for the
    /// word index.
    fn usage_words(&self, value: &str) -> Vec<String> {
        crate::index::words(value)
    }

    /// Whether a usage written `value` is one of `key`.
    fn refers_to(&self, value: &str, key: &str) -> bool {
        value == key
    }

    /// The value a declaration at byte `offset` of `path` declares (the
    /// key of a configuration array), with the byte range of its literal's
    /// content and the caret's byte in the value.
    fn declared_at(&self, _cx: &RefContext<'_>, _path: &Path, _parsed: &ParsedFile, _offset: u32) -> Option<Declared> {
        None
    }

    /// What renaming at byte `at` of `value` changes; `None` when it can't
    /// be renamed there.
    fn rename_target(&self, _cx: &RefContext<'_>, _value: &str, _at: usize) -> Option<RenameTarget> {
        None
    }

    /// Whether a usage written `value` changes with a rename of `key`
    /// (`app` when `app.name` is renamed: keys below it change too).
    fn renames_with(&self, value: &str, key: &str) -> bool {
        value == key
    }

    /// Whether `name` can be the new name of a rename.
    fn valid_name(&self, name: &str) -> bool {
        !name.is_empty() && !name.contains(['\'', '"', '\\'])
    }

    /// Whether `value` names something that exists (the "unknown …"
    /// inspection).
    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool;
}

/// A declaration found by [`ReferenceKind::declared_at`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declared {
    pub value: String,
    pub start: u32,
    pub end: u32,
    pub at: usize,
}

/// The built-in kinds.
pub fn kinds() -> &'static [&'static dyn ReferenceKind] {
    &[&ConfigKey]
}

/// The kind whose patterns `site` matches.
pub fn kind_of(site: &StringSite, resolver: &Resolver<'_>) -> Option<&'static dyn ReferenceKind> {
    kinds().iter().copied().find(|kind| kind.patterns().iter().any(|pattern| pattern.matches(site, resolver)))
}

// ------------------------------------------------------------------ caret

/// What the caret is on.
pub struct Subject {
    pub kind: &'static dyn ReferenceKind,
    /// The value (a declaration's full key).
    pub value: String,
    /// The caret's byte in `value`.
    pub at: usize,
    /// The byte range of the literal's content in the file.
    pub start: u32,
    pub end: u32,
    /// The caret is on a declaration, not a usage.
    pub declaration: bool,
}

/// The string literal around `offset` (inside its quotes): the offset of
/// its opening quote, and of the end of its content (the closing quote, or
/// the end of the line while it isn't closed) and whether it is closed.
fn literal_around(text: &str, offset: usize) -> Option<(usize, usize, bool)> {
    let bytes = text.as_bytes();
    let quote = crate::complete::string_start(bytes, offset)?;
    let mut end = offset;
    while end < bytes.len() && bytes[end] != bytes[quote] && bytes[end] != b'\n' {
        if bytes[end] == b'\\' {
            end += 1;
        }
        end += 1;
    }
    let end = end.min(bytes.len());
    let closed = bytes.get(end) == Some(&bytes[quote]);
    let content_end = if closed { end } else { text[..end].trim_end().len().max(offset) };
    Some((quote, content_end, closed))
}

/// The string site at `offset` of `parsed`, in its own parse or in a probe
/// with the literal closed.
pub fn site_at(parsed: &ParsedFile, resolver: &Resolver<'_>, offset: u32) -> Option<StringSite> {
    let text = parsed.text();
    let (quote, content_end, closed) = literal_around(text, offset as usize)?;
    let kinds = kinds();
    if let Some(site) = sites(parsed, resolver, kinds, Some(quote as u32)).into_iter().next() {
        return Some(site);
    }
    // Not a literal of the parse (being typed): a probe string in its place.
    let after = if closed { content_end + 1 } else { content_end };
    let rest = &text[after..];
    let mut tries = vec![String::new()];
    if !closed {
        tries.push(")".to_owned());
    }
    for close in tries {
        let terminator = if crate::complete::needs_terminator(rest) { ";" } else { "" };
        let probe_value = "x".repeat(content_end - quote - 1);
        let probe =
            ParsedFile::parse("reference.php", format!("{}'{probe_value}'{close}{terminator}{rest}", &text[..quote]));
        if let Some(mut site) = sites(&probe, resolver, kinds, Some(quote as u32)).into_iter().next() {
            site.start = quote as u32 + 1;
            site.end = content_end as u32;
            site.value = text[quote + 1..content_end].to_owned();
            return Some(site);
        }
    }
    None
}

impl PhpEngine {
    /// The reference context, when the project is a Laravel project.
    fn ref_context(&self) -> Option<RefContext<'_>> {
        Some(RefContext { engine: self, project: self.laravel()? })
    }

    /// What the caret at `offset` of `parsed` (the file at `path`) is on.
    fn ref_subject(&self, parsed: &ParsedFile, path: &Path, offset: u32) -> Option<(RefContext<'_>, Subject)> {
        // Cheap checks first: inside a string at all.
        literal_around(parsed.text(), offset as usize)?;
        let cx = self.ref_context()?;
        let resolver = self.resolver();
        if let Some(site) = site_at(parsed, &resolver, offset)
            && let Some(kind) = kind_of(&site, &resolver)
        {
            let at = (offset.clamp(site.start, site.end) - site.start) as usize;
            let subject = Subject { kind, value: site.value, at, start: site.start, end: site.end, declaration: false };
            return Some((cx, subject));
        }
        let declared = kinds().iter().find_map(|kind| Some((*kind, kind.declared_at(&cx, path, parsed, offset)?)));
        let (kind, declared) = declared?;
        let subject = Subject {
            kind,
            value: declared.value,
            at: declared.at,
            start: declared.start,
            end: declared.end,
            declaration: true,
        };
        Some((cx, subject))
    }

    /// Completion inside a string reference; `None` when the caret isn't in
    /// one.
    pub(crate) fn string_ref_completion(&self, parsed: &ParsedFile, path: &Path, offset: u32) -> Option<Completions> {
        let (cx, subject) = self.ref_subject(parsed, path, offset)?;
        if subject.declaration {
            return None;
        }
        let lines = parsed.line_index();
        let typed = &subject.value[..subject.at];
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        for item in subject.kind.complete(&cx, &subject.value, subject.at) {
            let prefix = typed.get(item.from..).unwrap_or_default();
            let Some(quality) = crate::complete::quality(&item.label, prefix) else { continue };
            if !seen.insert(item.label.clone()) {
                continue;
            }
            let from = subject.start + item.from as u32;
            let to = subject.start + item.to.max(subject.at) as u32;
            items.push(Completion {
                label: item.label.clone(),
                label_detail: None,
                detail: item.detail,
                kind: CompletionKind::Value,
                insert_text: item.insert,
                is_snippet: false,
                filter_text: None,
                sort_text: format!("0{quality}{}", item.label.to_lowercase()),
                replace: lines.range(from, offset),
                replace_tab: (to > offset).then(|| lines.range(from, to)),
                additional_edits: Vec::new(),
                deprecated: false,
                data: None,
            });
        }
        items.sort_by(|a, b| a.sort_text.cmp(&b.sort_text));
        // The segment being completed changes with every `.`: ask again.
        Some(Completions { items, incomplete: true })
    }

    /// Goto from a string reference; `None` when the caret isn't on one (or
    /// is on a declaration).
    pub(crate) fn string_ref_definition(&self, parsed: &ParsedFile, path: &Path, offset: u32) -> Option<Vec<Target>> {
        let (cx, subject) = self.ref_subject(parsed, path, offset)?;
        if subject.declaration {
            return None;
        }
        Some(subject.kind.resolve(&cx, &subject.value, subject.at))
    }

    /// The usages of the string reference at the caret.
    pub(crate) fn string_ref_references(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        offset: u32,
        include_declaration: bool,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<Vec<Usage>>> {
        let (cx, subject) = self.ref_subject(parsed, path, offset)?;
        let key = subject.value.clone();
        let kind = subject.kind;
        let found = self.string_usages(kind, &key, &|value| kind.refers_to(value, &key), cancel);
        Some(found.map(|sites| {
            let mut usages: Vec<Usage> = Vec::new();
            if include_declaration {
                for target in kind.resolve(&cx, &key, key.len()) {
                    usages.push(Usage { path: target.path, range: target.range, kind: UsageKind::Declaration });
                }
            }
            for site in sites {
                usages.push(Usage { path: site.path, range: site.range, kind: UsageKind::String });
            }
            usages.sort_by(|a, b| (&a.path, a.range.start).cmp(&(&b.path, b.range.start)));
            usages.dedup();
            usages
        }))
    }

    /// The range a rename at the caret changes, when the caret is on a
    /// string reference: `Some(None)` when it can't be renamed.
    pub(crate) fn string_ref_prepare_rename(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        offset: u32,
    ) -> Option<Option<Range>> {
        let (cx, subject) = self.ref_subject(parsed, path, offset)?;
        let lines = parsed.line_index();
        Some(subject.kind.rename_target(&cx, &subject.value, subject.at).map(|target| {
            if subject.declaration {
                lines.range(subject.start, subject.end)
            } else {
                lines.range(subject.start + target.range.0 as u32, subject.start + target.range.1 as u32)
            }
        }))
    }

    /// Renames the string reference at the caret: its declaration and every
    /// usage.
    pub(crate) fn string_ref_rename(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        offset: u32,
        new_name: &str,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<WorkspaceEdit>> {
        let (cx, subject) = self.ref_subject(parsed, path, offset)?;
        let kind = subject.kind;
        let Some(target) = kind.rename_target(&cx, &subject.value, subject.at) else {
            return Some(Err(IdeError::invalid("this string can't be renamed")));
        };
        if !kind.valid_name(new_name) {
            return Some(Err(IdeError::invalid(format!("'{new_name}' is not a valid name"))));
        }
        let key = target.key.clone();
        let sites = match self.string_usages(kind, &key, &|value| kind.renames_with(value, &key), cancel) {
            Ok(sites) => sites,
            Err(e) => return Some(Err(e)),
        };
        let mut files: Vec<(PathBuf, Vec<TextEdit>)> = Vec::new();
        let mut add = |path: PathBuf, range: Range| match files.iter_mut().find(|(known, _)| *known == path) {
            Some((_, edits)) => {
                if !edits.iter().any(|edit| edit.range == range) {
                    edits.push(TextEdit { range, new_text: new_name.to_owned() });
                }
            }
            None => files.push((path, vec![TextEdit { range, new_text: new_name.to_owned() }])),
        };
        if let Some((path, range)) = target.declaration.clone() {
            add(path, range);
        }
        for site in sites {
            let range = site.lines.range(site.start + target.range.0 as u32, site.start + target.range.1 as u32);
            add(site.path, range);
        }
        let mut edit = WorkspaceEdit::default();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        for (path, edits) in files {
            edit.files.push(FileEdit::Edit { path: path.into(), edits, version: None });
        }
        Some(Ok(edit))
    }

    /// The other places in the document of the string reference at `pos`:
    /// its usages, and its declaration when it is in the document. `None`
    /// when the caret isn't on a string reference.
    pub fn string_highlights(&self, doc: DocId, pos: Pos) -> Option<Vec<StringHighlight>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let offset = parsed.line_index().byte(pos);
        let (cx, subject) = self.ref_subject(&parsed, &path, offset)?;
        let resolver = self.resolver();
        let lines = parsed.line_index();
        let mut out: Vec<StringHighlight> = Vec::new();
        for target in subject.kind.resolve(&cx, &subject.value, subject.value.len()) {
            if target.path == path && target.range != Range::default() {
                out.push(StringHighlight { range: target.range, write: true });
            }
        }
        for site in sites(&parsed, &resolver, &[subject.kind], None) {
            if subject.kind.refers_to(&site.value, &subject.value)
                && kind_of(&site, &resolver).is_some_and(|kind| kind.id() == subject.kind.id())
            {
                out.push(StringHighlight { range: lines.range(site.start, site.end), write: false });
            }
        }
        out.sort_by_key(|highlight| highlight.range.start);
        out.dedup();
        Some(out)
    }

    /// The string sites of `kind` in the project whose value `keep`
    /// accepts. The candidate files are the indexed files with every word
    /// of `key` and of the kind, and the open documents.
    fn string_usages(
        &self,
        kind: &'static dyn ReferenceKind,
        key: &str,
        keep: &dyn Fn(&str) -> bool,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<FoundSite>> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(index) = self.index() {
            let mut words = kind.usage_words(key);
            words.sort();
            words.dedup();
            let mut found: Option<HashSet<PathBuf>> = None;
            for word in words {
                let files: HashSet<PathBuf> = index.files_with_word(&word)?.into_iter().collect();
                found = Some(match found {
                    Some(known) => known.intersection(&files).cloned().collect(),
                    None => files,
                });
            }
            candidates.extend(found.unwrap_or_default());
        }
        let open: Vec<_> = self.open_documents().into_iter().filter(|document| !document.embedded).collect();
        for document in &open {
            if !candidates.contains(&document.path) {
                candidates.push(document.path.clone());
            }
        }
        candidates.sort();
        let resolver = self.resolver();
        let library = |path: &Path| self.is_library(path);
        let mut out = Vec::new();
        for path in candidates {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if library(&path) {
                continue;
            }
            let parsed = match open.iter().find(|document| document.path == path) {
                Some(document) => self.parse_open(document),
                None => {
                    let Ok(text) = std::fs::read_to_string(&path) else { continue };
                    if !text.contains(key) {
                        continue;
                    }
                    Arc::new(ParsedFile::parse("usages.php", text))
                }
            };
            if !parsed.text().contains(key) {
                continue;
            }
            let lines = Arc::new(parsed.line_index().clone());
            for site in sites(&parsed, &resolver, &[kind], None) {
                if !keep(&site.value) || !kind.patterns().iter().any(|pattern| pattern.matches(&site, &resolver)) {
                    continue;
                }
                let range = lines.range(site.start, site.end);
                out.push(FoundSite { path: path.clone(), range, start: site.start, lines: lines.clone() });
            }
        }
        Ok(out)
    }
}

/// A string site found in the project.
struct FoundSite {
    path: PathBuf,
    /// The content of the literal.
    range: Range,
    /// The byte the content starts at, and the file's lines (for edits
    /// inside it).
    start: u32,
    lines: Arc<crate::syntax::LineIndex>,
}

/// One place [`PhpEngine::string_highlights`] marks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StringHighlight {
    pub range: Range,
    /// The declaration (as opposed to a usage).
    pub write: bool,
}
