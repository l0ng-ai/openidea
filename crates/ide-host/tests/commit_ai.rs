use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops::vcs};
use std::sync::Arc;

fn host(base: &std::path::Path) -> Host {
    Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    })
}

#[tokio::test]
async fn configuration_is_local_validated_and_persisted_without_a_secret() {
    let tmp = tempfile::tempdir().unwrap();
    let host = host(tmp.path());
    let initial = vcs::vcs_commit_ai_settings(&host).await.unwrap();
    assert!(initial.config.base_url.is_empty());
    assert!(!initial.has_api_key);
    let config = vcs::CommitAiConfig { base_url: " http://localhost:1234/v1/ ".into(), model: " test-model ".into() };
    vcs::vcs_commit_ai_save_settings(&host, config, None).await.unwrap();
    let saved = vcs::vcs_commit_ai_settings(&host).await.unwrap();
    assert_eq!(saved.config.base_url, "http://localhost:1234/v1/");
    assert_eq!(saved.config.model, "test-model");
    let json = std::fs::read_to_string(host.config_dir.join("commit-ai.json")).unwrap();
    assert!(!json.contains("apiKey"));
    assert!(
        vcs::vcs_commit_ai_save_settings(
            &host,
            vcs::CommitAiConfig { base_url: "file:///tmp/key".into(), model: "test".into() },
            None
        )
        .await
        .is_err()
    );
    assert_eq!(vcs::vcs_commit_ai_settings(&host).await.unwrap().config.model, "test-model");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn evidence_reads_reject_large_files_and_preserve_open_buffer_text() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let host = host(&base);
    let root = base.join("repo");
    std::fs::create_dir(&root).unwrap();
    ide_vcs::init(&root).unwrap();
    let path = root.join("notes.txt");
    std::fs::write(&path, "disk text\n").unwrap();
    let project = host.open_project("main", &root).unwrap();
    vcs::status(&host, "main").await.unwrap();
    let opened = ide_host::ops::doc::open(&host, "main", path.clone()).await.unwrap();
    project.documents.replace_all(opened.id, "unsaved text\n").unwrap();
    assert_eq!(vcs::vcs_commit_ai_read_text(&host, "main", path, None).await.unwrap(), "unsaved text\n");
    let large = root.join("large.txt");
    std::fs::write(&large, vec![b'x'; 1_000_001]).unwrap();
    assert!(vcs::vcs_commit_ai_read_text(&host, "main", large, None).await.unwrap_err().message.contains("too large"));
    #[cfg(unix)]
    {
        let secret = base.join("secret.txt");
        std::fs::write(&secret, "never send these contents").unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let text = vcs::vcs_commit_ai_read_text(&host, "main", link, None).await.unwrap();
        assert_eq!(text, secret.to_string_lossy());
        assert!(!text.contains("never send"));
    }
}
