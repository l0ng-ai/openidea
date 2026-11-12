use super::doc::blocking;
use crate::Host;
use crate::Project;
use crate::rpc::Dispatcher;
use ide_core::{DocId, IdeResult, IpcPath, Location, Pos};
use ide_index::{ExtensionCount, FileMatch, IndexStatus, SymbolFilter, SymbolMatch};
use ide_language::{FileReference, WebReference};
use ide_workspace::file_refs::{self, PathCompletion};
use serde::{Deserialize, Serialize};
use specta::Type;
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

pub async fn find_files_named(host: &Host, window: &str, name: String) -> IdeResult<Vec<IpcPath>> {
    let project = host.project(window)?;
    blocking(move || Ok(project.index.files_named(&name).into_iter().map(Into::into).collect())).await
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

/// The file a Python import path names: `a.b.c` is `a/b/c.py(i)` or `a/b/c/__init__.py(i)`
/// in the project or one of its content roots (an attached dependency project included);
/// `.x` names it relative to `from`'s directory. Neither the language server (it analyses a
/// single root) nor the definition index resolves a package segment, so ⌘B on the `a.b` of
/// `from a.b import x` needs this.
pub async fn nav_resolve_module(host: &Host, window: &str, name: String, from: IpcPath) -> IdeResult<Option<IpcPath>> {
    let project = host.project(window)?;
    blocking(move || {
        let dots = name.len() - name.trim_start_matches('.').len();
        let parts: Vec<&str> = name.split('.').filter(|s| !s.is_empty()).collect();
        if parts.is_empty() {
            return Ok(None);
        }
        let rel = parts.iter().collect::<PathBuf>();
        let bases: Vec<PathBuf> = if dots > 0 {
            let dir = PathBuf::from(from);
            let dir = dir.parent().map(Path::to_path_buf).unwrap_or(dir);
            let base = (0..dots.saturating_sub(1)).fold(dir, |p, _| p.parent().map(Path::to_path_buf).unwrap_or(p));
            vec![base]
        } else {
            crate::project::navigation_roots(&project, &from)
        };
        for base in bases {
            let dir = base.join(&rel);
            for candidate in
                [dir.with_extension("py"), dir.with_extension("pyi"), dir.join("__init__.py"), dir.join("__init__.pyi")]
            {
                if candidate.is_file() {
                    return Ok(Some(IpcPath::from(candidate)));
                }
            }
        }
        Ok(None)
    })
    .await
}

/// Index definitions named `name` in the other roots `from` may navigate into (its configured
/// dependencies and extra content roots — see `navigation_roots`): the cross-root answer when
/// the language server cannot resolve an import into an attached dependency project. `from`'s
/// own root is left out: the server sees it, so a name it could not resolve there is not
/// answered by every declaration that happens to share it (any `save` for `repo.save()`).
pub async fn nav_index_definitions(
    host: &Host,
    window: &str,
    name: String,
    from: IpcPath,
) -> IdeResult<Vec<SymbolMatch>> {
    let project = host.project(window)?;
    blocking(move || {
        let roots = crate::project::navigation_roots(&project, &from);
        let Some((_own, roots)) = roots.split_first() else { return Ok(Vec::new()) };
        if roots.is_empty() {
            return Ok(Vec::new());
        }
        // Filter inside the index: a cap applied before the root filter can fill with
        // own-root matches and evict the dependency roots entirely.
        Ok(project.index.symbols_named_within(&name, None, roots, 500))
    })
    .await
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
    d.add("find_files_named", |c| async move { find_files_named(&c.host, &c.window, c.arg("name")?).await });
    d.add("find_dirs", |c| async move { find_dirs(&c.host, &c.window, c.arg("query")?, c.arg("limit")?) });
    d.add("find_symbols", |c| async move {
        find_symbols(&c.host, &c.window, c.arg("query")?, c.arg("filter")?, c.arg("limit")?)
    });
    d.add("mark_recent", |c| async move { mark_recent(&c.host, &c.window, c.arg("path")?) });
    d.add("remove_recent", |c| async move { remove_recent(&c.host, &c.window, c.arg("path")?) });
    d.add("recent_files", |c| async move { recent_files(&c.host, &c.window) });
    d.add("web_goto", |c| async move { web_goto(&c.host, &c.window, c.arg("doc")?, c.arg("pos")?).await });
    d.add("nav_resolve_module", |c| async move {
        nav_resolve_module(&c.host, &c.window, c.arg("name")?, c.arg("from")?).await
    });
    d.add("nav_index_definitions", |c| async move {
        nav_index_definitions(&c.host, &c.window, c.arg("name")?, c.arg("from")?).await
    });
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
