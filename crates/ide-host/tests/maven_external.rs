use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use ide_workspace::settings::SettingsScope;
use std::sync::Arc;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_maven_link_persists_reloads_and_unlink_keeps_files() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("A");
    let sibling = base.join("B");
    std::fs::create_dir_all(root.join("core")).unwrap();
    std::fs::create_dir_all(&sibling).unwrap();
    let a_pom = "<project><artifactId>a</artifactId><packaging>pom</packaging><modules><module>core</module></modules></project>";
    let b_pom = "<project><artifactId>b</artifactId></project>";
    std::fs::write(root.join("pom.xml"), a_pom).unwrap();
    std::fs::write(root.join("core/pom.xml"), "<project><artifactId>core</artifactId></project>").unwrap();
    std::fs::write(sibling.join("pom.xml"), b_pom).unwrap();
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
    host.set_project_trust(&root, true, false).await.unwrap();

    let written =
        serde_json::to_string(&vec!["../B/pom.xml".to_owned(), sibling.join("pom.xml").to_string_lossy().into_owned()])
            .unwrap();
    ops::project::set_settings(&host, "main", SettingsScope::Project, "languages.java.maven.linkedProjects", &written)
        .unwrap();
    let saved =
        || ide_workspace::SettingsStore::load(&config, Some(&root)).effective().languages.java.maven.linked_projects;
    let canonical = dunce::canonicalize(sibling.join("pom.xml")).unwrap().to_string_lossy().replace('\\', "/");
    assert_eq!(saved(), vec![canonical.clone()]);

    let model = ops::build::build_model(&host, "main").await.unwrap();
    let projects = &model.maven.unwrap().projects;
    assert_eq!(projects.iter().filter(|p| p.artifact_id == "a").count(), 1);
    let b = projects.iter().find(|p| p.artifact_id == "b").unwrap();
    assert!(!b.aggregated);
    assert_eq!(b.pom, canonical);
    assert_eq!(dunce::canonicalize(root.join(&b.dir)).unwrap(), sibling);
    assert_eq!(host.project("main").unwrap().content_roots(), vec![sibling.clone()]);
    assert_eq!(host.project("main").unwrap().lsp.jdtls_import_roots(), vec![sibling.clone()]);

    let reloaded = ops::build::build_model(&host, "main").await.unwrap();
    assert_eq!(
        reloaded.maven.unwrap().projects.iter().map(|p| p.pom.clone()).collect::<Vec<_>>(),
        projects.iter().map(|p| p.pom.clone()).collect::<Vec<_>>()
    );
    assert_eq!(saved(), vec![canonical]);

    ops::project::set_settings(&host, "main", SettingsScope::Project, "languages.java.maven.linkedProjects", "[]")
        .unwrap();
    let gone = ops::build::build_model(&host, "main").await.unwrap();
    assert!(gone.maven.unwrap().projects.iter().all(|p| p.artifact_id != "b"));
    assert!(host.project("main").unwrap().content_roots().is_empty());
    assert!(host.project("main").unwrap().lsp.jdtls_import_roots().is_empty());
    assert_eq!(saved(), Vec::<String>::new());
    assert_eq!(std::fs::read_to_string(root.join("pom.xml")).unwrap(), a_pom);
    assert_eq!(std::fs::read_to_string(sibling.join("pom.xml")).unwrap(), b_pom);
    host.shutdown().await;
}
