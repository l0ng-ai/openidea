//! Explicit external logs allow history reads without adding a writable project root.
use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops::vcs};
use std::{path::Path, process::Command, sync::Arc};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_history_is_readable_and_never_becomes_a_write_target() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    let external = base.join("external");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&external).unwrap();
    git(&external, &["init", "-b", "main"]);
    let deleted = external.join("deleted.txt");
    std::fs::write(&deleted, "historical content\n").unwrap();
    git(&external, &["add", "."]);
    git(&external, &["commit", "-m", "initial"]);
    let first = git(&external, &["rev-parse", "HEAD"]);
    git(&external, &["rm", "deleted.txt"]);
    git(&external, &["commit", "-m", "delete"]);
    let head = git(&external, &["rev-parse", "HEAD"]);
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    // A standalone editor needs no project, indexer, or writable VCS root.
    vcs::vcs_open_external_log(&host, "standalone", external.clone()).await.unwrap();
    let standalone = vcs::vcs_log(&host, "standalone", Some(external.clone()), Default::default()).await.unwrap();
    assert_eq!(standalone[0].id, head);
    let details = vcs::vcs_log_details_batch(
        &host,
        "standalone",
        Some(external.clone()),
        vec![head.clone(), first.clone()],
        ide_core::RequestId(987),
    )
    .await
    .unwrap();
    assert!(details.iter().all(|d| d.signature == "N"));
    assert_eq!(
        vcs::vcs_revision_children(&host, "standalone", Some(external.clone()), first.clone(), String::new())
            .await
            .unwrap(),
        vec!["deleted.txt"]
    );
    assert!(host.project("standalone").is_err());
    host.trust.decide(&external, false, false).unwrap();
    let restricted = host.open_project("restricted", &external).unwrap();
    assert!(!restricted.is_trusted());
    vcs::vcs_open_external_log(&host, "restricted", external.clone()).await.unwrap();
    let restricted_log = vcs::vcs_log(
        &host,
        "restricted",
        Some(external.clone()),
        ide_vcs::LogQuery { request: Some(ide_core::RequestId(988)), summary_only: true, ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(restricted_log[0].id, head);
    assert_eq!(
        vcs::vcs_log_details_batch(
            &host,
            "restricted",
            Some(external.clone()),
            vec![head.clone()],
            ide_core::RequestId(989)
        )
        .await
        .unwrap()[0]
            .signature,
        "N"
    );
    host.close_project("restricted");
    let payload =
        serde_json::to_vec(&serde_json::json!({ "repo": external, "revision": first, "path": "deleted.txt" })).unwrap();
    let hex = payload.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let uri = format!("git-revision:{hex}/deleted.txt");
    let document = vcs::revision_virtual_document(&host, "standalone", &uri, None).await.unwrap();
    assert_eq!(document.text, "historical content\n");
    assert_eq!(document.encoding, "utf-8");
    assert!(document.can_reload_encoding);
    // Reload with Encoding re-decodes the blob with the chosen charset.
    let reloaded = vcs::revision_virtual_document(&host, "standalone", &uri, Some("utf-16le")).await.unwrap();
    assert_eq!(reloaded.encoding, "utf-16le");
    assert_ne!(reloaded.text, document.text);
    host.trust.decide(&root, true, false).unwrap();
    let project = host.open_project("main", &root).unwrap();
    assert!(vcs::vcs_log(&host, "main", Some(external.clone()), Default::default()).await.is_err());
    vcs::vcs_open_external_log(&host, "main", external.clone()).await.unwrap();
    let log = vcs::vcs_log(&host, "main", Some(external.clone()), Default::default()).await.unwrap();
    assert_eq!(log.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec![head.as_str(), first.as_str()]);
    assert_eq!(
        vcs::vcs_file_at(&host, "main", deleted.clone(), Some(first.clone())).await.unwrap().as_deref(),
        Some("historical content\n")
    );
    assert!(project.repos().at_root(&external).is_none());
    assert!(vcs::vcs_checkout(&host, "main", Some(external.clone()), first.clone(), false, None).await.is_err());
    assert!(vcs::vcs_apply_patch(&host, "main", Some(external.clone()), String::new()).await.is_err());
    assert_eq!(git(&external, &["rev-parse", "HEAD"]), head);
    assert!(!deleted.exists());
    host.close_project("main");
}
