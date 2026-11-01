use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use std::sync::Arc;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn split_storage_keeps_user_history_and_uses_local_tools_and_caches() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let data = base.join("roaming");
    let local = base.join("local");
    let root = base.join("project");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("notes.txt"), "hello\n").unwrap();
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: data.clone(),
        local_data_dir: local.clone(),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    assert_eq!(
        std::path::PathBuf::from(ops::tools::jdk_download_location(&host, "main").unwrap()),
        local.join("tools/jdks")
    );
    let light = host.open_light("main", &root.join("notes.txt")).unwrap();
    assert!(light.cache_dir.starts_with(&local));
    assert!(data.join("history").exists());
    assert!(!local.join("history").exists());
    let project = host.open_project("main", &root).unwrap();
    assert!(project.cache_dir.starts_with(&local));
    assert!(local.join("index").exists());
    assert!(!data.join("index").exists());
    assert!(!data.join("tools").exists());
    host.shutdown().await;
}
