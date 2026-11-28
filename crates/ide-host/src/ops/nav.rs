use super::blocking;
use super::pytest_fixtures::{
    PytestFixtureAt, PytestFixtureRename, PytestFixtureTarget, PytestFixtureUsages, fixture_at, fixture_target,
    fixture_usages, rename_fixture,
};
use super::python_stubs::{
    PythonStubLinks, counterpart_candidates, match_declarations, module_name, site_packages, stub_path,
};
use crate::Host;
use crate::Project;
use ide_command::command;
use ide_core::{DocId, IdeResult, IpcPath, LanguageId, Location, Pos, RequestId};
use ide_index::{ExtensionCount, FileMatch, IndexStatus, SymbolFilter, SymbolMatch};
use ide_language::{CSS_VARIABLE, FileReference, WebReference};
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

/// A custom property declaration (`--accent: #3b82f6`), for `var(--…)` completion and hover.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CssVariable {
    pub name: String,
    /// The declared value, whitespace collapsed.
    pub value: Option<String>,
    pub location: Location,
}

const MAX_CSS_VARIABLES: usize = 5000;

/// A Python class definition and the base names written in its source. The UI builds a
/// name → locations index from every class in the project (attached dependency roots
/// included) to compute ↑ overrides / ↓ overridden gutter markers without a language
/// server's type-hierarchy provider.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClassInheritance {
    /// Start of the class definition's selection range (0-based line, UTF-16 column).
    pub path: IpcPath,
    pub line: u32,
    pub col: u32,
    pub name: String,
    /// Base names as written in source (bare name, e.g. `AllToAllTokenDispatcher`; a
    /// qualified name keeps only its last segment).
    pub bases: Vec<String>,
}

/// The project root and its resource roots (served at `/`), for file references.
fn reference_roots(project: &Project) -> (PathBuf, Vec<PathBuf>) {
    let resources = project.roots().resource_dirs().iter().map(|d| project.root.join(d)).collect();
    (project.root.clone(), resources)
}

#[command(trust = always)]
pub fn index_status(host: &Host, window: &str) -> IdeResult<IndexStatus> {
    Ok(host.project(window)?.index.status())
}

#[command(trust = always)]
pub fn index_file_extensions(host: &Host, window: &str) -> IdeResult<Vec<ExtensionCount>> {
    // Most common first.
    Ok(host.project(window)?.index.file_extensions())
}

#[command(trust = always)]
pub async fn find_files(host: &Host, window: &str, query: String, limit: u32) -> IdeResult<Vec<FileMatch>> {
    let project = host.project(window)?;
    blocking(move || Ok(project.index.find_files(&query, limit as usize))).await
}

#[command(trust = always)]
pub async fn find_files_named(host: &Host, window: &str, name: String) -> IdeResult<Vec<IpcPath>> {
    let project = host.project(window)?;
    blocking(move || Ok(project.index.files_named(&name).into_iter().map(Into::into).collect())).await
}

/// The files of a custom scope (`file:src//*.ts`), for the Project view's scope panes.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScopeFiles {
    pub paths: Vec<IpcPath>,
    /// More files than `limit` matched; `paths` holds the first ones.
    pub truncated: bool,
}

#[command(trust = always)]
pub async fn scope_files(host: &Host, window: &str, pattern: String, limit: u32) -> IdeResult<ScopeFiles> {
    let project = host.project(window)?;
    blocking(move || {
        let mask = ide_search::FileMask::new(&[], &project.search_excludes())?;
        let scope = ide_search::SearchScope::Pattern { pattern };
        let mut files =
            ide_search::scope_files(&project.root, &scope, &mask, None, &ide_core::CancellationToken::new())?;
        files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        let truncated = files.len() > limit as usize;
        files.truncate(limit as usize);
        Ok(ScopeFiles { paths: files.into_iter().map(|f| f.path.into()).collect(), truncated })
    })
    .await
}

/// Folders holding indexed files, for `@` references.
#[command(trust = always)]
pub async fn find_dirs(host: &Host, window: &str, query: String, limit: u32) -> IdeResult<Vec<FileMatch>> {
    let project = host.project(window)?;
    blocking(move || Ok(project.index.find_dirs(&query, limit as usize))).await
}

#[command(trust = always)]
pub async fn find_symbols(
    host: &Host,
    window: &str,
    query: String,
    filter: SymbolFilter,
    limit: u32,
) -> IdeResult<Vec<SymbolMatch>> {
    let project = host.project(window)?;
    blocking(move || Ok(project.index.find_symbols(&query, filter, limit as usize))).await
}

/// Index symbols named exactly one of `names` inside `within` (an agent task's folder).
#[command(trust = always)]
pub async fn find_symbols_named(
    host: &Host,
    window: &str,
    names: Vec<String>,
    within: IpcPath,
) -> IdeResult<Vec<SymbolMatch>> {
    // At most `SYMBOLS_PER_NAME` each: every name an agent reply shows, in one lookup.
    const SYMBOLS_PER_NAME: usize = 50;
    let project = host.project(window)?;
    blocking(move || Ok(project.index.symbols_named_any(&names, &PathBuf::from(within), SYMBOLS_PER_NAME))).await
}

#[command(trust = always)]
pub fn mark_recent(host: &Host, window: &str, path: PathBuf) -> IdeResult<()> {
    host.project(window)?.index.mark_recent(&path);
    Ok(())
}

#[command(trust = always)]
pub fn remove_recent(host: &Host, window: &str, path: PathBuf) -> IdeResult<()> {
    host.project(window)?.index.remove_recent(&path);
    Ok(())
}

/// Recently opened files, most recent first (⌘E).
#[command(trust = always)]
pub fn recent_files(host: &Host, window: &str) -> IdeResult<Vec<ide_core::IpcPath>> {
    Ok(host.project(window)?.index.recent_files().into_iter().map(Into::into).collect())
}

/// The web reference at `pos` of `doc` and its targets; `None` when there is no reference.
#[command(trust = always)]
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

/// Custom properties declared in `doc` (from its current text, first) and in the project's
/// other stylesheets (from the index, so kept up to date as files change).
#[command(trust = always)]
pub async fn web_css_variables(host: &Host, window: &str, doc: DocId) -> IdeResult<Vec<CssVariable>> {
    let project = host.project(window)?;
    let syntax = host.syntax();
    blocking(move || {
        let snap = project.documents.snapshot(doc)?;
        let own = if snap.large { Vec::new() } else { syntax.web_definitions(&snap.language, &snap.text) };
        let mut out: Vec<CssVariable> = own
            .into_iter()
            .filter(|t| t.kind == CSS_VARIABLE)
            .map(|t| CssVariable {
                name: t.name,
                value: t.container,
                location: Location { path: snap.path.clone(), range: t.range, uri: None },
            })
            .collect();
        out.extend(
            project
                .index
                .symbols_prefixed("--", CSS_VARIABLE, MAX_CSS_VARIABLES)
                .into_iter()
                .filter(|m| *m.path != *snap.path)
                .map(|m| CssVariable {
                    name: m.name,
                    value: m.container,
                    location: Location { path: m.path, range: m.range, uri: None },
                }),
        );
        Ok(out)
    })
    .await
}

/// The file a Python import path (`a.b.c`, or `.x` relative to `from`) names; `None` when
/// no project or content root has it.
#[command(trust = always)]
pub async fn nav_resolve_module(host: &Host, window: &str, name: String, from: IpcPath) -> IdeResult<Option<IpcPath>> {
    // `a.b.c` is `a/b/c.py(i)` or `a/b/c/__init__.py(i)` in the project or one of its content roots
    // (an attached dependency project included). Neither the language server (it analyses a single
    // root) nor the definition index resolves a package segment, so ⌘B on the `a.b` of
    // `from a.b import x` needs this.
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

/// Index definitions named `name` within the roots `from` may navigate into (its own root
/// plus its configured dependencies).
#[command(trust = always)]
pub async fn nav_index_definitions(
    host: &Host,
    window: &str,
    name: String,
    from: IpcPath,
) -> IdeResult<Vec<SymbolMatch>> {
    // The cross-root answer when the language server cannot resolve an import into an attached
    // dependency project. `from`'s own root is left out: the server sees it, so a name it could
    // not resolve there is not answered by every declaration that happens to share it (any `save`
    // for `repo.save()`).
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

/// Every Python class in the project (attached dependency roots included) and its base names,
/// for native inheritance gutter markers.
#[command(trust = always)]
pub async fn nav_inheritance(host: &Host, window: &str) -> IdeResult<Vec<ClassInheritance>> {
    // The index covers content roots, so this is the whole-project answer when no type-hierarchy
    // provider exists.
    let project = host.project(window)?;
    let syntax = host.syntax();
    blocking(move || {
        let python = LanguageId::new("python");
        let mut cache = CLASS_BASES.lock();
        // Disk-backed classes come from the index: it already parsed every file once for
        // symbols, so no second parse of the project is needed here.
        let mut out: Vec<ClassInheritance> = project
            .index
            .inheritance()
            .into_iter()
            // The index holds classes of every language; the graph is Python's.
            .filter(|c| matches!(c.path.extension().and_then(std::ffi::OsStr::to_str), Some("py" | "pyi")))
            .map(|c| ClassInheritance {
                path: IpcPath::from(c.path.clone()),
                line: c.range.start.line,
                col: c.range.start.col,
                name: c.name.clone(),
                bases: c.bases.clone(),
            })
            .collect();
        // Open buffers may be unsaved, so their classes are parsed live (and cached per
        // text/stamp) and replace the index's view of that file. This keeps #3359's
        // "open buffer by its text" behaviour while the disk path is index-backed.
        let open_files: Vec<PathBuf> = project
            .index
            .files_with_extensions(&["py".into(), "pyi".into()], 20_000)
            .into_iter()
            .filter(|path| project.documents.text_of(path).is_some())
            .collect();
        for path in open_files {
            let open = project.documents.text_of(&path);
            let stamp = match &open {
                Some(text) => Stamp(text_hash(text)),
                None => continue,
            };
            let text = open.unwrap();
            let classes = match cache.get(&path) {
                Some((cached, classes)) if *cached == stamp => classes,
                _ => &cache.entry(path.clone()).insert_entry((stamp, syntax.class_bases(&python, &text))).into_mut().1,
            };
            out.retain(|c| c.path.0 != *path);
            out.extend(classes.iter().map(|class| ClassInheritance {
                path: IpcPath::from(path.clone()),
                line: class.line,
                col: class.col,
                name: class.name.clone(),
                bases: class.bases.clone(),
            }));
        }
        Ok(out)
    })
    .await
}

#[derive(Clone, PartialEq, Eq)]
struct Stamp(u64);

fn text_hash(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

type ClassBasesCache = std::collections::HashMap<PathBuf, (Stamp, Vec<ide_language::ClassBases>)>;

/// Class bases per Python file, reused while the file is unchanged.
static CLASS_BASES: std::sync::LazyLock<parking_lot::Mutex<ClassBasesCache>> =
    std::sync::LazyLock::new(Default::default);

/// The existing file or directory a path written in `from` names (`href`, `url()`, a string literal).
#[command(trust = always)]
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
#[command(trust = always)]
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
#[command(trust = always)]
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

/// The stub (`.pyi`) of a Python document, or the implementation of a stub, and the
/// functions and classes declared in both: PyCharm's stub gutter markers.
#[command(trust = always)]
pub async fn nav_python_stubs(host: &Host, window: &str, doc: DocId) -> IdeResult<PythonStubLinks> {
    let project = host.project(window)?;
    let syntax = host.syntax();
    blocking(move || {
        let snap = project.documents.snapshot(doc)?;
        if snap.large {
            return Ok(PythonStubLinks::default());
        }
        let path = PathBuf::from(snap.path.clone());
        // Modules are found in the project's Python roots and its virtualenv's site-packages.
        let mut search = super::python::paths(&project);
        let settings = project.settings.effective();
        if let Some(venv) =
            ide_sdk::apply::python_interpreter(&project.root, &settings).and_then(|p| ide_sdk::venv_of(&p))
        {
            search.extend(site_packages(&venv));
        }
        let module = module_name(&path, &search);
        let candidates = counterpart_candidates(&path, &stub_path(&project.root), module.as_deref(), &search);
        let watched = candidates.iter().cloned().map(IpcPath::from).collect();
        let Some(counterpart) = candidates.into_iter().find(|p| project.documents.text_of(p).is_some() || p.is_file())
        else {
            return Ok(PythonStubLinks { candidates: watched, ..Default::default() });
        };
        // A counterpart too large to parse still opens; it just gets no markers.
        let other = match project.documents.text_of(&counterpart) {
            Some(text) => Some(text).filter(|t| t.len() as u64 <= ide_vfs::LARGE_FILE_THRESHOLD),
            None => std::fs::metadata(&counterpart)
                .is_ok_and(|m| m.len() <= ide_vfs::LARGE_FILE_THRESHOLD)
                .then(|| project.text_of(&counterpart))
                .transpose()?,
        };
        let links = other
            .map(|other| {
                match_declarations(&syntax.outline(&snap.language, &snap.text), &syntax.outline(&snap.language, &other))
            })
            .unwrap_or_default();
        Ok(PythonStubLinks { counterpart: Some(IpcPath::from(counterpart)), links, candidates: watched })
    })
    .await
}

/// pytest fixtures at `pos` of a Python document: the definition pytest uses for the fixture
/// named there (a test's parameter, a `usefixtures` / `getfixturevalue` string), and the
/// fixtures visible where a fixture name goes, for completion.
#[command(trust = always)]
pub async fn nav_pytest_fixtures(host: &Host, window: &str, doc: DocId, pos: Pos) -> IdeResult<PytestFixtureAt> {
    let project = host.project(window)?;
    let syntax = host.syntax();
    blocking(move || {
        let snap = project.documents.snapshot(doc)?;
        if snap.large || snap.language.as_str() != "python" {
            return Ok(Default::default());
        }
        Ok(fixture_at(&project, &syntax, &snap.path, &snap.text, pos))
    })
    .await
}

/// Find Usages of the pytest fixture at `pos` (its definition, or a place asking for it): every
/// test and fixture parameter, `usefixtures` and `getfixturevalue` string that gets it.
/// None when `pos` names no fixture. Cancellable.
#[command(trust = always)]
pub async fn nav_pytest_fixture_usages(
    host: &Host,
    window: &str,
    doc: DocId,
    pos: Pos,
    request: RequestId,
) -> IdeResult<Option<PytestFixtureUsages>> {
    let project = host.project(window)?;
    let syntax = host.syntax();
    let token = host.begin_request(request);
    let result = blocking(move || {
        let snap = project.documents.snapshot(doc)?;
        if snap.large || snap.language.as_str() != "python" {
            return Ok(None);
        }
        fixture_usages(&project, &syntax, &snap.path, &snap.text, pos, &|| token.is_cancelled())
    })
    .await;
    host.end_request(request);
    result
}

/// The pytest fixture at `pos` (its definition, a place asking for it, or a read of such a
/// parameter in a function body), without searching the project: what Rename renames.
#[command(trust = always)]
pub async fn nav_pytest_fixture_target(
    host: &Host,
    window: &str,
    doc: DocId,
    pos: Pos,
) -> IdeResult<Option<PytestFixtureTarget>> {
    let project = host.project(window)?;
    let syntax = host.syntax();
    blocking(move || {
        let snap = project.documents.snapshot(doc)?;
        if snap.large || snap.language.as_str() != "python" {
            return Ok(None);
        }
        Ok(fixture_target(&project, &syntax, &snap.path, &snap.text, pos))
    })
    .await
}

/// Rename of the pytest fixture at `pos`: its definition, every place that gets it and the
/// reads of those parameters in their functions; or the parameter or fixture the new name
/// would clash with. Cancellable.
#[command(trust = always)]
pub async fn nav_pytest_fixture_rename(
    host: &Host,
    window: &str,
    doc: DocId,
    pos: Pos,
    new_name: String,
    request: RequestId,
) -> IdeResult<PytestFixtureRename> {
    let project = host.project(window)?;
    let syntax = host.syntax();
    let token = host.begin_request(request);
    let result = blocking(move || {
        let snap = project.documents.snapshot(doc)?;
        let mut renamed =
            rename_fixture(&project, &syntax, &snap.path, &snap.text, pos, &new_name, &|| token.is_cancelled())?;
        if token.is_cancelled() {
            return Err(ide_core::IdeError::cancelled());
        }
        project.documents.prepare_workspace_edit(&mut renamed.edit)?;
        Ok(renamed)
    })
    .await;
    host.end_request(request);
    result
}

ide_command::domain!(
    nav:
    find_dirs,
    find_files,
    find_files_named,
    find_symbols,
    find_symbols_named,
    fs_resolve_reference,
    index_file_extensions,
    index_status,
    mark_recent,
    nav_index_definitions,
    nav_inheritance,
    nav_pytest_fixture_rename,
    nav_pytest_fixture_target,
    nav_pytest_fixture_usages,
    nav_pytest_fixtures,
    nav_python_stubs,
    nav_resolve_module,
    path_completions,
    recent_files,
    remove_recent,
    scope_files,
    web_css_variables,
    web_goto,
    web_unresolved_references,
);
