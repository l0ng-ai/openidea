//! `.py` ↔ `.pyi` pairing for the stub gutter markers and Navigate › Stub / Implementation:
//! which file holds a module's stub (or implementation), and which declarations match.

use ide_core::{OutlineItem, Range, SymbolKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A declaration of the document and its counterpart in the other file.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StubLink {
    /// Qualified name, `Class.method`.
    pub name: String,
    /// The declaration's identifier in the document.
    pub range: Range,
    /// The declaration's whole extent in the document.
    pub extent: Range,
    /// The counterpart's identifier in `PythonStubLinks::counterpart`.
    pub target: Range,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PythonStubLinks {
    /// The stub of a `.py` document, the implementation of a `.pyi` one.
    pub counterpart: Option<ide_core::IpcPath>,
    pub links: Vec<StubLink>,
    /// Every place the counterpart was looked for: a change to one of them may change the answer.
    pub candidates: Vec<ide_core::IpcPath>,
}

/// The stub folder basedpyright reads: `stubPath` from `pyrightconfig.json` or the
/// `[tool.basedpyright]` / `[tool.pyright]` table of `pyproject.toml`, else `typings`.
pub(crate) fn stub_path(root: &Path) -> PathBuf {
    let json = || {
        let text = std::fs::read_to_string(root.join("pyrightconfig.json")).ok()?;
        serde_json::from_str::<serde_json::Value>(&text).ok()?.get("stubPath")?.as_str().map(str::to_owned)
    };
    let toml = || {
        let text = std::fs::read_to_string(root.join("pyproject.toml")).ok()?;
        let tool = text.parse::<toml::Table>().ok()?.remove("tool")?;
        ["basedpyright", "pyright"].iter().find_map(|t| tool.get(t)?.get("stubPath")?.as_str().map(str::to_owned))
    };
    root.join(json().or_else(toml).unwrap_or_else(|| "typings".to_owned()))
}

/// The `site-packages` folders of a virtualenv (`lib/python3.x/site-packages`, `Lib/site-packages`).
pub(crate) fn site_packages(venv: &Path) -> Vec<PathBuf> {
    let mut out = vec![venv.join("Lib").join("site-packages")];
    if let Ok(entries) = std::fs::read_dir(venv.join("lib")) {
        out.extend(entries.flatten().map(|e| e.path().join("site-packages")));
    }
    out.retain(|p| p.is_dir());
    out
}

/// The dotted module of a Python file, from the innermost `search` folder holding it
/// (`src/a/b.py` → `a.b`, `site-packages/a/__init__.py` → `a`).
pub(crate) fn module_name(path: &Path, search: &[PathBuf]) -> Option<String> {
    let base = search.iter().filter(|b| path.starts_with(b)).max_by_key(|b| b.components().count())?;
    let rel = path.strip_prefix(base).ok()?.with_extension("");
    let rel = if rel.file_name()? == "__init__" { rel.parent()?.to_path_buf() } else { rel };
    let parts: Vec<&str> = rel.iter().map(|c| c.to_str()).collect::<Option<_>>()?;
    let valid = |s: &str| {
        s.chars().next().is_some_and(|c| !c.is_ascii_digit()) && s.chars().all(|c| c == '_' || c.is_alphanumeric())
    };
    (!parts.is_empty() && parts.iter().all(|p| valid(p))).then(|| parts.join("."))
}

/// Where the counterpart of `path` may be, nearest first: beside it, in a PEP 561
/// `<package>-stubs` folder beside its package (or `<module>-stubs/__init__.pyi` for a
/// single module), and in the `stubs` folder, which mirrors module paths (`module` names a
/// `.py` file's module, `search` lists the folders modules are found in).
pub(crate) fn counterpart_candidates(
    path: &Path,
    stubs: &Path,
    module: Option<&str>,
    search: &[PathBuf],
) -> Vec<PathBuf> {
    let stub = match path.extension().and_then(|e| e.to_str()) {
        Some("pyi") => true,
        Some("py") => false,
        _ => return Vec::new(),
    };
    let other = if stub { "py" } else { "pyi" };
    let mut out = vec![path.with_extension(other)];
    // `a/pkg-stubs/m.pyi` ↔ `a/pkg/m.py`.
    for dir in path.ancestors().skip(1) {
        let (Some(parent), Some(name)) = (dir.parent(), dir.file_name().and_then(|n| n.to_str())) else { break };
        let renamed = match (stub, name.strip_suffix("-stubs")) {
            (true, Some(package)) => package.to_owned(),
            (false, None) => format!("{name}-stubs"),
            _ => continue,
        };
        if let Ok(rest) = path.strip_prefix(dir) {
            out.push(parent.join(renamed).join(rest).with_extension(other));
        }
    }
    // `a/six.py` ↔ `a/six-stubs/__init__.pyi`.
    if let (Some(dir), Some(name)) = (path.parent(), path.file_stem().and_then(|n| n.to_str())) {
        if !stub {
            out.push(dir.join(format!("{name}-stubs")).join("__init__.pyi"));
        } else if let (true, Some(package), Some(parent)) = (
            name == "__init__",
            dir.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix("-stubs")),
            dir.parent(),
        ) {
            out.push(parent.join(package).with_extension("py"));
        }
    }
    // `typings/a/b.pyi` ↔ the module `a.b`: `a/b.py` or `a/b/__init__.py` in a search folder.
    let modules = |rel: &Path, base: &Path, ext: &str| {
        [base.join(rel).with_extension(ext), base.join(rel).join("__init__").with_extension(ext)]
    };
    let module = if stub { module_name(path, &[stubs.to_path_buf()]) } else { module.map(str::to_owned) };
    if let Some(module) = module {
        let rel: PathBuf = module.split('.').collect();
        if stub {
            out.extend(search.iter().flat_map(|base| modules(&rel, base, "py")));
        } else {
            out.extend(modules(&rel, stubs, "pyi"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| p != path && seen.insert(p.clone()));
    out
}

/// The declarations of `doc` (functions and classes, recursing into classes) whose
/// qualified name `other` declares too; an overloaded name targets its first declaration.
pub(crate) fn match_declarations(doc: &[OutlineItem], other: &[OutlineItem]) -> Vec<StubLink> {
    let mut targets: HashMap<String, Range> = HashMap::new();
    walk(other, "", &mut |name, item| {
        targets.entry(name).or_insert(item.selection_range);
    });
    let mut links = Vec::new();
    walk(doc, "", &mut |name, item| {
        if let Some(target) = targets.get(&name) {
            links.push(StubLink { name, range: item.selection_range, extent: item.range, target: *target });
        }
    });
    links
}

fn walk(items: &[OutlineItem], prefix: &str, f: &mut impl FnMut(String, &OutlineItem)) {
    for item in items {
        let class = item.kind == SymbolKind::Class;
        if !class && !matches!(item.kind, SymbolKind::Function | SymbolKind::Method | SymbolKind::Constructor) {
            continue;
        }
        let name = if prefix.is_empty() { item.name.clone() } else { format!("{prefix}.{}", item.name) };
        f(name.clone(), item);
        if class {
            walk(&item.children, &name, f);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::LanguageId;
    use ide_language::Syntax;

    fn outline(text: &str) -> Vec<OutlineItem> {
        Syntax::new().outline(&LanguageId::new("python"), text)
    }

    #[test]
    fn candidates_cover_siblings_stub_packages_and_typings() {
        let typings = Path::new("/p/typings");
        let site = PathBuf::from("/p/.venv/lib/python3.12/site-packages");
        let search = [PathBuf::from("/p"), PathBuf::from("/p/src"), site.clone()];
        let module = |p: &str| module_name(Path::new(p), &search);
        assert_eq!(module("/p/src/pkg/m.py").as_deref(), Some("pkg.m"));
        assert_eq!(module("/p/.venv/lib/python3.12/site-packages/requests/__init__.py").as_deref(), Some("requests"));
        assert_eq!(module("/elsewhere/x.py"), None);

        let py = counterpart_candidates(Path::new("/p/src/pkg/m.py"), typings, Some("pkg.m"), &search);
        assert_eq!(py[0], Path::new("/p/src/pkg/m.pyi"));
        assert!(py.contains(&PathBuf::from("/p/src/pkg-stubs/m.pyi")));
        assert!(py.contains(&PathBuf::from("/p/src/pkg/m-stubs/__init__.pyi")));
        assert!(py.contains(&PathBuf::from("/p/typings/pkg/m.pyi")));
        assert!(py.contains(&PathBuf::from("/p/typings/pkg/m/__init__.pyi")));

        let stub = counterpart_candidates(Path::new("/lib/pkg-stubs/sub/m.pyi"), typings, None, &search);
        assert_eq!(stub[0], Path::new("/lib/pkg-stubs/sub/m.py"));
        assert!(stub.contains(&PathBuf::from("/lib/pkg/sub/m.py")));
        assert!(!stub.iter().any(|p| p.to_string_lossy().contains("-stubs-stubs")));

        // PEP 561 stubs of a single module: `six-stubs/__init__.pyi` ↔ `six.py`.
        let six = counterpart_candidates(&site.join("six-stubs/__init__.pyi"), typings, None, &search);
        assert!(six.contains(&site.join("six.py")));

        // `typings/` stubs of an installed package resolve into site-packages.
        let typed = counterpart_candidates(Path::new("/p/typings/requests/api.pyi"), typings, None, &search);
        assert!(typed.contains(&site.join("requests/api.py")));
        let installed = site.join("requests/api.py");
        let back = counterpart_candidates(&installed, typings, module_name(&installed, &search).as_deref(), &search);
        assert!(back.contains(&PathBuf::from("/p/typings/requests/api.pyi")));

        let package = counterpart_candidates(Path::new("/p/typings/pkg/__init__.pyi"), typings, None, &search);
        assert!(package.contains(&PathBuf::from("/p/src/pkg.py")));
        assert!(package.contains(&PathBuf::from("/p/src/pkg/__init__.py")));

        assert!(counterpart_candidates(Path::new("/p/a.txt"), typings, None, &search).is_empty());
    }

    #[test]
    fn stub_path_follows_the_pyright_settings() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(stub_path(dir.path()), dir.path().join("typings"));
        std::fs::write(dir.path().join("pyproject.toml"), "[tool.basedpyright]\nstubPath = \"stubs\"\n").unwrap();
        assert_eq!(stub_path(dir.path()), dir.path().join("stubs"));
        std::fs::write(dir.path().join("pyrightconfig.json"), r#"{"stubPath": "types"}"#).unwrap();
        assert_eq!(stub_path(dir.path()), dir.path().join("types"));
    }

    #[test]
    fn declarations_match_by_qualified_name() {
        let py = "def f(a):\n    def inner(): pass\n    return a\n\nclass C:\n    def __init__(self): pass\n    def m(self): pass\n    def extra(self): pass\n\ndef g(): pass\nX = 1\n";
        let pyi = "from typing import overload\n@overload\ndef f(a: int) -> int: ...\n@overload\ndef f(a: str) -> str: ...\nclass C:\n    def __init__(self) -> None: ...\n    def m(self) -> None: ...\ndef inner() -> None: ...\nX: int\n";
        let links = match_declarations(&outline(py), &outline(pyi));
        let names: Vec<(&str, u32, u32)> =
            links.iter().map(|l| (l.name.as_str(), l.range.start.line, l.target.start.line)).collect();
        assert_eq!(names, [("f", 0, 2), ("C", 4, 5), ("C.__init__", 5, 6), ("C.m", 6, 7)]);
    }
}
