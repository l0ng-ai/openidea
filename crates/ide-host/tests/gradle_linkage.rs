use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use std::sync::Arc;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn links_are_validated_persisted_and_unlinked_without_removing_files() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("workspace");
    for dir in [root.join("a"), root.join("b"), base.join("external")] {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.gradle"), "rootProject.name = 'same-name'").unwrap();
    }
    let config = base.join("config");
    let host = Host::new(HostConfig {
        config_dir: config.clone(),
        data_dir: base.join("data"),
        local_data_dir: base.join("local"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |window| window,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.open_project("main", &root).unwrap();
    assert!(ops::build::gradle_link_projects(&host, "main", vec!["b".into()]).await.is_err());
    host.set_project_trust(&root, true, false).await.unwrap();
    let model = ops::build::gradle_link_projects(&host, "main", vec!["b/settings.gradle".into()]).await.unwrap();
    assert_eq!(model.gradle.iter().map(|g| g.dir.as_str()).collect::<Vec<_>>(), ["a", "b"]);
    let saved =
        || ide_workspace::SettingsStore::load(&config, Some(&root)).effective().languages.java.gradle.linked_projects;
    assert_eq!(saved(), Some(vec!["a".into(), "b".into()]));
    assert!(ops::build::gradle_link_projects(&host, "main", vec!["missing".into()]).await.is_err());
    assert_eq!(saved(), Some(vec!["a".into(), "b".into()]));
    let outside = base.join("external").to_string_lossy().into_owned();
    let model = ops::build::gradle_link_projects(&host, "main", vec![outside.clone()]).await.unwrap();
    assert_eq!(model.gradle.len(), 3);
    let model = ops::build::gradle_unlink_projects(&host, "main", vec!["a".into(), "b".into(), outside]).await.unwrap();
    assert!(model.gradle.is_empty());
    assert_eq!(saved(), Some(vec![]));
    for dir in [root.join("a"), root.join("b"), base.join("external")] {
        assert!(dir.join("settings.gradle").is_file());
    }
    let model = ops::build::gradle_link_projects(&host, "main", vec!["b".into()]).await.unwrap();
    assert_eq!(model.gradle.len(), 1);
    assert_eq!(model.gradle[0].dir, "b");
    host.shutdown().await;
}
