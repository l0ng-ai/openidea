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
        git(root, &["config", "core.autocrlf", "false"]);
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
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.trust.decide(&project_root, true, false).unwrap();
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

/// The Changes view also lists attached projects' repositories, and their untracked files
/// offer Add to .gitignore / .git/info/exclude: the guard must follow the window's
/// repository set, not the project folder alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_to_ignore_accepts_the_repositories_of_attached_projects() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let project_root = base.join("project");
    let attached_root = base.join("attached");
    for root in [&project_root, &attached_root] {
        std::fs::create_dir_all(root).unwrap();
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("tracked.txt"), "x\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "initial"]);
    }
    // Untracked files, one per repository; the attached one is what failed.
    let own = project_root.join("own.ignore-me");
    let attached = attached_root.join("attached.ignore-me");
    std::fs::write(&own, "x").unwrap();
    std::fs::write(&attached, "x").unwrap();

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
    host.trust.decide(&project_root, true, false).unwrap();
    host.trust.decide(&attached_root, true, false).unwrap();
    let project = host.open_project("main", &project_root).unwrap();
    ide_host::ops::project::attach_workspace(&host, "main", &attached_root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);

    vcs::vcs_add_to_ignore(&host, "main", vec![attached.clone()], ide_vcs::IgnoreDestination::Gitignore).await.unwrap();
    assert!(
        std::fs::read_to_string(attached_root.join(".gitignore")).unwrap().contains("/attached.ignore-me"),
        "the attached repository's .gitignore did not receive the rule"
    );
    vcs::vcs_add_to_ignore(&host, "main", vec![own.clone()], ide_vcs::IgnoreDestination::LocalExclude).await.unwrap();
    assert!(
        std::fs::read_to_string(project_root.join(".git/info/exclude")).unwrap().contains("/own.ignore-me"),
        "the project repository's exclude did not receive the rule"
    );

    // A repository of an unattached sibling folder stays outside.
    let sibling_root = base.join("sibling");
    std::fs::create_dir_all(&sibling_root).unwrap();
    git(&sibling_root, &["init", "-b", "main"]);
    let sibling = sibling_root.join("sibling.ignore-me");
    std::fs::write(&sibling, "x").unwrap();
    let error =
        vcs::vcs_add_to_ignore(&host, "main", vec![sibling], ide_vcs::IgnoreDestination::Gitignore).await.unwrap_err();
    assert!(error.message.contains("outside the project"), "{error:?}");
    assert!(!sibling_root.join(".gitignore").exists());
    host.close_project("main");
}
