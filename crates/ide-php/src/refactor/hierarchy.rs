//! Pull Members Up / Push Members Down (IDEA's class-hierarchy
//! refactorings) for PHP classes, answering the editor's
//! `lsp_hierarchy_members` / `lsp_hierarchy_refactor` flow (the one the
//! Java extension serves) in-process.
//!
//! The editor asks in two steps. [`PhpEngine::hierarchy_members`] lists the
//! class at the caret, where its members can go and which members can move;
//! the dialog picks them, and [`PhpEngine::hierarchy_refactor`] checks the
//! move and computes the edit without applying it:
//!
//! - **Pull up** (from a class or an interface) to one of its project
//!   parent classes or interfaces (nearest first). Methods, properties and
//!   constants move with their docblocks; a private one becomes protected
//!   (the class it came from still needs it). "Make abstract" leaves the
//!   method where it is and declares it `abstract` in the destination (in
//!   an interface every method is only declared, and must be public); a
//!   destination class that gets an abstract method is made abstract.
//! - **Push down** (from a class) into every direct subclass in the
//!   project; a subclass already declaring the member keeps its own.
//!   "Keep abstract" leaves an abstract declaration of the method behind
//!   (and makes the class abstract).
//!
//! Moved code keeps meaning the same classes: a name the destination file
//! resolves differently is imported there, or written fully qualified when
//! its short name is taken.
//!
//! Problems are reported IDEA's way: fatal ones (the destination already
//! declares the member, a property or non-public member pulled into an
//! interface, a member declared in one statement with others) leave no
//! edit; warnings (a moved member uses one that stays behind, a pushed-down
//! member is still used through the class, a class made abstract) are
//! confirmed by the user first. Docblock types aren't re-imported. The
//! rules are our own, after IntelliJ's documented Pull Members Up / Push
//! Members Down behaviour.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ide_core::{CancellationToken, DocId, FileEdit, IdeError, IdeResult, Pos, TextEdit, WorkspaceEdit};
use mago_span::HasSpan;
use mago_syntax::cst::{Method, Modifier, Node};
use serde::{Deserialize, Serialize};

use super::visit;
use crate::engine::PhpEngine;
use crate::imports::{import_insertion, removal};
use crate::index::path_key;
use crate::inspect::fixes::{MemberKind as InsertKind, insert_member, line_indent, newline};
use crate::names::{FileNames, NameKind, NameRole, Resolution, fqn_eq};
use crate::navigate::enclosing_class;
use crate::navigate::hierarchy::Subtypes;
use crate::navigate::references::{Sought, UsageKind};
use crate::navigate::symbol::{MemberKind, file_text};
use crate::summary::{ClassKind, ClassLike, FileSummary, Loc, TypeHint, Visibility};
use crate::syntax::{LineIndex, ParsedFile};

/// Which way members move.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HierarchyKind {
    PullUp,
    PushDown,
}

/// A class members can be pulled up to, or are pushed down into.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyTarget {
    /// The fully qualified name, passed back as the pull-up destination.
    pub id: String,
    pub name: String,
    pub qualified_name: String,
    pub interface: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MovableKind {
    /// A property or a constant.
    Field,
    Method,
}

/// A member the refactoring can move.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Movable {
    /// `method:name`, `property:name` or `constant:NAME`.
    pub id: String,
    /// `name(int $a): string`, `$name: Type`, `NAME`.
    pub label: String,
    pub kind: MovableKind,
    /// The member at the caret.
    pub selected: bool,
    /// Can be declared abstract in the destination (pull up) or kept
    /// abstract (push down): methods that aren't private.
    pub abstractable: bool,
}

/// The class at the caret, where its members go and what can move.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyInfo {
    pub class_name: String,
    pub targets: Vec<HierarchyTarget>,
    pub members: Vec<Movable>,
}

/// A member chosen in the dialog.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyChoice {
    pub id: String,
    pub make_abstract: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProblemSeverity {
    Info,
    Warning,
    Error,
    /// Nothing can be done; there is no edit.
    Fatal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyProblem {
    pub severity: ProblemSeverity,
    pub message: String,
}

/// A checked move: its problems, and the edit unless one is fatal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HierarchyMove {
    pub problems: Vec<HierarchyProblem>,
    pub edit: Option<WorkspaceEdit>,
}

impl HierarchyMove {
    fn fatal(message: impl Into<String>) -> Self {
        HierarchyMove {
            problems: vec![HierarchyProblem { severity: ProblemSeverity::Fatal, message: message.into() }],
            edit: None,
        }
    }
}

// ------------------------------------------------------------ members

/// A member of the class at the caret, as the summary has it.
#[derive(Clone, Debug)]
struct Member {
    kind: MemberKind,
    name: String,
    /// The declaration statement (attributes and modifiers included, the
    /// docblock not).
    loc: Loc,
    name_loc: Loc,
    visibility: Visibility,
    is_abstract: bool,
    label: String,
    /// Declared in one statement with other members (`public $a, $b;`).
    shared: bool,
}

impl Member {
    fn id(&self) -> String {
        match self.kind {
            MemberKind::Method => format!("method:{}", self.name),
            MemberKind::Property => format!("property:{}", self.name),
            MemberKind::Constant => format!("constant:{}", self.name),
        }
    }

    /// `Method foo()`, `Property $bar`, `Constant BAZ`.
    fn display(&self) -> String {
        display(self.kind, &self.name)
    }

    fn abstractable(&self) -> bool {
        self.kind == MemberKind::Method && self.visibility != Visibility::Private
    }

    fn insert_kind(&self) -> InsertKind {
        match self.kind {
            MemberKind::Method => InsertKind::Method,
            MemberKind::Property => InsertKind::Property,
            MemberKind::Constant => InsertKind::Constant,
        }
    }
}

fn display(kind: MemberKind, name: &str) -> String {
    match kind {
        MemberKind::Method => format!("Method {name}()"),
        MemberKind::Property => format!("Property ${name}"),
        MemberKind::Constant => format!("Constant {name}"),
    }
}

fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

/// A type hint with class names shortened, for labels.
fn short_hint(hint: &TypeHint) -> String {
    match hint {
        TypeHint::Named(fqn) => short(fqn).to_owned(),
        TypeHint::Builtin(name) => name.clone(),
        TypeHint::Relative(relative) => relative.as_str().to_owned(),
        TypeHint::Nullable(inner) => format!("?{}", short_hint(inner)),
        TypeHint::Union(members) => members
            .iter()
            .map(|m| match m {
                TypeHint::Intersection(_) => format!("({})", short_hint(m)),
                _ => short_hint(m),
            })
            .collect::<Vec<_>>()
            .join("|"),
        TypeHint::Intersection(members) => members.iter().map(short_hint).collect::<Vec<_>>().join("&"),
    }
}

/// The members of `class` that can move: methods but the constructor,
/// properties that aren't promoted, constants; in source order.
fn members_of(class: &ClassLike) -> Vec<Member> {
    let mut out = Vec::new();
    for method in &class.methods {
        if method.name.eq_ignore_ascii_case("__construct") {
            continue;
        }
        let params: Vec<String> = method
            .params
            .iter()
            .map(|p| {
                let dots = if p.variadic { "..." } else { "" };
                match &p.type_hint {
                    Some(ty) => format!("{} {dots}${}", short_hint(ty), p.name),
                    None => format!("{dots}${}", p.name),
                }
            })
            .collect();
        let ret = method.return_type.as_ref().map(|t| format!(": {}", short_hint(t))).unwrap_or_default();
        out.push(Member {
            kind: MemberKind::Method,
            name: method.name.clone(),
            loc: method.loc,
            name_loc: method.name_loc,
            visibility: method.visibility,
            is_abstract: method.is_abstract || class.kind == ClassKind::Interface,
            label: format!("{}({}){ret}", method.name, params.join(", ")),
            shared: false,
        });
    }
    for property in class.properties.iter().filter(|p| !p.is_promoted) {
        let ty = property.type_hint.as_ref().map(|t| format!(": {}", short_hint(t))).unwrap_or_default();
        out.push(Member {
            kind: MemberKind::Property,
            name: property.name.clone(),
            loc: property.loc,
            name_loc: property.name_loc,
            visibility: property.visibility,
            is_abstract: property.is_abstract,
            label: format!("${}{ty}", property.name),
            shared: class.properties.iter().filter(|p| p.loc == property.loc).count() > 1,
        });
    }
    for constant in &class.constants {
        out.push(Member {
            kind: MemberKind::Constant,
            name: constant.name.clone(),
            loc: constant.loc,
            name_loc: constant.name_loc,
            visibility: constant.visibility,
            is_abstract: false,
            label: constant.name.clone(),
            shared: class.constants.iter().filter(|c| c.loc == constant.loc).count() > 1,
        });
    }
    out.sort_by_key(|m| m.loc.start);
    out
}

fn declares(class: &ClassLike, kind: MemberKind, name: &str) -> bool {
    match kind {
        MemberKind::Method => class.method(name).is_some(),
        MemberKind::Property => class.property(name).is_some(),
        MemberKind::Constant => class.constant(name).is_some() || class.cases.iter().any(|c| c.name == name),
    }
}

// ------------------------------------------------------------ text

/// Where the docblock right before `start` begins (`start` without one).
fn doc_start(text: &str, start: u32) -> u32 {
    let before = text[..start as usize].trim_end();
    if before.ends_with("*/")
        && let Some(open) = before.rfind("/**")
        && !before[open..before.len() - 2].contains("*/")
    {
        return open as u32;
    }
    start
}

/// The bytes to delete to remove a member at `start..end` with its lines
/// ([`removal`]), plus the blank lines it would leave right after the
/// class's `{` or right before its `}`.
fn member_removal(text: &str, start: u32, end: u32) -> (u32, u32) {
    let (mut from, mut to) = removal(text, start, end);
    let blank = |line: &str| line.trim().is_empty();
    if text[..from as usize].trim_end().ends_with('{') {
        while let Some(len) = text[to as usize..].find('\n').map(|i| i as u32 + 1) {
            if !blank(&text[to as usize..(to + len) as usize]) {
                break;
            }
            to += len;
        }
    }
    if text[to as usize..].trim_start().starts_with('}') {
        while from > 0 {
            let line_start = text[..from as usize - 1].rfind('\n').map_or(0, |i| i as u32 + 1);
            if line_start == 0 || !blank(&text[line_start as usize..from as usize]) {
                break;
            }
            from = line_start;
        }
    }
    (from, to)
}

/// The method node whose name starts at `name_start`.
fn method_at(parsed: &ParsedFile, name_start: u32) -> Option<&Method<'_>> {
    let mut found = None;
    visit(Node::Program(parsed.program()), &mut |node| {
        if let Node::Method(m) = node
            && m.name.span.start.offset == name_start
        {
            found = Some(m);
        }
    });
    found
}

/// Where the `class` keyword of the class named at `name_start` is (to make
/// it abstract), and whether it already is.
fn class_keyword(parsed: &ParsedFile, name_start: u32) -> Option<(u32, bool)> {
    let mut found = None;
    visit(Node::Program(parsed.program()), &mut |node| {
        if let Node::Class(class) = node
            && class.name.span.start.offset == name_start
        {
            let is_abstract = class.modifiers.iter().any(|m| matches!(m, Modifier::Abstract(_)));
            found = Some((class.class.span.start.offset, is_abstract));
        }
    });
    found
}

/// `private` in a member's modifiers (not `private(set)`) becomes
/// `protected`: the byte range of the word.
fn private_word(text: &str, member: &Member) -> Option<(u32, u32)> {
    let head = &text[member.loc.start as usize..member.name_loc.start as usize];
    let mut from = 0;
    while let Some(at) = head[from..].find("private") {
        let start = from + at;
        let end = start + "private".len();
        let before_ok = start == 0 || !head.as_bytes()[start - 1].is_ascii_alphanumeric();
        let after = head[end..].chars().next();
        if before_ok && after.is_some_and(|c| c.is_whitespace()) {
            return Some((member.loc.start + start as u32, member.loc.start + end as u32));
        }
        from = end;
    }
    None
}

/// An abstract declaration of the method:
/// `[abstract ]visibility [static ]function name(…): T;`, in an interface
/// without `abstract`. `header` renders bytes of the method (from
/// `function` to the return type).
fn abstract_declaration(
    method: &Method<'_>,
    member: &Member,
    interface: bool,
    header: impl FnOnce(u32, u32) -> String,
) -> String {
    let visibility = match member.visibility {
        Visibility::Private | Visibility::Protected => "protected",
        Visibility::Public => "public",
    };
    let is_static = method.modifiers.iter().any(|m| matches!(m, Modifier::Static(_)));
    let end =
        method.return_type_hint.as_ref().map_or(method.parameter_list.span().end.offset, |hint| hint.span().end.offset);
    let header = header(method.function.span.start.offset, end);
    let abstract_word = if interface { "" } else { "abstract " };
    let static_word = if is_static { " static" } else { "" };
    format!("{abstract_word}{visibility}{static_word} {header};")
}

/// `declaration`'s lines after the first, re-based from `from` indentation
/// to `to`.
fn reindent(declaration: &str, from: &str, to: &str) -> String {
    let mut out = String::new();
    for (i, line) in declaration.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
            match line.strip_prefix(from) {
                Some(rest) if !from.is_empty() || !line.trim().is_empty() => {
                    out.push_str(to);
                    out.push_str(rest);
                }
                _ => out.push_str(line),
            }
        } else {
            out.push_str(line);
        }
    }
    out
}

/// The members of its own class a member's code refers to: `$this->x`,
/// `$this->m(`, `self::`/`static::` `C`, `$p`, `m(`.
fn own_references(code: &str) -> Vec<(MemberKind, String)> {
    let mut out: Vec<(MemberKind, String)> = Vec::new();
    let ident = |s: &str| -> String { s.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect() };
    let called = |rest: &str| rest.trim_start().starts_with('(');
    for prefix in ["$this->", "$this?->"] {
        for (at, _) in code.match_indices(prefix) {
            let rest = &code[at + prefix.len()..];
            let name = ident(rest);
            if name.is_empty() {
                continue;
            }
            let kind = if called(&rest[name.len()..]) { MemberKind::Method } else { MemberKind::Property };
            out.push((kind, name));
        }
    }
    for prefix in ["self::", "static::"] {
        for (at, _) in code.match_indices(prefix) {
            if at > 0 && code.as_bytes()[at - 1].is_ascii_alphanumeric() {
                continue;
            }
            let rest = &code[at + prefix.len()..];
            let (kind, name) = match rest.strip_prefix('$') {
                Some(rest) => (MemberKind::Property, ident(rest)),
                None => {
                    let name = ident(rest);
                    let kind = if called(&rest[name.len()..]) { MemberKind::Method } else { MemberKind::Constant };
                    (kind, name)
                }
            };
            if name.is_empty() || name.eq_ignore_ascii_case("class") {
                continue;
            }
            out.push((kind, name));
        }
    }
    let mut seen = HashSet::new();
    out.retain(|(kind, name)| seen.insert((*kind as u8, name.to_ascii_lowercase())));
    out
}

// ------------------------------------------------------------ files

/// A file the edit changes: its text and byte edits.
struct Work {
    path: PathBuf,
    text: String,
    edits: Vec<(u32, u32, String)>,
}

/// The files of a move, loaded once (open buffers first).
struct Files<'e> {
    engine: &'e PhpEngine,
    by_key: BTreeMap<String, Work>,
}

impl<'e> Files<'e> {
    fn new(engine: &'e PhpEngine) -> Self {
        Files { engine, by_key: BTreeMap::new() }
    }

    fn load(&mut self, path: &Path) -> IdeResult<&mut Work> {
        let key = path_key(path);
        if !self.by_key.contains_key(&key) {
            let text = file_text(self.engine, path)
                .ok_or_else(|| IdeError::not_found(format!("{} can't be read", path.display())))?;
            self.by_key.insert(key.clone(), Work { path: path.to_path_buf(), text, edits: Vec::new() });
        }
        Ok(self.by_key.get_mut(&key).expect("loaded"))
    }

    fn into_edit(self) -> WorkspaceEdit {
        let mut edit = WorkspaceEdit::default();
        for (_, work) in self.by_key {
            if work.edits.is_empty() {
                continue;
            }
            let index = LineIndex::new(&work.text);
            let mut edits = work.edits;
            edits.sort_by_key(|(start, end, _)| (*start, *end));
            // Insertions at one place join, in the order they were made.
            let mut merged: Vec<(u32, u32, String)> = Vec::new();
            for (start, end, text) in edits {
                match merged.last_mut() {
                    Some(last) if last.0 == start && last.1 == start && end == start => last.2.push_str(&text),
                    _ => merged.push((start, end, text)),
                }
            }
            let edits = merged
                .into_iter()
                .map(|(start, end, new_text)| TextEdit { range: index.range(start, end), new_text })
                .collect();
            edit.files.push(FileEdit::Edit { path: work.path.into(), edits, version: None });
        }
        edit
    }
}

/// A class a member goes to, parsed from its current text.
struct Destination {
    path: PathBuf,
    parsed: ParsedFile,
    class: ClassLike,
    names: FileNames,
}

/// Code moved into `dest`: `text[start..end]` with the class, function and
/// constant names its file resolves differently rewritten, and the imports
/// that needs (`imports`, fully qualified).
fn transplant(
    engine: &PhpEngine,
    source: &ParsedFile,
    source_names: &FileNames,
    start: u32,
    end: u32,
    dest: &Destination,
    imports: &mut Vec<String>,
) -> String {
    let text = source.text();
    let mut out = String::new();
    let mut at = start;
    for (name, fqn) in foreign_names(source_names, start, end, dest) {
        out.push_str(&text[at as usize..name.start as usize]);
        out.push_str(&replacement(engine, name.kind, fqn, dest, imports));
        at = name.end;
    }
    out.push_str(&text[at as usize..end as usize]);
    out
}

/// The names written in bytes `start..end` that `dest`'s file resolves
/// differently, with what they mean here.
fn foreign_names<'n>(
    names: &'n FileNames,
    start: u32,
    end: u32,
    dest: &Destination,
) -> Vec<(&'n crate::names::ResolvedName, &'n str)> {
    let scope = dest.names.scope_at(dest.class.name_loc.start);
    names
        .names()
        .iter()
        .filter(|name| start <= name.start && name.end <= end && name.role == NameRole::Reference)
        .filter_map(|name| match &name.resolution {
            Resolution::Fqn(fqn) if !scope.resolve(name.kind, &name.text).resolution.matches(name.kind, fqn) => {
                Some((name, fqn.as_str()))
            }
            _ => None,
        })
        .collect()
}

/// How `dest` writes `fqn`: its short name (imported when needed, added to
/// `imports`), or fully qualified when the short name means something else
/// there. Functions and constants are always written fully qualified.
fn replacement(engine: &PhpEngine, kind: NameKind, fqn: &str, dest: &Destination, imports: &mut Vec<String>) -> String {
    if kind != NameKind::ClassLike {
        return format!("\\{fqn}");
    }
    let scope = dest.names.scope_at(dest.class.name_loc.start);
    let short_name = short(fqn);
    let by_short = scope.resolve(NameKind::ClassLike, short_name);
    if by_short.resolution.matches(NameKind::ClassLike, fqn) {
        return short_name.to_owned();
    }
    let pending = imports.iter().find(|i| short(i).eq_ignore_ascii_case(short_name));
    if pending.is_some_and(|i| fqn_eq(kind, i, fqn)) {
        return short_name.to_owned();
    }
    let free = pending.is_none()
        && !by_short.imported
        && !by_short.resolution.primary().is_some_and(|other| engine.declares(NameKind::ClassLike, other))
        && !dest.class.name.eq_ignore_ascii_case(short_name);
    if free {
        imports.push(fqn.to_owned());
        short_name.to_owned()
    } else {
        format!("\\{fqn}")
    }
}

/// The import edits for `imports` in `dest`'s file.
fn import_edits(dest: &Destination, imports: &[String]) -> Vec<(u32, u32, String)> {
    let mut sorted: Vec<&String> = imports.iter().collect();
    sorted.sort_by_key(|fqn| fqn.to_ascii_lowercase());
    sorted
        .into_iter()
        .map(|fqn| {
            let (at, text) = import_insertion(&dest.parsed, dest.class.loc.start, NameKind::ClassLike, fqn);
            (at, at, text)
        })
        .collect()
}

/// Declarations to add to a class, by kind, in the order given.
#[derive(Default)]
struct Additions {
    /// `(kind, text with source indentation, source indentation)`.
    items: Vec<(InsertKind, String, String)>,
}

impl Additions {
    fn push(&mut self, kind: InsertKind, text: String, indent: String) {
        self.items.push((kind, text, indent));
    }

    /// The edits adding them to `class` in `text`: constants after the
    /// constants, properties after the properties, methods last. In an
    /// empty class they go in together.
    fn edits(&self, text: &str, class: &ClassLike) -> Option<Vec<(u32, u32, String)>> {
        let nl = newline(text);
        let render = |kind: InsertKind, indent: &str| -> String {
            let separator =
                if kind == InsertKind::Method { format!("{nl}{nl}{indent}") } else { format!("{nl}{indent}") };
            self.items
                .iter()
                .filter(|(k, _, _)| *k == kind)
                .map(|(_, declaration, from)| reindent(declaration, from, indent))
                .collect::<Vec<_>>()
                .join(&separator)
        };
        let kinds: Vec<InsertKind> = [InsertKind::Constant, InsertKind::Property, InsertKind::Method]
            .into_iter()
            .filter(|kind| self.items.iter().any(|(k, _, _)| k == kind))
            .collect();
        let close = class.loc.end.checked_sub(1)? as usize;
        let open = class.name_loc.end as usize + text[class.name_loc.end as usize..close].find('{')?;
        if text[open + 1..close].trim().is_empty() {
            let first = *kinds.first()?;
            let (start, end, new_text) = insert_member(text, class, first, |indent| {
                kinds.iter().map(|kind| render(*kind, indent)).collect::<Vec<_>>().join(&format!("{nl}{nl}{indent}"))
            })?;
            return Some(vec![(start, end, new_text)]);
        }
        let mut out = Vec::new();
        for kind in kinds {
            out.push(insert_member(text, class, kind, |indent| render(kind, indent))?);
        }
        Some(out)
    }
}

// ------------------------------------------------------------ the engine

/// The class at the caret.
struct Source {
    path: PathBuf,
    parsed: Arc<ParsedFile>,
    summary: FileSummary,
    class: ClassLike,
    members: Vec<Member>,
    offset: u32,
}

impl PhpEngine {
    /// The class at `pos` in an open document and what Pull Members Up /
    /// Push Members Down can do with it (see the module docs). `None` when
    /// the engine doesn't hold the document; an invalid-input error says
    /// why nothing can move.
    pub fn hierarchy_members(
        &self,
        doc: DocId,
        pos: Pos,
        kind: HierarchyKind,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<HierarchyInfo>> {
        let source = match self.hierarchy_source(doc, pos, kind)? {
            Ok(source) => source,
            Err(e) => return Some(Err(e)),
        };
        Some(self.hierarchy_info(&source, kind, cancel))
    }

    /// Checks moving `choices` (to `target`, for pull up) out of the class at
    /// `pos` and computes the edit without applying it. `None` when the
    /// engine doesn't hold the document.
    pub fn hierarchy_refactor(
        &self,
        doc: DocId,
        pos: Pos,
        kind: HierarchyKind,
        target: Option<&str>,
        choices: &[HierarchyChoice],
        cancel: &CancellationToken,
    ) -> Option<IdeResult<HierarchyMove>> {
        let source = match self.hierarchy_source(doc, pos, kind)? {
            Ok(source) => source,
            Err(e) => return Some(Err(e)),
        };
        Some(match kind {
            HierarchyKind::PullUp => self.pull_up(&source, target, choices, cancel),
            HierarchyKind::PushDown => self.push_down(&source, choices, cancel),
        })
    }

    fn hierarchy_source(&self, doc: DocId, pos: Pos, kind: HierarchyKind) -> Option<IdeResult<Source>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let summary = FileSummary::extract(&parsed);
        if summary.has_errors {
            return Some(Err(IdeError::invalid("Fix the syntax errors first")));
        }
        let offset = parsed.line_index().byte(pos);
        let Some(class) = enclosing_class(&summary, offset).cloned() else {
            return Some(Err(IdeError::invalid("The caret should be inside a class")));
        };
        let allowed = match kind {
            HierarchyKind::PullUp => matches!(class.kind, ClassKind::Class | ClassKind::Interface),
            HierarchyKind::PushDown => class.kind == ClassKind::Class,
        };
        if !allowed {
            let message = match kind {
                HierarchyKind::PullUp => "Pull Members Up works on classes and interfaces",
                HierarchyKind::PushDown => "Push Members Down works on classes",
            };
            return Some(Err(IdeError::invalid(message)));
        }
        let members = members_of(&class);
        Some(Ok(Source { path, parsed, summary, class, members, offset }))
    }

    /// Pull up: the project classes and interfaces above, nearest first.
    /// Push down: the direct subclasses in the project.
    fn hierarchy_targets(
        &self,
        source: &Source,
        kind: HierarchyKind,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<(HierarchyTarget, PathBuf)>> {
        let mut out = Vec::new();
        let entry = |class: &ClassLike, path: PathBuf| {
            let fqn = class.fqn.trim_start_matches('\\').to_owned();
            let target = HierarchyTarget {
                id: fqn.clone(),
                name: class.name.clone(),
                qualified_name: fqn,
                interface: class.kind == ClassKind::Interface,
            };
            (target, path)
        };
        match kind {
            HierarchyKind::PullUp => {
                let Some(model) = self.class_model(&source.class.fqn) else { return Ok(out) };
                for fqn in model.parents.iter().chain(&model.interfaces) {
                    let Some(above) = self.class_model(fqn) else { continue };
                    let Some(path) = self.class_path(&above.class, &source.path, &source.summary) else { continue };
                    if !self.is_library(&path) {
                        out.push(entry(&above.class, path));
                    }
                }
            }
            HierarchyKind::PushDown => {
                for subtype in Subtypes::new(self).direct(self, &source.class.fqn)? {
                    if cancel.is_cancelled() {
                        return Err(IdeError::cancelled());
                    }
                    if !self.is_library(&subtype.path) && subtype.class.kind == ClassKind::Class {
                        out.push(entry(&subtype.class, subtype.path));
                    }
                }
            }
        }
        Ok(out)
    }

    fn hierarchy_info(
        &self,
        source: &Source,
        kind: HierarchyKind,
        cancel: &CancellationToken,
    ) -> IdeResult<HierarchyInfo> {
        let targets = self.hierarchy_targets(source, kind, cancel)?;
        let name = &source.class.name;
        if targets.is_empty() {
            return Err(IdeError::invalid(match kind {
                HierarchyKind::PullUp => format!("'{name}' has no parent class or interface in the project"),
                HierarchyKind::PushDown => format!("'{name}' has no subclasses in the project"),
            }));
        }
        if source.members.is_empty() {
            return Err(IdeError::invalid(format!("'{name}' has no members to move")));
        }
        let members = source
            .members
            .iter()
            .map(|m| Movable {
                id: m.id(),
                label: m.label.clone(),
                kind: if m.kind == MemberKind::Method { MovableKind::Method } else { MovableKind::Field },
                selected: m.loc.start <= source.offset && source.offset <= m.loc.end,
                abstractable: m.abstractable(),
            })
            .collect();
        Ok(HierarchyInfo { class_name: name.clone(), targets: targets.into_iter().map(|(t, _)| t).collect(), members })
    }

    /// The chosen members with their "abstract" flags, or the fatal problem.
    fn chosen<'s>(source: &'s Source, choices: &[HierarchyChoice]) -> Result<Vec<(&'s Member, bool)>, HierarchyMove> {
        if choices.is_empty() {
            return Err(HierarchyMove::fatal("Choose the members to move"));
        }
        let mut out = Vec::new();
        for choice in choices {
            let Some(member) = source.members.iter().find(|m| m.id() == choice.id) else {
                return Err(HierarchyMove::fatal(format!(
                    "'{}' isn't a member of '{}' any more; open the dialog again",
                    choice.id, source.class.name
                )));
            };
            if member.shared {
                return Err(HierarchyMove::fatal(format!(
                    "{} is declared together with other members; declare it on its own first",
                    member.display()
                )));
            }
            out.push((member, choice.make_abstract && member.abstractable()));
        }
        Ok(out)
    }

    fn destination(&self, path: &Path, fqn: &str) -> IdeResult<Destination> {
        let text =
            file_text(self, path).ok_or_else(|| IdeError::not_found(format!("{} can't be read", path.display())))?;
        let parsed = ParsedFile::parse(&path_key(path), text);
        let summary = FileSummary::extract(&parsed);
        if summary.has_errors {
            return Err(IdeError::invalid(format!("Fix the syntax errors in {} first", file_name(path))));
        }
        let class = summary
            .class_like(fqn)
            .cloned()
            .ok_or_else(|| IdeError::not_found(format!("'{}' isn't declared in {}", short(fqn), file_name(path))))?;
        let names = FileNames::resolve(&parsed);
        Ok(Destination { path: path.to_path_buf(), parsed, class, names })
    }

    fn pull_up(
        &self,
        source: &Source,
        target: Option<&str>,
        choices: &[HierarchyChoice],
        cancel: &CancellationToken,
    ) -> IdeResult<HierarchyMove> {
        let chosen = match Self::chosen(source, choices) {
            Ok(chosen) => chosen,
            Err(fatal) => return Ok(fatal),
        };
        let Some(target) = target else {
            return Ok(HierarchyMove::fatal("Choose the class to pull the members up to"));
        };
        let targets = self.hierarchy_targets(source, HierarchyKind::PullUp, cancel)?;
        let Some((target, target_path)) = targets.into_iter().find(|(t, _)| fqn_eq(NameKind::ClassLike, &t.id, target))
        else {
            return Ok(HierarchyMove::fatal(format!(
                "'{}' isn't above '{}' any more; open the dialog again",
                short(target),
                source.class.name
            )));
        };
        let dest = self.destination(&target_path, &target.id)?;
        let interface = dest.class.kind == ClassKind::Interface;
        let target_model = self.class_model(&target.id);
        let mut problems = Vec::new();
        let fatal = |message: String| Ok(HierarchyMove::fatal(message));

        // Fatal problems first.
        for (member, _) in &chosen {
            if declares(&dest.class, member.kind, &member.name) {
                return fatal(format!("'{}' already declares {}", target.name, lower_first(&member.display())));
            }
            if interface {
                if member.kind == MemberKind::Property {
                    return fatal(format!("{} can't be pulled up: interfaces have no properties", member.display()));
                }
                if member.visibility != Visibility::Public {
                    return fatal(format!("{} must be public to be pulled up to an interface", member.display()));
                }
            }
        }

        let text = source.parsed.text();
        let source_names = FileNames::resolve(&source.parsed);
        let mut files = Files::new(self);
        let mut additions = Additions::default();
        let mut imports = Vec::new();
        let moved: HashSet<(u8, String)> =
            chosen.iter().map(|(m, _)| (m.kind as u8, m.name.to_ascii_lowercase())).collect();
        let mut source_edits = Vec::new();
        let mut needs_abstract = false;
        for (member, make_abstract) in &chosen {
            let is_method = member.kind == MemberKind::Method;
            let declare_only = is_method && (*make_abstract || interface);
            let start = doc_start(text, member.loc.start);
            let indent = line_indent(text, member.loc.start).to_owned();
            if declare_only {
                let method = method_at(&source.parsed, member.name_loc.start)
                    .ok_or_else(|| IdeError::not_found("the method's declaration"))?;
                // The docblock as it is; the header's names as the
                // destination writes them.
                let lead = &text[start as usize..method.span().start.offset as usize];
                let declaration = abstract_declaration(method, member, interface, |s, e| {
                    transplant(self, &source.parsed, &source_names, s, e, &dest, &mut imports)
                });
                additions.push(InsertKind::Method, format!("{lead}{declaration}"), indent);
                if member.is_abstract {
                    // An abstract method moves: nothing stays behind.
                    let (s, e) = member_removal(text, start, member.loc.end);
                    source_edits.push((s, e, String::new()));
                } else if member.visibility == Visibility::Private
                    && let Some((s, e)) = private_word(text, member)
                {
                    // It implements a protected abstract method now.
                    source_edits.push((s, e, "protected".into()));
                }
                needs_abstract |= !interface;
            } else {
                // A private member becomes protected (split around the word).
                let moved_text = match private_word(text, member).filter(|_| member.visibility == Visibility::Private) {
                    Some((s, e)) => format!(
                        "{}protected{}",
                        transplant(self, &source.parsed, &source_names, start, s, &dest, &mut imports),
                        transplant(self, &source.parsed, &source_names, e, member.loc.end, &dest, &mut imports)
                    ),
                    None => transplant(self, &source.parsed, &source_names, start, member.loc.end, &dest, &mut imports),
                };
                additions.push(member.insert_kind(), moved_text, indent);
                let (s, e) = member_removal(text, start, member.loc.end);
                source_edits.push((s, e, String::new()));
                needs_abstract |= member.is_abstract && !interface;
                // What the moved code uses that stays behind.
                for (kind, name) in own_references(&text[member.loc.start as usize..member.loc.end as usize]) {
                    let stays = declares(&source.class, kind, &name)
                        && !moved.contains(&(kind as u8, name.to_ascii_lowercase()));
                    let inherited = target_model.as_ref().is_some_and(|model| match kind {
                        MemberKind::Method => model.method(&name).is_some(),
                        MemberKind::Property => model.property(&name).is_some(),
                        MemberKind::Constant => model.constant(&name).is_some(),
                    });
                    if stays && !inherited {
                        problems.push(HierarchyProblem {
                            severity: ProblemSeverity::Warning,
                            message: format!(
                                "{} uses {}, which is not pulled up to '{}'",
                                member.display(),
                                lower_first(&display(kind, &name)),
                                target.name
                            ),
                        });
                    }
                }
            }
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }

        // The destination: the members, its imports, `abstract`.
        let dest_text = dest.parsed.text();
        let mut dest_edits = additions
            .edits(dest_text, &dest.class)
            .ok_or_else(|| IdeError::invalid("the destination class can't be edited"))?;
        dest_edits.extend(import_edits(&dest, &imports));
        if needs_abstract && let Some((at, false)) = class_keyword(&dest.parsed, dest.class.name_loc.start) {
            dest_edits.push((at, at, "abstract ".into()));
            problems.push(HierarchyProblem {
                severity: ProblemSeverity::Warning,
                message: format!("Class '{}' will be made abstract", target.name),
            });
        }
        let work = files.load(&dest.path)?;
        if work.text != dest_text {
            return Err(IdeError::invalid("the destination changed meanwhile; try again"));
        }
        work.edits.extend(dest_edits);
        let work = files.load(&source.path)?;
        work.edits.extend(source_edits);
        Ok(HierarchyMove { problems, edit: Some(files.into_edit()) })
    }

    fn push_down(
        &self,
        source: &Source,
        choices: &[HierarchyChoice],
        cancel: &CancellationToken,
    ) -> IdeResult<HierarchyMove> {
        let chosen = match Self::chosen(source, choices) {
            Ok(chosen) => chosen,
            Err(fatal) => return Ok(fatal),
        };
        let targets = self.hierarchy_targets(source, HierarchyKind::PushDown, cancel)?;
        if targets.is_empty() {
            return Ok(HierarchyMove::fatal(format!("'{}' has no subclasses in the project", source.class.name)));
        }
        let text = source.parsed.text();
        let source_names = FileNames::resolve(&source.parsed);
        let mut files = Files::new(self);
        let mut problems = Vec::new();
        let mut source_edits: Vec<(u32, u32, String)> = Vec::new();
        let mut make_source_abstract = false;
        let mut destinations = Vec::new();
        for (target, path) in &targets {
            destinations.push((target, self.destination(path, &target.id)?));
        }

        for (target, dest) in &destinations {
            let mut additions = Additions::default();
            let mut imports = Vec::new();
            let concrete = class_keyword(&dest.parsed, dest.class.name_loc.start).is_some_and(|(_, abs)| !abs);
            for (member, _) in &chosen {
                if declares(&dest.class, member.kind, &member.name) {
                    continue;
                }
                if member.is_abstract && concrete {
                    return Ok(HierarchyMove::fatal(format!(
                        "{} is abstract and can't be pushed into the concrete class '{}'",
                        member.display(),
                        target.name
                    )));
                }
                let start = doc_start(text, member.loc.start);
                let indent = line_indent(text, member.loc.start).to_owned();
                let copy = transplant(self, &source.parsed, &source_names, start, member.loc.end, dest, &mut imports);
                additions.push(member.insert_kind(), copy, indent);
            }
            if additions.items.is_empty() {
                continue;
            }
            let dest_text = dest.parsed.text();
            let mut edits = additions
                .edits(dest_text, &dest.class)
                .ok_or_else(|| IdeError::invalid(format!("'{}' can't be edited", target.name)))?;
            edits.extend(import_edits(dest, &imports));
            files.load(&dest.path)?.edits.extend(edits);
        }

        for (member, keep_abstract) in &chosen {
            let start = doc_start(text, member.loc.start);
            if *keep_abstract {
                if !member.is_abstract {
                    let method = method_at(&source.parsed, member.name_loc.start)
                        .ok_or_else(|| IdeError::not_found("the method's declaration"))?;
                    let declaration =
                        abstract_declaration(method, member, false, |s, e| text[s as usize..e as usize].to_owned());
                    // Attributes stay; from the modifiers on it's replaced.
                    let from =
                        method.modifiers.first().map_or(method.function.span.start.offset, |m| m.span().start.offset);
                    source_edits.push((from, member.loc.end, declaration));
                    make_source_abstract = true;
                }
                continue;
            }
            let (s, e) = member_removal(text, start, member.loc.end);
            source_edits.push((s, e, String::new()));
            // Still used through the class?
            let sought = [Sought::Member {
                kind: member.kind,
                name: member.name.clone(),
                declaring: source.class.fqn.clone(),
                private: member.visibility == Visibility::Private,
            }];
            let usages = self.find_usages(&sought, &source.path, &source.summary, false, cancel)?;
            let outside = usages.into_iter().filter(|u| u.kind == UsageKind::Code).find(|usage| {
                let in_target = destinations.iter().any(|(_, dest)| {
                    path_key(&dest.path) == path_key(&usage.path)
                        && dest.class.loc.range.start <= usage.range.start
                        && usage.range.end <= dest.class.loc.range.end
                });
                let in_moved = path_key(&usage.path) == path_key(&source.path)
                    && chosen.iter().any(|(m, keep)| {
                        !keep && m.loc.range.start <= usage.range.start && usage.range.end <= m.loc.range.end
                    });
                !in_target && !in_moved
            });
            if let Some(usage) = outside {
                problems.push(HierarchyProblem {
                    severity: ProblemSeverity::Warning,
                    message: format!(
                        "{} is still used in {} at line {}, where '{}' won't have it",
                        member.display(),
                        file_name(&usage.path),
                        usage.range.start.line + 1,
                        source.class.name
                    ),
                });
            }
        }
        if make_source_abstract && let Some((at, false)) = class_keyword(&source.parsed, source.class.name_loc.start) {
            source_edits.push((at, at, "abstract ".into()));
            problems.push(HierarchyProblem {
                severity: ProblemSeverity::Warning,
                message: format!("Class '{}' will be made abstract", source.class.name),
            });
        }
        let work = files.load(&source.path)?;
        if work.text != text {
            return Err(IdeError::invalid("the file changed meanwhile; try again"));
        }
        work.edits.extend(source_edits);
        Ok(HierarchyMove { problems, edit: Some(files.into_edit()) })
    }
}

fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}
