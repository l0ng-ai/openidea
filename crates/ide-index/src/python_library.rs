//! Import candidates for a name from a Python interpreter's installed packages (PyCharm's
//! "Import this name" for library symbols). basedpyright offers import fixes for the project's
//! own symbols and the standard library only; this index covers `site-packages`.
//!
//! Every public module of the installed packages is read once: its `__all__`, else its public
//! top-level definitions ([`Syntax::python_exports`]). Indexes are shared by every request for
//! the same folders and rebuilt in the background when one of the folders changes: installing,
//! upgrading or removing a package adds or removes entries there (its `.dist-info` at least).

use ide_core::CancellationToken;
use ide_language::Syntax;
use parking_lot::{Condvar, Mutex};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

/// Modules read at most: a very large environment is indexed in part rather than for minutes.
const MAX_MODULES: usize = 60_000;
/// Package nesting below `site-packages` that is still walked.
const MAX_DEPTH: usize = 8;
/// Candidates returned for one name.
const MAX_CANDIDATES: usize = 10;

/// An import that binds a name: `from module import name`, or `import module` without `name`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PythonImportCandidate {
    pub module: String,
    pub name: Option<String>,
}

/// The public names of the modules below some `site-packages` folders.
#[derive(Debug, Default)]
pub struct PythonLibraryIndex {
    modules: Vec<String>,
    /// Name → the modules exporting it (indexes into `modules`).
    names: HashMap<String, Vec<u32>>,
    /// Importable top-level modules and packages.
    top_level: HashSet<String>,
}

/// A module found on disk and the file its names are read from (none for an extension module
/// without a stub).
struct Source {
    module: String,
    file: Option<PathBuf>,
    /// A folder without `__init__` holding modules: `from google import protobuf`, not `import google`.
    namespace: bool,
}

impl PythonLibraryIndex {
    /// Indexes the modules of `roots`, in `sys.path` order (the first folder holding a top-level
    /// name wins). None when `cancel` fired first.
    pub fn scan(roots: &[PathBuf], syntax: &Syntax, cancel: &CancellationToken) -> Option<Self> {
        let mut sources = Vec::new();
        let mut taken = HashSet::new();
        for root in roots {
            let mut found = Vec::new();
            walk(root, "", 0, &mut found, cancel);
            for source in found {
                let top = source.module.split('.').next().unwrap_or_default();
                // A package shadowed by an earlier folder is not importable from this one.
                if taken.contains(top) || sources.len() >= MAX_MODULES {
                    continue;
                }
                sources.push(source);
            }
            // Namespace packages span folders (`google.protobuf` here, `google.api` there).
            taken.extend(sources.iter().filter(|s| !s.namespace && !s.module.contains('.')).map(|s| s.module.clone()));
        }
        if cancel.is_cancelled() {
            return None;
        }
        let exports: Vec<Vec<String>> = sources
            .par_iter()
            .map(|s| match &s.file {
                Some(file) if !cancel.is_cancelled() => std::fs::metadata(file)
                    .ok()
                    .filter(|m| m.len() <= crate::MAX_SYMBOL_FILE)
                    .and_then(|_| std::fs::read_to_string(file).ok())
                    .map(|text| syntax.python_exports(&text))
                    .unwrap_or_default(),
                _ => Vec::new(),
            })
            .collect();
        if cancel.is_cancelled() {
            return None;
        }
        let mut index = Self::default();
        let ids: HashMap<&str, u32> = sources.iter().enumerate().map(|(i, s)| (s.module.as_str(), i as u32)).collect();
        for (i, (source, names)) in sources.iter().zip(exports).enumerate() {
            let module = &source.module;
            index.modules.push(module.clone());
            for name in names {
                index.names.entry(name).or_default().push(i as u32);
            }
            match module.rsplit_once('.') {
                // `from matplotlib import pyplot`
                Some((parent, last)) => {
                    if let Some(&parent) = ids.get(parent) {
                        index.names.entry(last.to_owned()).or_default().push(parent);
                    }
                }
                None if !source.namespace => {
                    index.top_level.insert(module.clone());
                }
                None => {}
            }
        }
        for modules in index.names.values_mut() {
            modules.sort_unstable();
            modules.dedup();
        }
        Some(index)
    }

    /// The imports that bind `name`: `import name` for a top-level module, then the modules that
    /// export it, the shortest module path first (a package re-exporting a name before the
    /// submodule defining it).
    pub fn candidates(&self, name: &str) -> Vec<PythonImportCandidate> {
        let mut out = Vec::new();
        if self.top_level.contains(name) {
            out.push(PythonImportCandidate { module: name.to_owned(), name: None });
        }
        let mut modules: Vec<&String> =
            self.names.get(name).into_iter().flatten().map(|&i| &self.modules[i as usize]).collect();
        let key = |m: &String| (m.matches('.').count(), m.len());
        modules.sort_by(|a, b| key(a).cmp(&key(b)).then_with(|| a.cmp(b)));
        out.extend(
            modules.into_iter().map(|m| PythonImportCandidate { module: m.clone(), name: Some(name.to_owned()) }),
        );
        out.truncate(MAX_CANDIDATES);
        out
    }
}

/// A Python identifier that is not private (`_name`).
fn public_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_alphabetic()) && chars.all(|c| c == '_' || c.is_alphanumeric())
}

/// The public modules below `dir` (the package `prefix`, empty for a `site-packages` folder).
fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<Source>, cancel: &CancellationToken) {
    if depth > MAX_DEPTH || out.len() >= MAX_MODULES || cancel.is_cancelled() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    // Module name → (`.py`, `.pyi`, extension module); packages → their folder.
    let mut files: BTreeMap<String, (Option<PathBuf>, Option<PathBuf>, bool)> = BTreeMap::new();
    let mut packages: BTreeMap<String, PathBuf> = BTreeMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            // `pkg-stubs` (PEP 561 stub-only package) holds the stubs of `pkg`.
            let name = if depth == 0 { file_name.strip_suffix("-stubs").unwrap_or(&file_name) } else { &file_name };
            if public_identifier(name) && !matches!(name, "test" | "tests") {
                let stubs = name.len() != file_name.len();
                // Stubs win over the package itself.
                if stubs || !packages.contains_key(name) {
                    packages.insert(name.to_owned(), path);
                }
            }
            continue;
        }
        let (stem, kind) = if let Some(stem) = file_name.strip_suffix(".pyi") {
            (stem, 1)
        } else if let Some(stem) = file_name.strip_suffix(".py") {
            (stem, 0)
        } else if file_name.ends_with(".so") || file_name.ends_with(".pyd") {
            // `name.cpython-313-darwin.so`, `name.abi3.so`, `name.pyd`
            (file_name.split('.').next().unwrap_or_default(), 2)
        } else {
            continue;
        };
        if !public_identifier(stem) {
            continue;
        }
        let slot = files.entry(stem.to_owned()).or_default();
        match kind {
            0 => slot.0 = Some(path),
            1 => slot.1 = Some(path),
            _ => slot.2 = true,
        }
    }
    let qualified = |name: &str| if prefix.is_empty() { name.to_owned() } else { format!("{prefix}.{name}") };
    for (name, (py, pyi, extension)) in files {
        if out.len() >= MAX_MODULES {
            return;
        }
        if packages.contains_key(&name) {
            continue;
        }
        let file = pyi.or(py);
        if file.is_some() || extension {
            out.push(Source { module: qualified(&name), file, namespace: false });
        }
    }
    for (name, path) in packages {
        let init = ["__init__.pyi", "__init__.py"].iter().map(|f| path.join(f)).find(|p| p.is_file());
        let module = qualified(&name);
        let at = out.len();
        let package = init.is_some();
        out.push(Source { module: module.clone(), file: init, namespace: !package });
        walk(&path, &module, depth + 1, out, cancel);
        // A folder without `__init__` is a namespace package only when it holds modules.
        if !package && out.len() == at + 1 {
            out.pop();
        }
    }
}

/// The indexes of every set of `site-packages` folders asked for, shared by all requests.
#[derive(Default)]
pub struct PythonLibraries {
    builds: Mutex<HashMap<Vec<PathBuf>, Arc<Build>>>,
}

struct Build {
    /// Modification times of the folders when the build started.
    stamp: Vec<Option<SystemTime>>,
    /// None while building; then the index (None when it failed or was cancelled).
    result: Mutex<Option<Option<Arc<PythonLibraryIndex>>>>,
    done: Condvar,
    cancel: CancellationToken,
}

impl Build {
    fn finish(&self, index: Option<PythonLibraryIndex>) {
        *self.result.lock() = Some(index.map(Arc::new));
        self.done.notify_all();
    }
}

/// Marks a build finished even when the indexing thread panics.
struct Finish(Arc<Build>);

impl Drop for Finish {
    fn drop(&mut self) {
        if self.0.result.lock().is_none() {
            self.0.finish(None);
        }
    }
}

impl PythonLibraries {
    /// The index of `roots`. The first request, and the first after a folder changed, starts a
    /// build on its own thread; a request only waits for it, until `cancel` fires (None then).
    pub fn index(
        &self,
        roots: &[PathBuf],
        syntax: &Arc<Syntax>,
        cancel: &CancellationToken,
    ) -> Option<Arc<PythonLibraryIndex>> {
        if roots.is_empty() {
            return Some(Arc::default());
        }
        let build = self.build(roots, syntax);
        let mut result = build.result.lock();
        loop {
            if let Some(index) = &*result {
                return index.clone();
            }
            if cancel.is_cancelled() {
                return None;
            }
            build.done.wait_for(&mut result, Duration::from_millis(50));
        }
    }

    fn build(&self, roots: &[PathBuf], syntax: &Arc<Syntax>) -> Arc<Build> {
        let stamp = stamp(roots);
        let mut builds = self.builds.lock();
        if let Some(build) = builds.get(roots).filter(|b| b.stamp == stamp) {
            return build.clone();
        }
        let build =
            Arc::new(Build { stamp, result: Mutex::new(None), done: Condvar::new(), cancel: CancellationToken::new() });
        if let Some(old) = builds.insert(roots.to_vec(), build.clone()) {
            old.cancel.cancel();
        }
        let (job, roots, syntax) = (Finish(build.clone()), roots.to_vec(), syntax.clone());
        // When the thread cannot start, dropping `job` finishes the build without an index.
        let _ = std::thread::Builder::new().name("python-library-index".into()).spawn(move || {
            let index = PythonLibraryIndex::scan(&roots, &syntax, &job.0.cancel);
            job.0.finish(index);
        });
        build
    }
}

fn stamp(roots: &[PathBuf]) -> Vec<Option<SystemTime>> {
    roots.iter().map(|r| std::fs::metadata(r).and_then(|m| m.modified()).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn candidates(index: &PythonLibraryIndex, name: &str) -> Vec<String> {
        index
            .candidates(name)
            .into_iter()
            .map(|c| match c.name {
                Some(name) => format!("from {} import {name}", c.module),
                None => format!("import {}", c.module),
            })
            .collect()
    }

    /// The shapes of the report: a name re-exported by a package's `__all__` from a submodule,
    /// and names defined in a public submodule only.
    fn site_packages() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "langchain/__init__.py", "");
        write(
            root,
            "langchain/agents/__init__.py",
            "from langchain.agents.factory import create_agent\n__all__ = ['create_agent']\n",
        );
        write(root, "langchain/agents/factory.py", "def create_agent(): pass\ndef _private(): pass\n");
        write(root, "matplotlib/__init__.py", "def use(): pass\n");
        write(root, "matplotlib/figure.py", "class Figure: pass\nclass SubFigure: pass\n");
        write(root, "matplotlib/colors.py", "class Normalize: pass\n");
        write(root, "matplotlib/pyplot.py", "def figure(): pass\n");
        write(root, "matplotlib/_private_module.py", "class Hidden: pass\n");
        write(root, "matplotlib/tests/test_figure.py", "class Figure: pass\n");
        write(root, "numpy/__init__.pyi", "class ndarray: ...\n");
        write(root, "numpy/__init__.py", "class ndarray: pass\nclass only_in_source: pass\n");
        write(root, "six.py", "def add_metaclass(): pass\n");
        write(root, "_cffi_backend.cpython-313-darwin.so", "");
        write(root, "orjson.cpython-313-x86_64-linux-gnu.so", "");
        write(root, "requests-stubs/__init__.pyi", "def get(url: str) -> None: ...\n");
        write(root, "requests/__init__.py", "def get(url): pass\ndef untyped(): pass\n");
        write(root, "google/protobuf/__init__.py", "");
        write(root, "google/protobuf/message.py", "class Message: pass\n");
        write(root, "langchain-1.0.dist-info/METADATA", "");
        dir
    }

    fn scan(roots: &[PathBuf]) -> PythonLibraryIndex {
        PythonLibraryIndex::scan(roots, &Syntax::new(), &CancellationToken::new()).unwrap()
    }

    #[test]
    fn indexes_the_public_names_of_installed_modules() {
        let dir = site_packages();
        let index = scan(&[dir.path().to_path_buf()]);
        assert_eq!(
            candidates(&index, "create_agent"),
            ["from langchain.agents import create_agent", "from langchain.agents.factory import create_agent"]
        );
        assert_eq!(candidates(&index, "Figure"), ["from matplotlib.figure import Figure"]);
        assert_eq!(candidates(&index, "Normalize"), ["from matplotlib.colors import Normalize"]);
        assert_eq!(candidates(&index, "pyplot"), ["from matplotlib import pyplot"]);
        assert_eq!(candidates(&index, "add_metaclass"), ["from six import add_metaclass"]);
        assert_eq!(candidates(&index, "Message"), ["from google.protobuf.message import Message"]);
        // Top-level modules and extension modules are imported as a whole.
        assert_eq!(candidates(&index, "matplotlib"), ["import matplotlib"]);
        assert_eq!(candidates(&index, "orjson"), ["import orjson"]);
        assert_eq!(candidates(&index, "six"), ["import six"]);
        // A namespace package is not offered; its subpackage is.
        assert_eq!(candidates(&index, "google"), Vec::<String>::new());
        assert_eq!(candidates(&index, "protobuf"), ["from google import protobuf"]);
    }

    #[test]
    fn leaves_out_private_and_test_modules_and_prefers_stubs() {
        let dir = site_packages();
        let index = scan(&[dir.path().to_path_buf()]);
        for hidden in ["_private", "Hidden", "_cffi_backend", "_private_module", "tests", "only_in_source", "untyped"] {
            assert_eq!(candidates(&index, hidden), Vec::<String>::new(), "{hidden}");
        }
        assert_eq!(candidates(&index, "ndarray"), ["from numpy import ndarray"]);
        assert_eq!(candidates(&index, "get"), ["from requests import get"]);
    }

    #[test]
    fn an_earlier_folder_shadows_a_package_of_a_later_one() {
        let (first, second) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        write(first.path(), "pkg/__init__.py", "def new(): pass\n");
        write(second.path(), "pkg/__init__.py", "def old(): pass\n");
        write(second.path(), "other.py", "def thing(): pass\n");
        let index = scan(&[first.path().to_path_buf(), second.path().to_path_buf()]);
        assert_eq!(candidates(&index, "new"), ["from pkg import new"]);
        assert_eq!(candidates(&index, "old"), Vec::<String>::new());
        assert_eq!(candidates(&index, "thing"), ["from other import thing"]);
    }

    #[test]
    fn a_cancelled_scan_has_no_result() {
        let dir = site_packages();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(PythonLibraryIndex::scan(&[dir.path().to_path_buf()], &Syntax::new(), &cancel).is_none());
    }

    #[test]
    fn builds_are_shared_and_redone_when_a_folder_changes() {
        let dir = site_packages();
        let roots = vec![dir.path().to_path_buf()];
        let (libraries, syntax, cancel) =
            (PythonLibraries::default(), Arc::new(Syntax::new()), CancellationToken::new());
        let first = libraries.index(&roots, &syntax, &cancel).unwrap();
        assert!(Arc::ptr_eq(&first, &libraries.index(&roots, &syntax, &cancel).unwrap()));
        assert!(first.candidates("installed_later").is_empty());

        // `pip install`: a new top-level entry changes the folder's modification time.
        std::thread::sleep(Duration::from_millis(20));
        write(dir.path(), "newpkg/__init__.py", "def installed_later(): pass\n");
        let file = fs::File::open(dir.path()).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(5)).ok();
        let second = libraries.index(&roots, &syntax, &cancel).unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        assert_eq!(candidates(&second, "installed_later"), ["from newpkg import installed_later"]);
    }

    #[test]
    fn a_cancelled_request_stops_waiting() {
        let dir = site_packages();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let libraries = PythonLibraries::default();
        // Either the build finished first or the request gave up; it never blocks.
        let _ = libraries.index(&[dir.path().to_path_buf()], &Arc::new(Syntax::new()), &cancel);
        assert!(libraries.index(&[], &Arc::new(Syntax::new()), &cancel).is_some());
    }
}
