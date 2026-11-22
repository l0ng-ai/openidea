use ide_core::{NullSink, RequestId};
use ide_host::{Host, HostConfig, Project, ops::vcs};
use std::{path::PathBuf, process::Command, sync::Arc, time::Duration};

fn git(root: &std::path::Path, args: &[&str]) {
    let out = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

async fn wait_for_repos(project: &Arc<Project>, count: usize) {
    for _ in 0..200 {
        if project.repos().all().len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("expected {} repositories, found {}", count, project.repos().all().len());
}

struct Fixture {
    host: Host,
    project: Arc<Project>,
    root: PathBuf,
    _temp: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("file.txt"), "original\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "original"]);
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
        wait_for_repos(&project, 1).await;
        Self { host, project, root, _temp: temp }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.host.close_project("main");
    }
}

fn setup_script(root: &std::path::Path, unix: &str, windows: &str) -> PathBuf {
    let file = root.join(if cfg!(windows) { "local setup.cmd" } else { "local setup.sh" });
    if cfg!(windows) {
        std::fs::write(&file, format!("@echo off\r\n{}", windows.replace('\n', "\r\n"))).unwrap();
    } else {
        std::fs::write(&file, format!("#!/bin/sh\n{unix}")).unwrap();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    file
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn command_added_worktree_joins_the_repository_set() {
    let f = Fixture::new().await;
    let linked = f.root.join("linked");
    vcs::vcs_add_worktree(&f.host, "main", None, linked.clone(), "main".into(), Some("topic".into()), None, None)
        .await
        .unwrap();
    let roots = f.project.repos().roots();
    assert!(roots.contains(&linked), "worktree below the project did not join the repository set: {roots:?}");
    assert_eq!(roots.len(), 2);
    std::fs::write(f.root.join(".worktreeinclude"), ".env\n").unwrap();
    let primary = vcs::vcs_worktree_include(&f.host, "main", Some(f.root.clone())).await.unwrap();
    let include = vcs::vcs_worktree_include(&f.host, "main", Some(linked.clone())).await.unwrap();
    assert!(primary.exists);
    assert!(!include.exists);
    assert_eq!(include.path.into_path_buf(), linked.join(".worktreeinclude"));
    let roots = vcs::vcs_roots(&f.host, "main").await.unwrap();
    assert_eq!(roots[0].root, f.root);
    assert_eq!(roots[0].branch_root, f.root);
    assert_eq!(roots[0].head.as_deref(), Some("main"));
    assert_eq!(roots[1].root, linked);
    assert_eq!(roots[1].branch_root, f.root);
    assert_eq!(roots[1].head.as_deref(), Some("topic"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn removed_worktree_leaves_the_repository_set() {
    let f = Fixture::new().await;
    let linked = f.root.join("linked");
    vcs::vcs_add_worktree(&f.host, "main", None, linked.clone(), "main".into(), Some("topic".into()), None, None)
        .await
        .unwrap();
    assert_eq!(f.project.repos().all().len(), 2);
    vcs::vcs_remove_worktree(&f.host, "main", None, linked, false).await.unwrap();
    assert_eq!(f.project.repos().all().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn new_worktree_copies_requested_local_configuration() {
    let f = Fixture::new().await;
    let write = |name: &str, contents: &str| std::fs::write(f.root.join(name), contents).unwrap();
    write(".env.target", "checkout content");
    git(&f.root, &["add", ".env.target"]);
    git(&f.root, &["commit", "-m", "track a destination file"]);
    git(&f.root, &["branch", "older"]);
    git(&f.root, &["rm", ".env.target"]);
    write("old-only.txt", "committed");
    git(&f.root, &["add", "old-only.txt"]);
    git(&f.root, &["commit", "-m", "track another file"]);
    std::fs::create_dir_all(f.root.join(".openidea")).unwrap();
    write(".openidea/settings.toml", "local settings");
    write(".env", "local environment");
    write(".env.secret", "excluded by negated pattern");
    write(".env.staged", "local staged addition");
    write(".env.target", "local collision");
    git(&f.root, &["add", ".env.staged"]);
    write("file.txt", "local edits to a committed file");
    write(".worktreeinclude", ".openidea/settings.toml\n.env*\n!.env.secret\nfile.txt\nold-only.txt\n");

    let linked = f.root.with_file_name("with config");
    let result = vcs::vcs_add_worktree(&f.host, "main", None, linked.clone(), "older".into(), None, Some(true), None)
        .await
        .unwrap();
    assert_eq!(result.copy_warning, None);
    for (name, contents) in [
        (".openidea/settings.toml", "local settings"),
        (".env", "local environment"),
        (".env.staged", "local staged addition"),
        (".env.target", "checkout content"),
        ("file.txt", "original\n"),
    ] {
        assert_eq!(std::fs::read_to_string(linked.join(name)).unwrap(), contents);
    }
    assert!(!linked.join(".env.secret").exists());
    assert!(!linked.join("old-only.txt").exists());

    let no_copy = f.root.with_file_name("without config");
    vcs::vcs_add_worktree(&f.host, "main", None, no_copy.clone(), "main".into(), Some("opt-out".into()), None, None)
        .await
        .unwrap();
    assert!(!no_copy.join(".env").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configuration_copy_failure_keeps_the_created_worktree() {
    let f = Fixture::new().await;
    std::fs::create_dir(f.root.join(".worktreeinclude")).unwrap();
    let include = vcs::vcs_worktree_include(&f.host, "main", None).await;
    assert!(matches!(include, Err(err) if err.kind == ide_core::error::ErrorKind::InvalidInput));
    let linked = f.root.with_file_name("still created");
    let result = vcs::vcs_add_worktree(&f.host, "main", None, linked.clone(), "HEAD".into(), None, Some(true), None)
        .await
        .unwrap();
    assert!(result.copy_warning.is_some_and(|error| error.contains(".worktreeinclude")));
    assert!(linked.join("file.txt").exists());
    assert_eq!(vcs::vcs_worktrees(&f.host, "main", None).await.unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn setup_runs_after_copy_in_the_new_worktree() {
    let f = Fixture::new().await;
    std::fs::write(f.root.join(".worktreeinclude"), ".env\n").unwrap();
    std::fs::write(f.root.join(".env"), "copied contents").unwrap();
    let script = setup_script(
        &f.root,
        "test \"$#\" -eq 1 || exit 11\npwd >setup-cwd.txt\nprintf '%s' \"$1\" >setup-arg.txt\ncat .env >setup-copy.txt\n",
        "if not \"%~2\"==\"\" exit /b 11\ncd >setup-cwd.txt\necho %1>setup-arg.txt\ntype .env >setup-copy.txt\n",
    );
    let linked = f.root.with_file_name("initialized worktree");
    let setup = vcs::WorktreeSetup { script, request: RequestId(1) };
    let result =
        vcs::vcs_add_worktree(&f.host, "main", None, linked.clone(), "HEAD".into(), None, Some(true), Some(setup))
            .await
            .unwrap();
    assert_eq!(result.copy_warning, None);
    assert_eq!(result.setup_warning, None);
    for name in ["setup-cwd.txt", "setup-arg.txt"] {
        let value = std::fs::read_to_string(linked.join(name)).unwrap();
        assert_eq!(dunce::canonicalize(value.trim().trim_matches('"')).unwrap(), linked);
    }
    assert_eq!(std::fs::read_to_string(linked.join("setup-copy.txt")).unwrap(), "copied contents");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_setup_refuses_creation_and_failed_setup_keeps_the_checkout() {
    let f = Fixture::new().await;
    let linked = f.root.with_file_name("failed setup");
    let setup = vcs::WorktreeSetup { script: f.root.join("does-not-exist"), request: RequestId(1) };
    assert!(
        vcs::vcs_add_worktree(&f.host, "main", None, linked.clone(), "HEAD".into(), None, None, Some(setup))
            .await
            .is_err()
    );
    assert!(!linked.exists());
    let script = setup_script(&f.root, "echo failed-script >&2\nexit 7\n", "echo failed-script 1>&2\nexit /b 7\n");
    let setup = vcs::WorktreeSetup { script, request: RequestId(2) };
    let result = vcs::vcs_add_worktree(&f.host, "main", None, linked.clone(), "HEAD".into(), None, None, Some(setup))
        .await
        .unwrap();
    let warning = result.setup_warning.unwrap();
    assert!(warning.contains("code 7") && warning.contains("failed-script"), "{warning}");
    assert!(linked.join("file.txt").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skipping_setup_stops_the_process_and_keeps_the_checkout() {
    let f = Fixture::new().await;
    let script = setup_script(&f.root, "touch started\nsleep 45\n", "echo started>started\n:wait\ngoto wait\n");
    let linked = f.root.with_file_name("skipped setup");
    let request = RequestId(3);
    let setup = vcs::WorktreeSetup { script, request };
    let (result, ()) = tokio::join!(
        vcs::vcs_add_worktree(&f.host, "main", None, linked.clone(), "HEAD".into(), None, None, Some(setup)),
        async {
            let started = tokio::time::timeout(Duration::from_secs(5), async {
                while !linked.join("started").is_file() {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await;
            f.host.cancel_request(request);
            started.unwrap();
        },
    );
    assert_eq!(result.unwrap().setup_warning, None);
    assert!(linked.join("file.txt").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tagged_worktree_can_be_locked_unlocked_and_pruned() {
    let f = Fixture::new().await;
    // The tag and branch share a short name but point to different commits.
    git(&f.root, &["tag", "release"]);
    let first = vcs::vcs_worktrees(&f.host, "main", None).await.unwrap()[0].head.clone();
    git(&f.root, &["commit", "--allow-empty", "-m", "next"]);
    git(&f.root, &["branch", "release"]);

    let linked = f.root.with_file_name("release copy");
    vcs::vcs_add_worktree(&f.host, "main", None, linked.clone(), "refs/tags/release".into(), None, None, None)
        .await
        .unwrap();
    let list = vcs::vcs_worktrees(&f.host, "main", None).await.unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[1].branch, None);
    assert_eq!(list[1].head, first);

    vcs::vcs_set_worktree_locked(&f.host, "main", None, linked.clone(), true).await.unwrap();
    assert!(vcs::vcs_worktrees(&f.host, "main", None).await.unwrap()[1].locked);
    vcs::vcs_prune_worktrees(&f.host, "main", None).await.unwrap();
    assert!(linked.join("file.txt").exists());
    vcs::vcs_set_worktree_locked(&f.host, "main", None, linked.clone(), false).await.unwrap();
    assert!(!vcs::vcs_worktrees(&f.host, "main", None).await.unwrap()[1].locked);

    std::fs::remove_dir_all(&linked).unwrap();
    assert!(vcs::vcs_worktrees(&f.host, "main", None).await.unwrap()[1].prunable);
    vcs::vcs_prune_worktrees(&f.host, "main", None).await.unwrap();
    assert_eq!(vcs::vcs_worktrees(&f.host, "main", None).await.unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn watcher_picks_up_a_worktree_added_below_the_project() {
    let f = Fixture::new().await;
    let linked = f.root.join("watched");
    git(&f.root, &["worktree", "add", "watched", "-b", "watched"]);
    wait_for_repos(&f.project, 2).await;
    let roots = f.project.repos().roots();
    assert!(roots.contains(&linked), "watcher did not discover the worktree added below the project: {roots:?}");
}

impl Fixture {
    async fn open(&self, root: &std::path::Path) {
        self.host.trust.decide(root, true, false).unwrap();
        let project = self.host.open_project("main", root).unwrap();
        wait_for_repos(&project, 1).await;
    }

    fn linked(&self, path: &std::path::Path, branch: &str) {
        git(&self.root, &["worktree", "add", "-b", branch, path.to_str().unwrap()]);
    }

    async fn assert_protected(&self, path: &std::path::Path) {
        for force in [false, true] {
            let error =
                vcs::vcs_remove_worktree(&self.host, "main", None, path.to_path_buf(), force).await.unwrap_err();
            assert_eq!(error.message, "Cannot remove a worktree containing the open project.");
            assert!(path.join("file.txt").exists());
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cannot_remove_the_open_linked_worktree_or_its_ancestor() {
    let f = Fixture::new().await;
    let linked = f.root.with_file_name("front");
    f.linked(&linked, "front");
    let nested = linked.join("src");
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(linked.join("file.txt"), "uncommitted changes\n").unwrap();
    for root in [&linked, &nested] {
        f.open(root).await;
        f.assert_protected(&linked).await;
        assert_eq!(std::fs::read_to_string(linked.join("file.txt")).unwrap(), "uncommitted changes\n");
        // Relative paths must be judged from the same repository as git uses.
        let error = vcs::vcs_remove_worktree(&f.host, "main", None, ".".into(), true).await.unwrap_err();
        assert_eq!(error.message, "Cannot remove a worktree containing the open project.");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sibling_with_a_shared_prefix_and_worktrees_below_the_project_stay_removable() {
    for force in [false, true] {
        let f = Fixture::new().await;
        let linked = f.root.with_file_name("front");
        let sibling = f.root.with_file_name("front-wt");
        f.linked(&linked, "front");
        f.linked(&sibling, "sibling");
        f.open(&sibling).await;
        vcs::vcs_remove_worktree(&f.host, "main", None, linked.clone(), force).await.unwrap();
        assert!(!linked.exists());
        assert!(sibling.exists());

        let below = sibling.join("below");
        f.linked(&below, "below");
        vcs::vcs_remove_worktree(&f.host, "main", Some(sibling.clone()), below.clone(), force).await.unwrap();
        assert!(!below.exists());

        let parent = f.root.parent().unwrap();
        f.open(parent).await;
        vcs::vcs_remove_worktree(&f.host, "main", Some(f.root.clone()), sibling.clone(), force).await.unwrap();
        assert!(!sibling.exists());
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn symlinked_project_root_is_protected() {
    let f = Fixture::new().await;
    let linked = f.root.with_file_name("front");
    f.linked(&linked, "front");
    let alias = f.root.with_file_name("alias");
    std::os::unix::fs::symlink(&linked, &alias).unwrap();
    f.open(&alias).await;
    f.assert_protected(&linked).await;
    f.assert_protected(&alias).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_project_and_worktree_paths_still_use_canonical_ancestors() {
    let f = Fixture::new().await;
    let linked = f.root.with_file_name("front");
    f.linked(&linked, "front");
    let nested = linked.join("src");
    std::fs::create_dir(&nested).unwrap();
    f.open(&nested).await;
    std::fs::remove_dir(&nested).unwrap();
    f.assert_protected(&linked).await;
    std::fs::remove_dir_all(&linked).unwrap();
    for force in [false, true] {
        let error =
            vcs::vcs_remove_worktree(&f.host, "main", Some(f.root.clone()), linked.clone(), force).await.unwrap_err();
        assert_eq!(error.message, "Cannot remove a worktree containing the open project.");
    }
}

#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tmp_alias_is_protected() {
    let f = Fixture::new().await;
    let linked = f.root.with_file_name("front");
    f.linked(&linked, "front");
    f.open(&linked).await;
    let alias = std::path::Path::new("/").join(linked.strip_prefix("/private").unwrap());
    f.assert_protected(&alias).await;
}
