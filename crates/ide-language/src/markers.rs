//! Root markers: files whose presence in a directory marks a tool's or a
//! framework's project there (`Cargo.toml`, `angular.json`). Language server
//! roots (`root-markers`) and framework modes (`framework-ui-modes`) share them.

use std::path::{Path, PathBuf};

/// The outermost ancestor of `file` containing a root marker, within
/// `project_root` (any ancestor without one: loose files).
pub fn marked_root(project_root: Option<&Path>, file: &Path, markers: &[String]) -> Option<PathBuf> {
    let mut best = None;
    for dir in file.ancestors().skip(1) {
        if project_root.is_some_and(|root| !dir.starts_with(root)) {
            break;
        }
        if markers.iter().any(|m| has_marker(dir, m)) {
            best = Some(dir.to_path_buf());
        }
    }
    best
}

/// `dir` contains `marker`: a relative path, or a file name pattern with one
/// `*` (`*.csproj`).
fn has_marker(dir: &Path, marker: &str) -> bool {
    let Some((prefix, suffix)) = marker.split_once('*') else {
        return dir.join(marker).exists();
    };
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|e| matches_pattern(&e.file_name().to_string_lossy(), prefix, suffix))
    })
}

/// `path` is (or, after its creation or removal, was) a root marker of the
/// directory above it.
pub(crate) fn is_marker_path(path: &Path, marker: &str) -> bool {
    match marker.split_once('*') {
        None => path.ends_with(marker),
        Some((prefix, suffix)) => {
            path.file_name().is_some_and(|name| matches_pattern(&name.to_string_lossy(), prefix, suffix))
        }
    }
}

fn matches_pattern(name: &str, prefix: &str, suffix: &str) -> bool {
    name.len() >= prefix.len() + suffix.len() && name.starts_with(prefix) && name.ends_with(suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marked_root_needs_a_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let file = root.join("apps/web/src/app.ts");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let markers = vec!["angular.json".to_string(), "node_modules/@angular/core".to_string()];
        assert_eq!(marked_root(Some(root), &file, &markers), None);
        std::fs::create_dir_all(root.join("apps/web/node_modules/@angular/core")).unwrap();
        assert_eq!(marked_root(Some(root), &file, &markers), Some(root.join("apps/web")));
        assert_eq!(marked_root(Some(root), &root.join("apps/api/main.ts"), &markers), None);
    }

    #[test]
    fn markers_above_the_project_root_only_count_without_one() {
        let tmp = tempfile::tempdir().unwrap();
        let (home, project) = (tmp.path(), tmp.path().join("work/site"));
        let file = project.join("src/index.html");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::create_dir_all(home.join("node_modules/@angular/core")).unwrap();
        let markers = vec!["node_modules/@angular/core".to_string()];
        assert_eq!(marked_root(Some(&project), &file, &markers), None);
        assert_eq!(marked_root(None, &file, &markers), Some(home.to_path_buf()));
    }

    #[test]
    fn patterns_match_file_names() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("App.csproj"), "").unwrap();
        assert!(has_marker(dir, "*.csproj") && has_marker(dir, "App.*") && !has_marker(dir, "*.fsproj"));
        assert!(is_marker_path(&dir.join("App.csproj"), "*.csproj"));
        assert!(is_marker_path(Path::new("/p/web/node_modules/@angular/core"), "node_modules/@angular/core"));
        assert!(is_marker_path(Path::new("/p/web/angular.json"), "angular.json"));
        assert!(!is_marker_path(Path::new("/p/web/angular.json.bak"), "angular.json"));
        assert!(!is_marker_path(Path::new("/p/core"), "node_modules/@angular/core"));
    }
}
