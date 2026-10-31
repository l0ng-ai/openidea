use super::{ProjectRoots, RootKind};
use ide_core::settings::ProjectStructureSettings;
use std::path::{Component, Path};

/// Source paths for jdtls's unmanaged project, relative to its workspace folder.
/// Build tools and Eclipse own their source model; other layouts retain jdtls inference.
pub fn unmanaged_java_source_paths(
    project: &Path,
    server_root: &Path,
    settings: &ProjectStructureSettings,
) -> Option<Vec<String>> {
    if [
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
        "build.xml",
        ".project",
    ]
    .iter()
    .any(|name| server_root.join(name).is_file())
    {
        return None;
    }
    let roots = ProjectRoots::compute(Vec::new(), settings);
    let mut paths: Vec<String> = roots
        .roots
        .iter()
        .filter(|r| matches!(r.kind, RootKind::Source | RootKind::Test))
        .filter(|r| Path::new(&r.path).components().all(|c| matches!(c, Component::Normal(_))))
        .filter_map(|r| {
            let absolute = project.join(&r.path);
            let relative = absolute.strip_prefix(server_root).ok()?;
            let path = relative.to_string_lossy().replace('\\', "/");
            Some(if path.is_empty() { ".".into() } else { path })
        })
        .collect();
    if paths.is_empty() {
        // jdtls can infer the package directory itself as a source root. Give
        // conventional layouts an unambiguous base without guessing other layouts.
        paths = ["src/main/java", "src/test/java"]
            .into_iter()
            .filter(|p| server_root.join(p).is_dir())
            .map(str::to_owned)
            .collect();
        if paths.is_empty() && server_root.join("src").is_dir() {
            paths.push("src".into());
        }
    }
    (!paths.is_empty()).then_some(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marked_sources_and_tests_are_relative_to_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let settings = ProjectStructureSettings {
            source_roots: vec!["./app/generated/".into(), "other/src".into(), "../outside".into()],
            test_roots: vec!["app/tests".into()],
            resource_roots: vec!["app/resources".into()],
            excluded: vec!["app/out".into()],
            ..Default::default()
        };
        assert_eq!(
            unmanaged_java_source_paths(dir.path(), &dir.path().join("app"), &settings),
            Some(vec!["generated".into(), "tests".into()])
        );
        let settings = ProjectStructureSettings { source_roots: vec![".".into()], ..Default::default() };
        assert_eq!(unmanaged_java_source_paths(dir.path(), dir.path(), &settings), Some(vec![".".into()]));
    }

    #[test]
    fn conventional_layouts_and_other_unmarked_projects() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let settings = ProjectStructureSettings::default();
        assert_eq!(unmanaged_java_source_paths(root, root, &settings), None);
        std::fs::create_dir_all(root.join("src")).unwrap();
        assert_eq!(unmanaged_java_source_paths(root, root, &settings), Some(vec!["src".into()]));
        std::fs::create_dir_all(root.join("src/main/java")).unwrap();
        std::fs::create_dir_all(root.join("src/test/java")).unwrap();
        assert_eq!(
            unmanaged_java_source_paths(root, root, &settings),
            Some(vec!["src/main/java".into(), "src/test/java".into()])
        );
        let settings = ProjectStructureSettings { source_roots: vec!["custom".into()], ..settings };
        assert_eq!(unmanaged_java_source_paths(root, root, &settings), Some(vec!["custom".into()]));
    }

    #[test]
    fn managed_projects_keep_their_build_model() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let settings = ProjectStructureSettings { source_roots: vec!["custom".into()], ..Default::default() };
        for marker in
            ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", ".project"]
        {
            std::fs::write(root.join(marker), "").unwrap();
            assert_eq!(unmanaged_java_source_paths(root, root, &settings), None, "{marker}");
            std::fs::remove_file(root.join(marker)).unwrap();
        }
    }
}
