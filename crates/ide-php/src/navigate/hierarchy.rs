//! Implementations and hierarchies.
//!
//! - [`PhpEngine::implementations`]: goto implementation. On a class-like,
//!   every class-like that extends or implements it, directly or not
//!   (interfaces left out: they implement nothing); on a method, the
//!   concrete declarations of that method those subtypes have, their own or
//!   from a parent or trait (an interface method implemented by a parent
//!   class, a trait method, an override). The subtypes come from the
//!   index's subclass table and the open buffers, followed transitively.
//! - [`PhpEngine::type_hierarchy`]: the direct supertypes (`extends` and
//!   `implements`, built-in ones from the stubs included) or the direct
//!   subtypes of the class-like at the caret (or around it). The editor asks
//!   again at each item to expand it.
//! - [`PhpEngine::call_hierarchy`]: for the function or method at the caret
//!   (or around it), the callers, found through find usages ([`super::references`],
//!   grouped by the innermost function or method around each usage; `new
//!   Foo` counts as a call of `Foo::__construct`), or the callees, every call
//!   in its body (closures included) resolved as goto resolves it.
//!
//! The kinds of relations follow the public descriptions of IntelliJ's
//! Hierarchy tool windows and the LSP 3.17 `typeHierarchy` / `callHierarchy`
//! requests.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use ide_core::{CancellationToken, DocId, IdeError, IdeResult, Pos, Range, SymbolKind};
use mago_span::HasSpan;
use mago_syntax::cst::{Call, ClassLikeMemberSelector, Expression};
use mago_syntax::walker::Walker;

use super::references::{Sought, UsageKind, sought_decl};
use super::symbol::{Decl, Lookup, Member, MemberKind, Subject, file_text};
use super::{Target, class_kind, enclosing_class, namespace_of};
use crate::engine::PhpEngine;
use crate::index::path_key;
use crate::names::{FileNames, NameKind, fqn_eq};
use crate::summary::{ClassKind, ClassLike, FileSummary, Visibility};
use crate::syntax::ParsedFile;
use crate::types::{Context, ExprTypes, Type};

/// The most subtypes one request follows.
const MAX_SUBTYPES: usize = 10_000;

/// Which way a hierarchy goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// Supertypes, or callers.
    Up,
    /// Subtypes, or callees.
    Down,
}

/// One item of a type or call hierarchy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HierarchyEntry {
    pub name: String,
    pub kind: SymbolKind,
    /// The namespace of a class-like or function, the class of a method.
    pub detail: Option<String>,
    pub path: PathBuf,
    /// The whole declaration.
    pub range: Range,
    /// The declared name (where the editor asks again to expand the item).
    pub selection_range: Range,
    /// For calls: where the calls are, in the caller's file.
    pub from_ranges: Vec<Range>,
}

/// A function or method, as the call hierarchy follows it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Callable {
    Function(String),
    Method { class: String, name: String },
}

/// A direct subtype found by [`Subtypes::direct`].
pub(super) struct Subtype {
    pub(super) path: PathBuf,
    pub(super) class: ClassLike,
}

/// Direct subtypes from the index and the open buffers (which override the
/// index for their files).
pub(super) struct Subtypes {
    open: Vec<(PathBuf, FileSummary)>,
    open_keys: HashSet<String>,
}

impl Subtypes {
    pub(super) fn new(engine: &PhpEngine) -> Self {
        let open: Vec<(PathBuf, FileSummary)> = engine
            .open_documents()
            .iter()
            .map(|document| (document.path.clone(), FileSummary::extract(&engine.parse_open(document))))
            .collect();
        let open_keys = open.iter().map(|(path, _)| path_key(path)).collect();
        Self { open, open_keys }
    }

    /// The class-likes that directly extend or implement `fqn`, sorted by
    /// file and position.
    fn direct(&self, engine: &PhpEngine, fqn: &str) -> IdeResult<Vec<Subtype>> {
        let mut out = Vec::new();
        if let Some(index) = engine.index() {
            for decl in index.direct_subclasses(fqn)? {
                if self.open_keys.contains(&decl.file) {
                    continue;
                }
                let path = decl.path();
                let Some(summary) = engine.summary(&path)? else { continue };
                let class = summary
                    .class_likes
                    .get(decl.index as usize)
                    .filter(|class| fqn_eq(NameKind::ClassLike, &class.fqn, &decl.fqn))
                    .or_else(|| summary.class_like(&decl.fqn));
                if let Some(class) = class {
                    out.push(Subtype { path, class: class.clone() });
                }
            }
        }
        for (path, summary) in &self.open {
            for class in &summary.class_likes {
                let names_it = class.extends.iter().chain(&class.implements).any(|parent| {
                    fqn_eq(NameKind::ClassLike, parent, fqn) && !fqn_eq(NameKind::ClassLike, &class.fqn, fqn)
                });
                if names_it {
                    out.push(Subtype { path: path.clone(), class: class.clone() });
                }
            }
        }
        out.sort_by(|a, b| {
            (path_key(&a.path), a.class.name_loc.start).cmp(&(path_key(&b.path), b.class.name_loc.start))
        });
        out.dedup_by(|b, a| path_key(&a.path) == path_key(&b.path) && a.class.name_loc == b.class.name_loc);
        Ok(out)
    }

    /// Every subtype of `fqn`, directly or not, nearest first.
    pub(super) fn all(&self, engine: &PhpEngine, fqn: &str, cancel: &CancellationToken) -> IdeResult<Vec<Subtype>> {
        let mut seen: HashSet<String> = HashSet::from([fqn.trim_start_matches('\\').to_ascii_lowercase()]);
        let mut queue = vec![fqn.to_owned()];
        let mut out = Vec::new();
        let mut next = 0;
        while next < queue.len() && out.len() < MAX_SUBTYPES {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let parent = queue[next].clone();
            next += 1;
            for subtype in self.direct(engine, &parent)? {
                if seen.insert(subtype.class.fqn.to_ascii_lowercase()) {
                    queue.push(subtype.class.fqn.clone());
                    out.push(subtype);
                }
            }
        }
        Ok(out)
    }
}

fn class_entry(path: PathBuf, class: &ClassLike) -> HierarchyEntry {
    let namespace = namespace_of(&class.fqn);
    HierarchyEntry {
        name: class.name.clone(),
        kind: class_kind(class.kind),
        detail: Some(namespace).filter(|ns| !ns.is_empty()).map(str::to_owned),
        path,
        range: class.loc.range,
        selection_range: class.name_loc.range,
        from_ranges: Vec::new(),
    }
}

fn method_kind(name: &str) -> SymbolKind {
    if name.eq_ignore_ascii_case("__construct") { SymbolKind::Constructor } else { SymbolKind::Method }
}

/// Whether `range` contains `pos`.
fn encloses(range: Range, pos: Pos) -> bool {
    range.start <= pos && pos <= range.end
}

/// The innermost function or method of `summary` around `pos`.
fn enclosing_callable(summary: &FileSummary, pos: Pos) -> Option<(Callable, HierarchyEntry, Range)> {
    let mut best: Option<(Callable, String, Option<String>, SymbolKind, Range, Range)> = None;
    let mut consider = |callable: Callable, name: &str, detail: Option<String>, kind, range: Range, name_range| {
        let inner = best.as_ref().is_none_or(|b| b.4.start <= range.start && range.end <= b.4.end);
        if encloses(range, pos) && inner {
            best = Some((callable, name.to_owned(), detail, kind, range, name_range));
        }
    };
    for function in &summary.functions {
        let namespace = Some(namespace_of(&function.fqn)).filter(|ns| !ns.is_empty()).map(str::to_owned);
        consider(
            Callable::Function(function.fqn.clone()),
            &function.name,
            namespace,
            SymbolKind::Function,
            function.loc.range,
            function.name_loc.range,
        );
    }
    for class in &summary.class_likes {
        for method in &class.methods {
            consider(
                Callable::Method { class: class.fqn.clone(), name: method.name.clone() },
                &method.name,
                Some(class.fqn.clone()),
                method_kind(&method.name),
                method.loc.range,
                method.name_loc.range,
            );
        }
    }
    let (callable, name, detail, kind, range, selection_range) = best?;
    let entry =
        HierarchyEntry { name, kind, detail, path: PathBuf::new(), range, selection_range, from_ranges: Vec::new() };
    Some((callable, entry, range))
}

impl PhpEngine {
    /// Goto implementation for each of `positions` in an open document (see
    /// the module docs), one list per position. `None` when the engine
    /// doesn't hold the document.
    pub fn implementations(
        &self,
        doc: DocId,
        positions: &[Pos],
        cancel: &CancellationToken,
    ) -> Option<IdeResult<Vec<Vec<Target>>>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let here = FileSummary::extract(&parsed);
        let subtypes = Subtypes::new(self);
        let mut out = Vec::with_capacity(positions.len());
        for &pos in positions {
            let decls = {
                let resolver = self.resolver();
                let offset = parsed.line_index().byte(pos);
                match self.at_caret(&parsed, &here, &resolver, offset).map(|found| found.subject) {
                    Some(Subject::Decls(decls)) => decls,
                    _ => Vec::new(),
                }
            };
            let mut targets: Vec<Target> = Vec::new();
            for decl in &decls {
                let found = match self.implementations_of(decl, &subtypes, &path, &here, cancel) {
                    Ok(found) => found,
                    Err(e) => return Some(Err(e)),
                };
                for target in found {
                    if !targets.contains(&target) {
                        targets.push(target);
                    }
                }
            }
            out.push(targets);
        }
        Some(Ok(out))
    }

    fn implementations_of(
        &self,
        decl: &Decl,
        subtypes: &Subtypes,
        here: &Path,
        summary: &FileSummary,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<Target>> {
        match decl {
            Decl::ClassLike(fqn) => Ok(subtypes
                .all(self, fqn, cancel)?
                .into_iter()
                .filter(|subtype| subtype.class.kind != ClassKind::Interface)
                .map(|subtype| Target { path: subtype.path, range: subtype.class.name_loc.range })
                .collect()),
            Decl::Member(member) if member.kind == MemberKind::Method => {
                let Some(info) = member.info() else { return Ok(Vec::new()) };
                if info.visibility == Visibility::Private {
                    return Ok(Vec::new());
                }
                let declaring = info.declaring.fqn.clone();
                let mut seen: HashSet<String> = HashSet::from([declaring.to_ascii_lowercase()]);
                let mut out = Vec::new();
                let resolver = self.resolver();
                for subtype in subtypes.all(self, &declaring, cancel)? {
                    if subtype.class.kind == ClassKind::Interface {
                        continue;
                    }
                    let Some(model) = resolver.class_model(&subtype.class.fqn) else { continue };
                    let Some(method) = model.method(&member.name) else { continue };
                    let Some(declared) = method.declared() else { continue };
                    if declared.is_abstract || !seen.insert(method.declaring.fqn.to_ascii_lowercase()) {
                        continue;
                    }
                    if let Some(path) = self.class_path(&method.declaring, here, summary) {
                        out.push(Target { path, range: declared.name_loc.range });
                    }
                }
                Ok(out)
            }
            _ => Ok(Vec::new()),
        }
    }

    /// The direct supertypes ([`Direction::Up`]) or subtypes
    /// ([`Direction::Down`]) of the class-like at `pos` in an open document,
    /// or of the one around it. `None` when the engine doesn't hold the
    /// document or there is no class-like there.
    pub fn type_hierarchy(&self, doc: DocId, pos: Pos, direction: Direction) -> Option<IdeResult<Vec<HierarchyEntry>>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let here = FileSummary::extract(&parsed);
        let resolver = self.resolver();
        let offset = parsed.line_index().byte(pos);
        let at_caret = match self.at_caret(&parsed, &here, &resolver, offset).map(|found| found.subject) {
            Some(Subject::Decls(decls)) => decls.into_iter().find_map(|decl| match decl {
                Decl::ClassLike(fqn) => Some(fqn),
                _ => None,
            }),
            _ => None,
        };
        let fqn = at_caret.or_else(|| enclosing_class(&here, offset).map(|class| class.fqn.clone()))?;
        let model = resolver.class_model(&fqn)?;
        let out = match direction {
            Direction::Up => {
                let mut out = Vec::new();
                for parent in model.class.extends.iter().chain(&model.class.implements) {
                    let Some(parent) = resolver.class_model(parent) else { continue };
                    if let Some(path) = self.class_path(&parent.class, &path, &here) {
                        out.push(class_entry(path, &parent.class));
                    }
                }
                Ok(out)
            }
            Direction::Down => Subtypes::new(self).direct(self, &model.class.fqn).map(|subtypes| {
                subtypes.into_iter().map(|subtype| class_entry(subtype.path, &subtype.class)).collect()
            }),
        };
        Some(out)
    }

    /// The callers ([`Direction::Up`]) or callees ([`Direction::Down`]) of
    /// the function or method at `pos` in an open document, or of the one
    /// around it, each with the ranges of its calls. `None` when the engine
    /// doesn't hold the document or there is no function or method there.
    pub fn call_hierarchy(
        &self,
        doc: DocId,
        pos: Pos,
        direction: Direction,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<Vec<HierarchyEntry>>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let here = FileSummary::extract(&parsed);
        let callable = {
            let resolver = self.resolver();
            let offset = parsed.line_index().byte(pos);
            let at_caret = match self.at_caret(&parsed, &here, &resolver, offset).map(|found| found.subject) {
                Some(Subject::Decls(decls)) => decls.iter().find_map(callable_of),
                _ => None,
            };
            at_caret.or_else(|| enclosing_callable(&here, pos).map(|(callable, _, _)| callable))?
        };
        Some(match direction {
            Direction::Up => self.callers(&callable, &path, &here, cancel),
            Direction::Down => self.callees(&callable, &path, &here, cancel),
        })
    }

    /// Where `callable` is declared: its file, its summary and the
    /// declaration's range.
    fn callable_source(&self, callable: &Callable, here: &Path, summary: &FileSummary) -> Option<(PathBuf, Range)> {
        match callable {
            Callable::Function(fqn) => {
                let (path, function) = self.function_source(fqn, here, summary)?;
                Some((path, function.loc.range))
            }
            Callable::Method { class, name } => {
                let model = self.class_model(class)?;
                let method = model.method(name)?;
                let declared = method.declared()?;
                let path = self.class_path(&method.declaring, here, summary)?;
                Some((path, declared.loc.range))
            }
        }
    }

    /// The hierarchy item of a function or method.
    fn callable_entry(&self, callable: &Callable, here: &Path, summary: &FileSummary) -> Option<HierarchyEntry> {
        match callable {
            Callable::Function(fqn) => {
                let (path, function) = self.function_source(fqn, here, summary)?;
                let namespace = namespace_of(&function.fqn);
                Some(HierarchyEntry {
                    name: function.name.clone(),
                    kind: SymbolKind::Function,
                    detail: Some(namespace).filter(|ns| !ns.is_empty()).map(str::to_owned),
                    path,
                    range: function.loc.range,
                    selection_range: function.name_loc.range,
                    from_ranges: Vec::new(),
                })
            }
            Callable::Method { class, name } => {
                let model = self.class_model(class)?;
                let method = model.method(name)?;
                let (name, range, selection_range) = match (method.declared(), method.magic()) {
                    (Some(declared), _) => (declared.name.clone(), declared.loc.range, declared.name_loc.range),
                    (None, Some(magic)) => (magic.name.clone(), magic.name_loc.range, magic.name_loc.range),
                    (None, None) => return None,
                };
                let path = self.class_path(&method.declaring, here, summary)?;
                Some(HierarchyEntry {
                    kind: method_kind(&name),
                    name,
                    detail: Some(method.declaring.fqn.clone()),
                    path,
                    range,
                    selection_range,
                    from_ranges: Vec::new(),
                })
            }
        }
    }

    fn callers(
        &self,
        callable: &Callable,
        here: &Path,
        summary: &FileSummary,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<HierarchyEntry>> {
        let mut sought: Vec<Sought> = Vec::new();
        match callable {
            Callable::Function(fqn) => sought.push(Sought::Name { kind: NameKind::Function, fqn: fqn.clone() }),
            Callable::Method { class, name } => {
                let Some(model) = self.class_model(class) else { return Ok(Vec::new()) };
                let ty = Type::named(class);
                let member = Member {
                    kind: MemberKind::Method,
                    model,
                    name: name.clone(),
                    receiver: ty.clone(),
                    context: Context::in_class(class),
                    ty,
                };
                sought.extend(sought_decl(&Decl::Member(member)));
            }
        }
        // `new Foo(…)` calls `Foo::__construct`.
        let constructor_of = match callable {
            Callable::Method { class, name } if name.eq_ignore_ascii_case("__construct") => Some(class.clone()),
            _ => None,
        };
        if let Some(class) = &constructor_of {
            sought.push(Sought::Name { kind: NameKind::ClassLike, fqn: class.clone() });
        }
        if sought.is_empty() {
            return Ok(Vec::new());
        }
        let usages = self.find_usages(&sought, here, summary, false, cancel)?;
        let mut out: Vec<HierarchyEntry> = Vec::new();
        let mut texts: Vec<(PathBuf, Option<String>, Option<FileSummary>)> = Vec::new();
        for usage in usages.into_iter().filter(|usage| usage.kind == UsageKind::Code) {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let cached = match texts.iter().position(|(path, _, _)| path == &usage.path) {
                Some(i) => i,
                None => {
                    let summary = self.summary(&usage.path).ok().flatten();
                    texts.push((usage.path.clone(), file_text(self, &usage.path), summary));
                    texts.len() - 1
                }
            };
            let (_, text, file_summary) = &texts[cached];
            let line = text.as_deref().and_then(|text| text.lines().nth(usage.range.start.line as usize));
            if line.is_some_and(is_import) {
                continue;
            }
            if constructor_of.is_some() && !line.is_some_and(|line| is_new_before(line, usage.range.start.col)) {
                // A class name that isn't `new Foo`, or a `->__construct()` call.
                let selector_call = line.is_some_and(|line| {
                    utf16_slice(line, usage.range.start.col, usage.range.end.col)
                        .is_some_and(|name| name.eq_ignore_ascii_case("__construct"))
                });
                if !selector_call {
                    continue;
                }
            }
            let caller = file_summary.as_ref().and_then(|s| enclosing_callable(s, usage.range.start));
            let mut entry = match caller {
                Some((_, mut entry, _)) => {
                    entry.path = usage.path.clone();
                    entry
                }
                None => HierarchyEntry {
                    name: usage.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    kind: SymbolKind::File,
                    detail: None,
                    path: usage.path.clone(),
                    range: usage.range,
                    selection_range: usage.range,
                    from_ranges: Vec::new(),
                },
            };
            let same = |e: &&mut HierarchyEntry| {
                path_key(&e.path) == path_key(&entry.path)
                    && (e.selection_range == entry.selection_range
                        || (e.kind == SymbolKind::File && entry.kind == SymbolKind::File))
            };
            match out.iter_mut().find(same) {
                Some(existing) => existing.from_ranges.push(usage.range),
                None => {
                    entry.from_ranges.push(usage.range);
                    out.push(entry);
                }
            }
        }
        Ok(out)
    }

    fn callees(
        &self,
        callable: &Callable,
        here: &Path,
        summary: &FileSummary,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<HierarchyEntry>> {
        let Some((path, range)) = self.callable_source(callable, here, summary) else { return Ok(Vec::new()) };
        let parsed = match self.open_document(&path) {
            Some(document) => self.parse_open(&document),
            None => {
                let Some(text) = file_text(self, &path) else { return Ok(Vec::new()) };
                std::sync::Arc::new(ParsedFile::parse(&path_key(&path), text.as_str()))
            }
        };
        let source_summary = FileSummary::extract(&parsed);
        let (start, end) = parsed.line_index().byte_range(range);
        let mut calls = CallSites { start, end, found: Vec::new() };
        CallWalker.walk_program(parsed.program(), &mut calls);

        let resolver = self.resolver();
        let names = FileNames::resolve(&parsed);
        let types = ExprTypes::new(&parsed, &names, &source_summary, &resolver);
        let lookup =
            Lookup { parsed: &parsed, names: &names, here: &source_summary, resolver: &resolver, types: &types };
        let mut out: Vec<HierarchyEntry> = Vec::new();
        for site in calls.found {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let decls = match site.kind {
                SiteKind::Function => names
                    .at_offset(site.start)
                    .filter(|name| name.kind == NameKind::Function)
                    .and_then(|name| lookup.name(name)),
                SiteKind::Method => lookup.syntax(site.start),
                SiteKind::New => names
                    .at_offset(site.start)
                    .filter(|name| name.kind == NameKind::ClassLike)
                    .and_then(|name| lookup.name(name)),
            };
            let Some(Subject::Decls(decls)) = decls.map(|found| found.subject) else { continue };
            let callee = decls.iter().find_map(|decl| match (site.kind, decl) {
                (SiteKind::New, Decl::ClassLike(fqn)) => {
                    let model = resolver.class_model(fqn)?;
                    let constructor = model.method("__construct")?;
                    Some(Callable::Method { class: constructor.declaring.fqn.clone(), name: "__construct".into() })
                }
                (SiteKind::New, _) => None,
                _ => callable_of(decl),
            });
            let Some(callee) = callee else { continue };
            let Some(mut entry) = self.callable_entry(&callee, &path, &source_summary) else { continue };
            let call_range = parsed.line_index().range(site.start, site.end);
            match out
                .iter_mut()
                .find(|e| path_key(&e.path) == path_key(&entry.path) && e.selection_range == entry.selection_range)
            {
                Some(existing) => existing.from_ranges.push(call_range),
                None => {
                    entry.from_ranges.push(call_range);
                    out.push(entry);
                }
            }
        }
        Ok(out)
    }
}

/// The function or method a declaration is.
fn callable_of(decl: &Decl) -> Option<Callable> {
    match decl {
        Decl::Function(fqn) => Some(Callable::Function(fqn.clone())),
        Decl::Member(member) if member.kind == MemberKind::Method => {
            let info = member.info()?;
            Some(Callable::Method { class: info.declaring.fqn.clone(), name: member.name.clone() })
        }
        _ => None,
    }
}

/// A `use` statement line (an import, not a call).
fn is_import(line: &str) -> bool {
    line.trim_start().get(..4).is_some_and(|start| start.eq_ignore_ascii_case("use "))
}

/// The text of `line` between two UTF-16 columns.
fn utf16_slice(line: &str, start: u32, end: u32) -> Option<&str> {
    let byte = |col: u32| {
        let mut units = 0u32;
        for (i, c) in line.char_indices() {
            if units >= col {
                return Some(i);
            }
            units += c.len_utf16() as u32;
        }
        (units >= col).then_some(line.len())
    };
    line.get(byte(start)?..byte(end)?)
}

/// Whether the text before UTF-16 column `col` of `line` ends with `new`.
fn is_new_before(line: &str, col: u32) -> bool {
    let Some(before) = utf16_slice(line, 0, col) else { return false };
    let before = before.trim_end();
    let Some(split) = before.len().checked_sub(3) else { return false };
    match (before.get(..split), before.get(split..)) {
        (Some(rest), Some(keyword)) => {
            keyword.eq_ignore_ascii_case("new") && !rest.ends_with(|c: char| c.is_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SiteKind {
    Function,
    Method,
    New,
}

/// A call in a function-like body: where its callee's name is.
struct Site {
    kind: SiteKind,
    start: u32,
    end: u32,
}

/// The calls inside the byte range `[start, end)`.
struct CallSites {
    start: u32,
    end: u32,
    found: Vec<Site>,
}

impl CallSites {
    fn add(&mut self, kind: SiteKind, span: mago_span::Span) {
        let (start, end) = (span.start.offset, span.end.offset);
        if self.start <= start && end <= self.end {
            self.found.push(Site { kind, start, end });
        }
    }

    fn selector(&mut self, selector: &ClassLikeMemberSelector<'_>) {
        if let ClassLikeMemberSelector::Identifier(name) = selector {
            self.add(SiteKind::Method, name.span);
        }
    }
}

struct CallWalker;

impl<'a> Walker<'a, 'a, CallSites> for CallWalker {
    fn walk_in_expression(&self, expr: &'a Expression<'a>, cx: &mut CallSites) {
        let span = expr.span();
        if span.end.offset < cx.start || span.start.offset > cx.end {
            return;
        }
        match expr {
            Expression::Call(Call::Function(call)) => {
                if let Expression::Identifier(identifier) = call.function {
                    cx.add(SiteKind::Function, identifier.span());
                }
            }
            Expression::Call(Call::Method(call)) => cx.selector(&call.method),
            Expression::Call(Call::NullSafeMethod(call)) => cx.selector(&call.method),
            Expression::Call(Call::StaticMethod(call)) => cx.selector(&call.method),
            Expression::Instantiation(instantiation) => {
                if let Expression::Identifier(identifier) = instantiation.class {
                    cx.add(SiteKind::New, identifier.span());
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod text_tests {
    use super::*;

    #[test]
    fn line_helpers() {
        assert!(is_import("  use function App\\format_price;"));
        assert!(!is_import("$user = 1;"));
        assert!(is_new_before("$b = new Book();", 9));
        assert!(is_new_before("$b = new  \\App\\Book();", 10));
        assert!(!is_new_before("$b = renew(Book::class);", 11));
        assert_eq!(utf16_slice("é😀ab", 1, 3), Some("😀"));
        assert_eq!(utf16_slice("ab", 1, 5), None);
    }
}
