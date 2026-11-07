//! Code completion: what may be typed at the caret, ranked.
//!
//! The context comes from the text around the caret, and the types from a
//! copy of the file with a probe in place of the word being typed
//! (`$x->__ideProbe`, `$__ideProbe`, `__ideProbe`), followed by `;` when the
//! statement looks unfinished. Incomplete code then parses into the same tree
//! the finished code would, and the expression types, the flow and the class
//! models answer as they do for hover. (IntelliJ completes the same way, with
//! its documented dummy identifier; this is written for this engine.)
//!
//! Contexts:
//!
//! - after `->` / `?->`: properties and methods of the receiver's classes;
//!   after `::`: constants, enum cases, static methods and properties, and
//!   `class` (`parent::`/`self::`/`static::` also instance methods). Members
//!   the caller's class may not see (private, protected) are left out.
//!   Then the members the type providers know through magic methods
//!   (a facade's service methods, Eloquent's forwarded builder methods and
//!   scopes, model attributes), after the declared ones.
//! - after `$`: the variables the flow has at the caret (with their types),
//!   `$this` in instance code, and the superglobals.
//! - names: keywords for the place (statement start, expression, class
//!   body), class-likes (only classes after `new`, class-likes after
//!   `extends`/`implements`/`instanceof`/`catch (`), functions and constants
//!   from the file, the index and the stubs. Picking a name of another
//!   namespace adds its `use` import (a fully qualified name when the short
//!   name is taken by another import).
//! - call arguments: named arguments (`name: `) for the parameters not passed
//!   yet, the `expectedArguments` values of `.phpstorm.meta.php`, and the
//!   cases of an enum-typed parameter.
//! - `match` arms: the enum cases (or literal values) of the subject not
//!   covered yet.
//! - array keys (`$a['` / `$a[`): the keys of the array's shapes.
//!
//! Items are sorted by their group (what the context makes most likely)
//! and then by how well they match the typed prefix. Documentation is left
//! for [`PhpEngine::completion_documentation`] (completion item resolve).

#[cfg(test)]
mod tests;

use std::collections::HashSet;

use ide_core::{CancellationToken, DocId, Pos, Range, TextEdit};
use mago_span::HasSpan;
use mago_syntax::cst::{Access, ArgumentList, Call, Expression, MatchArm, Method, Modifier, Trivia, TriviaKind};
use mago_syntax::walker::Walker;
use serde::{Deserialize, Serialize};

use crate::engine::PhpEngine;
use crate::index::DeclKind;
use crate::meta::{CallTarget, MetaValue};
use crate::names::{FileNames, NameKind, fqn_eq};
use crate::navigate::symbol::{Decl, Magic, Member, MemberKind};
use crate::navigate::{enclosing_class, rank, short_name};
use crate::signature::Callee;
use crate::summary::{ClassKind, FileSummary};
use crate::syntax::ParsedFile;
use crate::types::provider::MagicTarget;
use crate::types::{ClassModel, Context, ExprTypes, Frame, PROBE_VARIABLE, Resolver, SignatureParam, Type};

/// The name put in place of the word being completed.
pub const PROBE: &str = "__ideProbe";

/// The most class-likes, functions and constants one answer lists.
const MAX_GLOBALS: usize = 100;

/// How many index short names are looked up per completion.
const MAX_INDEX_NAMES: usize = 400;

/// What a completion item is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CompletionKind {
    Class,
    Interface,
    Trait,
    Enum,
    Function,
    Method,
    Property,
    Constant,
    EnumCase,
    Variable,
    /// A named argument.
    Parameter,
    Keyword,
    /// An expected value (`.phpstorm.meta.php`), a literal or an array key.
    Value,
}

/// One completion item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Completion {
    pub label: String,
    /// Shown right after the label: a function's parameters.
    pub label_detail: Option<String>,
    /// Shown on the right: a type, or a class-like's namespace.
    pub detail: Option<String>,
    pub kind: CompletionKind,
    pub insert_text: String,
    /// `insert_text` uses snippet syntax (`$0` for the caret).
    pub is_snippet: bool,
    pub filter_text: Option<String>,
    pub sort_text: String,
    /// What accepting the item replaces: the typed prefix.
    pub replace: Range,
    /// What accepting with Tab replaces, when the word goes on after the
    /// caret.
    pub replace_tab: Option<Range>,
    /// A `use` import.
    pub additional_edits: Vec<TextEdit>,
    pub deprecated: bool,
    /// What [`PhpEngine::completion_documentation`] needs.
    pub data: Option<CompletionData>,
}

/// The answer to a completion request.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Completions {
    pub items: Vec<Completion>,
    /// More typing can bring other items (names were filtered by the
    /// prefix): ask again rather than filtering this list.
    pub incomplete: bool,
}

/// Identifies the declaration of a completion item, for its documentation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "php", rename_all = "camelCase")]
pub enum CompletionData {
    ClassLike {
        fqn: String,
    },
    Function {
        fqn: String,
    },
    Constant {
        fqn: String,
    },
    Method {
        class: String,
        name: String,
    },
    Property {
        class: String,
        name: String,
    },
    ClassConstant {
        class: String,
        name: String,
    },
    /// A property of `class` only magic methods have (a model attribute).
    MagicProperty {
        class: String,
        name: String,
    },
}

// ----------------------------------------------------------------- engine

impl PhpEngine {
    /// Completion at `pos` of an open document; `None` when the engine
    /// doesn't hold it. `trigger` is the character that opened completion
    /// automatically: items come only where it starts a context (`->`,
    /// `::`, `$`, a quote, `\`).
    pub fn completion(
        &self,
        doc: DocId,
        pos: Pos,
        trigger: Option<&str>,
        cancel: &CancellationToken,
    ) -> Option<Completions> {
        let parsed = self.parsed_document(doc)?;
        let offset = parsed.line_index().byte(pos);
        let resolver = self.resolver();
        let here = FileSummary::extract(&parsed);
        let names = FileNames::resolve(&parsed);
        let mut collector = Collector {
            engine: self,
            parsed: &parsed,
            here: &here,
            names: &names,
            resolver: &resolver,
            cancel,
            offset: offset as usize,
            prefix: String::new(),
            replace: Range::new(pos, pos),
            replace_tab: None,
            items: Vec::new(),
            seen: HashSet::new(),
            incomplete: false,
        };
        collector.run(trigger);
        let Collector { mut items, incomplete, .. } = collector;
        items.sort_by(|a, b| a.sort_text.cmp(&b.sort_text).then_with(|| a.label.cmp(&b.label)));
        Some(Completions { items, incomplete })
    }

    /// The documentation of a completion item (Markdown, as hover shows
    /// it), computed when the item is selected.
    pub fn completion_documentation(&self, doc: DocId, data: &CompletionData) -> Option<String> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let here = FileSummary::extract(&parsed);
        let resolver = self.resolver();
        let member = |kind: MemberKind, class: &str, name: &str| {
            let model = resolver.class_model(class)?;
            let receiver = Type::named(model.fqn());
            let context = Context::in_class(model.fqn());
            let ty = match kind {
                MemberKind::Method => resolver.method_return(&receiver, name, &context),
                MemberKind::Property => resolver.property_type(&receiver, name, &context),
                MemberKind::Constant => resolver.class_constant_type(&receiver, name, &context),
            };
            Some(Decl::Member(Member { kind, model, name: name.to_owned(), receiver, context, ty }))
        };
        let decl = match data {
            CompletionData::ClassLike { fqn } => Decl::ClassLike(fqn.clone()),
            CompletionData::Function { fqn } => Decl::Function(fqn.clone()),
            CompletionData::Constant { fqn } => Decl::Constant(fqn.clone()),
            CompletionData::Method { class, name } => member(MemberKind::Method, class, name)?,
            CompletionData::Property { class, name } => member(MemberKind::Property, class, name)?,
            CompletionData::ClassConstant { class, name } => member(MemberKind::Constant, class, name)?,
            CompletionData::MagicProperty { class, name } => {
                let receiver = Type::named(class);
                let context = Context::in_class(class);
                let member = resolver.providers().magic_member(&receiver, name, false, &resolver, &context)?;
                let ty = resolver.property_type(&receiver, name, &context);
                Decl::Magic(Magic { member, ty })
            }
        };
        self.describe(&decl, &resolver, &path, &here)
    }
}

// ------------------------------------------------------------------- text

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80
}

/// The end of the text before `at` without its trailing whitespace.
fn skip_ws_back(bytes: &[u8], mut at: usize) -> usize {
    while at > 0 && bytes[at - 1].is_ascii_whitespace() {
        at -= 1;
    }
    at
}

/// The identifier ending at `end`, lower case.
fn word_before(bytes: &[u8], end: usize) -> String {
    let mut start = end;
    while start > 0 && is_ident(bytes[start - 1]) {
        start -= 1;
    }
    String::from_utf8_lossy(&bytes[start..end]).to_ascii_lowercase()
}

/// Whether the probe needs a `;` after it: the statement looks unfinished
/// (what follows is on a later line, a `}` or the end of the file).
fn needs_terminator(rest: &str) -> bool {
    let trimmed = rest.trim_start();
    let Some(&next) = trimmed.as_bytes().first() else { return true };
    let newline = rest[..rest.len() - trimmed.len()].contains('\n');
    next == b'}' || trimmed.starts_with("?>") || (newline && (is_ident(next) || next == b'$'))
}

/// The opening quote of the single-line string the caret is in.
fn string_start(bytes: &[u8], offset: usize) -> Option<usize> {
    let line_start = bytes[..offset].iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let mut open: Option<usize> = None;
    let mut i = line_start;
    while i < offset {
        let byte = bytes[i];
        match open {
            Some(_) if byte == b'\\' => i += 1,
            Some(quote) if byte == bytes[quote] => open = None,
            Some(_) => {}
            None if byte == b'\'' || byte == b'"' => open = Some(i),
            None if byte == b'#' || (byte == b'/' && bytes.get(i + 1) == Some(&b'/')) => return None,
            None => {}
        }
        i += 1;
    }
    open
}

/// How well `name` matches the typed `prefix`: 0 for a prefix with the
/// same case, 1 for a prefix in another case, 2 for the letters in order;
/// `None` when it doesn't match.
fn quality(name: &str, prefix: &str) -> Option<u8> {
    if prefix.is_empty() || name.starts_with(prefix) {
        return Some(0);
    }
    let lower = name.to_lowercase();
    let wanted = prefix.to_lowercase();
    if lower.starts_with(&wanted) {
        return Some(1);
    }
    // The first letter must start the name (as IntelliJ matches); the rest
    // in order.
    let mut chars = lower.trim_start_matches(['_', '$']).chars();
    let mut wanted_chars = wanted.trim_start_matches(['_', '$']).chars();
    match (wanted_chars.next(), chars.next()) {
        (Some(first), Some(name_first)) if first == name_first => {}
        (None, _) => return Some(2),
        _ => return None,
    }
    wanted_chars.all(|c| chars.any(|n| n == c)).then_some(2)
}

/// Escapes text for snippet syntax.
fn snippet_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('$', "\\$").replace('}', "\\}")
}

fn in_comment(trivia: &Trivia<'_>, offset: u32) -> bool {
    let span = trivia.span;
    match trivia.kind {
        TriviaKind::WhiteSpace => false,
        TriviaKind::SingleLineComment | TriviaKind::HashComment => {
            span.start.offset < offset && offset <= span.end.offset
        }
        TriviaKind::MultiLineComment | TriviaKind::DocBlockComment => {
            span.start.offset < offset && offset < span.end.offset
        }
    }
}

const STATEMENT_KEYWORDS: &[&str] = &[
    "abstract",
    "break",
    "class",
    "const",
    "continue",
    "declare",
    "do",
    "echo",
    "else",
    "elseif",
    "enum",
    "final",
    "for",
    "foreach",
    "function",
    "global",
    "if",
    "include",
    "include_once",
    "interface",
    "namespace",
    "readonly",
    "require",
    "require_once",
    "return",
    "static",
    "switch",
    "throw",
    "trait",
    "try",
    "unset",
    "use",
    "while",
    "yield",
];

const EXPRESSION_KEYWORDS: &[&str] = &[
    "array", "clone", "empty", "false", "fn", "function", "isset", "list", "match", "new", "null", "parent", "print",
    "self", "static", "throw", "true", "yield",
];

const CLASS_BODY_KEYWORDS: &[&str] =
    &["abstract", "const", "final", "function", "private", "protected", "public", "readonly", "static", "use", "var"];

const MODIFIERS: &[&str] = &["private", "protected", "public", "readonly", "static", "var", "final", "abstract"];

const SUPERGLOBALS: &[&str] =
    &["GLOBALS", "_COOKIE", "_ENV", "_FILES", "_GET", "_POST", "_REQUEST", "_SERVER", "_SESSION"];

// -------------------------------------------------------------- collector

/// Which class-likes a name context accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClassFilter {
    Any,
    /// `new`: classes.
    Instantiable,
}

/// How a name is inserted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Insert {
    /// As code: the short name, imported when needed.
    Code,
    /// In a `use` statement: the fully qualified name, no import.
    Import,
}

/// A class-like, function or constant offered by name.
struct Global {
    fqn: String,
    kind: DeclKind,
    /// From the stubs (ranked after the project's).
    builtin: bool,
}

struct Collector<'e, 'r> {
    engine: &'e PhpEngine,
    parsed: &'e ParsedFile,
    here: &'e FileSummary,
    names: &'e FileNames,
    resolver: &'r Resolver<'r>,
    cancel: &'e CancellationToken,
    /// The caret.
    offset: usize,
    /// The typed prefix the items are matched against.
    prefix: String,
    replace: Range,
    replace_tab: Option<Range>,
    items: Vec<Completion>,
    seen: HashSet<(String, CompletionKind)>,
    incomplete: bool,
}

/// A call whose argument the probe is.
struct ArgumentSite<'a> {
    call: &'a Expression<'a>,
    /// The position of the probe among the arguments.
    index: usize,
    /// The names of the named arguments given.
    named: Vec<String>,
}

/// What the probe is part of.
#[derive(Default)]
struct Sites<'a> {
    probe: u32,
    argument: Option<ArgumentSite<'a>>,
    /// A `match` whose arm condition the probe is, with the names of the
    /// class constants the other conditions use.
    arm: Option<(&'a Expression<'a>, Vec<String>)>,
    /// An array access whose index the probe is.
    key: Option<&'a Expression<'a>>,
}

struct SiteWalker;

impl<'a> Sites<'a> {
    fn arguments(&mut self, call: &'a Expression<'a>, list: &'a ArgumentList<'a>) {
        let at = list.arguments.iter().position(|argument| argument.value().span().start.offset == self.probe);
        if let Some(at) = at
            && list.arguments.get(at).is_some_and(|argument| argument.is_positional())
        {
            // The parameter position: the positional arguments before it.
            let index = list.arguments.iter().take(at).filter(|argument| argument.is_positional()).count();
            let named = list
                .arguments
                .iter()
                .filter_map(|argument| match argument {
                    mago_syntax::cst::Argument::Named(named) => {
                        Some(String::from_utf8_lossy(named.name.value).into_owned())
                    }
                    _ => None,
                })
                .collect();
            self.argument = Some(ArgumentSite { call, index, named });
        }
    }
}

impl<'a> Walker<'a, 'a, Sites<'a>> for SiteWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut Sites<'a>) {
        match expr {
            Expression::Call(Call::Function(call)) => cx.arguments(expr, &call.argument_list),
            Expression::Call(Call::Method(call)) => cx.arguments(expr, &call.argument_list),
            Expression::Call(Call::NullSafeMethod(call)) => cx.arguments(expr, &call.argument_list),
            Expression::Call(Call::StaticMethod(call)) => cx.arguments(expr, &call.argument_list),
            Expression::Instantiation(instantiation) => {
                if let Some(list) = &instantiation.argument_list {
                    cx.arguments(expr, list);
                }
            }
            Expression::Match(r#match) => {
                let mut hit = false;
                let mut covered = Vec::new();
                for arm in r#match.arms.iter() {
                    let MatchArm::Expression(arm) = arm else { continue };
                    for condition in arm.conditions.iter() {
                        if condition.span().start.offset == cx.probe {
                            hit = true;
                        } else if let Expression::Access(Access::ClassConstant(access)) = condition
                            && let mago_syntax::cst::ClassLikeConstantSelector::Identifier(name) = &access.constant
                        {
                            covered.push(String::from_utf8_lossy(name.value).into_owned());
                        } else if let Expression::Literal(literal) = condition {
                            covered.push(literal_text(literal));
                        }
                    }
                }
                if hit {
                    cx.arm = Some((expr, covered));
                }
            }
            Expression::ArrayAccess(access) if access.index.span().start.offset == cx.probe => cx.key = Some(expr),
            _ => {}
        }
    }
}

/// A literal's source form as a match arm compares it (`'a'`, `1`).
fn literal_text(literal: &mago_syntax::cst::Literal<'_>) -> String {
    match literal {
        mago_syntax::cst::Literal::String(string) => {
            format!("'{}'", String::from_utf8_lossy(string.value.unwrap_or_default()))
        }
        mago_syntax::cst::Literal::Integer(integer) => String::from_utf8_lossy(integer.raw).into_owned(),
        _ => String::new(),
    }
}

impl<'e, 'r> Collector<'e, 'r> {
    fn text(&self) -> &'e str {
        self.parsed.text()
    }

    fn pos(&self, byte: usize) -> Pos {
        self.parsed.line_index().pos(byte as u32)
    }

    /// Items replace `start..caret` (Tab: `start..end`), matched against
    /// the text there.
    fn word(&mut self, start: usize, end: usize) {
        self.prefix = self.text()[start..self.offset].to_owned();
        self.replace = Range::new(self.pos(start), self.pos(self.offset));
        self.replace_tab = (end > self.offset).then(|| Range::new(self.pos(start), self.pos(end)));
    }

    fn run(&mut self, trigger: Option<&str>) {
        let program = self.parsed.program();
        if program.trivia.iter().any(|trivia| in_comment(trivia, self.offset as u32)) {
            return;
        }
        let bytes = self.text().as_bytes();
        let offset = self.offset;
        let mut start = offset;
        while start > 0 && is_ident(bytes[start - 1]) {
            start -= 1;
        }
        let mut end = offset;
        while end < bytes.len() && is_ident(bytes[end]) {
            end += 1;
        }
        if start < offset && bytes[start].is_ascii_digit() {
            return;
        }
        // `$name`, or `Foo::$name`.
        if start > 0 && bytes[start - 1] == b'$' {
            let dollar = start - 1;
            let before = skip_ws_back(bytes, dollar);
            if bytes[..before].ends_with(b"::") {
                self.word(dollar, end);
                self.members(dollar, end, true);
            } else {
                self.word(dollar, end);
                self.variables(dollar, end);
            }
            return;
        }
        let before = skip_ws_back(bytes, start);
        if bytes[..before].ends_with(b"->") || bytes[..before].ends_with(b"::") {
            self.word(start, end);
            self.members(start, end, false);
            return;
        }
        if let Some(quote) = string_start(bytes, offset) {
            self.string(quote);
            return;
        }
        if trigger.is_some_and(|trigger| !matches!(trigger, "\\" | "$")) {
            return;
        }
        let mut qualified = start;
        while qualified > 0 && (is_ident(bytes[qualified - 1]) || bytes[qualified - 1] == b'\\') {
            qualified -= 1;
        }
        self.word(qualified, end);
        self.names(qualified, end);
    }

    // ------------------------------------------------------------- probes

    /// The file with `replacement` in place of `start..end` (and a `;` when
    /// the statement looks unfinished).
    fn probe(&self, start: usize, end: usize, replacement: &str) -> ParsedFile {
        let text = self.text();
        let rest = &text[end..];
        let terminator = if needs_terminator(rest) { ";" } else { "" };
        ParsedFile::parse("completion.php", format!("{}{replacement}{terminator}{rest}", &text[..start]))
    }

    fn push(&mut self, mut item: Completion, group: u8) {
        let name = item.filter_text.as_deref().unwrap_or(&item.label);
        let Some(quality) = quality(name, &self.prefix) else { return };
        if !self.seen.insert((item.label.clone(), item.kind)) {
            return;
        }
        item.sort_text = format!("{group}{quality}{}", item.label.to_lowercase());
        item.replace = self.replace;
        item.replace_tab = self.replace_tab;
        self.items.push(item);
    }

    fn item(label: impl Into<String>, kind: CompletionKind) -> Completion {
        let label = label.into();
        Completion {
            insert_text: label.clone(),
            label,
            label_detail: None,
            detail: None,
            kind,
            is_snippet: false,
            filter_text: None,
            sort_text: String::new(),
            replace: Range::default(),
            replace_tab: None,
            additional_edits: Vec::new(),
            deprecated: false,
            data: None,
        }
    }

    /// Whether `(` already follows the word.
    fn call_follows(&self, end: usize) -> bool {
        self.text()[end..].trim_start().starts_with('(')
    }

    // ------------------------------------------------------------ members

    /// Members after `->`, `?->` or `::` (`dollar`: after `::$`).
    fn members(&mut self, start: usize, end: usize, dollar: bool) {
        let replacement = if dollar { format!("${PROBE}") } else { PROBE.to_owned() };
        let probe = self.probe(start, end, &replacement);
        let names = FileNames::resolve(&probe);
        let summary = FileSummary::extract(&probe);
        let types = ExprTypes::new(&probe, &names, &summary, self.resolver);
        let Some((expr, frames)) = types.locate(start as u32).expression else { return };
        let context = types.context(&frames);
        let relative = |class: &Expression<'_>| {
            matches!(class, Expression::Parent(_) | Expression::Self_(_) | Expression::Static(_))
        };
        let (receiver, is_static, relative) = match expr {
            Expression::Access(Access::Property(access)) => (types.type_of(access.object, &frames), false, false),
            Expression::Access(Access::NullSafeProperty(access)) => {
                (types.type_of(access.object, &frames).without_null(), false, false)
            }
            Expression::Call(Call::Method(call)) => (types.type_of(call.object, &frames), false, false),
            Expression::Call(Call::NullSafeMethod(call)) => {
                (types.type_of(call.object, &frames).without_null(), false, false)
            }
            Expression::Access(Access::ClassConstant(access)) => {
                (types.class_ref(access.class, &frames), true, relative(access.class))
            }
            Expression::Access(Access::StaticProperty(access)) => {
                (types.class_ref(access.class, &frames), true, relative(access.class))
            }
            Expression::Call(Call::StaticMethod(call)) => {
                (types.class_ref(call.class, &frames), true, relative(call.class))
            }
            _ => return,
        };
        let in_static_method = frames
            .iter()
            .rev()
            .find(|frame| !matches!(frame, Frame::Class(_)))
            .is_some_and(|frame| matches!(frame, Frame::Method(method) if is_static_method(method)));
        let scope = context.self_class.as_deref().and_then(|class| self.resolver.class_model(class));
        let call_follows = self.call_follows(end);
        for model in self.resolver.class_models(&receiver, &context) {
            if self.cancel.is_cancelled() {
                return;
            }
            let own = model.fqn().to_owned();
            let group = |declaring: &str| if fqn_eq(NameKind::ClassLike, declaring, &own) { 1 } else { 2 };
            if !dollar {
                for method in model.methods.iter() {
                    if !model.is_accessible(method, scope.as_deref()) {
                        continue;
                    }
                    let instance_ok = !is_static || (relative && !in_static_method) || method.is_static;
                    // Magic methods only when asked for (`__`), or
                    // `parent::__construct()`.
                    let magic_ok = !method.name.starts_with("__")
                        || self.prefix.starts_with('_')
                        || (relative && method.name.eq_ignore_ascii_case("__construct"));
                    if !instance_ok || !magic_ok {
                        continue;
                    }
                    let params = self.resolver.method_params_on(&receiver, &method.name, &context).unwrap_or_default();
                    let returns = self.resolver.method_return(&receiver, &method.name, &context);
                    let mut item = Self::item(&method.name, CompletionKind::Method);
                    item.label_detail = Some(params_text(&params));
                    item.detail = Some(returns.widen().to_string());
                    item.deprecated =
                        method.declared().is_some_and(|m| m.doc.as_ref().is_some_and(|d| d.deprecated.is_some()));
                    if !call_follows {
                        item.insert_text = if params.is_empty() {
                            format!("{}()", snippet_escape(&method.name))
                        } else {
                            format!("{}($0)", snippet_escape(&method.name))
                        };
                        item.is_snippet = true;
                    }
                    item.data =
                        Some(CompletionData::Method { class: model.fqn().to_owned(), name: method.name.clone() });
                    let group = group(&method.declaring.fqn);
                    self.push(item, group);
                }
            }
            for property in model.properties.iter() {
                if property.is_static != is_static || !model.is_accessible(property, scope.as_deref()) {
                    continue;
                }
                let ty = self.resolver.property_type(&receiver, &property.name, &context);
                let label = if is_static { format!("${}", property.name) } else { property.name.clone() };
                let mut item = Self::item(label, CompletionKind::Property);
                item.detail = Some(ty.widen().to_string());
                item.deprecated =
                    property.declared().is_some_and(|p| p.doc.as_ref().is_some_and(|d| d.deprecated.is_some()));
                item.data =
                    Some(CompletionData::Property { class: model.fqn().to_owned(), name: property.name.clone() });
                let group = group(&property.declaring.fqn);
                self.push(item, group);
            }
            if is_static && !dollar {
                for constant in model.constants.iter() {
                    if !model.is_accessible(constant, scope.as_deref()) {
                        continue;
                    }
                    let kind =
                        if constant.case().is_some() { CompletionKind::EnumCase } else { CompletionKind::Constant };
                    let ty = self.resolver.class_constant_type(&receiver, &constant.name, &context);
                    let mut item = Self::item(&constant.name, kind);
                    item.detail = Some(ty.widen().to_string());
                    item.data = Some(CompletionData::ClassConstant {
                        class: model.fqn().to_owned(),
                        name: constant.name.clone(),
                    });
                    let group = if kind == CompletionKind::EnumCase { 0 } else { group(&constant.declaring.fqn) };
                    self.push(item, group);
                }
            }
        }
        self.magic_members(&receiver, &context, is_static, dollar, call_follows);
        if is_static && !dollar {
            self.push(Self::item("class", CompletionKind::Keyword), 3);
        }
    }

    /// The members of `receiver` the type providers know through magic
    /// methods, after `->` (instance ones) or `::` (static ones).
    fn magic_members(&mut self, receiver: &Type, context: &Context, is_static: bool, dollar: bool, call_follows: bool) {
        if dollar {
            return;
        }
        for member in self.resolver.providers().magic_members(receiver, self.resolver, context) {
            if self.cancel.is_cancelled() {
                return;
            }
            if member.is_static != is_static {
                continue;
            }
            let item = match &member.target {
                MagicTarget::Method { class, method } => {
                    let target = Type::named(class);
                    let mut params = self.resolver.method_params_on(&target, method, context).unwrap_or_default();
                    // A scope's query parameter is passed by Eloquent.
                    if !method.eq_ignore_ascii_case(&member.name) && !params.is_empty() {
                        params.remove(0);
                    }
                    let returns = self.resolver.method_return(&target, method, context);
                    let mut item = Self::item(&member.name, CompletionKind::Method);
                    item.label_detail = Some(params_text(&params));
                    item.detail = Some(returns.widen().to_string());
                    if !call_follows {
                        let body = if params.is_empty() { "()" } else { "($0)" };
                        item.insert_text = format!("{}{body}", snippet_escape(&member.name));
                        item.is_snippet = true;
                    }
                    item.data = Some(CompletionData::Method { class: class.clone(), name: method.clone() });
                    item
                }
                MagicTarget::Attribute { class, ty, .. } => {
                    let mut item = Self::item(&member.name, CompletionKind::Property);
                    item.detail = Some(ty.widen().to_string());
                    item.data = Some(CompletionData::MagicProperty { class: class.clone(), name: member.name.clone() });
                    item
                }
            };
            self.push(item, 2);
        }
    }

    // ---------------------------------------------------------- variables

    fn variables(&mut self, dollar: usize, end: usize) {
        let probe = self.probe(dollar, end, &format!("${PROBE}"));
        let names = FileNames::resolve(&probe);
        let summary = FileSummary::extract(&probe);
        let types = ExprTypes::new(&probe, &names, &summary, self.resolver);
        let located = types.locate(dollar as u32);
        let Some((_, frames)) = located.variable.filter(|(v, _)| v.span.start.offset == dollar as u32) else {
            return;
        };
        let flow = types.flow(&frames);
        let mut found: Vec<(String, Type)> = Vec::new();
        if let Some(vars) = flow.variables_at(dollar as u32) {
            for (name, state) in vars {
                if name.as_slice() == PROBE_VARIABLE || state.defined == crate::types::Defined::No {
                    continue;
                }
                found.push((String::from_utf8_lossy(name).into_owned(), state.ty.widen()));
            }
        }
        for (name, ty) in found {
            let mut item = Self::item(format!("${name}"), CompletionKind::Variable);
            item.detail = Some(ty.to_string());
            self.push(item, 1);
        }
        let function = frames.iter().rev().find(|frame| !matches!(frame, Frame::Class(_)));
        let class = frames.iter().rev().find_map(|frame| match frame {
            Frame::Class(Some(fqn)) => Some(fqn.clone()),
            _ => None,
        });
        let is_static = matches!(function, Some(Frame::Method(method)) if is_static_method(method));
        if let Some(class) = class
            && function.is_some()
            && !is_static
        {
            let mut item = Self::item("$this", CompletionKind::Variable);
            item.detail = Some(class);
            self.push(item, 1);
        }
        for name in SUPERGLOBALS {
            let mut item = Self::item(format!("${name}"), CompletionKind::Variable);
            item.detail = Some("array".to_owned());
            self.push(item, 4);
        }
    }

    // ------------------------------------------------------------ strings

    /// Inside a string literal opened at `quote`: array keys and expected
    /// argument values.
    fn string(&mut self, quote: usize) {
        let bytes = self.text().as_bytes();
        let mut end = self.offset;
        while end < bytes.len() && bytes[end] != bytes[quote] && bytes[end] != b'\n' {
            end += 1;
        }
        let close = if bytes.get(end) == Some(&bytes[quote]) { end + 1 } else { end };
        self.prefix = self.text()[quote + 1..self.offset].to_owned();
        self.replace = Range::new(self.pos(quote + 1), self.pos(self.offset));
        self.replace_tab = (end > self.offset).then(|| Range::new(self.pos(quote + 1), self.pos(end)));
        let before = skip_ws_back(bytes, quote);
        match before.checked_sub(1).map(|i| bytes[i]) {
            Some(b'[') => self.keys(quote, close, false),
            Some(b'(' | b',') => self.arguments(quote, close, true),
            _ => {}
        }
    }

    /// Keys of the array whose index the probe at `start` is.
    fn keys(&mut self, start: usize, end: usize, quoted: bool) {
        let mut replacement = format!("'{PROBE}'");
        if !self.text()[end..].trim_start().starts_with(']') {
            replacement.push(']');
        }
        let probe = self.probe(start, end, &replacement);
        let names = FileNames::resolve(&probe);
        let summary = FileSummary::extract(&probe);
        let types = ExprTypes::new(&probe, &names, &summary, self.resolver);
        let mut sites = Sites { probe: start as u32, ..Sites::default() };
        SiteWalker.walk_program(probe.program(), &mut sites);
        let Some(Expression::ArrayAccess(access)) = sites.key else { return };
        let frames = types.locate(access.array.span().start.offset).expression.map(|(_, f)| f).unwrap_or_default();
        let base = types.type_of(access.array, &frames);
        for member in base.members() {
            let Type::Shape(shape) = member else { continue };
            for field in &shape.fields {
                let (label, insert) = match &field.key {
                    crate::types::ShapeKey::String(key) => {
                        (key.clone(), if quoted { format!("'{key}'") } else { key.clone() })
                    }
                    crate::types::ShapeKey::Int(key) => (key.to_string(), key.to_string()),
                };
                let mut item = Self::item(label, CompletionKind::Value);
                item.insert_text = insert;
                item.detail = Some(field.ty.widen().to_string());
                self.push(item, 0);
            }
        }
    }

    // -------------------------------------------------------------- names

    fn names(&mut self, start: usize, end: usize) {
        let bytes = self.text().as_bytes();
        let before = skip_ws_back(bytes, start);
        let previous = before.checked_sub(1).map(|i| bytes[i]);
        let keyword = word_before(bytes, before);
        let typed = self.text()[start..self.offset].to_owned();
        if matches!(
            keyword.as_str(),
            "function" | "class" | "interface" | "trait" | "enum" | "namespace" | "as" | "goto" | "const" | "case"
        ) && previous.is_some_and(is_ident)
        {
            // A name being declared.
            return;
        }
        if previous == Some(b'[') && before >= 2 && (is_ident(bytes[before - 2]) || b"])}".contains(&bytes[before - 2]))
        {
            // `$a[key`: array keys, quoted.
            if !typed.contains('\\') {
                self.keys(start, end, true);
            }
            return;
        }
        let class = enclosing_class(self.here, start as u32);
        let in_body = class.is_some_and(|class| {
            !class.methods.iter().any(|m| m.loc.start <= start as u32 && (start as u32) < m.loc.end)
                && class.loc.start <= start as u32
        });
        let ident_before = previous.is_some_and(is_ident);
        if in_body && !matches!(previous, Some(b'=' | b'(' | b',' | b'[' | b'.' | b'>' | b'<' | b'+' | b'-' | b'*')) {
            if keyword == "use" && ident_before {
                self.globals(&typed, ClassFilter::Any, Insert::Code, true, false);
                return;
            }
            let after_modifier = ident_before && MODIFIERS.contains(&keyword.as_str());
            for keyword in CLASS_BODY_KEYWORDS {
                self.push(Self::item(*keyword, CompletionKind::Keyword), 1);
            }
            if class.is_some_and(|class| class.kind == ClassKind::Enum) {
                self.push(Self::item("case", CompletionKind::Keyword), 1);
            }
            if after_modifier || matches!(previous, Some(b'?' | b'|' | b'&')) {
                self.globals(&typed, ClassFilter::Any, Insert::Code, true, false);
            }
            return;
        }
        if ident_before {
            match keyword.as_str() {
                "new" => {
                    self.globals(&typed, ClassFilter::Instantiable, Insert::Code, true, false);
                    return;
                }
                "extends" | "implements" | "instanceof" | "insteadof" => {
                    self.globals(&typed, ClassFilter::Any, Insert::Code, true, false);
                    return;
                }
                "use" => {
                    let functions = class.is_none();
                    self.globals(&typed, ClassFilter::Any, Insert::Import, true, functions);
                    return;
                }
                "function" | "const" => {
                    // `use function` / `use const` are handled by `use`.
                }
                _ => {}
            }
        }
        if previous == Some(b'(') && word_before(bytes, skip_ws_back(bytes, before - 1)) == "catch" {
            self.globals(&typed, ClassFilter::Any, Insert::Code, true, false);
            return;
        }
        // An expression or a statement.
        if !typed.contains('\\') {
            self.call_and_match(start, end);
        }
        let statement_start =
            matches!(previous, None | Some(b';' | b'{' | b'}')) || self.text()[..before].trim_end().ends_with("<?php");
        if !typed.contains('\\') {
            if statement_start {
                for keyword in STATEMENT_KEYWORDS {
                    self.push(Self::item(*keyword, CompletionKind::Keyword), 3);
                }
            }
            for keyword in EXPRESSION_KEYWORDS {
                self.push(Self::item(*keyword, CompletionKind::Keyword), 3);
            }
        }
        self.globals(&typed, ClassFilter::Any, Insert::Code, true, true);
    }

    /// Named arguments, expected values and enum cases for the argument the
    /// probe at `start` is, and the cases of a `match` subject.
    fn call_and_match(&mut self, start: usize, end: usize) {
        let probe = self.probe(start, end, PROBE);
        if self.arguments_in(&probe, start, false) {
            return;
        }
        // A `match` arm being started: finish it so the `match` parses.
        let text = self.text();
        let rest = &text[end..];
        let after = rest.trim_start();
        if after.starts_with("=>") || !(after.starts_with('}') || after.starts_with(',')) {
            return;
        }
        let comma = if after.starts_with('}') { "," } else { "" };
        let probe = ParsedFile::parse("completion.php", format!("{}{PROBE} => null{comma}{rest}", &text[..start]));
        self.arguments_in(&probe, start, false);
    }

    /// Like [`Self::call_and_match`] for a string argument (`quoted`: the
    /// caret is inside the quotes, values are inserted without them).
    fn arguments(&mut self, start: usize, end: usize, quoted: bool) {
        let probe = self.probe(start, end, &format!("'{PROBE}'"));
        self.arguments_in(&probe, start, quoted);
    }

    /// True when the probe is an argument or a `match` arm condition.
    fn arguments_in(&mut self, probe: &ParsedFile, start: usize, in_string: bool) -> bool {
        let names = FileNames::resolve(probe);
        let summary = FileSummary::extract(probe);
        let types = ExprTypes::new(probe, &names, &summary, self.resolver);
        let mut sites = Sites { probe: start as u32, ..Sites::default() };
        SiteWalker.walk_program(probe.program(), &mut sites);
        let frames_at = |expr: &Expression<'_>| {
            types.locate(expr.span().start.offset).expression.map(|(_, f)| f).unwrap_or_default()
        };
        if let Some(site) = &sites.argument {
            let frames = frames_at(site.call);
            let context = types.context(&frames);
            let callee = crate::signature::callee(&types, &names, self.resolver, site.call, &frames);
            if let Some(callee) = callee {
                self.argument_items(&callee, site, &context, in_string);
            }
        }
        if !in_string && let Some((Expression::Match(r#match), covered)) = &sites.arm {
            let frames = frames_at(r#match.expression);
            let subject = types.type_of(r#match.expression, &frames);
            let context = types.context(&frames);
            self.value_items(&subject, &context, covered);
        }
        sites.argument.is_some() || sites.arm.is_some()
    }

    fn argument_items(&mut self, callee: &Callee, site: &ArgumentSite<'_>, context: &Context, in_string: bool) {
        let params: Vec<SignatureParam> = crate::signature::callee_params(self.resolver, self.here, callee, context);
        // Named arguments for the parameters not passed yet.
        if !in_string {
            for param in params.iter().skip(site.index) {
                let Some(name) = &param.name else { continue };
                if param.variadic || site.named.iter().any(|named| named == name) {
                    continue;
                }
                let mut item = Self::item(format!("{name}:"), CompletionKind::Parameter);
                item.insert_text = format!("{name}: ");
                item.filter_text = Some(name.clone());
                item.detail = Some(param.ty.widen().to_string());
                self.push(item, 0);
            }
        }
        if !site.named.is_empty() {
            return;
        }
        // Expected values.
        let meta = self.resolver.meta();
        let values = match callee {
            Callee::Function(fqn) => {
                meta.expected_arguments(CallTarget::Function(fqn), site.index as u32, self.resolver, context)
            }
            Callee::Method { receiver, name } => meta.expected_arguments(
                CallTarget::Method { receiver, name },
                site.index as u32,
                self.resolver,
                context,
            ),
        };
        for value in values {
            match (&value, in_string) {
                (MetaValue::String(text), true) => {
                    let mut item = Self::item(text.clone(), CompletionKind::Value);
                    item.insert_text = text.replace('\\', "\\\\").replace('\'', "\\'");
                    self.push(item, 0);
                }
                (_, true) => {}
                (_, false) => {
                    let text = value.to_string();
                    self.push(Self::item(text, CompletionKind::Value), 0);
                }
            }
        }
        // The cases of an enum-typed parameter.
        if !in_string {
            let param = params.get(site.index).or_else(|| params.last().filter(|p| p.variadic));
            if let Some(param) = param {
                let ty = param.ty.clone();
                self.value_items(&ty, context, &[]);
            }
        }
    }

    /// The enum cases (`Genre::Fiction`) and literal values of `ty` not in
    /// `covered`.
    fn value_items(&mut self, ty: &Type, context: &Context, covered: &[String]) {
        for member in ty.members() {
            match member {
                Type::Named { fqn, .. } => {
                    let Some(model) = self.resolver.class_model(fqn) else { continue };
                    if model.kind() != ClassKind::Enum {
                        continue;
                    }
                    self.enum_cases(&model, covered);
                }
                Type::Relative(_) | Type::GenericRelative { .. } => {
                    for model in self.resolver.class_models(member, context) {
                        if model.kind() == ClassKind::Enum {
                            self.enum_cases(&model, covered);
                        }
                    }
                }
                Type::LiteralString(value) => {
                    let text = format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"));
                    if !covered.contains(&text) {
                        self.push(Self::item(text, CompletionKind::Value), 0);
                    }
                }
                Type::LiteralInt(value) => {
                    let text = value.to_string();
                    if !covered.contains(&text) {
                        self.push(Self::item(text, CompletionKind::Value), 0);
                    }
                }
                _ => {}
            }
        }
    }

    fn enum_cases(&mut self, model: &ClassModel, covered: &[String]) {
        let Some((class, edit)) = self.class_insertion(NameKind::ClassLike, model.fqn(), None, Insert::Code) else {
            return;
        };
        for constant in model.constants.iter() {
            if constant.case().is_none() || covered.iter().any(|c| c == &constant.name) {
                continue;
            }
            let label = format!("{}::{}", short_name(model.fqn()), constant.name);
            let mut item = Self::item(label.clone(), CompletionKind::EnumCase);
            item.insert_text = format!("{class}::{}", constant.name);
            item.filter_text = Some(label);
            item.detail = Some(model.fqn().to_owned());
            item.additional_edits = edit.clone().into_iter().collect();
            item.data =
                Some(CompletionData::ClassConstant { class: model.fqn().to_owned(), name: constant.name.clone() });
            self.push(item, 0);
        }
    }

    // ------------------------------------------------------- global names

    /// Class-likes (and functions and constants when `functions`) whose
    /// short name matches the last segment of `typed`.
    fn globals(&mut self, typed: &str, filter: ClassFilter, insert: Insert, classes: bool, functions: bool) {
        let (namespace, short) = match typed.rsplit_once('\\') {
            Some((namespace, short)) => (Some(namespace), short),
            None => (None, typed),
        };
        if short.is_empty() && namespace.is_none() {
            // Every name of the project: wait for a letter.
            self.incomplete = true;
            return;
        }
        self.incomplete = true;
        // Items replace the whole qualified name but match its last segment.
        self.prefix = short.to_owned();
        let wanted = |kind: DeclKind| match kind {
            DeclKind::ClassLike(class_kind) => {
                classes && (filter == ClassFilter::Any || class_kind == ClassKind::Class)
            }
            DeclKind::Function | DeclKind::Constant => functions && filter == ClassFilter::Any,
            DeclKind::Namespace => false,
        };
        let mut found: Vec<Global> = Vec::new();
        let mut seen: HashSet<(String, NameKind)> = HashSet::new();
        let mut add = |found: &mut Vec<Global>, fqn: &str, kind: DeclKind, builtin: bool| {
            if !wanted(kind) || quality(short_name(fqn), short).is_none() {
                return;
            }
            let key = match kind.name_kind() {
                NameKind::Constant => fqn.to_owned(),
                _ => fqn.to_ascii_lowercase(),
            };
            if seen.insert((key, kind.name_kind())) {
                found.push(Global { fqn: fqn.to_owned(), kind, builtin });
            }
        };
        for class in &self.here.class_likes {
            add(&mut found, &class.fqn, DeclKind::ClassLike(class.kind), false);
        }
        for function in &self.here.functions {
            add(&mut found, &function.fqn, DeclKind::Function, false);
        }
        for constant in &self.here.constants {
            add(&mut found, &constant.fqn, DeclKind::Constant, false);
        }
        if let Some(index) = self.engine.index()
            && let Ok(keys) = index.short_names(self.cancel)
        {
            let ranked = if short.is_empty() { Vec::new() } else { rank(&keys, short, MAX_INDEX_NAMES) };
            for (_, key) in ranked {
                if self.cancel.is_cancelled() {
                    return;
                }
                for decl in index.by_short_name(&keys[key]).unwrap_or_default() {
                    add(&mut found, &decl.fqn, decl.kind, false);
                }
            }
        }
        let stubs = self.engine.stubs();
        for file in &stubs.files {
            for class in &file.summary.class_likes {
                add(&mut found, &class.fqn, DeclKind::ClassLike(class.kind), true);
            }
            for function in &file.summary.functions {
                add(&mut found, &function.fqn, DeclKind::Function, true);
            }
            for constant in &file.summary.constants {
                add(&mut found, &constant.fqn, DeclKind::Constant, true);
            }
        }
        // Rank before resolving types: only the best are shown.
        found.sort_by_cached_key(|global| {
            let name = short_name(&global.fqn);
            (quality(name, short).unwrap_or(3), global.builtin, name.len(), global.fqn.to_ascii_lowercase())
        });
        if found.len() > MAX_GLOBALS {
            found.truncate(MAX_GLOBALS);
        }
        let call_follows =
            self.call_follows(self.offset + self.text()[self.offset..].bytes().take_while(|&b| is_ident(b)).count());
        for global in found {
            let kind = global.kind.name_kind();
            let Some((text, edit)) = self.class_insertion(kind, &global.fqn, namespace, insert) else { continue };
            let short = short_name(&global.fqn).to_owned();
            let group = if global.builtin { 3 } else { 2 };
            let mut item = match global.kind {
                DeclKind::ClassLike(class_kind) => {
                    let kind = match class_kind {
                        ClassKind::Class => CompletionKind::Class,
                        ClassKind::Interface => CompletionKind::Interface,
                        ClassKind::Trait => CompletionKind::Trait,
                        ClassKind::Enum => CompletionKind::Enum,
                    };
                    let mut item = Self::item(&short, kind);
                    item.insert_text = text;
                    item.data = Some(CompletionData::ClassLike { fqn: global.fqn.clone() });
                    item
                }
                DeclKind::Function => {
                    let mut item = Self::item(&short, CompletionKind::Function);
                    let function = self
                        .resolver
                        .declarations()
                        .function(&global.fqn)
                        .or_else(|| self.here.function(&global.fqn).cloned());
                    let params = function
                        .map(|function| {
                            let doc = function.doc.as_deref();
                            let templates: Vec<&str> = doc.iter().flat_map(|doc| doc.local_type_names()).collect();
                            crate::types::resolve::declared_params(&function.params, doc, &templates)
                        })
                        .unwrap_or_default();
                    item.label_detail = Some(params_text(&params));
                    item.detail = self.resolver.function_return(&global.fqn).map(|ty| ty.widen().to_string());
                    if call_follows || insert == Insert::Import {
                        item.insert_text = text;
                    } else {
                        let body = if params.is_empty() { "()" } else { "($0)" };
                        item.insert_text = format!("{}{body}", snippet_escape(&text));
                        item.is_snippet = true;
                    }
                    item.data = Some(CompletionData::Function { fqn: global.fqn.clone() });
                    item
                }
                DeclKind::Constant => {
                    let mut item = Self::item(&short, CompletionKind::Constant);
                    item.insert_text = text;
                    item.detail = self.resolver.constant_type(&global.fqn).map(|ty| ty.widen().to_string());
                    item.data = Some(CompletionData::Constant { fqn: global.fqn.clone() });
                    item
                }
                DeclKind::Namespace => continue,
            };
            if !matches!(global.kind, DeclKind::Function | DeclKind::Constant) || item.detail.is_none() {
                let namespace = crate::navigate::namespace_of(&global.fqn);
                if !namespace.is_empty() && item.detail.is_none() {
                    item.detail = Some(namespace.to_owned());
                }
            }
            item.filter_text = Some(short.clone());
            item.additional_edits = edit.into_iter().collect();
            self.push(item, group);
        }
    }

    /// The text that names `fqn` at the caret, and the `use` import it
    /// needs. `namespace` is the qualifier typed before the short name.
    fn class_insertion(
        &self,
        kind: NameKind,
        fqn: &str,
        namespace: Option<&str>,
        insert: Insert,
    ) -> Option<(String, Option<TextEdit>)> {
        let short = short_name(fqn);
        let scope = self.names.scope_at(self.offset as u32);
        if insert == Insert::Import {
            return Some((fqn.to_owned(), None));
        }
        if let Some(namespace) = namespace {
            let written = format!("{namespace}\\{short}");
            if namespace.is_empty() {
                return Some((format!("\\{fqn}"), None));
            }
            return scope.resolve(kind, &written).resolution.matches(kind, fqn).then_some((written, None));
        }
        let resolved = scope.resolve(kind, short);
        if resolved.resolution.matches(kind, fqn) {
            return Some((short.to_owned(), None));
        }
        if resolved.imported {
            return Some((format!("\\{fqn}"), None));
        }
        Some((short.to_owned(), Some(self.import_edit(kind, fqn))))
    }

    /// The `use` of `fqn`, placed as the file writes its imports
    /// ([`crate::imports`]).
    fn import_edit(&self, kind: NameKind, fqn: &str) -> TextEdit {
        let (at, text) = crate::imports::import_insertion(self.parsed, self.offset as u32, kind, fqn);
        let pos = self.pos(at as usize);
        TextEdit { range: Range::new(pos, pos), new_text: text }
    }
}

fn is_static_method(method: &Method<'_>) -> bool {
    method.modifiers.iter().any(|modifier| matches!(modifier, Modifier::Static(_)))
}

/// `(int $a, string ...$rest)`.
fn params_text(params: &[SignatureParam]) -> String {
    let params: Vec<String> = params
        .iter()
        .map(|param| {
            let mut out = String::new();
            if param.ty != Type::Mixed {
                out.push_str(&param.ty.to_string());
                out.push(' ');
            }
            if param.by_ref {
                out.push('&');
            }
            if param.variadic {
                out.push_str("...");
            }
            out.push('$');
            out.push_str(param.name.as_deref().unwrap_or("arg"));
            if param.optional {
                out.push_str(" = …");
            }
            out
        })
        .collect();
    format!("({})", params.join(", "))
}
