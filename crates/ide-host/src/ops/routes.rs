//! Routes for Search Everywhere's Routes scope.
//!
//! - Spring Web mappings, source side: the project's Java and Kotlin files that could
//!   declare a route, with their text. The UI owns the annotation parser and the index
//!   it feeds, so this side stays a cheap scan.
//! - Laravel routes: the native PHP engine's route table ([`php_laravel_routes`]).

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
    pub path: String,
    pub text: String,
}

/// The files Spring mappings can live in: Java and Kotlin sources.
fn declares_mappings(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()), Some("java" | "kt" | "kts"))
}

/// Files under `root` whose text names a mapping: `ignore` rules and `excludes`
/// decide what counts, and the UI ranks the matches itself.
pub(crate) fn sources_in(root: &Path, excludes: &[String]) -> Vec<RouteSource> {
    let found: Mutex<Vec<RouteSource>> = Mutex::new(Vec::new());
    let bytes = AtomicUsize::new(0);
    ide_vfs::walk_files(root, excludes, |path| {
        if !declares_mappings(path) || bytes.load(Ordering::Relaxed) >= MAX_BYTES {
            return;
        }
        if std::fs::metadata(path).map_or(true, |m| m.len() > MAX_FILE_BYTES) {
            return;
        }
        let Ok(text) = std::fs::read_to_string(path) else { return };
        // Only a file that names a mapping annotation is worth parsing.
        if !text.contains("Mapping") {
            return;
        }
        let Ok(mut found) = found.lock() else { return };
        if found.len() >= MAX_FILES {
            return;
        }
        bytes.fetch_add(text.len(), Ordering::Relaxed);
        found.push(RouteSource { path: path.to_string_lossy().into_owned(), text });
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

/// Every mapping source of the project, for the request-path index.
pub fn spring_route_sources(host: &Host, window: &str) -> IdeResult<Vec<RouteSource>> {
    let project = host.project(window)?;
    let excludes = project.search_excludes();
    let mut out = Vec::new();
    for root in scan_roots(&project.root, project.content_roots()) {
        out.extend(sources_in(&root, &excludes));
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    match out.len() {
        0 => tracing::warn!("spring routes: no mapping source under {:?} (excludes: {})", project.root, excludes.len()),
        n => tracing::info!("spring routes: {n} mapping sources under {:?}", project.root),
    }
    Ok(out)
}

/// A Laravel route, as the native PHP engine reads it from the route files
/// (`ide_php::frameworks::laravel::RouteInfo`).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LaravelRoute {
    /// The full name (`dashboard.posts.create`).
    pub name: Option<String>,
    /// `GET`, `PUT|PATCH`… (`HEAD` left out next to `GET`).
    pub methods: Vec<String>,
    /// The full URI with a leading `/`.
    pub uri: String,
    /// `App\Http\Controllers\PostController@show`, `view about`, `Closure`…
    pub action: String,
    pub middleware: Vec<String>,
    /// The route file, and the registering method's name in it.
    pub path: ide_core::IpcPath,
    pub range: ide_core::Range,
    /// `APP_URL` and the URI.
    pub url: String,
    /// The route as an HTTP client request (`.http`).
    pub request: String,
}

impl From<ide_php::frameworks::laravel::RouteInfo> for LaravelRoute {
    fn from(route: ide_php::frameworks::laravel::RouteInfo) -> Self {
        Self {
            name: route.name,
            methods: route.methods,
            uri: route.uri,
            action: route.action,
            middleware: route.middleware,
            path: route.path.into(),
            range: route.range,
            url: route.url,
            request: route.request,
        }
    }
}

/// The routes of the project's Laravel application matching every term of
/// `query` (name, URI, method or action parts; empty: all), in file order.
/// Empty while the native PHP engine isn't running or the project isn't a
/// Laravel application.
pub async fn php_laravel_routes(host: &Host, window: &str, query: String) -> IdeResult<Vec<LaravelRoute>> {
    let project = host.project(window)?;
    let Some(engine) = project.php.engine() else { return Ok(Vec::new()) };
    host.blocking(move || {
        Ok(engine.laravel_route_list(&query).unwrap_or_default().into_iter().map(LaravelRoute::from).collect())
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
            assert_eq!(declares_mappings(Path::new(name)), expected, "{name}");
        }
    }

    #[test]
    fn files_that_name_no_mapping_are_left_out() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/Ctl.java"), "class Ctl { @GetMapping(\"/a\") void a() {} }").unwrap();
        std::fs::write(tmp.path().join("src/Plain.java"), "class Plain { void a() {} }").unwrap();
        std::fs::write(tmp.path().join("src/Notes.txt"), "@GetMapping(\"/a\")").unwrap();
        let files = sources_in(tmp.path(), &[]);
        assert_eq!(files.len(), 1, "{:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>());
        assert!(Path::new(&files[0].path).ends_with("src/Ctl.java"), "{}", files[0].path);
        assert!(files[0].text.contains("@GetMapping"));
    }

    #[test]
    fn excluded_folders_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("module/src")).unwrap();
        std::fs::create_dir_all(tmp.path().join("build")).unwrap();
        std::fs::write(tmp.path().join("module/src/A.java"), "@RequestMapping(\"/a\")").unwrap();
        std::fs::write(tmp.path().join("build/B.java"), "@RequestMapping(\"/b\")").unwrap();
        let files = sources_in(tmp.path(), &["build/**".to_owned()]);
        assert_eq!(files.len(), 1, "{:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>());
        assert!(Path::new(&files[0].path).ends_with("module/src/A.java"), "{}", files[0].path);
    }
}
