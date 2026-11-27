//! Web framework routes, source side: the project's files that could declare a route
//! (Spring's Java and Kotlin, Flask's and FastAPI's Python), with their text. The UI owns
//! the parsers and the index they feed, so this side stays a cheap scan.

use crate::Host;
use ide_core::IdeResult;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Files handed out at most, and bytes in total: a project's controllers fit well
/// inside these, and the UI indexes them once.
const MAX_FILES: usize = 1024;
const MAX_BYTES: usize = 48 << 20;
/// A single source bigger than this is not a controller.
const MAX_FILE_BYTES: u64 = 4 << 20;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RouteSource {
    pub path: ide_core::IpcPath,
    pub text: String,
}

/// Which files a framework's routes can live in, and words one of which such a file names.
#[derive(Clone, Copy)]
pub(crate) struct RouteFiles {
    extensions: &'static [&'static str],
    words: &'static [&'static str],
}

/// Spring mappings: Java and Kotlin sources that name a mapping annotation.
pub(crate) const SPRING: RouteFiles = RouteFiles { extensions: &["java", "kt", "kts"], words: &["Mapping"] };
/// Flask and FastAPI routes: Python sources that import either (blueprints, routers and the
/// modules registering them all do).
pub(crate) const PYTHON: RouteFiles = RouteFiles { extensions: &["py"], words: &["flask", "fastapi"] };

impl RouteFiles {
    fn declares_routes(&self, path: &Path) -> bool {
        path.extension().and_then(|e| e.to_str()).is_some_and(|e| self.extensions.contains(&e))
            // Installed packages (a virtualenv the ignore rules don't cover) declare their own examples.
            && !path.components().any(|c| c.as_os_str() == "site-packages")
    }
}

/// Files under `root` whose text names a route: `ignore` rules and `excludes`
/// decide what counts, and the UI ranks the matches itself.
pub(crate) fn sources_in(root: &Path, excludes: &[String], kind: RouteFiles) -> Vec<RouteSource> {
    let found: Mutex<Vec<RouteSource>> = Mutex::new(Vec::new());
    let bytes = AtomicUsize::new(0);
    ide_vfs::walk_files(root, excludes, |path| {
        if !kind.declares_routes(path) || bytes.load(Ordering::Relaxed) >= MAX_BYTES {
            return;
        }
        if std::fs::metadata(path).map_or(true, |m| m.len() > MAX_FILE_BYTES) {
            return;
        }
        let Ok(text) = std::fs::read_to_string(path) else { return };
        // Only a file that names a mapping annotation (or imports the framework) is worth parsing.
        if !kind.words.iter().any(|w| text.contains(w)) {
            return;
        }
        let Ok(mut found) = found.lock() else { return };
        if found.len() >= MAX_FILES {
            return;
        }
        bytes.fetch_add(text.len(), Ordering::Relaxed);
        found.push(RouteSource { path: path.to_path_buf().into(), text });
    });
    let mut files = found.into_inner().unwrap_or_default();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

/// The folders to scan: the project folder itself first, then content roots outside it
/// (`content_roots` lists only the ones outside, so the project folder is never implied —
/// forgetting it scans nothing).
fn scan_roots(root: &Path, content_roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut roots = vec![root.to_path_buf()];
    roots.extend(content_roots);
    roots
}

/// Every mapping source of the project, for the request-path index. Walks the whole tree,
/// so it runs on the blocking pool.
pub async fn spring_route_sources(host: &Host, window: &str) -> IdeResult<Vec<RouteSource>> {
    route_sources(host, window, SPRING, "spring").await
}

/// Every Flask / FastAPI source of the project, for the request-path index.
pub async fn python_route_sources(host: &Host, window: &str) -> IdeResult<Vec<RouteSource>> {
    route_sources(host, window, PYTHON, "python").await
}

async fn route_sources(
    host: &Host,
    window: &str,
    kind: RouteFiles,
    label: &'static str,
) -> IdeResult<Vec<RouteSource>> {
    let project = host.project(window)?;
    host.blocking(move || {
        let mut out = Vec::new();
        for root in scan_roots(&project.root, project.content_roots()) {
            out.extend(sources_in(&root, &project.search_excludes_in(&root), kind));
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out.dedup_by(|a, b| a.path == b.path);
        match out.len() {
            0 => tracing::debug!("{label} routes: no route source under {:?}", project.root),
            n => tracing::info!("{label} routes: {n} route sources under {:?}", project.root),
        }
        Ok(out)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_project_folder_is_scanned_even_without_other_content_roots() {
        let root = Path::new("/p/demo");
        assert_eq!(scan_roots(root, Vec::new()), [PathBuf::from("/p/demo")]);
        assert_eq!(
            scan_roots(root, vec![PathBuf::from("/p/elsewhere")]),
            [PathBuf::from("/p/demo"), PathBuf::from("/p/elsewhere")]
        );
    }

    #[test]
    fn only_java_and_kotlin_sources_are_read() {
        for (name, expected) in
            [("A.java", true), ("B.kt", true), ("C.kts", true), ("D.txt", false), ("pom.xml", false), ("noext", false)]
        {
            assert_eq!(SPRING.declares_routes(Path::new(name)), expected, "{name}");
        }
    }

    #[test]
    fn python_sources_that_import_flask_or_fastapi_are_read_outside_installed_packages() {
        let tmp = tempfile::tempdir().unwrap();
        let write = |rel: &str, text: &str| {
            let path = tmp.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write("app.py", "from flask import Flask\n");
        write("api/routers/items.py", "from fastapi import APIRouter\n");
        write("util.py", "import os\n");
        write("venv/lib/python3.12/site-packages/flask/app.py", "import flask\n");
        let files = sources_in(tmp.path(), &[], PYTHON);
        assert_eq!(files.len(), 2, "{:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>());
        assert!(files[0].path.ends_with("api/routers/items.py"), "{:?}", files[0].path);
        assert!(files[1].path.ends_with("app.py"), "{:?}", files[1].path);
    }

    #[test]
    fn files_that_name_no_mapping_are_left_out() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/Ctl.java"), "class Ctl { @GetMapping(\"/a\") void a() {} }").unwrap();
        std::fs::write(tmp.path().join("src/Plain.java"), "class Plain { void a() {} }").unwrap();
        std::fs::write(tmp.path().join("src/Notes.txt"), "@GetMapping(\"/a\")").unwrap();
        let files = sources_in(tmp.path(), &[], SPRING);
        assert_eq!(files.len(), 1, "{:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>());
        assert!(files[0].path.ends_with("src/Ctl.java"), "{:?}", files[0].path);
        assert!(files[0].text.contains("@GetMapping"));
    }

    #[test]
    fn excluded_folders_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("module/src")).unwrap();
        std::fs::create_dir_all(tmp.path().join("build")).unwrap();
        std::fs::write(tmp.path().join("module/src/A.java"), "@RequestMapping(\"/a\")").unwrap();
        std::fs::write(tmp.path().join("build/B.java"), "@RequestMapping(\"/b\")").unwrap();
        let files = sources_in(tmp.path(), &["build/**".to_owned()], SPRING);
        assert_eq!(files.len(), 1, "{:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>());
        assert!(files[0].path.ends_with("module/src/A.java"), "{:?}", files[0].path);
    }
}
