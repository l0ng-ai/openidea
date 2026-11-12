//! Root markers: files whose presence in a directory marks a tool's or a
//! framework's project there (`Cargo.toml`, `angular.json`). Language server
//! roots (`root-markers`) and framework modes (`framework-ui-modes`) share them.

use std::path::{Path, PathBuf};

/// The outermost ancestor of `file` containing a root marker, within
/// `project_root` (any ancestor without one: loose files). A directory counts
/// as its own ancestor: a module folder is served like the files in it.
pub fn marked_root(project_root: Option<&Path>, file: &Path, markers: &[String]) -> Option<PathBuf> {
    let mut best = None;
    for dir in file.ancestors().skip(usize::from(!file.is_dir())) {
        if project_root.is_some_and(|root| !dir.starts_with(root)) {
            break;
        }
        if markers.iter().any(|m| has_marker(dir, m)) {
            best = Some(dir.to_path_buf());
        }
    }
    best
}

/// `dir` contains at least one `.ino` regular file.
pub fn is_arduino_sketch_dir(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            entry.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("ino"))
                && entry.file_type().is_ok_and(|kind| kind.is_file())
        })
    })
}

/// Nearest enclosing directory of `path` (including `path` when it is already a
/// directory) within `project` that contains a `.ino` file.
pub fn arduino_sketch_root(project: &Path, path: &Path) -> Option<PathBuf> {
    let start = usize::from(!path.is_dir());
    path.ancestors()
        .skip(start)
        .take_while(|dir| dir.starts_with(project))
        .find(|dir| is_arduino_sketch_dir(dir))
        .map(Path::to_path_buf)
}

/// `dir` contains `marker`: a relative path, a file name pattern with one
/// `*` (`*.csproj`), or a TOML or JSON file name (no pattern) and a dotted table
/// it must contain (`pyproject.toml#tool.ruff`, `package.json#eslintConfig`).
fn has_marker(dir: &Path, marker: &str) -> bool {
    if let Some((file, table)) = marker.split_once('#') {
        return if file.ends_with(".json") {
            has_json_object(&dir.join(file), table)
        } else {
            has_toml_table(&dir.join(file), table)
        };
    }
    let Some((prefix, suffix)) = marker.split_once('*') else {
        return dir.join(marker).exists();
    };
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|e| matches_pattern(&e.file_name().to_string_lossy(), prefix, suffix))
    })
}

/// `file` parses as TOML and has the dotted `table` (`tool.ruff`).
fn has_toml_table(file: &Path, table: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else { return false };
    let value = match toml::from_str::<toml::Value>(&text) {
        Ok(value) => value,
        Err(e) => {
            tracing::debug!("root marker {}: {e}", file.display());
            return false;
        }
    };
    table.split('.').try_fold(&value, |v, key| v.get(key)).is_some_and(toml::Value::is_table)
}

/// `file` parses as JSON and has the dotted object `key` (`eslintConfig`).
fn has_json_object(file: &Path, key: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else { return false };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    key.split('.').try_fold(&value, |v, key| v.get(key)).is_some_and(serde_json::Value::is_object)
}

/// `path` is (or, after its creation or removal, was) a root marker of the
/// directory above it.
pub(crate) fn is_marker_path(path: &Path, marker: &str) -> bool {
    let marker = marker.split_once('#').map_or(marker, |(file, _)| file);
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
    fn a_marked_directory_is_its_own_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let module = root.join("first");
        std::fs::create_dir_all(module.join("src")).unwrap();
        std::fs::write(module.join("pom.xml"), "").unwrap();
        let markers = vec!["pom.xml".to_string()];
        assert_eq!(marked_root(Some(root), &module.join("src/Main.java"), &markers), Some(module.clone()));
        assert_eq!(marked_root(Some(root), &module, &markers), Some(module.clone()));
        assert_eq!(marked_root(Some(root), &module.join("src"), &markers), Some(module));
        assert_eq!(marked_root(Some(root), &root.join("second"), &markers), None);
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
    fn toml_markers_need_their_table() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let file = root.join("svc/app/main.py");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let markers = vec!["ruff.toml".to_string(), "pyproject.toml#tool.ruff".to_string()];
        std::fs::write(root.join("pyproject.toml"), "[project]\nname = \"x\"\n[tool.black]\n").unwrap();
        assert_eq!(marked_root(Some(root), &file, &markers), None);
        std::fs::write(root.join("svc/pyproject.toml"), "[tool.ruff.lint]\nselect = [\"E\"]\n").unwrap();
        assert_eq!(marked_root(Some(root), &file, &markers), Some(root.join("svc")));
        // Outermost wins: an inline table counts; a value that is no table, or a
        // file that does not parse, does not.
        std::fs::write(root.join("pyproject.toml"), "tool = { ruff = { line-length = 100 } }\n").unwrap();
        assert_eq!(marked_root(Some(root), &file, &markers), Some(root.to_path_buf()));
        std::fs::write(root.join("pyproject.toml"), "tool = { ruff = 1 }\n").unwrap();
        assert_eq!(marked_root(Some(root), &file, &markers), Some(root.join("svc")));
        std::fs::write(root.join("pyproject.toml"), "[tool.ruff]\n[broken").unwrap();
        assert_eq!(marked_root(Some(root), &file, &markers), Some(root.join("svc")));
        assert!(is_marker_path(&root.join("svc/pyproject.toml"), "pyproject.toml#tool.ruff"));
        assert!(!is_marker_path(&root.join("svc/setup.cfg"), "pyproject.toml#tool.ruff"));
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
