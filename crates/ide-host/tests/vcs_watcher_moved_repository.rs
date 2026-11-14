//! A repository folder moved into an open project is registered while the project is open:
//! the folder brings no `.git` event of its own, so the watcher's "created path" is what the
//! rescan has to answer to (the open scan already ran).

use ide_core::NullSink;
use ide_host::{Host, HostConfig};
use std::{path::Path, sync::Arc, time::Duration};

fn git_init(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let status = std::process::Command::new("git").args(["init", "-q"]).current_dir(dir).status();
    assert!(status.is_ok_and(|status| status.success()), "git init in {}", dir.display());
}

async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !done() {
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn moving_a_repository_into_the_project_registers_it() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    git_init(&root);
    // Prepared outside the project, as a restored or moved folder would be.
    let prepared = base.join("prepared");
    git_init(&prepared);

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
    // The scan on project open runs in the background: wait for it before moving anything in.
    wait_until("the project's own repository", || project.repos().roots().len() == 1).await;

    std::fs::rename(&prepared, root.join("moved")).unwrap();
    wait_until("the moved repository to be registered", || {
        project.repos().roots().iter().any(|r| r.ends_with("moved"))
    })
    .await;
}
