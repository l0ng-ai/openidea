//! Source / test / resource / excluded roots ("content roots" in IDEA terms).
//!
//! Roots are auto-detected from build files ([`detect`]) and merged with the
//! user's Project Structure marks ([`ProjectRoots::compute`]): a user mark on a
//! folder always wins, and `unmarked` hides a detected root. Paths are
//! project-relative and `/`-separated; `""` is the project root itself.

mod detect;
mod gradle;
mod java;
mod maven;

pub use detect::{affects_roots, detect};
pub use java::unmanaged_java_source_paths;

use ide_core::settings::ProjectStructureSettings;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RootKind {
    Source,
    Test,
    Resources,
    TestResources,
    Excluded,
}

impl RootKind {
    /// Test sources and test resources.
    pub fn is_test(self) -> bool {
        matches!(self, Self::Test | Self::TestResources)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceFolder {
    /// Project-relative, `/`-separated; `""` = the project root.
    pub path: String,
    pub kind: RootKind,
    /// Build file the root was detected from (`"pom.xml"`, `"app/build.gradle.kts"`);
    /// `None` for a folder the user marked.
    pub detected_from: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRoots {
    /// Effective roots, sorted by path.
    pub roots: Vec<SourceFolder>,
    /// Every auto-detected root, including ones the user overrode or unmarked.
    pub detected: Vec<SourceFolder>,
}

/// `/`-separated, no leading `./` or `/`, no trailing `/` (mirrors the UI's `normalizeFolder`).
pub fn normalize(path: &str) -> String {
    let mut p = path.trim().replace('\\', "/");
    while let Some(rest) = p.strip_prefix("./") {
        p = rest.to_owned();
    }
    let p = p.trim_matches('/');
    if p == "." { String::new() } else { p.to_owned() }
}

fn is_inside(rel: &str, root: &str) -> bool {
    root.is_empty() || rel == root || (rel.starts_with(root) && rel.as_bytes().get(root.len()) == Some(&b'/'))
}

impl ProjectRoots {
    /// Merges detected roots with the user's marks.
    pub fn compute(detected: Vec<SourceFolder>, ps: &ProjectStructureSettings) -> Self {
        let mut roots: Vec<SourceFolder> = Vec::new();
        let mut user = |list: &[String], kind: RootKind| {
            for p in list.iter().map(|p| normalize(p)) {
                if !roots.iter().any(|r| r.path == p) {
                    roots.push(SourceFolder { path: p, kind, detected_from: None });
                }
            }
        };
        user(&ps.source_roots, RootKind::Source);
        user(&ps.test_roots, RootKind::Test);
        user(&ps.resource_roots, RootKind::Resources);
        user(&ps.test_resource_roots, RootKind::TestResources);
        user(&ps.excluded, RootKind::Excluded);
        let unmarked: Vec<String> = ps.unmarked.iter().map(|p| normalize(p)).collect();
        for d in &detected {
            if !unmarked.contains(&d.path) && !roots.iter().any(|r| r.path == d.path) {
                roots.push(d.clone());
            }
        }
        roots.sort_by(|a, b| a.path.cmp(&b.path));
        Self { roots, detected }
    }

    /// The innermost root containing `rel` (a project-relative path).
    pub fn root_for(&self, rel: &str) -> Option<&SourceFolder> {
        self.roots.iter().filter(|r| is_inside(rel, &r.path)).max_by_key(|r| r.path.len())
    }

    /// IDEA's "Project Test Files": under a test (resource) root, or a test file by name
    /// (`*_test.go`, `*.test.ts`, `*.spec.js`, `test_*.py`) — like IDEA's `TestSourcesFilter`s.
    pub fn is_test(&self, rel: &str) -> bool {
        match self.root_for(rel) {
            Some(r) if r.kind.is_test() => true,
            Some(r) if r.kind == RootKind::Excluded => false,
            _ => is_test_file_name(rel.rsplit('/').next().unwrap_or(rel)),
        }
    }

    /// Effective resource folders (project-relative): served at `/` for web file references.
    pub fn resource_dirs(&self) -> Vec<&str> {
        self.roots.iter().filter(|r| r.kind == RootKind::Resources).map(|r| r.path.as_str()).collect()
    }

    /// Effective excluded folders as anchored globs (`/target`), for the index, watcher and search.
    pub fn excluded_globs(&self) -> Vec<String> {
        self.roots
            .iter()
            .filter(|r| r.kind == RootKind::Excluded && !r.path.is_empty())
            .map(|r| format!("/{}", r.path))
            .collect()
    }
}

/// Test files recognised by name, whatever their folder.
pub fn is_test_file_name(name: &str) -> bool {
    if name.ends_with("_test.go") {
        return true;
    }
    if let Some(stem) = name.strip_suffix(".py") {
        return stem.starts_with("test_") || stem.ends_with("_test") || stem == "conftest";
    }
    // `x.test.ts`, `x.spec.jsx`, `x.test.mjs`, …
    let mut parts = name.rsplitn(3, '.');
    let ext = parts.next().unwrap_or("");
    let kind = parts.next().unwrap_or("");
    parts.next().is_some()
        && matches!(kind, "test" | "spec")
        && matches!(ext, "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(path: &str, kind: RootKind) -> SourceFolder {
        SourceFolder { path: path.into(), kind, detected_from: Some("pom.xml".into()) }
    }

    #[test]
    fn user_marks_override_detected_roots_and_unmarked_hides_them() {
        let detected = vec![
            d("src/main/java", RootKind::Source),
            d("src/test/java", RootKind::Test),
            d("target", RootKind::Excluded),
        ];
        let ps = ProjectStructureSettings {
            source_roots: vec!["gen/".into()],
            test_roots: vec!["./src/main/java".into()],
            unmarked: vec!["target".into()],
            ..Default::default()
        };
        let roots = ProjectRoots::compute(detected.clone(), &ps);
        let summary: Vec<(&str, RootKind, bool)> =
            roots.roots.iter().map(|r| (r.path.as_str(), r.kind, r.detected_from.is_some())).collect();
        assert_eq!(
            summary,
            vec![
                ("gen", RootKind::Source, false),
                ("src/main/java", RootKind::Test, false),
                ("src/test/java", RootKind::Test, true),
            ]
        );
        assert_eq!(roots.detected, detected);
        assert!(roots.excluded_globs().is_empty());
    }

    #[test]
    fn innermost_root_decides_test_and_production() {
        let roots = ProjectRoots::compute(
            vec![
                d("", RootKind::Source),
                d("src/test/java", RootKind::Test),
                d("src/test/resources", RootKind::TestResources),
                d("target", RootKind::Excluded),
            ],
            &ProjectStructureSettings::default(),
        );
        assert_eq!(roots.root_for("src/test/java/a/B.java").unwrap().path, "src/test/java");
        assert_eq!(roots.root_for("src/test/javax/B.java").unwrap().path, "");
        assert!(roots.is_test("src/test/java/a/B.java"));
        assert!(roots.is_test("src/test/resources/x.yml"));
        assert!(!roots.is_test("README.md"));
        assert!(roots.is_test("pkg/math_test.go"));
        assert!(roots.is_test("web/app.spec.ts"));
        assert!(!roots.is_test("target/foo_test.go"));
        assert_eq!(roots.excluded_globs(), vec!["/target"]);
    }

    #[test]
    fn test_file_names() {
        for name in ["a_test.go", "test_x.py", "x_test.py", "conftest.py", "a.test.ts", "b.spec.jsx", "c.test.mjs"] {
            assert!(is_test_file_name(name), "{name}");
        }
        for name in ["test.ts", "spec.js", "latest.go", "contest.py", "a.test.rs", "testing.py", "x.spec"] {
            assert!(!is_test_file_name(name), "{name}");
        }
    }

    #[test]
    fn normalize_paths() {
        assert_eq!(normalize("./a/b/"), "a/b");
        assert_eq!(normalize("\\a\\b"), "a/b");
        assert_eq!(normalize("."), "");
        assert_eq!(normalize("/"), "");
    }
}
