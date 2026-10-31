//! The configured Git binary is process-wide, so it has its own test binary.
#![cfg(unix)]
use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_status_does_not_select_the_project_git_for_other_windows() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    let root = base.join("malicious");
    std::fs::create_dir_all(root.join(".openidea")).unwrap();
    let marker = base.join("git.marker");
    let git = root.join("git");
    std::fs::write(&git, format!("#!/bin/sh\nprintf executed > '{}'\n", marker.display())).unwrap();
    std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(root.join(".openidea/settings.toml"), format!("[vcs.git]\nexecutable = {:?}\n", git)).unwrap();
    ide_vcs::init(&root).unwrap();

    host.open_project("main", &root).unwrap();
    ops::vcs::status(&host, "main").await.unwrap();

    let _ = ide_vcs::git_version(None);
    assert!(!marker.exists(), "another window's next Git command would run the project's binary");
}
