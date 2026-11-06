use super::doc::blocking;
use crate::Host;
use crate::Project;
use crate::rpc::Dispatcher;
use ide_core::paths::{AliasMap, resolve_spec};
use ide_core::{CancellationToken, DocId, IdeResult, IpcPath, Location, Pos, SymbolKind};
use ide_index::{ExtensionCount, FileMatch, IndexStatus, ProjectIndex, SymbolFilter, SymbolMatch};
use ide_language::{FileReference, ImportName, WebReference};
use ide_syntax::{Locals, Snapshot as StructureSnapshot};
use ide_workspace::file_refs::{self, PathCompletion};
use ide_workspace::roots::alias_map;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// A web reference no language server resolves and where it points: `class="card"` →
/// `.card` selectors, `id` → `#id` selectors, `href="#top"` → the element, `var(--x)` →
/// `--x:` declarations.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebGoto {
    pub reference: WebReference,
    pub targets: Vec<Location>,
}

const MAX_WEB_TARGETS: usize = 200;

/// The project root and its resource roots (served at `/`), for file references.
fn reference_roots(project: &Project) -> (PathBuf, Vec<PathBuf>) {
    let resources = project.roots().resource_dirs().iter().map(|d| project.root.join(d)).collect();
    (project.root.clone(), resources)
}

pub fn index_status(host: &Host, window: &str) -> IdeResult<IndexStatus> {
    Ok(host.project(window)?.index.status())
}

/// The project's file extensions, most common first.
pub fn index_file_extensions(host: &Host, window: &str) -> IdeResult<Vec<ExtensionCount>> {
    Ok(host.project(window)?.index.file_extensions())
}

pub fn find_files(host: &Host, window: &str, query: String, limit: u32) -> IdeResult<Vec<FileMatch>> {
    Ok(host.project(window)?.index.find_files(&query, limit as usize))
}

pub fn find_dirs(host: &Host, window: &str, query: String, limit: u32) -> IdeResult<Vec<FileMatch>> {
    Ok(host.project(window)?.index.find_dirs(&query, limit as usize))
}

pub fn find_symbols(
    host: &Host,
    window: &str,
    query: String,
    filter: SymbolFilter,
    limit: u32,
) -> IdeResult<Vec<SymbolMatch>> {
    Ok(host.project(window)?.index.find_symbols(&query, filter, limit as usize))
}

pub fn mark_recent(host: &Host, window: &str, path: PathBuf) -> IdeResult<()> {
    host.project(window)?.index.mark_recent(&path);
    Ok(())
}

pub fn remove_recent(host: &Host, window: &str, path: PathBuf) -> IdeResult<()> {
    host.project(window)?.index.remove_recent(&path);
    Ok(())
}

/// Recently opened files, most recent first (⌘E).
pub fn recent_files(host: &Host, window: &str) -> IdeResult<Vec<ide_core::IpcPath>> {
    Ok(host.project(window)?.index.recent_files().into_iter().map(Into::into).collect())
}

/// The web reference at `pos` of `doc` and its targets; `None` when there is no reference.
pub async fn web_goto(host: &Host, window: &str, doc: DocId, pos: Pos) -> IdeResult<Option<WebGoto>> {
    let project = host.project(window)?;
    let syntax = host.syntax();
    blocking(move || {
        let snap = project.documents.snapshot(doc)?;
        if snap.large {
            return Ok(None);
        }
        let Some(reference) = syntax.web_reference_at(&snap.language, &snap.text, pos) else { return Ok(None) };
        let here = |range| Location { path: snap.path.clone(), range, uri: None };
        let targets = match reference.symbol() {
            None => syntax.web_anchors(&snap.language, &snap.text, &reference.name).into_iter().map(here).collect(),
            Some((name, kind)) => {
                // The open document from its (possibly unsaved) text, other files from the index.
                let mut targets: Vec<Location> = syntax
                    .web_definitions(&snap.language, &snap.text)
                    .into_iter()
                    .filter(|t| t.name == name && t.kind == kind)
                    .map(|t| here(t.range))
                    .collect();
                targets.extend(
                    project
                        .index
                        .symbols_named(&name, Some(kind), MAX_WEB_TARGETS)
                        .into_iter()
                        .filter(|m| *m.path != *snap.path)
                        .map(|m| Location { path: m.path, range: m.range, uri: None }),
                );
                targets
            }
        };
        Ok(Some(WebGoto { reference, targets }))
    })
    .await
}

/// Where the project index resolves a symbol to without a language server
/// (docs/vue-ts-semantic-index.md): a local's definition, the import chain's
/// declaration, a re-export's origin, or a component's file.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexGoto {
    pub targets: Vec<Location>,
    /// `certain`: the import chain names the target. `candidate`: a name
    /// match (the component registry) — the UI labels it.
    pub note: IndexNote,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IndexNote {
    Certain,
    Candidate,
}

/// Where the project index sees `name` (identifiers, component tags):
/// the find-usages fallback's answer, an inverted-index lookup.
pub async fn index_usages(host: &Host, window: &str, name: String, css: bool) -> IdeResult<Vec<Location>> {
    let project = host.project(window)?;
    let index = project.index.clone();
    blocking(move || Ok(index.usages_of(&name, css))).await
}

/// The languages whose `<script>` regions carry module facts.
fn is_web_language(lang: &str) -> bool {
    matches!(lang, "vue" | "svelte" | "html" | "htm" | "jsp")
}

/// Whether `path` is a single-file component module.
fn is_component_file(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()), Some("vue" | "svelte"))
}

/// `my-widget` / `MyWidget` → `MyWidget`: how component tags name files.
fn pascal_case(word: &str) -> String {
    word.split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|p| {
            let mut c = p.chars();
            c.next().map_or(String::new(), |f| f.to_uppercase().collect::<String>() + c.as_str())
        })
        .collect()
}

/// Go-to-definition from the project index: the local of a `<script>` region,
/// the import chain's declaration (following re-exports), or a component's
/// file. `word` is the identifier at `pos` (the caller's word at the caret).
/// `None` when the index cannot answer — the caller falls back to symbol
/// name matching.
pub async fn index_goto(host: &Host, window: &str, doc: DocId, pos: Pos, word: String) -> IdeResult<Option<IndexGoto>> {
    let project = host.project(window)?;
    let syntax = host.syntax();
    let structure = project.structure.clone();
    let documents = project.documents.clone();
    let index = project.index.clone();
    let root = project.root.clone();
    blocking(move || {
        let Ok(info) = documents.snapshot(doc) else { return Ok(None) };
        if info.large || word.is_empty() {
            return Ok(None);
        }
        let lang = info.language.clone();
        let text = info.text;
        let from: PathBuf = info.path.into();
        let mut word = word;

        // A local of a <script> region resolves in-file: the structure service
        // cannot see regions (a .vue file's grammar is HTML).
        if is_web_language(lang.as_str())
            && let Some((region, region_pos)) = syntax.script_region_at(&lang, &text, pos)
        {
            let snap = StructureSnapshot::text(&region.language, &region.text);
            let cancel = CancellationToken::new();
            if let Ok(locals) = structure.locals(&snap, region_pos, &cancel) {
                match locals {
                    Locals::NoIdentifier => return Ok(None),
                    Locals::Local { symbol } => {
                        return Ok(Some(IndexGoto {
                            targets: vec![Location {
                                path: from.into(),
                                range: region.shift(symbol.definition),
                                uri: None,
                            }],
                            note: IndexNote::Certain,
                        }));
                    }
                    Locals::NotLocal { name, .. } => word = name,
                }
            }
        }

        // The import chain: the word bound by an import names its module's export.
        let facts = syntax.script_facts(&lang, &text);
        let aliases = alias_map(&root, &from);
        let exists = |p: &Path| index.has_file(p);
        for import in &facts.imports {
            // "" names the default export, "*" a namespace import (the module file).
            let target_name = import.names.iter().find_map(|n| match n {
                ImportName::Named { imported, local } if local == &word => Some(imported.clone()),
                ImportName::Default { local } if local == &word => Some(String::new()),
                ImportName::Namespace { local } if local == &word => Some("*".to_string()),
                _ => None,
            });
            let Some(target_name) = target_name else { continue };
            let Some(target) = resolve_spec(&from, &import.source, &aliases, &exists) else { continue };
            if target_name == "*" {
                return Ok(Some(IndexGoto { targets: vec![file_location(&index, &target)], note: IndexNote::Certain }));
            }
            let mut visited = HashSet::new();
            if let Some(loc) = resolve_export(&index, &target, &target_name, &aliases, &mut visited, 0) {
                return Ok(Some(IndexGoto { targets: vec![loc], note: IndexNote::Certain }));
            }
        }

        // A module-level declaration of this file (script-setup state etc.):
        // the scope analysis calls it not-local and the import chain is done.
        if let Some(d) = facts.decls.iter().find(|d| d.name == word) {
            return Ok(Some(IndexGoto {
                targets: vec![Location { path: from.clone().into(), range: d.range, uri: None }],
                note: IndexNote::Certain,
            }));
        }

        // The component registry: a tag without an import (unplugin-style
        // auto-imports) resolves by file name.
        let component = pascal_case(&word);
        if component != word || word.contains('-') {
            let targets: Vec<Location> = index
                .symbols_named(&component, Some(SymbolKind::Class), MAX_WEB_TARGETS)
                .into_iter()
                .filter(|m| m.name == component && is_component_file(m.path.as_ref()))
                .map(|m| Location { path: m.path, range: m.range, uri: None })
                .collect();
            if !targets.is_empty() {
                return Ok(Some(IndexGoto { targets, note: IndexNote::Candidate }));
            }
        }
        Ok(None)
    })
    .await
}

/// The export named `name` of `target`, following re-export chains (depth-
/// and cycle-limited); the file itself for a default export without a
/// declaration, and for a component module.
fn resolve_export(
    index: &ProjectIndex,
    target: &Path,
    name: &str,
    aliases: &AliasMap,
    visited: &mut HashSet<PathBuf>,
    depth: u32,
) -> Option<Location> {
    const MAX_DEPTH: u32 = 8;
    if depth > MAX_DEPTH || !visited.insert(target.to_path_buf()) {
        return None;
    }
    let facts = index.facts_of(target)?;
    // A component module: the file is the component.
    if is_component_file(target) {
        return Some(file_location(index, target));
    }
    // The declaration itself, exported (or default) ones first.
    if let Some(decl) = facts
        .decls
        .iter()
        .find(|d| d.default && name.is_empty())
        .or_else(|| facts.decls.iter().find(|d| d.exported && d.name == name))
        .or_else(|| facts.decls.iter().find(|d| d.name == name))
    {
        return Some(Location { path: target.into(), range: decl.range, uri: None });
    }
    // A re-export names the next module; `export *` re-exports everything.
    for re in &facts.reexports {
        let reexports_name = re.names.iter().any(|n| match n {
            ImportName::Named { imported, .. } => imported == name,
            ImportName::Namespace { local } => local == "*" || local == name,
            ImportName::Default { .. } => false,
        });
        if reexports_name {
            let exists = |p: &Path| index.has_file(p);
            if let Some(next) = resolve_spec(target, &re.source, aliases, &exists)
                && let Some(loc) = resolve_export(index, &next, name, aliases, visited, depth + 1)
            {
                return Some(loc);
            }
        }
    }
    // A default export without a declaration (`export default {…}`): the file.
    if name.is_empty() {
        return Some(file_location(index, target));
    }
    None
}

/// A file-level target: the first declaration of its script, or the start.
fn file_location(index: &ProjectIndex, path: &Path) -> Location {
    let range = index.facts_of(path).and_then(|f| f.decls.first().map(|d| d.range)).unwrap_or_default();
    Location { path: path.into(), range, uri: None }
}

/// The existing file or directory a path written in `from` names (`href`, `url()`, a string literal).
pub async fn fs_resolve_reference(
    host: &Host,
    window: &str,
    from: IpcPath,
    value: String,
) -> IdeResult<Option<IpcPath>> {
    let project = host.project(window).ok();
    blocking(move || {
        let (root, resources) = project.as_deref().map(reference_roots).unzip();
        let resources = resources.unwrap_or_default();
        Ok(file_refs::resolve(&value, &from, root.as_deref(), &resources).map(Into::into))
    })
    .await
}

/// Files and folders that continue `prefix`, a path being typed in `from`.
pub async fn path_completions(
    host: &Host,
    window: &str,
    from: IpcPath,
    prefix: String,
) -> IdeResult<Vec<PathCompletion>> {
    let project = host.project(window).ok();
    blocking(move || {
        let (root, resources) = project.as_deref().map(reference_roots).unzip();
        let resources = resources.unwrap_or_default();
        Ok(file_refs::complete(&prefix, &from, root.as_deref(), &resources))
    })
    .await
}

/// Paths in an HTML document or stylesheet that name no existing file.
pub async fn web_unresolved_references(host: &Host, window: &str, doc: DocId) -> IdeResult<Vec<FileReference>> {
    let project = host.project(window)?;
    let syntax = host.syntax();
    blocking(move || {
        let snap = project.documents.snapshot(doc)?;
        if snap.large {
            return Ok(Vec::new());
        }
        let (root, resources) = reference_roots(&project);
        Ok(syntax
            .web_file_references(&snap.language, &snap.text)
            .into_iter()
            .filter(|r| {
                file_refs::is_file_reference(&r.value)
                    && !file_refs::path_part(&r.value).is_empty()
                    && file_refs::resolve(&r.value, &snap.path, Some(&root), &resources).is_none()
            })
            .collect())
    })
    .await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("index_status", |c| async move { index_status(&c.host, &c.window) });
    d.add("index_file_extensions", |c| async move { index_file_extensions(&c.host, &c.window) });
    d.add("find_files", |c| async move { find_files(&c.host, &c.window, c.arg("query")?, c.arg("limit")?) });
    d.add("find_dirs", |c| async move { find_dirs(&c.host, &c.window, c.arg("query")?, c.arg("limit")?) });
    d.add("find_symbols", |c| async move {
        find_symbols(&c.host, &c.window, c.arg("query")?, c.arg("filter")?, c.arg("limit")?)
    });
    d.add("mark_recent", |c| async move { mark_recent(&c.host, &c.window, c.arg("path")?) });
    d.add("remove_recent", |c| async move { remove_recent(&c.host, &c.window, c.arg("path")?) });
    d.add("recent_files", |c| async move { recent_files(&c.host, &c.window) });
    d.add("web_goto", |c| async move { web_goto(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?).await });
    d.add("index_goto", |c| async move {
        index_goto(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?, c.arg("word")?).await
    });
    d.add("index_usages", |c| async move { index_usages(&c.host, &c.window, c.arg("name")?, c.arg("css")?).await });
    d.add("fs_resolve_reference", |c| async move {
        fs_resolve_reference(&c.host, &c.window, c.arg("from")?, c.arg("value")?).await
    });
    d.add("path_completions", |c| async move {
        path_completions(&c.host, &c.window, c.arg("from")?, c.arg("prefix")?).await
    });
    d.add("web_unresolved_references", |c| async move {
        web_unresolved_references(&c.host, &c.window, c.arg("doc")?).await
    });
}
