use ide_core::NullSink;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn command_added_worktree_joins_the_repository_set() {
    let f = Fixture::new().await;
    let linked = f.root.join("linked");
    vcs::vcs_add_worktree(&f.host, "main", None, linked.clone(), "main".into(), Some("topic".into())).await.unwrap();
    let roots = f.project.repos().roots();
    assert!(roots.contains(&linked), "worktree below the project did not join the repository set: {roots:?}");
    assert_eq!(roots.len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn removed_worktree_leaves_the_repository_set() {
    let f = Fixture::new().await;
    let linked = f.root.join("linked");
    vcs::vcs_add_worktree(&f.host, "main", None, linked.clone(), "main".into(), Some("topic".into())).await.unwrap();
    assert_eq!(f.project.repos().all().len(), 2);
    vcs::vcs_remove_worktree(&f.host, "main", None, linked, false).await.unwrap();
    assert_eq!(f.project.repos().all().len(), 1);
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
