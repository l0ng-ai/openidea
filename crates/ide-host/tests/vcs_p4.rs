//! A project inside a Perforce workspace: the shared VCS commands answer for it,
//! and the Perforce commands manage its changelists. Runs against a throwaway
//! server (`p4d` through `rsh:`); skipped when `p4` or `p4d` (`$P4D`) is missing.
use ide_core::NullSink;
use ide_host::{
    Host, HostConfig,
    ops::{fs, vcs},
};
use ide_vcs::{ChangeKind, CommitOptions, LogQuery};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};

fn which(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|p| p.is_file())
}

/// Creates client `ws` of a new server below `base`; `None` without the tools.
fn workspace(base: &Path) -> Option<PathBuf> {
    let p4d = std::env::var_os("P4D").map(PathBuf::from).filter(|p| p.is_file()).or_else(|| which("p4d"))?;
    which("p4")?;
    static ENV: std::sync::Once = std::sync::Once::new();
    // SAFETY: set once, to the same value, before this binary runs `p4`.
    ENV.call_once(|| unsafe { std::env::set_var("P4CONFIG", ".p4config") });
    let root = base.join("ws");
    std::fs::create_dir_all(base.join("server")).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    let port =
        format!("rsh:{} -r {} -L {} -i", p4d.display(), base.join("server").display(), base.join("log").display());
    std::fs::write(root.join(".p4config"), format!("P4PORT={port}\nP4USER=ann\nP4CLIENT=ws\nP4CHARSET=none\n"))
        .unwrap();
    // Setup names the throwaway server itself; it must never reach a configured one.
    let p4 = |args: &[&str]| {
        let mut cmd = Command::new("p4");
        cmd.args(["-p", &port, "-u", "ann", "-c", "ws", "-C", "none"]).args(args);
        cmd.current_dir(&root).env("PWD", &root).env("P4CONFIG", ".p4config");
        cmd
    };
    let spec = p4(&["client", "-o"]).output().unwrap();
    assert!(spec.status.success() && !spec.stdout.is_empty(), "{}", String::from_utf8_lossy(&spec.stderr));
    let mut save = p4(&["client", "-i"]).stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap();
    std::io::Write::write_all(save.stdin.as_mut().unwrap(), &spec.stdout).unwrap();
    assert!(save.wait().unwrap().success());
    Some(root)
}

fn host(base: &Path) -> Host {
    Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    })
}

async fn wait_for_workspace(project: &ide_host::Project) -> bool {
    for _ in 0..500 {
        if !project.p4_workspaces().is_empty() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_perforce_project_edits_groups_and_submits() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let Some(root) = workspace(&base) else { return };
    let project_root = root.join("app");
    std::fs::create_dir_all(&project_root).unwrap();
    let file = project_root.join("main.txt");
    let other = project_root.join("other.txt");
    std::fs::write(&file, "one\ntwo\n").unwrap();
    std::fs::write(&other, "o\n").unwrap();

    let host = host(&base);
    host.trust.decide(&project_root, true, false).unwrap();
    let project = host.open_project("main", &project_root).unwrap();
    assert!(wait_for_workspace(&project).await, "the workspace above the project is found");
    assert!(project.p4_workspaces()[0].root().starts_with(&base));

    let roots = vcs::vcs_roots(&host, "main").await.unwrap();
    assert_eq!(roots.len(), 1);
    assert_eq!((roots[0].kind, roots[0].head.as_deref()), (vcs::VcsKind::Perforce, Some("ws")));
    assert_eq!(vcs::vcs_branch_info(&host, "main", None).await.unwrap().head.as_deref(), Some("ws"));
    assert!(vcs::vcs_branches(&host, "main", None).await.unwrap().is_empty());
    assert!(vcs::vcs_status(&host, "main").await.unwrap().is_empty());

    vcs::vcs_stage(&host, "main", vec![file.clone(), other.clone()]).await.unwrap();
    let status = vcs::vcs_status(&host, "main").await.unwrap();
    assert_eq!(status.iter().map(|f| f.unstaged).collect::<Vec<_>>(), [Some(ChangeKind::Added); 2]);
    let options = CommitOptions { stage: vec![file.clone().into(), other.clone().into()], ..Default::default() };
    let first = vcs::vcs_commit(&host, "main", None, "add files".into(), options).await.unwrap();

    // Synced files are read-only; making one writable opens it for edit.
    assert!(std::fs::metadata(&file).unwrap().permissions().readonly());
    assert!(!fs::fs_set_writable(&host, "main", file.clone(), true).unwrap());
    std::fs::write(&file, "one\nTWO\n").unwrap();
    let status = vcs::vcs_status_paths(&host, "main", vec![file.clone()]).await.unwrap();
    assert_eq!((status.len(), status[0].unstaged), (1, Some(ChangeKind::Modified)));
    assert_eq!(vcs::vcs_line_hunks(&host, "main", file.clone()).await.unwrap().len(), 1);
    assert!(vcs::vcs_diff_text(&host, "main", file.clone(), false).await.unwrap().contains("-two\n+TWO\n"));
    assert_eq!(vcs::vcs_file_at(&host, "main", file.clone(), None).await.unwrap().as_deref(), Some("one\ntwo\n"));

    let change =
        vcs::p4::p4_changelist_create(&host, "main", None, "feature".into(), vec![file.clone()]).await.unwrap();
    vcs::p4::p4_edit(&host, "main", vec![other.clone()], Some(change)).await.unwrap();
    let lists = vcs::p4::p4_changelists(&host, "main", None).await.unwrap();
    assert_eq!(lists.iter().map(|l| (l.number, l.files.len())).collect::<Vec<_>>(), [(0, 0), (change, 2)]);
    let reverted = vcs::p4::p4_revert_unchanged(&host, "main", None, Some(change)).await.unwrap();
    assert_eq!(reverted.files.len(), 1, "other.txt was opened but not changed");
    let second = vcs::p4::p4_submit(&host, "main", None, change, Some("edit main".into())).await.unwrap();
    assert!(vcs::vcs_status(&host, "main").await.unwrap().is_empty());

    let log = vcs::vcs_log(&host, "main", None, LogQuery { limit: 10, ..Default::default() }).await.unwrap();
    assert_eq!(log.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), [second.to_string(), first.clone()]);
    assert_eq!(vcs::vcs_log_details(&host, "main", None, second.to_string()).await.unwrap().message, "edit main");
    let files = vcs::vcs_commit_files(&host, "main", None, first).await.unwrap();
    assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["app/main.txt", "app/other.txt"]);
    let blame = vcs::vcs_blame(&host, "main", file.clone(), None, None).await.unwrap();
    assert_eq!(blame.iter().map(|l| l.summary.as_str()).collect::<Vec<_>>(), ["add files", "edit main"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_mode_never_runs_p4() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let Some(root) = workspace(&base) else { return };
    let host = host(&base);
    host.trust.decide(&root, false, false).unwrap();
    let project = host.open_project("main", &root).unwrap();
    project.refresh_repositories();
    assert!(project.p4_workspaces().is_empty(), "a P4CONFIG file can name a command to run");
    assert!(vcs::p4::p4_changelists(&host, "main", None).await.is_err());

    // Trusting the open project is enough: no reopening.
    host.set_project_trust(&root, true, false).await.unwrap();
    assert!(wait_for_workspace(&project).await, "the workspace shows up once the project is trusted");
    assert_eq!(vcs::p4::p4_changelists(&host, "main", None).await.unwrap().len(), 1);
}
