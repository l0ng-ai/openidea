//! pytest fixtures across files: the modules a test file sees, nearest first (the file, its
//! `conftest.py` files up to the project root, the modules `pytest_plugins` names, installed
//! plugins' `pytest11` entry points, pytest's own `_pytest` package), for Go to Declaration
//! and completion of fixture names.

use super::python_stubs::site_packages;
use crate::Project;
use ide_core::{FileEdit, IdeError, IdeResult, IpcPath, LanguageId, Location, Pos, Range, TextEdit, WorkspaceEdit};
use ide_language::{PytestModule, Syntax, resolve_fixture, visible_fixtures};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PytestFixtureAt {
    /// The fixture name at the position, and the definition pytest uses for it.
    pub reference: Option<PytestFixtureReference>,
    /// At a place a fixture name goes (a test's parameters, a `usefixtures` string): the
    /// fixtures visible there, nearest first.
    pub completions: Option<Vec<PytestFixtureItem>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PytestFixtureReference {
    pub name: String,
    pub range: Range,
    /// None when no visible module defines it (`request`, a fixture from a hook).
    pub definition: Option<Location>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PytestFixtureItem {
    pub name: String,
    /// The file defining it.
    pub path: IpcPath,
}

/// Fixtures at `pos` of the Python document `path` / `text`.
pub(crate) fn fixture_at(project: &Project, syntax: &Syntax, path: &Path, text: &str, pos: Pos) -> PytestFixtureAt {
    let own = syntax.pytest_module(&python(), text);
    let usage = own.use_at(pos).cloned();
    let slot = own.slot_at(pos).cloned();
    if usage.is_none() && slot.is_none() {
        return PytestFixtureAt::default();
    }
    let layers = Scope::new(project).layers(project, syntax, path, Arc::new(own));
    let modules: Vec<&PytestModule> = layers.iter().map(|(_, m)| m.as_ref()).collect();
    let reference = usage.map(|u| {
        let found = resolve_fixture(&modules, &u.name, u.class.as_deref(), u.in_fixture.as_deref() == Some(&u.name));
        PytestFixtureReference {
            definition: found.map(|(l, f)| Location {
                path: IpcPath::from(layers[l].0.clone()),
                range: modules[l].fixtures[f].selection,
                uri: None,
            }),
            name: u.name,
            range: u.range,
        }
    });
    let completions = slot.map(|s| {
        visible_fixtures(&modules, s.class.as_deref())
            .into_iter()
            // `_name` fixtures are internal, as `pytest --fixtures` hides them.
            .filter(|&(l, f)| !modules[l].fixtures[f].name.starts_with('_'))
            .map(|(l, f)| PytestFixtureItem {
                name: modules[l].fixtures[f].name.clone(),
                path: IpcPath::from(layers[l].0.clone()),
            })
            .collect()
    });
    PytestFixtureAt { reference, completions }
}

fn python() -> LanguageId {
    LanguageId::new("python")
}

type Layer = (PathBuf, Arc<PytestModule>);

/// What every file of the project sees after its own `conftest.py` files: the folders
/// `pytest_plugins` modules are found in, installed plugins and pytest's own modules.
struct Scope {
    search: Vec<PathBuf>,
    tail: Vec<PathBuf>,
}

impl Scope {
    fn new(project: &Project) -> Self {
        let packages = interpreter_site_packages(project);
        let mut search = super::python::paths(project);
        search.extend(packages.iter().cloned());
        // `pytest_plugins = ["pytester"]` names pytest's own optional plugins by their short name.
        search.extend(packages.iter().map(|p| p.join("_pytest")));
        let mut tail = Vec::new();
        for packages in &packages {
            tail.extend(
                entry_point_modules(packages).iter().filter_map(|m| module_file(m, std::slice::from_ref(packages))),
            );
        }
        for packages in &packages {
            tail.extend(builtin_modules(&packages.join("_pytest")));
        }
        Self { search, tail }
    }

    /// The modules `path` sees, nearest first, `own` being its own: its `conftest.py` files up to
    /// the project root, the modules their `pytest_plugins` name, then installed plugins and pytest.
    fn layers(&self, project: &Project, syntax: &Syntax, path: &Path, own: Arc<PytestModule>) -> Vec<Layer> {
        let mut out: Vec<Layer> = vec![(path.to_path_buf(), own)];
        let mut dir = path.parent();
        while let Some(d) = dir.filter(|d| d.starts_with(&project.root)) {
            let conftest = d.join("conftest.py");
            if conftest != path
                && let Some(m) = module_of(project, syntax, &conftest)
            {
                out.push((conftest, m));
            }
            dir = d.parent();
        }
        let named: Vec<String> = out.iter().flat_map(|(_, m)| m.plugins.clone()).collect();
        let extra =
            named.iter().filter_map(|module| module_file(module, &self.search)).chain(self.tail.iter().cloned());
        for file in extra.collect::<Vec<_>>() {
            if !out.iter().any(|(p, _)| *p == file)
                && let Some(m) = module_of(project, syntax, &file)
            {
                out.push((file, m));
            }
        }
        out
    }
}

/// A fixture definition: its file and the range of its name there.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Definition {
    name: String,
    path: PathBuf,
    selection: Range,
}

/// Where pytest finds the fixture `u` asks for, seen from `layers`.
fn definition_of(layers: &[Layer], u: &ide_language::PytestFixtureUse) -> Option<Definition> {
    let modules: Vec<&PytestModule> = layers.iter().map(|(_, m)| m.as_ref()).collect();
    let (l, f) = resolve_fixture(&modules, &u.name, u.class.as_deref(), u.in_fixture.as_deref() == Some(&u.name))?;
    Some(Definition { name: u.name.clone(), path: layers[l].0.clone(), selection: modules[l].fixtures[f].selection })
}

/// The fixture at `pos` of `path`: the one defined there, or the one a test asks for there.
fn target_at(
    project: &Project,
    syntax: &Syntax,
    scope: &Scope,
    path: &Path,
    own: &Arc<PytestModule>,
    pos: Pos,
) -> Option<Definition> {
    if let Some(f) = own.definition_at(pos) {
        let fixture = &own.fixtures[f];
        return Some(Definition { name: fixture.name.clone(), path: path.to_path_buf(), selection: fixture.selection });
    }
    let usage = own.use_at(pos)?;
    definition_of(&scope.layers(project, syntax, path, own.clone()), usage)
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PytestFixtureUsages {
    pub name: String,
    pub definition: Location,
    /// Defined in the project (not by a plugin or pytest): it may be renamed.
    pub in_project: bool,
    /// Every place that gets this fixture: parameters, `usefixtures` and `getfixturevalue` strings.
    pub usages: Vec<Location>,
}

struct Usage {
    path: PathBuf,
    use_: ide_language::PytestFixtureUse,
}

/// The fixture at `pos` of the Python document `path` / `text` and every place that gets it.
pub(crate) fn fixture_usages(
    project: &Project,
    syntax: &Syntax,
    path: &Path,
    text: &str,
    pos: Pos,
    cancelled: &dyn Fn() -> bool,
) -> IdeResult<Option<PytestFixtureUsages>> {
    let Some((target, usages)) = usages_of(project, syntax, path, text, pos, cancelled)? else { return Ok(None) };
    Ok(Some(PytestFixtureUsages {
        name: target.name.clone(),
        in_project: is_project_file(project, &target.path),
        definition: Location { path: IpcPath::from(target.path), range: target.selection, uri: None },
        usages: usages
            .into_iter()
            .map(|u| Location { path: IpcPath::from(u.path), range: u.use_.range, uri: None })
            .collect(),
    }))
}

/// Rename of the fixture at `pos`: its definition (the `name=` string, else the function name),
/// every place that gets it, and the uses of a renamed parameter in its function's body.
pub(crate) fn rename_fixture(
    project: &Project,
    syntax: &Syntax,
    path: &Path,
    text: &str,
    pos: Pos,
    new_name: &str,
    cancelled: &dyn Fn() -> bool,
) -> IdeResult<WorkspaceEdit> {
    let Some((target, usages)) = usages_of(project, syntax, path, text, pos, cancelled)? else {
        return Err(IdeError::invalid("No pytest fixture here"));
    };
    if !is_project_file(project, &target.path) {
        return Err(IdeError::invalid("The fixture is defined outside the project"));
    }
    let mut by_file: Vec<(PathBuf, Vec<TextEdit>)> = Vec::new();
    let mut edit = |file: &Path, range: Range| {
        let edits = match by_file.iter_mut().find(|(p, _)| p == file) {
            Some((_, edits)) => edits,
            None => {
                by_file.push((file.to_path_buf(), Vec::new()));
                &mut by_file.last_mut().expect("just pushed").1
            }
        };
        if !edits.iter().any(|e| e.range == range) {
            edits.push(TextEdit { range, new_text: new_name.to_owned() });
        }
    };
    edit(&target.path, target.selection);
    for u in &usages {
        edit(&u.path, u.use_.range);
        for &r in &u.use_.body {
            edit(&u.path, r);
        }
    }
    let files = by_file
        .into_iter()
        .map(|(p, mut edits)| {
            edits.sort_by_key(|e| e.range);
            FileEdit::Edit { path: IpcPath::from(p), edits, version: None }
        })
        .collect();
    Ok(WorkspaceEdit { files, preconditions: Vec::new() })
}

fn usages_of(
    project: &Project,
    syntax: &Syntax,
    path: &Path,
    text: &str,
    pos: Pos,
    cancelled: &dyn Fn() -> bool,
) -> IdeResult<Option<(Definition, Vec<Usage>)>> {
    let own = Arc::new(syntax.pytest_module(&python(), text));
    if own.definition_at(pos).is_none() && own.use_at(pos).is_none() {
        return Ok(None);
    }
    let scope = Scope::new(project);
    let Some(target) = target_at(project, syntax, &scope, path, &own, pos) else { return Ok(None) };
    let mut files = candidate_files(project, &target.path);
    if !files.iter().any(|f| f == path) && path.starts_with(&project.root) {
        files.push(path.to_path_buf());
    }
    let mut usages = Vec::new();
    for file in files {
        if cancelled() {
            return Err(IdeError::cancelled());
        }
        let module = if file == path { Some(own.clone()) } else { module_of(project, syntax, &file) };
        let Some(module) = module else { continue };
        if !module.uses.iter().any(|u| u.name == target.name) {
            continue;
        }
        let layers = scope.layers(project, syntax, &file, module.clone());
        for u in module.uses.iter().filter(|u| u.name == target.name) {
            if definition_of(&layers, u).as_ref() == Some(&target) {
                usages.push(Usage { path: file.clone(), use_: u.clone() });
            }
        }
    }
    Ok(Some((target, usages)))
}

/// The files that may get a fixture defined in `definition`: that test module alone, the test
/// modules and `conftest.py` files below a `conftest.py`, all of the project's for a plugin's.
fn candidate_files(project: &Project, definition: &Path) -> Vec<PathBuf> {
    let in_project = is_project_file(project, definition);
    let is_conftest = definition.file_name().is_some_and(|n| n == "conftest.py");
    if in_project && !is_conftest {
        return vec![definition.to_path_buf()];
    }
    let dir = if in_project { definition.parent().unwrap_or(&project.root) } else { &project.root };
    let mut files = project.index.files_matching(dir, is_test_file, MAX_FILES).unwrap_or_default();
    files.sort();
    files
}

const MAX_FILES: usize = 20_000;

/// A file of the project's own code: below its root, not in an installed package (a
/// virtualenv inside the project holds pytest and its plugins).
fn is_project_file(project: &Project, path: &Path) -> bool {
    path.starts_with(&project.root) && !path.components().any(|c| c.as_os_str() == "site-packages")
}

/// `test_*.py`, `*_test.py` and `conftest.py`: the files pytest collects or loads.
fn is_test_file(rel: &Path) -> bool {
    let Some(name) = rel.file_name().and_then(|n| n.to_str()) else { return false };
    let Some(stem) = name.strip_suffix(".py") else { return false };
    stem == "conftest" || stem.starts_with("test_") || stem.ends_with("_test")
}

/// The `site-packages` of the project's interpreter: its virtualenv's, else its install prefix's.
fn interpreter_site_packages(project: &Project) -> Vec<PathBuf> {
    let settings = project.settings.effective();
    let Some(python) = ide_sdk::apply::python_interpreter(&project.root, &settings) else { return Vec::new() };
    let prefix = ide_sdk::venv_of(&python).or_else(|| python.parent()?.parent().map(Path::to_path_buf));
    prefix.map(|p| site_packages(&p)).unwrap_or_default()
}

/// `pkg.mod` → `pkg/mod.py` or `pkg/mod/__init__.py` in the first folder that has it.
fn module_file(module: &str, search: &[PathBuf]) -> Option<PathBuf> {
    let rel: PathBuf = module.split('.').collect();
    search.iter().find_map(|base| {
        let file = base.join(&rel).with_extension("py");
        let package = base.join(&rel).join("__init__.py");
        [file, package].into_iter().find(|p| p.is_file())
    })
}

/// The modules of the `[pytest11]` entry points of the distributions in `site_packages`.
fn entry_point_modules(site_packages: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(site_packages) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().ends_with(".dist-info") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path().join("entry_points.txt")) else { continue };
        out.extend(pytest11_modules(&text));
    }
    out.sort();
    out
}

/// The modules of the `[pytest11]` section of an `entry_points.txt` (`name = module:attr`).
fn pytest11_modules(text: &str) -> Vec<String> {
    let mut section = "";
    let mut out = Vec::new();
    for line in text.lines().map(str::trim) {
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = name;
        } else if section == "pytest11"
            && let Some((_, value)) = line.split_once('=')
        {
            let module = value.trim().split(':').next().unwrap_or_default().trim();
            if !module.is_empty() {
                out.push(module.to_owned());
            }
        }
    }
    out
}

/// pytest's own plugins that are off unless `pytest_plugins` names them.
const OPTIONAL_BUILTINS: [&str; 2] = ["pytester.py", "pytester_assertions.py"];

/// pytest's own modules that may define fixtures: `_pytest/*.py`, one level of subpackages.
fn builtin_modules(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if OPTIONAL_BUILTINS.iter().any(|name| entry.file_name() == *name) {
            continue;
        }
        if path.extension().is_some_and(|e| e == "py") {
            out.push(path);
        } else if path.is_dir() {
            out.extend(
                std::fs::read_dir(&path)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|e| e == "py")),
            );
        }
    }
    out.sort();
    out
}

/// A parsed file and the modification time and length it was read at.
type Cached = (SystemTime, u64, Arc<PytestModule>);

/// The fixtures of a file: from its open editor, else from disk, parsed once per modification.
fn module_of(project: &Project, syntax: &Syntax, path: &Path) -> Option<Arc<PytestModule>> {
    if let Some(text) = project.documents.text_of(path) {
        return Some(Arc::new(syntax.pytest_module(&python(), &text)));
    }
    static CACHE: LazyLock<Mutex<HashMap<PathBuf, Cached>>> = LazyLock::new(Default::default);
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
    if meta.len() > ide_vfs::LARGE_FILE_THRESHOLD {
        return None;
    }
    let stamp = (meta.modified().ok()?, meta.len());
    if let Some((time, len, m)) = CACHE.lock().ok()?.get(path)
        && (*time, *len) == stamp
    {
        return Some(m.clone());
    }
    let text = std::fs::read_to_string(path).ok()?;
    let module = Arc::new(syntax.pytest_module(&python(), &ide_text::normalize_line_endings(&text)));
    CACHE.lock().ok()?.insert(path.to_path_buf(), (stamp.0, stamp.1, module.clone()));
    Some(module)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_files_are_the_ones_pytest_loads() {
        for (rel, expected) in [
            ("tests/test_a.py", true),
            ("a_test.py", true),
            ("pkg/conftest.py", true),
            ("pkg/helpers.py", false),
            ("test_data.json", false),
        ] {
            assert_eq!(is_test_file(Path::new(rel)), expected, "{rel}");
        }
    }

    #[test]
    fn reads_pytest11_entry_points() {
        let text =
            "[console_scripts]\nx = a:b\n\n[pytest11]\nmock = pytest_mock\nasyncio = pytest_asyncio.plugin:main\n";
        assert_eq!(pytest11_modules(text), ["pytest_mock", "pytest_asyncio.plugin"]);
    }

    #[test]
    fn finds_module_files_and_packages() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("pkg/sub")).unwrap();
        std::fs::write(dir.path().join("pkg/fixtures.py"), "").unwrap();
        std::fs::write(dir.path().join("pkg/sub/__init__.py"), "").unwrap();
        let search = [dir.path().to_path_buf()];
        assert_eq!(module_file("pkg.fixtures", &search), Some(dir.path().join("pkg/fixtures.py")));
        assert_eq!(module_file("pkg.sub", &search), Some(dir.path().join("pkg/sub/__init__.py")));
        assert_eq!(module_file("pkg.none", &search), None);
    }
}
