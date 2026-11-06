//! Navigation answered from the summaries and the indexes:
//!
//! - [`outline`] / [`PhpEngine::document_symbols`]: the Structure view of a
//!   file (class-likes with their constants, cases, properties and methods;
//!   functions; constants), in source order.
//! - [`PhpEngine::workspace_symbols`]: Go to Symbol over the project's
//!   class-likes, functions and constants. The distinct short names of the
//!   index are ranked with nucleo (as `ide-index` ranks its symbols, with
//!   exact and prefix boosts), and only the best are looked up. A query with
//!   `\` (`Model\Bo`) also filters by namespace.
//! - [`PhpEngine::definition`]: goto definition for class-like, function and
//!   constant names (references, declarations and `use` imports, with the
//!   global fallback of unqualified functions and constants, and `self`,
//!   `static` and `parent`), members (methods, properties, class constants
//!   and enum cases, through the receiver's type), parameters named by named
//!   arguments, and variables (their parameter, `use` capture or first
//!   write); see [`symbol`]. Project declarations come from the open buffers
//!   and the index; built-in ones from the bundled phpstorm-stubs, written
//!   once to the engine's cache directory so they open as ordinary files.
//! - [`PhpEngine::type_definition`]: the class-likes of the type of what the
//!   caret is on.
//! - [`PhpEngine::hover`]: signature, type at the caret and PHPDoc as
//!   Markdown, inherited docblocks included ([`hover`]).
//! - [`PhpEngine::references`]: find usages through the word index, each
//!   candidate resolved again ([`references`]).
//! - [`PhpEngine::implementations`], [`PhpEngine::type_hierarchy`] and
//!   [`PhpEngine::call_hierarchy`]: subtypes and implementing methods
//!   through the subclass index, supertypes, callers and callees
//!   ([`hierarchy`]).

pub mod hierarchy;
pub mod hover;
pub mod references;
pub(crate) mod symbol;
#[cfg(test)]
mod tests;

pub use hierarchy::{Direction, HierarchyEntry};
pub use hover::HoverInfo;
pub use references::{Usage, UsageKind};

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ide_core::{CancellationToken, DocId, IdeError, IdeResult, OutlineItem, Pos, Range, SymbolKind};
use nucleo_matcher::{Config, Matcher, Utf32Str, Utf32String};

use crate::engine::PhpEngine;
use crate::index::{DeclKind, path_key};
use crate::names::{NameKind, fqn_eq};
use crate::stubs::{BundledStubs, StubSet};
use crate::summary::{ClassKind, ClassLike, FileSummary, Loc, Param, TypeHint, Visibility};

/// A place to navigate to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub path: PathBuf,
    /// The declared name.
    pub range: Range,
}

/// One answer to a workspace symbol query.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymbolInfo {
    /// The short name as declared.
    pub name: String,
    pub kind: SymbolKind,
    /// The namespace, `None` in the global one.
    pub container: Option<String>,
    pub path: PathBuf,
    /// The declared name.
    pub range: Range,
}

// ----------------------------------------------------------------- outline

/// The Structure view of a file, in source order.
pub fn outline(summary: &FileSummary) -> Vec<OutlineItem> {
    let mut items: Vec<(u32, OutlineItem)> = Vec::new();
    for class in &summary.class_likes {
        items.push((class.loc.start, class_item(class)));
    }
    for function in &summary.functions {
        let detail = signature(&function.params, function.return_type.as_ref());
        items.push((
            function.loc.start,
            item(&function.name, Some(detail), SymbolKind::Function, function.loc, function.name_loc, None),
        ));
    }
    for constant in &summary.constants {
        let name = short_name(&constant.fqn);
        items.push((constant.loc.start, item(name, None, SymbolKind::Constant, constant.loc, constant.name_loc, None)));
    }
    sorted(items)
}

fn class_item(class: &ClassLike) -> OutlineItem {
    let mut members: Vec<(u32, OutlineItem)> = Vec::new();
    for constant in &class.constants {
        let detail = constant.type_hint.as_ref().map(ToString::to_string);
        let visibility = Some(visibility(constant.visibility));
        members.push((
            constant.name_loc.start,
            item(&constant.name, detail, SymbolKind::Constant, constant.loc, constant.name_loc, visibility),
        ));
    }
    for case in &class.cases {
        members
            .push((case.name_loc.start, item(&case.name, None, SymbolKind::EnumMember, case.loc, case.name_loc, None)));
    }
    for property in &class.properties {
        let detail = property.type_hint.as_ref().map(ToString::to_string);
        let visibility = Some(visibility(property.visibility));
        let name = format!("${}", property.name);
        members.push((
            property.name_loc.start,
            item(&name, detail, SymbolKind::Property, property.loc, property.name_loc, visibility),
        ));
    }
    for method in &class.methods {
        let kind =
            if method.name.eq_ignore_ascii_case("__construct") { SymbolKind::Constructor } else { SymbolKind::Method };
        let detail = signature(&method.params, method.return_type.as_ref());
        let visibility = Some(visibility(method.visibility));
        members.push((
            method.name_loc.start,
            item(&method.name, Some(detail), kind, method.loc, method.name_loc, visibility),
        ));
    }
    let mut out = item(&class.name, None, class_kind(class.kind), class.loc, class.name_loc, None);
    out.children = sorted(members);
    out
}

fn item(
    name: &str,
    detail: Option<String>,
    kind: SymbolKind,
    loc: Loc,
    name_loc: Loc,
    visibility: Option<ide_core::Visibility>,
) -> OutlineItem {
    OutlineItem {
        name: name.to_owned(),
        detail,
        kind,
        range: loc.range,
        selection_range: name_loc.range,
        children: Vec::new(),
        visibility,
    }
}

fn sorted(mut items: Vec<(u32, OutlineItem)>) -> Vec<OutlineItem> {
    items.sort_by_key(|(start, _)| *start);
    items.into_iter().map(|(_, item)| item).collect()
}

/// `(int $a, string ...$rest): bool`.
fn signature(params: &[Param], return_type: Option<&TypeHint>) -> String {
    let params: Vec<String> = params
        .iter()
        .map(|param| {
            let mut out = String::new();
            if let Some(hint) = &param.type_hint {
                out.push_str(&hint.to_string());
                out.push(' ');
            }
            if param.by_ref {
                out.push('&');
            }
            if param.variadic {
                out.push_str("...");
            }
            out.push('$');
            out.push_str(&param.name);
            out
        })
        .collect();
    match return_type {
        Some(ty) => format!("({}): {ty}", params.join(", ")),
        None => format!("({})", params.join(", ")),
    }
}

fn visibility(visibility: Visibility) -> ide_core::Visibility {
    match visibility {
        Visibility::Public => ide_core::Visibility::Public,
        Visibility::Protected => ide_core::Visibility::Protected,
        Visibility::Private => ide_core::Visibility::Private,
    }
}

fn class_kind(kind: ClassKind) -> SymbolKind {
    match kind {
        ClassKind::Class => SymbolKind::Class,
        ClassKind::Interface => SymbolKind::Interface,
        ClassKind::Trait => SymbolKind::Trait,
        ClassKind::Enum => SymbolKind::Enum,
    }
}

fn decl_kind(kind: DeclKind) -> SymbolKind {
    match kind {
        DeclKind::ClassLike(kind) => class_kind(kind),
        DeclKind::Function => SymbolKind::Function,
        DeclKind::Constant => SymbolKind::Constant,
        DeclKind::Namespace => SymbolKind::Namespace,
    }
}

pub(crate) fn short_name(fqn: &str) -> &str {
    fqn.rsplit_once('\\').map_or(fqn, |(_, name)| name)
}

pub(crate) fn namespace_of(fqn: &str) -> &str {
    fqn.rsplit_once('\\').map_or("", |(ns, _)| ns)
}

/// The declared name and its location of the `kind` declaration `fqn` in a
/// summary.
pub fn find_declaration<'a>(summary: &'a FileSummary, kind: NameKind, fqn: &str) -> Option<(&'a str, Loc)> {
    let fqn = fqn.trim_start_matches('\\');
    match kind {
        NameKind::ClassLike => summary.class_like(fqn).map(|class| (class.name.as_str(), class.name_loc)),
        NameKind::Function => summary.function(fqn).map(|function| (function.name.as_str(), function.name_loc)),
        NameKind::Constant => summary
            .constants
            .iter()
            .find(|constant| fqn_eq(NameKind::Constant, &constant.fqn, fqn))
            .map(|constant| (short_name(&constant.fqn), constant.name_loc)),
        NameKind::Namespace => None,
    }
}

/// The innermost class-like whose declaration contains `offset`.
pub(crate) fn enclosing_class(summary: &FileSummary, offset: u32) -> Option<&ClassLike> {
    summary
        .class_likes
        .iter()
        .filter(|class| class.loc.start <= offset && offset < class.loc.end)
        .min_by_key(|class| class.loc.end - class.loc.start)
}

// --------------------------------------------------------- fuzzy matching

const EXACT: u32 = 4000;
const PREFIX: u32 = 600;

/// Scores lower-case candidate names against a query (case-insensitive):
/// nucleo's fuzzy score, boosted for an exact name or a prefix. Returns the
/// best `limit` as `(score, candidate index)`, best first.
pub(crate) fn rank(candidates: &[String], query: &str, limit: usize) -> Vec<(u32, usize)> {
    let query = query.to_lowercase();
    let needle = Utf32String::from(query.as_str());
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut buf = Vec::new();
    let mut out: Vec<(u32, usize)> = candidates
        .iter()
        .enumerate()
        .filter_map(|(i, candidate)| {
            let score = u32::from(matcher.fuzzy_match(Utf32Str::new(candidate, &mut buf), needle.slice(..))?);
            let boost = if *candidate == query {
                EXACT
            } else if candidate.starts_with(&query) {
                PREFIX
            } else {
                0
            };
            Some((score * 4 + boost, i))
        })
        .collect();
    out.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| candidates[a.1].len().cmp(&candidates[b.1].len()))
            .then_with(|| candidates[a.1].cmp(&candidates[b.1]))
    });
    out.truncate(limit);
    out
}

// ------------------------------------------------------------------ engine

impl PhpEngine {
    /// The Structure view of an open document; `None` when the engine
    /// doesn't hold it.
    pub fn document_symbols(&self, doc: DocId) -> Option<Vec<OutlineItem>> {
        let parsed = self.parsed_document(doc)?;
        Some(outline(&FileSummary::extract(&parsed)))
    }

    /// Project declarations whose short name matches `query` fuzzily, best
    /// first. Empty before the index exists and for an empty query.
    pub fn workspace_symbols(
        &self,
        query: &str,
        limit: usize,
        cancel: &CancellationToken,
    ) -> IdeResult<Vec<SymbolInfo>> {
        let query: String = query.chars().filter(|c| !c.is_whitespace()).collect();
        let (namespace, name) = match query.rsplit_once('\\') {
            Some((namespace, name)) => (Some(namespace.trim_start_matches('\\').to_ascii_lowercase()), name),
            None => (None, query.as_str()),
        };
        let Some(index) = self.index() else { return Ok(Vec::new()) };
        if name.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let keys = index.short_names(cancel)?;
        let mut summaries: HashMap<String, Option<FileSummary>> = HashMap::new();
        let mut out: Vec<(u32, String, SymbolInfo)> = Vec::new();
        for (score, key) in rank(&keys, name, limit * 2 + 16) {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            for decl in index.by_short_name(&keys[key])? {
                if let Some(namespace) = &namespace
                    && !namespace_of(&decl.fqn).to_ascii_lowercase().contains(namespace.as_str())
                {
                    continue;
                }
                let summary =
                    summaries.entry(decl.file.clone()).or_insert_with(|| self.summary(&decl.path()).ok().flatten());
                let Some((declared, loc)) =
                    summary.as_ref().and_then(|s| find_declaration(s, decl.kind.name_kind(), &decl.fqn))
                else {
                    continue;
                };
                let container = Some(namespace_of(&decl.fqn)).filter(|ns| !ns.is_empty()).map(str::to_owned);
                let symbol = SymbolInfo {
                    name: declared.to_owned(),
                    kind: decl_kind(decl.kind),
                    container,
                    path: decl.path(),
                    range: loc.range,
                };
                out.push((score, decl.fqn.clone(), symbol));
            }
        }
        out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.path.cmp(&b.2.path)));
        out.truncate(limit);
        Ok(out.into_iter().map(|(_, _, symbol)| symbol).collect())
    }

    /// Goto definition of what is at `pos` in an open document (see
    /// [`symbol`]). `None` when the engine doesn't hold the document or the
    /// caret is on nothing it knows (another kind of request); an empty list
    /// when the name is declared nowhere.
    pub fn definition(&self, doc: DocId, pos: Pos) -> Option<Vec<Target>> {
        let parsed = self.parsed_document(doc)?;
        let path = self.document_path(doc)?;
        let here = FileSummary::extract(&parsed);
        let resolver = self.resolver();
        let offset = parsed.line_index().byte(pos);
        let found = self.at_caret(&parsed, &here, &resolver, offset)?;
        let mut out: Vec<Target> = Vec::new();
        match found.subject {
            symbol::Subject::Variable { declarations, .. } => {
                out.extend(declarations.into_iter().map(|loc| Target { path: path.clone(), range: loc.range }));
            }
            symbol::Subject::Decls(decls) => {
                for decl in &decls {
                    for target in self.decl_targets(decl, &path, &here) {
                        if !out.contains(&target) {
                            out.push(target);
                        }
                    }
                }
            }
        }
        Some(out)
    }

    /// Where `fqn` is declared: in the document itself, in the other files of
    /// the index (their open buffers first), or else in the stubs.
    pub(crate) fn declarations_of(&self, kind: NameKind, fqn: &str, here: &Path, summary: &FileSummary) -> Vec<Target> {
        let mut out = Vec::new();
        if let Some((_, loc)) = find_declaration(summary, kind, fqn) {
            out.push(Target { path: here.to_path_buf(), range: loc.range });
        }
        let here_key = path_key(here);
        if let Some(index) = self.index() {
            for decl in index.declarations(kind, fqn).unwrap_or_default() {
                if decl.file == here_key {
                    continue;
                }
                let path = decl.path();
                if let Ok(Some(summary)) = self.summary(&path)
                    && let Some((_, loc)) = find_declaration(&summary, kind, fqn)
                {
                    out.push(Target { path, range: loc.range });
                }
            }
        }
        if out.is_empty() {
            out.extend(self.stub_declaration(kind, fqn));
        }
        out
    }

    pub(crate) fn stub_declaration(&self, kind: NameKind, fqn: &str) -> Option<Target> {
        let stubs = self.stubs();
        let (file, loc) = stub_lookup(&stubs, kind, fqn)?;
        let path = BundledStubs::materialize(&self.stub_dir(), &file)?;
        Some(Target { path, range: loc.range })
    }
}

fn stub_lookup(stubs: &StubSet, kind: NameKind, fqn: &str) -> Option<(String, Loc)> {
    match kind {
        NameKind::ClassLike => stubs.class_like(fqn).map(|(file, class)| (file.path.clone(), class.name_loc)),
        NameKind::Function => stubs.function(fqn).map(|(file, function)| (file.path.clone(), function.name_loc)),
        NameKind::Constant => stubs.constant(fqn).map(|(file, constant)| (file.path.clone(), constant.name_loc)),
        NameKind::Namespace => None,
    }
}
