//! Unregistered Git roots: a repository the project's scan has not taken in is reported,
//! and the rescan the notification offers registers it.

use ide_core::{NullSink, ipc_path::to_ipc};
use ide_host::{Host, HostConfig, ops};
use ide_vcs::Repos;
use std::{path::Path, sync::Arc, time::Duration};

fn git_init(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let status = std::process::Command::new("git").args(["init", "-q"]).current_dir(dir).status();
    assert!(status.is_ok_and(|status| status.success()), "git init in {}", dir.display());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_repository_the_scan_has_not_taken_in_is_reported_and_a_rescan_registers_it() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    git_init(&root);
    git_init(&root.join("nested"));
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
    host.trust.decide(&root, true, false).unwrap();
    let project = host.open_project("main", &root).unwrap();
    // The scan on project open runs in the background; wait for it to take the nested
    // repository in.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !project.repos().roots().contains(&root.join("nested")) {
        assert!(tokio::time::Instant::now() < deadline, "the project scan did not register the nested repository");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(ops::vcs::vcs_unregistered_roots(&host, "main").await.unwrap().is_empty());

    // A scan can miss a repository (cloned where the watcher does not watch): the project
    // then holds only the repositories `open_project` starts from, before the scan runs.
    *project.repos.write() = Repos::enclosing(&root).unwrap();
    assert_eq!(
        ops::vcs::vcs_unregistered_roots(&host, "main").await.unwrap(),
        [to_ipc(&root.join("nested"))],
        "the nested repository is reported, the project's own (registered) one is not"
    );

    ops::vcs::vcs_refresh_roots(&host, "main").await.unwrap();
    assert!(project.repos().roots().contains(&root.join("nested")));
    assert!(ops::vcs::vcs_unregistered_roots(&host, "main").await.unwrap().is_empty());
    host.close_project("main");
}
