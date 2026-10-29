//! Repository-scoped patch operations must never fall back to the primary root.
use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops::vcs};
use std::{path::Path, process::Command, sync::Arc, time::Duration};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn patches_read_and_write_the_requested_repository() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let project_root = base.join("project");
    let roots = [project_root.join("front"), project_root.join("back")];
    let mut revisions = Vec::new();
    for (i, root) in roots.iter().enumerate() {
        std::fs::create_dir_all(root).unwrap();
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("same.txt"), format!("root {i}\n")).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "initial"]);
        std::fs::write(root.join("same.txt"), format!("changed {i}\n")).unwrap();
        git(root, &["commit", "-am", "change"]);
        revisions.push(git(root, &["rev-parse", "HEAD"]));
    }
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    let project = host.open_project("main", &project_root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);
    for (i, root) in roots.iter().enumerate() {
        let patch = vcs::vcs_create_patch(
            &host,
            "main",
            Some(root.clone()),
            vcs::PatchSource::Commits { commits: vec![revisions[i].clone()], reverse: true },
        )
        .await
        .unwrap();
        assert!(patch.contains(&format!("-changed {i}")));
        assert_eq!(vcs::vcs_patch_preview(&host, "main", Some(root.clone()), patch.clone()).await.unwrap().len(), 1);
        vcs::vcs_apply_patch(&host, "main", Some(root.clone()), patch).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("same.txt")).unwrap(), format!("root {i}\n"));
    }
    assert!(vcs::vcs_apply_patch(&host, "main", Some(base.join("outside")), String::new()).await.is_err());
    host.close_project("main");
}
