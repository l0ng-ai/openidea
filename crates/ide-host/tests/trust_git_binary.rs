//! Which git executable each window's repositories run. Its own test binary: the default
//! executable (global settings) is process-wide.
#![cfg(unix)]
use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;

fn host(base: &Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

/// A repository with `tools/git`: it appends a line to `marker`, waits while `gate` exists,
/// then runs the real git.
fn repo_with_wrapper(root: &Path, marker: &Path, gate: &Path) {
    std::fs::create_dir_all(root.join(".openidea")).unwrap();
    std::fs::create_dir_all(root.join("tools")).unwrap();
    let real = ide_vcs::detected_git_executable().expect("git is installed");
    let wrapper = root.join("tools/git");
    let script = format!(
        "#!/bin/sh\necho run >> '{}'\ni=0\nwhile [ -e '{}' ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done\nexec '{}' \"$@\"\n",
        marker.display(),
        gate.display(),
        real.display()
    );
    std::fs::write(&wrapper, script).unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let init = std::process::Command::new(&real).arg("init").arg("-q").arg(root).output().unwrap();
    assert!(init.status.success(), "{}", String::from_utf8_lossy(&init.stderr));
}

fn runs(marker: &Path) -> usize {
    std::fs::read_to_string(marker).map_or(0, |s| s.lines().count())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_project_git_executable_stays_with_its_project_while_another_window_runs_git() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let host = host(&base);
    let (a, c) = (base.join("a"), base.join("c"));
    let (a_marker, c_marker, gate) = (base.join("a.marker"), base.join("c.marker"), base.join("gate"));
    repo_with_wrapper(&a, &a_marker, &gate);
    repo_with_wrapper(&c, &c_marker, &gate);
    // Relative: resolved against the repository that runs it, so C has a `tools/git` of its own.
    std::fs::write(a.join(".openidea/settings.toml"), "[vcs.git]\nexecutable = \"tools/git\"\n").unwrap();
    let project_a = host.open_project("a", &a).unwrap();
    host.open_project("c", &c).unwrap();
    for root in [&a, &c] {
        host.set_project_trust(root, true, false).await.unwrap();
    }

    // Project A runs two git commands in one go, as `compare_paths` does; window C runs its own
    // git between them.
    std::fs::write(&gate, "").unwrap();
    let two_commands = tokio::task::spawn_blocking(move || {
        project_a.with_repo(|repo| {
            repo.remotes()?;
            repo.remotes()
        })
    });
    for _ in 0..200 {
        if runs(&a_marker) > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(runs(&a_marker), 1, "control: project A's first command runs A's git");
    ops::vcs::vcs_status(&host, "c").await.unwrap();
    ops::vcs::vcs_remotes(&host, "c", None).await.unwrap();
    std::fs::remove_file(&gate).unwrap();
    two_commands.await.unwrap().unwrap();

    assert_eq!(runs(&a_marker), 2, "project A's second command lost A's git once window C ran git");
    assert_eq!(runs(&c_marker), 0, "project C has no git setting but ran A's relative tools/git");
    host.shutdown().await;
}

/// An agent task opens repositories of its own (the project's, then its worktree): their git is
/// the project's too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_task_worktree_runs_the_project_git() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let host = host(&base);
    let root = base.join("a");
    let marker = base.join("a.marker");
    repo_with_wrapper(&root, &marker, &base.join("no-gate"));
    let real = ide_vcs::detected_git_executable().unwrap();
    let commit = std::process::Command::new(&real)
        .arg("-C")
        .arg(&root)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false"])
        .args(["commit", "-q", "--allow-empty", "-m", "init"])
        .output()
        .unwrap();
    assert!(commit.status.success(), "{}", String::from_utf8_lossy(&commit.stderr));
    let wrapper = root.join("tools/git");
    std::fs::write(root.join(".openidea/settings.toml"), format!("[vcs.git]\nexecutable = {wrapper:?}\n")).unwrap();
    host.open_project("a", &root).unwrap();
    host.set_project_trust(&root, true, false).await.unwrap();

    let task = ops::agent::agent_create(
        &host,
        "a",
        ide_agent::NewAgentTask {
            prompt: ide_agent::AgentPrompt { text: "Say hi".into(), ..Default::default() },
            provider: "codex".into(),
            isolation: ide_agent::Isolation::Worktree,
            idle: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(task.cwd.0.join(".git").exists(), "the task has its worktree");
    let created = runs(&marker);
    assert!(created > 0, "creating the task's worktree ran another git than the project's");

    ops::agent::agent_delete(&host, "a", task.id, true).await.unwrap();
    assert!(runs(&marker) > created, "removing the task's worktree ran another git than the project's");
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_status_does_not_select_the_project_git_for_other_windows() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let host = host(&base);
    let root = base.join("malicious");
    std::fs::create_dir_all(root.join(".openidea")).unwrap();
    let marker = base.join("git.marker");
    let git = root.join("git");
    std::fs::write(&git, format!("#!/bin/sh\nprintf executed > '{}'\n", marker.display())).unwrap();
    std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(root.join(".openidea/settings.toml"), format!("[vcs.git]\nexecutable = {:?}\n", git)).unwrap();
    ide_vcs::init(&root).unwrap();

    host.open_project("main", &root).unwrap();
    ops::vcs::vcs_status(&host, "main").await.unwrap();

    let _ = ide_vcs::git_version(None);
    assert!(!marker.exists(), "another window's next Git command would run the project's binary");
}
