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
    /// Named by its function (no `name=`): renaming it renames the function.
    function_name: bool,
}

impl Definition {
    fn of(path: &Path, fixture: &ide_language::PytestFixture) -> Self {
        Self {
            name: fixture.name.clone(),
            path: path.to_path_buf(),
            selection: fixture.selection,
            function_name: !fixture.by_argument,
        }
    }
}

/// Where pytest finds the fixture `u` asks for, seen from `layers`.
fn definition_of(layers: &[Layer], u: &ide_language::PytestFixtureUse) -> Option<Definition> {
    let modules: Vec<&PytestModule> = layers.iter().map(|(_, m)| m.as_ref()).collect();
    let (l, f) = resolve_fixture(&modules, &u.name, u.class.as_deref(), u.in_fixture.as_deref() == Some(&u.name))?;
    Some(Definition::of(&layers[l].0, &modules[l].fixtures[f]))
}

/// The fixture at `pos` of `path` and the range of its name there: the one defined there, the
/// one a test asks for there, or the one whose parameter a function body reads there.
fn target_at(
    project: &Project,
    syntax: &Syntax,
    scope: &Scope,
    path: &Path,
    own: &Arc<PytestModule>,
    pos: Pos,
) -> Option<(Definition, Range)> {
    if let Some(f) = own.definition_at(pos) {
        let fixture = &own.fixtures[f];
        return Some((Definition::of(path, fixture), fixture.selection));
    }
    let (usage, range) = own.use_or_read_at(pos)?;
    Some((definition_of(&scope.layers(project, syntax, path, own.clone()), usage)?, range))
}

/// The pytest fixture at a position, found without searching the project (for Rename to
/// decide what it renames before asking for the new name).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PytestFixtureTarget {
    pub name: String,
    /// The name at the position: a definition, a place asking for the fixture, or a read of
    /// such a parameter in a function body.
    pub range: Range,
    pub definition: Location,
    /// Defined in the project (not by a plugin or pytest): it may be renamed.
    pub in_project: bool,
    /// Named by its function (no `name=`): Python code may refer to the function too.
    pub function_name: bool,
}

pub(crate) fn fixture_target(
    project: &Project,
    syntax: &Syntax,
    path: &Path,
    text: &str,
    pos: Pos,
) -> Option<PytestFixtureTarget> {
    let own = Arc::new(syntax.pytest_module(&python(), text));
    if own.definition_at(pos).is_none() && own.use_or_read_at(pos).is_none() {
        return None;
    }
    let (target, range) = target_at(project, syntax, &Scope::new(project), path, &own, pos)?;
    Some(PytestFixtureTarget {
        name: target.name.clone(),
        range,
        in_project: is_project_file(project, &target.path),
        function_name: target.function_name,
        definition: Location { path: IpcPath::from(target.path), range: target.selection, uri: None },
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PytestFixtureUsages {
    pub name: String,
    pub definition: Location,
    /// Every place that gets this fixture: parameters, `usefixtures` and `getfixturevalue` strings.
    pub usages: Vec<Location>,
}

struct Usage {
    path: PathBuf,
    use_: ide_language::PytestFixtureUse,
}

/// The fixture at `pos` of the Python document `path` / `text` (a definition or a place asking
/// for it) and every place that gets it.
pub(crate) fn fixture_usages(
    project: &Project,
    syntax: &Syntax,
    path: &Path,
    text: &str,
    pos: Pos,
    cancelled: &dyn Fn() -> bool,
) -> IdeResult<Option<PytestFixtureUsages>> {
    let own = Arc::new(syntax.pytest_module(&python(), text));
    // Find Usages on a read in a body stays the language server's (the parameter's uses).
    if own.definition_at(pos).is_none() && own.use_at(pos).is_none() {
        return Ok(None);
    }
    let Some((target, usages)) = usages_of(project, syntax, path, own, pos, cancelled)? else { return Ok(None) };
    Ok(Some(PytestFixtureUsages {
        name: target.name.clone(),
        definition: Location { path: IpcPath::from(target.path), range: target.selection, uri: None },
        usages: usages
            .into_iter()
            .map(|u| Location { path: IpcPath::from(u.path), range: u.use_.range, uri: None })
            .collect(),
    }))
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PytestFixtureRename {
    pub edit: WorkspaceEdit,
    /// A parameter or fixture that already has the new name, which the rename would clash with
    /// (the edit is empty then).
    pub clash: Option<Location>,
}

/// Rename of the fixture at `pos`: its definition (the `name=` string, else the function name),
/// every place that gets it, and the reads of a renamed parameter in its function's body.
pub(crate) fn rename_fixture(
    project: &Project,
    syntax: &Syntax,
    path: &Path,
    text: &str,
    pos: Pos,
    new_name: &str,
    cancelled: &dyn Fn() -> bool,
) -> IdeResult<PytestFixtureRename> {
    let own = Arc::new(syntax.pytest_module(&python(), text));
    let Some((target, usages)) = usages_of(project, syntax, path, own, pos, cancelled)? else {
        return Err(IdeError::invalid("No pytest fixture here"));
    };
    if !is_project_file(project, &target.path) {
        return Err(IdeError::invalid("The fixture is defined outside the project"));
    }
    if let Some(clash) = clash(project, syntax, &target, &usages, new_name) {
        return Ok(PytestFixtureRename { edit: WorkspaceEdit::default(), clash: Some(clash) });
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
    Ok(PytestFixtureRename { edit: WorkspaceEdit { files, preconditions: Vec::new() }, clash: None })
}

/// Where `new_name` is already taken: another parameter of a function that gets the fixture,
/// or another fixture of the definition's scope.
fn clash(
    project: &Project,
    syntax: &Syntax,
    target: &Definition,
    usages: &[Usage],
    new_name: &str,
) -> Option<Location> {
    for u in usages {
        if u.use_.params.iter().any(|p| p == new_name) {
            return Some(Location { path: IpcPath::from(u.path.clone()), range: u.use_.range, uri: None });
        }
    }
    let module = module_of(project, syntax, &target.path)?;
    let class = module.fixtures.iter().find(|f| f.selection == target.selection)?.class.clone();
    let other = module.fixtures.iter().find(|f| f.name == new_name && f.class == class)?;
    Some(Location { path: IpcPath::from(target.path.clone()), range: other.selection, uri: None })
}

fn usages_of(
    project: &Project,
    syntax: &Syntax,
    path: &Path,
    own: Arc<PytestModule>,
    pos: Pos,
    cancelled: &dyn Fn() -> bool,
) -> IdeResult<Option<(Definition, Vec<Usage>)>> {
    let scope = Scope::new(project);
    let Some((target, _)) = target_at(project, syntax, &scope, path, &own, pos) else { return Ok(None) };
    let patterns = test_file_patterns(&project.root);
    let mut files = candidate_files(project, &target.path, &patterns);
    if !files.iter().any(|f| f == path) && is_project_file(project, path) {
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

/// Where the files that may get a fixture are.
#[derive(Debug, PartialEq, Eq)]
enum Searched<'a> {
    /// A test module's fixtures are its own.
    Itself,
    /// A `conftest.py`'s: the test files below its folder; any other module's (one that
    /// `pytest_plugins` loads or a conftest imports) and a plugin's: the whole project's.
    Below(&'a Path),
}

fn searched<'a>(root: &'a Path, definition: &'a Path, in_project: bool, patterns: &[String]) -> Searched<'a> {
    let name = definition.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    match () {
        _ if !in_project => Searched::Below(root),
        _ if name == "conftest.py" => Searched::Below(definition.parent().unwrap_or(root)),
        _ if is_test_module(name, patterns) => Searched::Itself,
        _ => Searched::Below(root),
    }
}

/// The files that may get a fixture defined in `definition`, from the file index (or the disk,
/// while the index is still being built).
fn candidate_files(project: &Project, definition: &Path, patterns: &[String]) -> Vec<PathBuf> {
    let dir = match searched(&project.root, definition, is_project_file(project, definition), patterns) {
        Searched::Itself => return vec![definition.to_path_buf()],
        Searched::Below(dir) => dir,
    };
    let wanted = |rel: &Path| rel.file_name().and_then(|n| n.to_str()).is_some_and(|n| is_test_file(n, patterns));
    let mut files = project.index.files_matching(dir, wanted, MAX_FILES).unwrap_or_else(|| {
        ignore::WalkBuilder::new(dir)
            .build()
            .flatten()
            .map(|e| e.into_path())
            .filter(|p| p.strip_prefix(dir).is_ok_and(wanted))
            .take(MAX_FILES)
            .collect()
    });
    files.retain(|f| is_project_file(project, f));
    // A module `pytest_plugins` loads is searched too (it may use its own fixtures).
    if is_project_file(project, definition) && !files.iter().any(|f| f == definition) {
        files.push(definition.to_path_buf());
    }
    files.sort();
    files
}

const MAX_FILES: usize = 20_000;

/// A file of the project's own code: below its root, not in an installed package (a
/// virtualenv inside the project holds pytest and its plugins).
fn is_project_file(project: &Project, path: &Path) -> bool {
    path.starts_with(&project.root) && !path.components().any(|c| c.as_os_str() == "site-packages")
}

/// The test modules pytest collects (`python_files`, default `test_*.py` and `*_test.py`) and
/// `conftest.py`, which it loads.
fn is_test_file(name: &str, patterns: &[String]) -> bool {
    name == "conftest.py" || is_test_module(name, patterns)
}

fn is_test_module(name: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| glob_match(p, name))
}

/// `python_files` from the project's pytest configuration (`pytest.ini`, `pyproject.toml`,
/// `tox.ini`, `setup.cfg`, the first that has a pytest section), else pytest's default.
fn test_file_patterns(root: &Path) -> Vec<String> {
    let read = |name: &str| std::fs::read_to_string(root.join(name)).ok();
    let from_ini = |text: String, section: &str| -> Option<Option<String>> {
        let mut inside = false;
        let mut found = None;
        for line in text.lines() {
            let line = line.trim();
            if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                inside = name == section;
                if inside {
                    found = Some(None);
                }
            } else if inside
                && let Some((key, value)) = line.split_once('=')
                && key.trim() == "python_files"
            {
                found = Some(Some(value.trim().to_owned()));
            }
        }
        found
    };
    let from_toml = |text: String| -> Option<Option<String>> {
        let table = text.parse::<toml::Table>().ok()?;
        let options = table.get("tool")?.get("pytest")?.get("ini_options")?;
        Some(match options.get("python_files") {
            Some(toml::Value::String(s)) => Some(s.clone()),
            Some(toml::Value::Array(a)) => Some(a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" ")),
            _ => None,
        })
    };
    // pytest uses the first file with a pytest section, in this order.
    let configured = read("pytest.ini")
        .and_then(|t| from_ini(t, "pytest"))
        .or_else(|| read("pyproject.toml").and_then(from_toml))
        .or_else(|| read("tox.ini").and_then(|t| from_ini(t, "pytest")))
        .or_else(|| read("setup.cfg").and_then(|t| from_ini(t, "tool:pytest")))
        .flatten();
    match configured {
        Some(value) if !value.trim().is_empty() => value.split_whitespace().map(str::to_owned).collect(),
        _ => vec!["test_*.py".to_owned(), "*_test.py".to_owned()],
    }
}

/// `fnmatch` with `*` and `?`, as pytest matches `python_files` against a file name.
fn glob_match(pattern: &str, name: &str) -> bool {
    fn go(p: &[char], n: &[char]) -> bool {
        match p.split_first() {
            None => n.is_empty(),
            Some(('*', rest)) => (0..=n.len()).any(|i| go(rest, &n[i..])),
            Some(('?', rest)) => !n.is_empty() && go(rest, &n[1..]),
            Some((c, rest)) => n.first() == Some(c) && go(rest, &n[1..]),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    go(&p, &n)
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
        let default = vec!["test_*.py".to_owned(), "*_test.py".to_owned()];
        for (name, expected) in [
            ("test_a.py", true),
            ("a_test.py", true),
            ("conftest.py", true),
            ("helpers.py", false),
            ("test_a.json", false),
        ] {
            assert_eq!(is_test_file(name, &default), expected, "{name}");
        }
        let custom = vec!["check_*.py".to_owned(), "tests.py".to_owned()];
        assert!(is_test_file("check_cli.py", &custom) && is_test_file("tests.py", &custom));
        assert!(!is_test_file("test_a.py", &custom));
    }

    #[test]
    fn reads_python_files_from_the_first_pytest_configuration() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(test_file_patterns(dir.path()), ["test_*.py", "*_test.py"]);
        std::fs::write(dir.path().join("setup.cfg"), "[tool:pytest]\npython_files = check_*.py\n").unwrap();
        assert_eq!(test_file_patterns(dir.path()), ["check_*.py"]);
        std::fs::write(
            dir.path().join("pyproject.toml"),
            "[tool.pytest.ini_options]\npython_files = [\"tests.py\", \"t_*.py\"]\n",
        )
        .unwrap();
        assert_eq!(test_file_patterns(dir.path()), ["tests.py", "t_*.py"]);
        // A pytest.ini section without python_files means pytest's default, even with the others.
        std::fs::write(dir.path().join("pytest.ini"), "[pytest]\naddopts = -q\n").unwrap();
        assert_eq!(test_file_patterns(dir.path()), ["test_*.py", "*_test.py"]);
    }

    #[test]
    fn a_fixture_is_searched_where_pytest_lets_tests_see_it() {
        let root = Path::new("/p");
        let default = vec!["test_*.py".to_owned(), "*_test.py".to_owned()];
        let at = |path: &'static str, in_project: bool| searched(root, Path::new(path), in_project, &default);
        assert_eq!(at("/p/tests/test_a.py", true), Searched::Itself);
        assert_eq!(at("/p/tests/conftest.py", true), Searched::Below(Path::new("/p/tests")));
        // A module that `pytest_plugins` loads, or that a conftest imports.
        assert_eq!(at("/p/tests/fixtures.py", true), Searched::Below(root));
        assert_eq!(at("/p/.venv/lib/python3.12/site-packages/_pytest/tmpdir.py", false), Searched::Below(root));
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
