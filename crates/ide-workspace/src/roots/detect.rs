//! Root detection from build files, per module directory (multi-module Maven /
//! Gradle builds, Cargo workspaces and monorepos are found by a bounded walk).

use super::{RootKind, SourceFolder, gradle, maven};
use std::collections::VecDeque;
use std::path::Path;

/// Module directories deeper than this below the project root are not looked at.
const MAX_DEPTH: usize = 6;
/// Upper bound on directories visited, so huge trees cost a few milliseconds at most.
const MAX_DIRS: usize = 4000;

const JVM_LANGS: &[&str] = &["java", "kotlin", "groovy", "scala"];
const GRADLE_FILES: &[&str] = &["build.gradle.kts", "build.gradle"];
const PYTHON_FILES: &[&str] = &["pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "requirements.txt"];
/// Never walked into while looking for modules (outputs, dependencies, VCS).
const SKIP_DIRS: &[&str] =
    &["node_modules", "target", "build", "dist", "out", "venv", "__pycache__", "vendor", "bower_components"];

/// Build files whose changes can change the detected roots.
const BUILD_FILES: &[&str] = &[
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "Pipfile",
    "requirements.txt",
    "package.json",
];

/// Folder names that are (or contain) conventional roots.
const ROOT_NAMES: &[&str] = &[
    "src",
    "main",
    "test",
    "tests",
    "__tests__",
    "java",
    "kotlin",
    "groovy",
    "scala",
    "resources",
    "benches",
    "examples",
    "target",
    "build",
    "node_modules",
    "dist",
    ".venv",
    "venv",
    "__pycache__",
    ".gradle",
];

/// Whether a created / changed / removed project-relative path can change the detected roots.
pub fn affects_roots(rel: &Path) -> bool {
    let mut names = rel.iter().rev().filter_map(|c| c.to_str());
    let Some(name) = names.next() else { return false };
    BUILD_FILES.contains(&name)
        || ROOT_NAMES.contains(&name)
        || matches!(name, "Assets" | "Packages" | "ProjectSettings" | "ProjectVersion.txt")
        || names.next() == Some("src")
}

/// Detects roots below `root`; paths in the result are unique and sorted.
pub fn detect(root: &Path) -> Vec<SourceFolder> {
    let mut out: Vec<SourceFolder> = Vec::new();
    let mut queue: VecDeque<(String, usize)> = VecDeque::from([(String::new(), 0)]);
    let mut visited = 0;
    while let Some((rel, depth)) = queue.pop_front() {
        visited += 1;
        if visited > MAX_DIRS {
            tracing::debug!("root detection stopped after {MAX_DIRS} directories");
            break;
        }
        let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(&rel) };
        if crate::unity::is_project(&dir) {
            for (name, kind) in
                [("Assets", RootKind::Source), ("Packages", RootKind::Source), ("ProjectSettings", RootKind::Resources)]
            {
                if dir.join(name).is_dir() {
                    out.push(SourceFolder {
                        path: join(&rel, name),
                        kind,
                        detected_from: Some(join(&rel, crate::unity::VERSION_FILE)),
                    });
                }
            }
            // Exclude before the index/watchers start, even if Unity creates its caches later.
            for name in crate::unity::GENERATED_DIRS {
                out.push(SourceFolder {
                    path: join(&rel, name),
                    kind: RootKind::Excluded,
                    detected_from: Some(join(&rel, crate::unity::VERSION_FILE)),
                });
            }
            // Assets and PackageCache may contain arbitrary build files; they aren't nested modules.
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<String> = Vec::new();
        let mut dirs: Vec<String> = Vec::new();
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            match e.file_type() {
                Ok(t) if t.is_dir() => dirs.push(name),
                Ok(t) if t.is_file() => files.push(name),
                _ => {}
            }
        }
        dirs.sort();
        let before = out.len();
        module_roots(root, &rel, &files, &mut out);
        if depth >= MAX_DEPTH {
            continue;
        }
        let found: Vec<String> = out[before..].iter().map(|r| r.path.clone()).collect();
        for name in dirs {
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let child = join(&rel, &name);
            // Roots are not searched for nested modules (`src/main/java` can be huge).
            if found.iter().any(|f| *f == child || f.is_empty() && name == "src") {
                continue;
            }
            queue.push_back((child, depth + 1));
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() { name.to_owned() } else { format!("{rel}/{name}") }
}

/// Roots of the module in `rel` (whose plain files are `files`), appended to `out`.
fn module_roots(root: &Path, rel: &str, files: &[String], out: &mut Vec<SourceFolder>) {
    let has = |f: &str| files.iter().any(|x| x == f);
    let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
    let mut add = |sub: &str, kind: RootKind, from: &str| {
        let path = if sub.is_empty() { rel.to_owned() } else { join(rel, sub) };
        if out.iter().any(|r| r.path == path) || !root.join(&path).is_dir() {
            return;
        }
        out.push(SourceFolder { path, kind, detected_from: Some(join(rel, from)) });
    };

    if has("pom.xml") {
        for lang in JVM_LANGS {
            add(&format!("src/main/{lang}"), RootKind::Source, "pom.xml");
            add(&format!("src/test/{lang}"), RootKind::Test, "pom.xml");
        }
        add("src/main/resources", RootKind::Resources, "pom.xml");
        add("src/test/resources", RootKind::TestResources, "pom.xml");
        if let Ok(text) = std::fs::read_to_string(dir.join("pom.xml")) {
            for (sub, kind) in maven::extra_roots(&text) {
                add(&sub, kind, "pom.xml");
            }
        }
        add("target", RootKind::Excluded, "pom.xml");
    }

    if let Some(file) = GRADLE_FILES.iter().find(|f| has(f)) {
        for (set, sub) in source_sets(&dir) {
            let test = gradle::is_test_set(&set);
            let kind = |lang: &str| match (lang == "resources", test) {
                (true, true) => RootKind::TestResources,
                (true, false) => RootKind::Resources,
                (false, true) => RootKind::Test,
                (false, false) => RootKind::Source,
            };
            add(&format!("src/{set}/{sub}"), kind(&sub), file);
        }
        if let Ok(text) = std::fs::read_to_string(dir.join(file)) {
            for (sub, kind) in gradle::extra_roots(&text) {
                add(&sub, kind, file);
            }
        }
        add("build", RootKind::Excluded, file);
        add(".gradle", RootKind::Excluded, file);
    }

    if has("Cargo.toml") {
        add("src", RootKind::Source, "Cargo.toml");
        add("examples", RootKind::Source, "Cargo.toml");
        add("tests", RootKind::Test, "Cargo.toml");
        add("benches", RootKind::Test, "Cargo.toml");
        add("target", RootKind::Excluded, "Cargo.toml");
    }

    if has("go.mod") {
        add("", RootKind::Source, "go.mod");
    }

    if let Some(file) = PYTHON_FILES.iter().find(|f| has(f)) {
        // `src` layout, else the flat layout's module directory itself.
        if dir.join("src").is_dir() {
            add("src", RootKind::Source, file);
        } else {
            add("", RootKind::Source, file);
        }
        add("tests", RootKind::Test, file);
        add("test", RootKind::Test, file);
        for ex in [".venv", "venv", "__pycache__", "build", "dist"] {
            add(ex, RootKind::Excluded, file);
        }
    }

    if has("package.json") {
        // A JVM build's `src` holds source sets, not JavaScript.
        if !has("pom.xml") && !GRADLE_FILES.iter().any(|f| has(f)) {
            add("src", RootKind::Source, "package.json");
            // Served at `/` by Vite, Next and Create React App: `href="/logo.svg"` resolves here.
            add("public", RootKind::Resources, "package.json");
            for t in ["test", "tests", "__tests__"] {
                add(t, RootKind::Test, "package.json");
            }
        }
        for ex in ["node_modules", "dist", "build"] {
            add(ex, RootKind::Excluded, "package.json");
        }
    }
}

/// Gradle's conventional `src/<set>/<lang>` folders that exist: `(set, lang)`.
fn source_sets(dir: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(sets) = std::fs::read_dir(dir.join("src")) else { return out };
    let mut sets: Vec<_> = sets.flatten().filter(|e| e.path().is_dir()).collect();
    sets.sort_by_key(|e| e.file_name());
    for set in sets {
        let set_name = set.file_name().to_string_lossy().into_owned();
        for sub in JVM_LANGS.iter().chain(&["resources"]) {
            if set.path().join(sub).is_dir() {
                out.push((set_name.clone(), (*sub).to_owned()));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tree(paths: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for p in paths {
            let path = dir.path().join(p);
            if p.ends_with('/') {
                fs::create_dir_all(&path).unwrap();
            } else {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, "").unwrap();
            }
        }
        dir
    }

    fn summary(roots: &[SourceFolder]) -> Vec<String> {
        roots.iter().map(|r| format!("{}={:?}@{}", r.path, r.kind, r.detected_from.as_deref().unwrap_or(""))).collect()
    }

    #[test]
    fn unity_roots_exclude_future_caches_and_do_not_scan_assets_as_modules() {
        let dir = tree(&[
            "Assets/Scripts/Player.cs",
            "Assets/Plugins/Tool/package.json",
            "ProjectSettings/ProjectVersion.txt",
            "Packages/manifest.json",
            "Library/PackageCache/tool/Cargo.toml",
        ]);
        let roots = detect(dir.path());
        assert!(roots.iter().any(|r| r.path == "Assets" && r.kind == RootKind::Source));
        assert!(roots.iter().any(|r| r.path == "Packages" && r.kind == RootKind::Source));
        assert!(!roots.iter().any(|r| r.path.starts_with("Assets/") || r.path.starts_with("Library/")));
        let effective = super::super::ProjectRoots::compute(roots, &Default::default());
        for name in crate::unity::GENERATED_DIRS {
            assert!(effective.excluded_globs().contains(&format!("/{name}")));
        }
        for path in ["Assets", "Packages", "ProjectSettings", crate::unity::VERSION_FILE] {
            assert!(affects_roots(Path::new(path)));
        }
    }

    #[test]
    fn nested_unity_roots_are_anchored_without_excluding_other_projects() {
        let dir = tree(&[
            "game/Assets/Scripts/Player.cs",
            "game/ProjectSettings/ProjectVersion.txt",
            "server/Cargo.toml",
            "server/src/main.rs",
            "Library/Source.cs",
        ]);
        let roots = super::super::ProjectRoots::compute(detect(dir.path()), &Default::default());
        assert!(roots.excluded_globs().contains(&"/game/Library".to_owned()));
        assert!(!roots.excluded_globs().contains(&"/Library".to_owned()));
        assert!(roots.roots.iter().any(|r| r.path == "server/src" && r.kind == RootKind::Source));
    }

    #[test]
    fn maven_conventional_roots_and_target() {
        let dir = tree(&[
            "pom.xml",
            "src/main/java/com/acme/App.java",
            "src/main/resources/app.yml",
            "src/test/java/com/acme/AppTest.java",
            "src/test/resources/",
            "target/classes/",
        ]);
        assert_eq!(
            summary(&detect(dir.path())),
            vec![
                "src/main/java=Source@pom.xml",
                "src/main/resources=Resources@pom.xml",
                "src/test/java=Test@pom.xml",
                "src/test/resources=TestResources@pom.xml",
                "target=Excluded@pom.xml",
            ]
        );
    }

    #[test]
    fn maven_multi_module_and_custom_source_directory() {
        let dir = tree(&["pom.xml", "core/src/main/kotlin/", "core/target/", "app/gen/", "app/src/test/java/"]);
        fs::write(
            dir.path().join("app/pom.xml"),
            "<project><build><sourceDirectory>${project.basedir}/gen</sourceDirectory></build></project>",
        )
        .unwrap();
        fs::write(dir.path().join("core/pom.xml"), "<project/>").unwrap();
        assert_eq!(
            summary(&detect(dir.path())),
            vec![
                "app/gen=Source@app/pom.xml",
                "app/src/test/java=Test@app/pom.xml",
                "core/src/main/kotlin=Source@core/pom.xml",
                "core/target=Excluded@core/pom.xml",
            ]
        );
    }

    #[test]
    fn gradle_source_sets_including_custom_and_multiplatform() {
        let dir = tree(&[
            "settings.gradle.kts",
            "build.gradle.kts",
            "src/main/kotlin/",
            "src/main/resources/",
            "src/integrationTest/kotlin/",
            "src/commonTest/kotlin/",
            "src/test/resources/",
            "build/",
            "lib/build.gradle",
            "lib/src/main/java/",
        ]);
        assert_eq!(
            summary(&detect(dir.path())),
            vec![
                "build=Excluded@build.gradle.kts",
                "lib/src/main/java=Source@lib/build.gradle",
                "src/commonTest/kotlin=Test@build.gradle.kts",
                "src/integrationTest/kotlin=Test@build.gradle.kts",
                "src/main/kotlin=Source@build.gradle.kts",
                "src/main/resources=Resources@build.gradle.kts",
                "src/test/resources=TestResources@build.gradle.kts",
            ]
        );
    }

    #[test]
    fn cargo_go_python_and_node() {
        let dir = tree(&[
            "Cargo.toml",
            "src/lib.rs",
            "tests/it.rs",
            "benches/b.rs",
            "examples/e.rs",
            "target/",
            "svc/go.mod",
            "py/pyproject.toml",
            "py/src/pkg/__init__.py",
            "py/tests/test_a.py",
            "py/.venv/",
            "flat/requirements.txt",
            "flat/tests/",
            "web/package.json",
            "web/src/",
            "web/public/",
            "web/__tests__/",
            "web/node_modules/x/package.json",
            "web/dist/",
        ]);
        assert_eq!(
            summary(&detect(dir.path())),
            vec![
                "benches=Test@Cargo.toml",
                "examples=Source@Cargo.toml",
                "flat=Source@flat/requirements.txt",
                "flat/tests=Test@flat/requirements.txt",
                "py/.venv=Excluded@py/pyproject.toml",
                "py/src=Source@py/pyproject.toml",
                "py/tests=Test@py/pyproject.toml",
                "src=Source@Cargo.toml",
                "svc=Source@svc/go.mod",
                "target=Excluded@Cargo.toml",
                "tests=Test@Cargo.toml",
                "web/__tests__=Test@web/package.json",
                "web/dist=Excluded@web/package.json",
                "web/node_modules=Excluded@web/package.json",
                "web/public=Resources@web/package.json",
                "web/src=Source@web/package.json",
            ]
        );
    }

    #[test]
    fn first_ecosystem_wins_for_a_shared_folder() {
        // A Gradle build with a frontend: `build` stays Gradle's, `src` is not a Node root.
        let dir =
            tree(&["build.gradle", "package.json", "src/main/java/", "src/test/java/", "build/", "node_modules/"]);
        assert_eq!(
            summary(&detect(dir.path())),
            vec![
                "build=Excluded@build.gradle",
                "node_modules=Excluded@package.json",
                "src/main/java=Source@build.gradle",
                "src/test/java=Test@build.gradle",
            ]
        );
    }

    #[test]
    fn plain_folders_have_no_roots() {
        let dir = tree(&["src/a.txt", "test/", "build/"]);
        assert!(detect(dir.path()).is_empty());
    }

    #[test]
    fn root_affecting_paths() {
        for p in [
            "pom.xml",
            "a/build.gradle.kts",
            "src",
            "core/src/integrationTest",
            "x/src/main",
            "target",
            "web/package.json",
        ] {
            assert!(affects_roots(Path::new(p)), "{p}");
        }
        for p in ["src/main/java/A.java", "README.md", "docs/guide"] {
            assert!(!affects_roots(Path::new(p)), "{p}");
        }
    }
}
