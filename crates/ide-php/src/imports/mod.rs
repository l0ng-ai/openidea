//! Imports: the auto-import quick-fix, Optimize Imports and inserting a
//! `use` statement the way the file already writes them.
//!
//! - [`PhpEngine::import_actions`]: the code actions of a range. For every
//!   unqualified class-like, function or constant name in it that resolves
//!   to nothing (no project declaration, open buffer or built-in), one
//!   `quickfix` per declaration of that short name elsewhere (the index's
//!   short-name table, open buffers not indexed yet, global built-ins from
//!   the stubs) titled `Import class 'App\Model\Genre'`; preferred when it
//!   is the only one, so the editor's "add unambiguous imports on the fly"
//!   applies it. And, when it changes anything, one
//!   `source.organizeImports` action, Optimize Imports.
//! - Optimize Imports ([`organize`]): per namespace (or the whole file
//!   without one), each run of `use` statements with only blank space
//!   between them is rewritten: imports no name refers to are dropped (code
//!   names, attribute names and class names in PHPDoc types count; a
//!   qualified `Model\Book` uses the class import `Model`), duplicates are
//!   dropped, the rest is grouped by kind (classes, then `use function`,
//!   then `use const`, a blank line between the groups as PSR-12 writes
//!   them) and sorted case-insensitively by name within each group, aliases
//!   kept. Group `use` statements (`use App\{A, B}`) are written out as one
//!   statement per name. A run left empty is removed with its line.
//! - [`import_insertion`]: where a new `use` goes, respecting the file's
//!   style: into a group `use` whose prefix is the name's namespace; among
//!   the imports of the same kind at its sorted place when they are sorted,
//!   else after the last of them; next to the other kinds in class →
//!   function → const order (separated by a blank line when the file does
//!   that or has a single group); else after the `namespace` statement, or
//!   after the opening tag and `declare`s. Completion's auto-import uses it
//!   too.
//!
//! IntelliJ documents the same behaviour for PHP (Settings › Editor › Code
//! Style › PHP › Imports, "Optimize imports"); this follows the
//! documentation only.

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::path::Path;

use ide_core::{DocId, FileEdit, Range, TextEdit, WorkspaceEdit};
use mago_span::HasSpan;
use mago_syntax::cst::{Program, Statement, TriviaKind, Use, UseItem, UseItems, UseType};

use crate::engine::PhpEngine;
use crate::names::{FileNames, NameKind, NameRole, ResolvedName, fqn_eq};
use crate::navigate::references::doc_type_names;
use crate::navigate::{find_declaration, namespace_of, short_name};
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;

/// The code action kind of the auto-import fixes.
pub const QUICKFIX: &str = "quickfix";
/// The code action kind of Optimize Imports.
pub const ORGANIZE_IMPORTS: &str = "source.organizeImports";
/// The code action kinds the engine offers.
pub const ACTION_KINDS: [&str; 2] = [QUICKFIX, ORGANIZE_IMPORTS];

/// One code action: an auto-import fix or Optimize Imports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportAction {
    pub title: String,
    /// [`QUICKFIX`] or [`ORGANIZE_IMPORTS`].
    pub kind: &'static str,
    pub preferred: bool,
    pub edit: WorkspaceEdit,
}

/// Whether an action of `kind` is asked for: `only` is empty, or names the
/// kind or a parent of it (`source` for `source.organizeImports`).
pub(crate) fn wanted(only: &[String], kind: &str) -> bool {
    only.is_empty()
        || only.iter().any(|o| kind == o || kind.strip_prefix(o.as_str()).is_some_and(|rest| rest.starts_with('.')))
}

impl PhpEngine {
    /// The auto-import fixes for the unresolved names in `range` and
    /// Optimize Imports, filtered by `only` (code action kinds). `None` when
    /// the engine doesn't hold the document.
    pub fn import_actions(&self, doc: DocId, range: Range, only: &[String]) -> Option<Vec<ImportAction>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let names = FileNames::resolve(&parsed);
        let mut out = Vec::new();
        if wanted(only, QUICKFIX) {
            let summary = FileSummary::extract(&parsed);
            let (start, end) = parsed.line_index().byte_range(range);
            out.extend(self.import_fixes(&parsed, &path, &names, &summary, start, end));
        }
        if wanted(only, ORGANIZE_IMPORTS) {
            let edits = organize(&parsed, &names);
            if !edits.is_empty() {
                out.push(ImportAction {
                    title: "Optimize imports".into(),
                    kind: ORGANIZE_IMPORTS,
                    preferred: true,
                    edit: file_edit(&path, edits),
                });
            }
        }
        Some(out)
    }

    fn import_fixes(
        &self,
        parsed: &ParsedFile,
        path: &Path,
        names: &FileNames,
        summary: &FileSummary,
        start: u32,
        end: u32,
    ) -> Vec<ImportAction> {
        let mut out = Vec::new();
        let mut seen: HashSet<(NameKind, String)> = HashSet::new();
        for name in names.names() {
            if name.end < start || name.start > end || !is_unresolved_candidate(name) {
                continue;
            }
            let key = (name.kind, name.text.to_ascii_lowercase());
            if seen.contains(&key) {
                continue;
            }
            let resolved = name
                .resolution
                .candidates()
                .any(|fqn| find_declaration(summary, name.kind, fqn).is_some() || self.declares(name.kind, fqn));
            if resolved {
                continue;
            }
            seen.insert(key);
            let namespace = names.scope_at(name.start).namespace().to_owned();
            let candidates: Vec<String> = self
                .import_candidates(name.kind, &name.text)
                .into_iter()
                .filter(|fqn| !namespace_of(fqn).eq_ignore_ascii_case(&namespace))
                .collect();
            let preferred = candidates.len() == 1;
            for fqn in candidates {
                let (at, text) = import_insertion(parsed, name.start, name.kind, &fqn);
                let pos = parsed.line_index().pos(at);
                out.push(ImportAction {
                    title: format!("Import {} '{fqn}'", kind_word(name.kind)),
                    kind: QUICKFIX,
                    preferred,
                    edit: file_edit(path, vec![TextEdit { range: Range::new(pos, pos), new_text: text }]),
                });
            }
        }
        out
    }

    /// The declarations named `short` (as written) that an import could
    /// bring in: project ones first (sorted), then global built-ins.
    fn import_candidates(&self, kind: NameKind, short: &str) -> Vec<String> {
        let same_short = |fqn: &str| match kind {
            NameKind::Constant => short_name(fqn) == short,
            _ => short_name(fqn).eq_ignore_ascii_case(short),
        };
        let mut project: Vec<String> = Vec::new();
        if let Some(index) = self.index() {
            for decl in index.by_short_name(short).unwrap_or_default() {
                if decl.kind.name_kind() == kind && same_short(&decl.fqn) {
                    project.push(decl.fqn);
                }
            }
        }
        // Unsaved files the index doesn't have yet.
        for document in self.open_documents() {
            if !document.text.contains(short) {
                continue;
            }
            let summary = FileSummary::extract(&self.parse_open(&document));
            let declared: Vec<&str> = match kind {
                NameKind::ClassLike => summary.class_likes.iter().map(|c| c.fqn.as_str()).collect(),
                NameKind::Function => summary.functions.iter().map(|f| f.fqn.as_str()).collect(),
                NameKind::Constant => summary.constants.iter().map(|c| c.fqn.as_str()).collect(),
                NameKind::Namespace => Vec::new(),
            };
            project.extend(declared.into_iter().filter(|fqn| same_short(fqn)).map(str::to_owned));
        }
        project.sort_by_key(|fqn| fqn.to_ascii_lowercase());
        project.dedup_by(|b, a| fqn_eq(kind, a, b));
        let stubs = self.stubs();
        let built_in = match kind {
            NameKind::ClassLike => stubs.class_like(short).map(|(_, class)| class.fqn.clone()),
            NameKind::Function => stubs.function(short).map(|(_, function)| function.fqn.clone()),
            NameKind::Constant => stubs.constant(short).map(|(_, constant)| constant.fqn.clone()),
            NameKind::Namespace => None,
        };
        if let Some(fqn) = built_in
            && !project.iter().any(|p| fqn_eq(kind, p, &fqn))
        {
            project.push(fqn);
        }
        project
    }
}

/// An unqualified reference to a class-like, function or constant that an
/// import could resolve.
fn is_unresolved_candidate(name: &ResolvedName) -> bool {
    name.role == NameRole::Reference
        && !name.imported
        && !name.text.contains('\\')
        && matches!(name.kind, NameKind::ClassLike | NameKind::Function | NameKind::Constant)
        && name.resolution.primary().is_some()
        && !(name.kind == NameKind::Constant
            && ["true", "false", "null"].iter().any(|s| name.text.eq_ignore_ascii_case(s)))
}

fn kind_word(kind: NameKind) -> &'static str {
    match kind {
        NameKind::Function => "function",
        NameKind::Constant => "constant",
        _ => "class",
    }
}

pub(crate) fn file_edit(path: &Path, edits: Vec<TextEdit>) -> WorkspaceEdit {
    WorkspaceEdit {
        files: vec![FileEdit::Edit { path: path.to_path_buf().into(), edits, version: None }],
        preconditions: Vec::new(),
    }
}

// ------------------------------------------------------------ the imports

/// One imported name.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Import {
    kind: NameKind,
    /// Without the leading `\`.
    fqn: String,
    /// The explicit `as` alias.
    alias: Option<String>,
}

impl Import {
    /// The name the file uses for it.
    fn local(&self) -> &str {
        self.alias.as_deref().unwrap_or_else(|| short_name(&self.fqn))
    }

    fn line(&self) -> String {
        let keyword = match self.kind {
            NameKind::Function => "function ",
            NameKind::Constant => "const ",
            _ => "",
        };
        match &self.alias {
            Some(alias) if alias != short_name(&self.fqn) => format!("use {keyword}{} as {alias};", self.fqn),
            _ => format!("use {keyword}{};", self.fqn),
        }
    }

    fn same(&self, other: &Self) -> bool {
        self.kind == other.kind && fqn_eq(self.kind, &self.fqn, &other.fqn) && self.local() == other.local()
    }
}

/// The items of a group `use` (`use App\Model\{Book, Genre};`).
#[derive(Clone, Debug)]
struct Group {
    /// The kind of every item, `None` when a mixed list has typed items.
    kind: Option<NameKind>,
    prefix: String,
    /// `(start, end, name relative to the prefix)` of each item's name
    /// (with its alias).
    items: Vec<(u32, u32, String)>,
}

/// One `use` statement.
#[derive(Clone, Debug)]
struct UseStatement {
    start: u32,
    end: u32,
    imports: Vec<Import>,
    group: Option<Group>,
}

impl UseStatement {
    fn kind(&self) -> NameKind {
        self.imports.first().map_or(NameKind::ClassLike, |import| import.kind)
    }
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn strip(bytes: &[u8]) -> String {
    lossy(bytes.strip_prefix(b"\\").unwrap_or(bytes))
}

fn use_kind(r#type: &UseType<'_>) -> NameKind {
    match r#type {
        UseType::Function(_) => NameKind::Function,
        UseType::Const(_) => NameKind::Constant,
    }
}

fn import_of(kind: NameKind, prefix: Option<&str>, item: &UseItem<'_>) -> Import {
    let name = strip(item.name.value());
    let fqn = match prefix {
        Some(prefix) => format!("{prefix}\\{name}"),
        None => name,
    };
    Import { kind, fqn, alias: item.alias.as_ref().map(|alias| lossy(alias.identifier.value)) }
}

fn use_statement(statement: &Use<'_>) -> UseStatement {
    let span = statement.span();
    let (mut imports, mut group) = (Vec::new(), None);
    let item_span = |item: &UseItem<'_>| {
        let end = item.alias.as_ref().map_or(item.name.span().end.offset, |alias| alias.identifier.span.end.offset);
        (item.name.span().start.offset, end)
    };
    match &statement.items {
        UseItems::Sequence(sequence) => {
            imports.extend(sequence.items.iter().map(|item| import_of(NameKind::ClassLike, None, item)));
        }
        UseItems::TypedSequence(sequence) => {
            let kind = use_kind(&sequence.r#type);
            imports.extend(sequence.items.iter().map(|item| import_of(kind, None, item)));
        }
        UseItems::TypedList(list) => {
            let kind = use_kind(&list.r#type);
            let prefix = strip(list.namespace.value());
            let mut items = Vec::new();
            for item in list.items.iter() {
                imports.push(import_of(kind, Some(&prefix), item));
                let (start, end) = item_span(item);
                items.push((start, end, lossy(item.name.value())));
            }
            group = Some(Group { kind: Some(kind), prefix, items });
        }
        UseItems::MixedList(list) => {
            let prefix = strip(list.namespace.value());
            let mut items = Vec::new();
            let mut typed = false;
            for maybe in list.items.iter() {
                let kind = maybe.r#type.as_ref().map_or(NameKind::ClassLike, use_kind);
                typed |= maybe.r#type.is_some();
                imports.push(import_of(kind, Some(&prefix), &maybe.item));
                let (start, end) = item_span(&maybe.item);
                items.push((start, end, lossy(maybe.item.name.value())));
            }
            group = Some(Group { kind: (!typed).then_some(NameKind::ClassLike), prefix, items });
        }
    }
    UseStatement { start: span.start.offset, end: span.end.offset, imports, group }
}

/// A namespace (or the whole file without one) and its `use` statements.
struct Region<'p> {
    /// Byte range of the names the imports apply to.
    start: u32,
    end: u32,
    statements: &'p [Statement<'p>],
    namespace: Option<&'p mago_syntax::cst::Namespace<'p>>,
    uses: Vec<UseStatement>,
}

fn regions<'p>(program: &'p Program<'p>, len: u32) -> Vec<Region<'p>> {
    let namespaces: Vec<_> = program
        .statements
        .iter()
        .filter_map(|statement| match statement {
            Statement::Namespace(namespace) => Some(namespace),
            _ => None,
        })
        .collect();
    let uses_of = |statements: &[Statement<'_>]| -> Vec<UseStatement> {
        statements
            .iter()
            .filter_map(|statement| match statement {
                Statement::Use(statement) => Some(use_statement(statement)),
                _ => None,
            })
            .collect()
    };
    if namespaces.is_empty() {
        let statements = program.statements.as_slice();
        return vec![Region { start: 0, end: len, statements, namespace: None, uses: uses_of(statements) }];
    }
    let mut out = Vec::new();
    for (i, namespace) in namespaces.iter().enumerate() {
        let start = namespace.span().start.offset;
        let end = namespaces.get(i + 1).map_or(len, |next| next.span().start.offset);
        let statements = namespace.statements().as_slice();
        out.push(Region { start, end, statements, namespace: Some(namespace), uses: uses_of(statements) });
    }
    out
}

fn newline(text: &str) -> &'static str {
    if text.contains("\r\n") { "\r\n" } else { "\n" }
}

/// The blanks between the start of the line and `offset`, when only blanks
/// precede it on its line.
fn indent_at(text: &str, offset: u32) -> &str {
    let before = &text[..offset as usize];
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let indent = &before[line_start..];
    if indent.chars().all(|c| c == ' ' || c == '\t') { indent } else { "" }
}

fn import_order(kind: NameKind) -> u8 {
    match kind {
        NameKind::Function => 1,
        NameKind::Constant => 2,
        _ => 0,
    }
}

fn sort_key(fqn: &str) -> String {
    fqn.to_ascii_lowercase()
}

/// Where the `use` of `fqn` goes for a name at `offset`, and the text to
/// insert there (byte offset), following the file's existing imports.
pub(crate) fn import_insertion(parsed: &ParsedFile, offset: u32, kind: NameKind, fqn: &str) -> (u32, String) {
    let text = parsed.text();
    let nl = newline(text);
    let fqn = fqn.trim_start_matches('\\');
    let line = Import { kind, fqn: fqn.to_owned(), alias: None }.line();
    let program = parsed.program();
    let regions = regions(program, text.len() as u32);
    let Some(region) = regions.iter().rev().find(|region| region.start <= offset).or(regions.first()) else {
        return (0, format!("{line}{nl}"));
    };
    let before: Vec<&UseStatement> = region.uses.iter().filter(|u| u.end <= offset).collect();
    let uses: Vec<&UseStatement> = if before.is_empty() { region.uses.iter().collect() } else { before };

    // Into a group `use` of the name's namespace.
    let namespace = namespace_of(fqn);
    for statement in &uses {
        let Some(group) = &statement.group else { continue };
        if group.kind != Some(kind) || !group.prefix.eq_ignore_ascii_case(namespace) || group.items.is_empty() {
            continue;
        }
        let short = short_name(fqn);
        let separator = match group.items.as_slice() {
            [first, second, ..] => text[first.1 as usize..second.0 as usize].to_owned(),
            _ => ", ".to_owned(),
        };
        let sorted = group.items.windows(2).all(|w| sort_key(&w[0].2) <= sort_key(&w[1].2));
        if sorted && let Some(next) = group.items.iter().find(|item| sort_key(&item.2) > sort_key(short)) {
            return (next.0, format!("{short}{separator}"));
        }
        let last = group.items.last().expect("not empty");
        return (last.1, format!("{separator}{short}"));
    }

    // Among the single imports of the same kind.
    let same: Vec<&UseStatement> =
        uses.iter().copied().filter(|u| u.group.is_none() && u.imports.iter().all(|i| i.kind == kind)).collect();
    if let Some(last) = same.last() {
        let keys: Vec<String> = same.iter().map(|u| sort_key(&u.imports[0].fqn)).collect();
        if keys.windows(2).all(|w| w[0] <= w[1])
            && let Some(next) = same.iter().find(|u| sort_key(&u.imports[0].fqn) > sort_key(fqn))
        {
            return (next.start, format!("{line}{nl}{}", indent_at(text, next.start)));
        }
        return (last.end, format!("{nl}{}{line}", indent_at(text, last.start)));
    }

    // Next to the other kinds.
    if let Some(first) = uses.first() {
        let mut changes = uses.windows(2).filter(|w| w[0].kind() != w[1].kind()).peekable();
        let blank = changes.peek().is_none()
            || changes.any(|w| text[w[0].end as usize..w[1].start as usize].matches('\n').count() >= 2);
        let gap = if blank { format!("{nl}{nl}") } else { nl.to_owned() };
        let order = import_order(kind);
        if let Some(previous) = uses.iter().rev().find(|u| import_order(u.kind()) < order) {
            return (previous.end, format!("{gap}{}{line}", indent_at(text, previous.start)));
        }
        return (first.start, format!("{line}{gap}{}", indent_at(text, first.start)));
    }

    // No imports yet.
    if let Some(namespace) = region.namespace {
        use mago_syntax::cst::NamespaceBody;
        return match &namespace.body {
            NamespaceBody::Implicit(body) => (body.terminator.span().end.offset, format!("{nl}{nl}{line}")),
            NamespaceBody::BraceDelimited(block) => {
                let indent = block.statements.first().map_or("", |s| indent_at(text, s.span().start.offset));
                (block.left_brace.end.offset, format!("{nl}{indent}{line}"))
            }
        };
    }
    let header = region
        .statements
        .iter()
        .take_while(|statement| matches!(statement, Statement::OpeningTag(_) | Statement::Declare(_)))
        .last();
    match header {
        Some(header) => (header.span().end.offset, format!("{nl}{nl}{line}")),
        None => (0, format!("{line}{nl}")),
    }
}

// ------------------------------------------------------- Optimize Imports

/// Optimize Imports: the edits removing unused and duplicate imports and
/// sorting and grouping the rest; empty when nothing changes.
pub(crate) fn organize(parsed: &ParsedFile, names: &FileNames) -> Vec<TextEdit> {
    let text = parsed.text();
    let nl = newline(text);
    let program = parsed.program();
    let line_index = parsed.line_index();
    let docs: Vec<(u32, String)> = program
        .trivia
        .iter()
        .filter(|trivia| trivia.kind == TriviaKind::DocBlockComment)
        .map(|trivia| (trivia.span.start.offset, lossy(trivia.value)))
        .collect();
    let mut edits = Vec::new();
    for region in regions(program, text.len() as u32) {
        if region.uses.is_empty() {
            continue;
        }
        let used = Usage::of(names, &docs, region.start, region.end);
        let mut kept: Vec<Import> = Vec::new();
        for run in runs(text, &region.uses) {
            let mut imports: Vec<Import> = Vec::new();
            for import in run.iter().flat_map(|u| &u.imports) {
                if used.uses(import) && !kept.iter().chain(&imports).any(|k| k.same(import)) {
                    imports.push(import.clone());
                }
            }
            kept.extend(imports.iter().cloned());
            let (start, end) = (run[0].start, run[run.len() - 1].end);
            let indent = indent_at(text, start);
            if imports.is_empty() {
                let (start, end) = removal(text, start, end);
                edits.push(TextEdit { range: line_index.range(start, end), new_text: String::new() });
                continue;
            }
            imports.sort_by(|a, b| {
                (import_order(a.kind), sort_key(&a.fqn), a.local()).cmp(&(
                    import_order(b.kind),
                    sort_key(&b.fqn),
                    b.local(),
                ))
            });
            let mut block = String::new();
            for (i, import) in imports.iter().enumerate() {
                if i > 0 {
                    block.push_str(nl);
                    if import.kind != imports[i - 1].kind {
                        block.push_str(nl);
                    }
                    block.push_str(indent);
                }
                block.push_str(&import.line());
            }
            if block != text[start as usize..end as usize] {
                edits.push(TextEdit { range: line_index.range(start, end), new_text: block });
            }
        }
    }
    edits
}

/// The `use` statements split where something other than blank space
/// (code, a comment) stands between two of them.
fn runs<'u>(text: &str, uses: &'u [UseStatement]) -> Vec<&'u [UseStatement]> {
    let mut out = Vec::new();
    let mut from = 0;
    for i in 1..=uses.len() {
        let split = i == uses.len() || !text[uses[i - 1].end as usize..uses[i].start as usize].trim().is_empty();
        if split {
            out.push(&uses[from..i]);
            from = i;
        }
    }
    out
}

/// The bytes to delete to remove `start..end` with its lines: from the start
/// of its first line when only blanks precede it, through the end of its
/// last line when only blanks follow, plus the blank lines after it when a
/// blank line precedes it (so no double gap remains).
fn removal(text: &str, start: u32, end: u32) -> (u32, u32) {
    let bytes = text.as_bytes();
    let mut from = start as usize;
    while from > 0 && matches!(bytes[from - 1], b' ' | b'\t') {
        from -= 1;
    }
    let line_start = from == 0 || bytes[from - 1] == b'\n';
    if !line_start {
        from = start as usize;
    }
    let mut to = end as usize;
    while to < bytes.len() && matches!(bytes[to], b' ' | b'\t') {
        to += 1;
    }
    if to < bytes.len() && bytes[to] == b'\r' {
        to += 1;
    }
    if line_start && to < bytes.len() && bytes[to] == b'\n' {
        to += 1;
        let before = &text[..from];
        if before.ends_with("\n\n") || before.ends_with("\n\r\n") {
            // Eat the blank lines that follow.
            loop {
                let rest = &text[to..];
                let line_len = rest.find('\n').map(|i| i + 1);
                match line_len {
                    Some(len) if rest[..len].trim().is_empty() => to += len,
                    _ => break,
                }
            }
        }
    } else {
        to = end as usize;
    }
    (from as u32, to as u32)
}

/// What the code of a region refers to through imports.
struct Usage {
    /// Lower-case names used unqualified as class-likes, plus the first
    /// segments of qualified names (which go through class imports).
    classes: HashSet<String>,
    functions: HashSet<String>,
    /// Constants by their exact case.
    constants: HashSet<String>,
}

impl Usage {
    fn of(names: &FileNames, docs: &[(u32, String)], start: u32, end: u32) -> Self {
        let mut usage = Self { classes: HashSet::new(), functions: HashSet::new(), constants: HashSet::new() };
        for name in names.names() {
            if name.start < start || name.start >= end || name.role != NameRole::Reference {
                continue;
            }
            usage.add(name.kind, &name.text);
        }
        for (base, doc) in docs {
            if *base < start || *base >= end {
                continue;
            }
            for (from, to) in doc_type_names(doc) {
                usage.add(NameKind::ClassLike, &doc[from..to]);
            }
        }
        usage
    }

    fn add(&mut self, kind: NameKind, written: &str) {
        if written.starts_with('\\') || written.is_empty() {
            return;
        }
        if let Some((first, _)) = written.split_once('\\') {
            if !first.eq_ignore_ascii_case("namespace") {
                self.classes.insert(first.to_ascii_lowercase());
            }
            return;
        }
        match kind {
            NameKind::ClassLike => {
                self.classes.insert(written.to_ascii_lowercase());
            }
            NameKind::Function => {
                self.functions.insert(written.to_ascii_lowercase());
            }
            NameKind::Constant => {
                self.constants.insert(written.to_owned());
            }
            NameKind::Namespace => {}
        }
    }

    fn uses(&self, import: &Import) -> bool {
        let local = import.local();
        match import.kind {
            NameKind::Function => self.functions.contains(&local.to_ascii_lowercase()),
            NameKind::Constant => self.constants.contains(local),
            _ => self.classes.contains(&local.to_ascii_lowercase()),
        }
    }
}
