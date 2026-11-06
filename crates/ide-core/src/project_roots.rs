//! Shared filesystem rules for discovering builds and resolving their owners.

use std::path::{Component, Path, PathBuf};

pub const SEARCH_DEPTH: usize = 3;

pub fn children(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut dirs: Vec<_> = entries
        .flatten()
        .filter(|entry| {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                return false;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.')
                && !matches!(
                    name.as_ref(),
                    "node_modules" | "target" | "build" | "dist" | "vendor" | "out" | "bin" | "obj" | "venv"
                )
        })
        .map(|entry| entry.path())
        .collect();
    dirs.sort();
    dirs
}

pub fn discover(root: &Path, markers: &[&str]) -> Vec<PathBuf> {
    discover_matching(root, SEARCH_DEPTH, true, |dir| markers.iter().any(|marker| dir.join(marker).is_file()))
}

pub fn discover_matching(
    root: &Path,
    max_depth: usize,
    stop_at_match: bool,
    marked: impl Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = pending.pop() {
        if marked(&dir) {
            found.push(dir.clone());
            if stop_at_match {
                continue;
            }
        }
        // A source folder may itself be a build root (e.g. src/pom.xml), but
        // source trees without their own build marker are never searched.
        let source = dir.join("src");
        if source.is_dir() && !source.is_symlink() && marked(&source) {
            found.push(source);
        }
        if depth < max_depth {
            pending.extend(
                children(&dir)
                    .into_iter()
                    .rev()
                    .filter(|child| !child.ends_with("src"))
                    .map(|child| (child, depth + 1)),
            );
        }
    }
    found.sort();
    found.dedup();
    found
}

/// The closest package manager declaration or lockfile, shared by build and run.
/*
pub fn package_manager(root: &Path) -> &'static str {
    for dir in root.ancestors() {
        let package = std::fs::read(dir.join("package.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if let Some(pm) = package.as_ref().and_then(|p| p.get("packageManager")).and_then(|p| p.as_str()) {
            match pm.split('@').next().unwrap_or_default() {
                "pnpm" => return "pnpm",
                "yarn" => return "yarn",
                "bun" => return "bun",
                "npm" => return "npm",
                _ => {}
            }
        }
        for (marker, pm) in [
            ("pnpm-lock.yaml", "pnpm"),
            ("yarn.lock", "yarn"),
            ("bun.lock", "bun"),
            ("bun.lockb", "bun"),
            ("package-lock.json", "npm"),
        ] {
            if dir.join(marker).is_file() {
                return pm;
            }
        }
    }
    "npm"
}
*/

pub fn package_manager(root: &Path) -> &'static str {
    for dir in root.ancestors() {
        let package = std::fs::read(dir.join("package.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if let Some(pm) = package.as_ref().and_then(|p| p.get("packageManager")).and_then(|p| p.as_str()) {
            match pm.split('@').next().unwrap_or_default() {
                "pnpm" => return "pnpm",
                "yarn" => return "yarn",
                "bun" => return "bun",
                "npm" => return "npm",
                _ => {}
            }
        }
        
        // Check if any script uses 'bun' command (bun project indicator)
        if let Some(scripts) = package.as_ref().and_then(|p| p.get("scripts")).and_then(|s| s.as_object()) {
            if scripts.values().any(|v| v.as_str().map(|s| s.starts_with("bun ")).unwrap_or(false)) {
                return "bun";
            }
        }
        
        for (marker, pm) in [
            ("pnpm-lock.yaml", "pnpm"),
            ("yarn.lock", "yarn"),
            ("bun.lock", "bun"),
            ("bun.lockb", "bun"),
            ("package-lock.json", "npm"),
        ] {
            if dir.join(marker).is_file() {
                return pm;
            }
        }
    }
    "npm"
}


pub fn resolve(root: &Path, path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in root.join(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir if out.file_name().is_some() => {
                out.pop();
            }
            component => out.push(component),
        }
    }
    out
}

pub fn relative(root: &Path, path: &Path) -> PathBuf {
    let path = resolve(root, path);
    path.strip_prefix(resolve(root, Path::new(""))).unwrap_or(&path).to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_manager_declarations_are_shared_by_build_and_run() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("pnpm-lock.yaml"), "").unwrap();
        let child = temp.path().join("packages/web");
        std::fs::create_dir_all(&child).unwrap();
        assert_eq!(package_manager(&child), "pnpm");
        std::fs::write(child.join("package.json"), r#"{"packageManager":"yarn@4.0"}"#).unwrap();
        assert_eq!(package_manager(&child), "yarn");
    }

    #[test]
    fn discovery_has_one_depth_boundary_and_exclusion_policy_for_all_families() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let markers = [
            "package.json",
            "Cargo.toml",
            "go.mod",
            "pom.xml",
            "build.gradle.kts",
            "pyproject.toml",
            "composer.json",
            "Gemfile",
            "CMakeLists.txt",
            "project.godot",
            "deno.json",
            "Makefile",
            "justfile",
        ];
        for marker in markers {
            for dir in [
                "apps/one",
                "services/backend/two",
                "src",
                "a/b/c/src",
                "too/deep/to/find",
                "node_modules/ignored",
                "target/ignored",
                "build/ignored",
                "vendor/ignored",
                ".hidden",
                "src/ignored",
            ] {
                let path = root.join(dir).join(marker);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, "").unwrap();
            }
            assert_eq!(
                discover(root, &[marker]),
                ["a/b/c/src", "apps/one", "services/backend/two", "src"].map(|dir| root.join(dir))
            );
        }
        std::fs::write(root.join("Cargo.toml"), "").unwrap();
        assert_eq!(discover(root, &["Cargo.toml"]), [root]);
    }

    #[cfg(unix)]
    #[test]
    fn discovery_never_follows_directory_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("real")).unwrap();
        std::fs::write(temp.path().join("real/go.mod"), "").unwrap();
        std::os::unix::fs::symlink(temp.path().join("real"), temp.path().join("alias")).unwrap();
        assert_eq!(discover(temp.path(), &["go.mod"]), [temp.path().join("real")]);
    }

    #[test]
    fn paths_keep_component_boundaries_and_external_roots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        assert_eq!(relative(&root, &root.join("apps/../api")), Path::new("api"));
        assert_eq!(relative(&root, &temp.path().join("workspace-other")), temp.path().join("workspace-other"));
        assert_eq!(resolve(&root, Path::new("./api/../web")), root.join("web"));
    }
}
