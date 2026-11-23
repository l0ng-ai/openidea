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
}

/// Where the counterpart of `path` may be, nearest first: beside it, in a PEP 561
/// `<package>-stubs` folder beside its package, and in the `typings` stub folder (`typings`
/// mirrors module paths; `module` names a `.py` file's module, `search` lists the folders
/// modules are found in).
pub(crate) fn counterpart_candidates(
    path: &Path,
    typings: &Path,
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
    // `typings/a/b.pyi` ↔ the module `a.b`: `a/b.py` or `a/b/__init__.py` in a search folder.
    let module_path = |rel: &Path| -> Option<PathBuf> {
        let rel = rel.with_extension("");
        let module = if rel.file_name()? == "__init__" { rel.parent()?.to_path_buf() } else { rel };
        (!module.as_os_str().is_empty()).then_some(module)
    };
    let modules = |rel: &Path, base: &Path, ext: &str| {
        [base.join(rel).with_extension(ext), base.join(rel).join("__init__").with_extension(ext)]
    };
    if stub {
        if let Some(rel) = path.strip_prefix(typings).ok().and_then(module_path) {
            out.extend(search.iter().flat_map(|base| modules(&rel, base, "py")));
        }
    } else if let Some(module) = module {
        let rel: PathBuf = module.split('.').collect();
        out.extend(modules(&rel, typings, "pyi"));
    }
    out.dedup();
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
        let search = [PathBuf::from("/p"), PathBuf::from("/p/src")];
        let py = counterpart_candidates(Path::new("/p/src/pkg/m.py"), typings, Some("pkg.m"), &search);
        assert_eq!(py[0], Path::new("/p/src/pkg/m.pyi"));
        assert!(py.contains(&PathBuf::from("/p/src/pkg-stubs/m.pyi")));
        assert!(py.contains(&PathBuf::from("/p/typings/pkg/m.pyi")));
        assert!(py.contains(&PathBuf::from("/p/typings/pkg/m/__init__.pyi")));

        let stub = counterpart_candidates(Path::new("/lib/pkg-stubs/sub/m.pyi"), typings, None, &search);
        assert_eq!(stub[0], Path::new("/lib/pkg-stubs/sub/m.py"));
        assert!(stub.contains(&PathBuf::from("/lib/pkg/sub/m.py")));
        assert!(!stub.iter().any(|p| p.to_string_lossy().contains("-stubs-stubs")));

        let typed = counterpart_candidates(Path::new("/p/typings/pkg/__init__.pyi"), typings, None, &search);
        assert!(typed.contains(&PathBuf::from("/p/src/pkg.py")));
        assert!(typed.contains(&PathBuf::from("/p/src/pkg/__init__.py")));

        assert!(counterpart_candidates(Path::new("/p/a.txt"), typings, None, &search).is_empty());
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
