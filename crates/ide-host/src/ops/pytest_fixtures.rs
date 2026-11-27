//! pytest fixtures across files: the modules a test file sees, nearest first (the file, its
//! `conftest.py` files up to the project root, the modules `pytest_plugins` names, installed
//! plugins' `pytest11` entry points, pytest's own `_pytest` package), for Go to Declaration
//! and completion of fixture names.

use super::python_stubs::site_packages;
use crate::Project;
use ide_core::{IpcPath, LanguageId, Location, Pos, Range};
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
    let layers = layers(project, syntax, path, Arc::new(own));
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

/// The modules `path` sees, nearest first, `own` being its own.
fn layers(project: &Project, syntax: &Syntax, path: &Path, own: Arc<PytestModule>) -> Vec<Layer> {
    let mut out: Vec<Layer> = vec![(path.to_path_buf(), own)];
    // conftest.py files from the file's folder up to the project root.
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
    let packages = interpreter_site_packages(project);
    let mut search = super::python::paths(project);
    search.extend(packages.iter().cloned());
    // `pytest_plugins = ["pytester"]` names pytest's own optional plugins by their short name.
    search.extend(packages.iter().map(|p| p.join("_pytest")));
    // Modules named by `pytest_plugins` in those files.
    let named: Vec<String> = out.iter().flat_map(|(_, m)| m.plugins.clone()).collect();
    let mut extra: Vec<PathBuf> = named.iter().filter_map(|module| module_file(module, &search)).collect();
    // Installed plugins, then pytest's own fixtures.
    for packages in &packages {
        extra.extend(
            entry_point_modules(packages).iter().filter_map(|m| module_file(m, std::slice::from_ref(packages))),
        );
    }
    for packages in &packages {
        extra.extend(builtin_modules(&packages.join("_pytest")));
    }
    for file in extra {
        if !out.iter().any(|(p, _)| *p == file)
            && let Some(m) = module_of(project, syntax, &file)
        {
            out.push((file, m));
        }
    }
    out
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
