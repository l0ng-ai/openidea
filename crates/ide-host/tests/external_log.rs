//! Explicit external logs allow history reads without adding a writable project root.
mod common;

use ide_host::{Host, ops::vcs};
use std::{path::Path, process::Command};

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
    let host = Host::new(common::host_config(&base));
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
    assert!(vcs::vcs_checkout(&host, "main", Some(external.clone()), first.clone(), false, None, None).await.is_err());
    assert!(vcs::vcs_apply_patch(&host, "main", Some(external.clone()), String::new(), None).await.is_err());
    assert_eq!(git(&external, &["rev-parse", "HEAD"]), head);
    assert!(!deleted.exists());
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revision_images_use_the_selected_git_blob_and_window() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("repo");
    std::fs::create_dir(&root).unwrap();
    git(&root, &["init", "-b", "main"]);
    let old = root.join("old.PNG");
    let new = root.join("new.webp");
    std::fs::write(&old, [0x89, 0x00, 0xff]).unwrap();
    std::fs::write(root.join("icon.svg"), b"<svg/>").unwrap();
    std::fs::write(root.join("photo.jpeg"), [0xff, 0xd8]).unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "old image"]);
    let first = git(&root, &["rev-parse", "HEAD"]);
    git(&root, &["mv", "old.PNG", "new.webp"]);
    std::fs::write(&new, [0xff, 0xfe]).unwrap();
    git(&root, &["commit", "-am", "rename and change image"]);
    std::fs::write(&new, [0x00, 0x80]).unwrap();
    git(&root, &["add", "new.webp"]);
    std::fs::write(&new, "working tree only").unwrap();

    let host = Host::new(common::host_config(&base));
    let read = |window, path: &Path, rev: &str| vcs::vcs_image_at(&host, window, path.to_owned(), rev.to_owned());
    assert!(read("standalone", &old, &first).await.is_err());
    vcs::vcs_open_external_log(&host, "standalone", root.clone()).await.unwrap();
    assert_eq!(read("standalone", &old, &first).await.unwrap().as_deref(), Some("data:image/png;base64,iQD/"));
    assert!(read("another-window", &old, &first).await.is_err());

    host.trust.decide(&root, false, false).unwrap();
    host.open_project("project", &root).unwrap();
    assert_eq!(read("project", &new, "HEAD").await.unwrap().as_deref(), Some("data:image/webp;base64,//4="));
    assert_eq!(read("project", &new, ":0").await.unwrap().as_deref(), Some("data:image/webp;base64,AIA="));
    assert_eq!(read("project", &old, "HEAD").await.unwrap(), None);
    assert_eq!(
        read("project", &root.join("icon.svg"), "HEAD").await.unwrap().as_deref(),
        Some("data:image/svg+xml;base64,PHN2Zy8+")
    );
    assert_eq!(
        read("project", &root.join("photo.jpeg"), "HEAD").await.unwrap().as_deref(),
        Some("data:image/jpeg;base64,/9g=")
    );
    assert!(read("project", &base.join("outside.png"), "HEAD").await.is_err());
    assert!(read("project", &root.join("file.txt"), "HEAD").await.is_err());
}
