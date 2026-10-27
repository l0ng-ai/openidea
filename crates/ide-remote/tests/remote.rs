//! Deployment and run targets against the in-process SSH / SFTP server.

use ide_core::remote_settings::{DeploymentMapping, DeploymentServer, DeploymentSettings, RunTarget, SshAuth};
use ide_core::{CancellationToken, IdeEvent, SharedSink};
use ide_remote::{Deployment, Excludes, Mappings, RemoteRuns, RemoteStart, SyncAction, SyncStatus, SyncStep};
use ide_run::{OutputChunk, RunConfig};
use ide_ssh::{RemoteFs, Session, SshFiles, SshTarget};
use parking_lot::Mutex;
use std::sync::Arc;

struct Env {
    _tmp: tempfile::TempDir,
    project: std::path::PathBuf,
    server_root: std::path::PathBuf,
    session: Arc<Session>,
}

async fn env() -> Env {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("project");
    let server_root = tmp.path().join("server");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::create_dir_all(project.join(".git")).unwrap();
    std::fs::create_dir_all(&server_root).unwrap();
    std::fs::write(project.join("src/main.py"), "print('hi')\n").unwrap();
    std::fs::write(project.join("README.md"), "# demo\n").unwrap();
    std::fs::write(project.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let port = ide_ssh::testing::sshd(server_root.clone(), Arc::new(|cmd| (format!("ran: {cmd}"), 0))).await;
    let files = SshFiles { known_hosts: tmp.path().join("known_hosts"), config: None };
    let target = SshTarget {
        host: "127.0.0.1".into(),
        port: Some(port),
        user: "dev".into(),
        auth: SshAuth::Password,
        key_file: String::new(),
    };
    let session = match Session::connect(&target, Some("secret"), &files).await {
        Err(ide_ssh::ConnectError::UnknownHostKey(k)) => {
            k.trust(&files.known_hosts).unwrap();
            Session::connect(&target, Some("secret"), &files).await.ok().unwrap()
        }
        other => other.ok().unwrap(),
    };
    Env { _tmp: tmp, project, server_root, session: Arc::new(session) }
}

fn server() -> DeploymentServer {
    DeploymentServer {
        id: "s".into(),
        name: "staging".into(),
        root_path: "/srv".into(),
        mappings: vec![DeploymentMapping { local: String::new(), deployment: "app".into(), web: String::new() }],
        ..Default::default()
    }
}

fn no_progress() -> impl FnMut(&str, usize, usize) + Send {
    |_, _, _| {}
}

#[tokio::test]
async fn uploads_compares_syncs_and_downloads() {
    let env = env().await;
    let fs = RemoteFs::new(env.session.sftp().await.unwrap());
    let server = server();
    let settings = DeploymentSettings::default();
    let map = Mappings::new(&server, &env.project, "/srv");
    let exclude = Excludes::new(&settings, &server, "/srv");
    let d = Deployment { fs: &fs, map: &map, exclude: &exclude, preserve_time: true, cancel: CancellationToken::new() };

    let report = d.upload(std::slice::from_ref(&env.project), &mut no_progress()).await;
    assert_eq!((report.files, report.errors.len()), (2, 0), "{report:?}");
    assert_eq!(std::fs::read_to_string(env.server_root.join("srv/app/src/main.py")).unwrap(), "print('hi')\n");
    assert!(!env.server_root.join("srv/app/.git").exists(), ".git is excluded by name");

    let same = d.compare(&env.project).await.unwrap();
    assert!(same.iter().all(|e| e.status == SyncStatus::Same), "{same:?}");

    // A new local file, a file only on the server, a remote change.
    std::fs::write(env.project.join("src/new.py"), "x = 1\n").unwrap();
    std::fs::write(env.server_root.join("srv/app/remote.txt"), "server side\n").unwrap();
    std::fs::write(env.server_root.join("srv/app/README.md"), "# changed on the server, longer\n").unwrap();
    let file = std::fs::File::options().write(true).open(env.server_root.join("srv/app/README.md")).unwrap();
    file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60)).unwrap();
    let entries = d.compare(&env.project).await.unwrap();
    let status = |p: &str| entries.iter().find(|e| e.path == p).map(|e| e.status);
    assert_eq!(status("src/new.py"), Some(SyncStatus::LocalOnly));
    assert_eq!(status("remote.txt"), Some(SyncStatus::RemoteOnly));
    assert_eq!(status("README.md"), Some(SyncStatus::RemoteNewer));
    assert_eq!(status("src/main.py"), Some(SyncStatus::Same));

    let steps = vec![
        SyncStep { path: "src/new.py".into(), action: SyncAction::Upload },
        SyncStep { path: "README.md".into(), action: SyncAction::Download },
        SyncStep { path: "remote.txt".into(), action: SyncAction::DeleteRemote },
    ];
    let report = d.apply(&steps, &mut no_progress()).await;
    assert_eq!((report.files, report.errors.len()), (3, 0), "{report:?}");
    assert!(env.server_root.join("srv/app/src/new.py").is_file());
    assert!(!env.server_root.join("srv/app/remote.txt").exists());
    assert_eq!(std::fs::read_to_string(env.project.join("README.md")).unwrap(), "# changed on the server, longer\n");

    // Download a folder, then delete it remotely.
    std::fs::remove_dir_all(env.project.join("src")).unwrap();
    let report = d.download(&[env.project.join("src")], &mut no_progress()).await;
    assert_eq!((report.files, report.errors.len()), (2, 0), "{report:?}");
    assert!(env.project.join("src/main.py").is_file());
    let report = d.delete_remote(&[env.project.join("src")]).await;
    assert_eq!(report.files, 1);
    assert!(!env.server_root.join("srv/app/src").exists());

    // Sync before a run uploads only what changed.
    let report = d.push_changes(&env.project, &mut no_progress()).await.unwrap();
    assert_eq!(report.files, 2, "{report:?}");
    assert_eq!(d.push_changes(&env.project, &mut no_progress()).await.unwrap().files, 0);
}

struct Sink(Mutex<Vec<IdeEvent>>);

impl ide_core::EventSink for Sink {
    fn emit(&self, event: IdeEvent) {
        self.0.lock().push(event);
    }
}

#[tokio::test]
async fn runs_a_configuration_on_a_target() {
    let env = env().await;
    let runs = RemoteRuns::new();
    let target =
        RunTarget { id: "t".into(), name: "box".into(), python: "/usr/bin/python3".into(), ..Default::default() };
    let config = RunConfig {
        id: "main".into(),
        name: "main".into(),
        kind: "python".into(),
        command: "python3".into(),
        args: vec![env.project.join("src/main.py").to_string_lossy().into_owned()],
        cwd: None,
        env: Default::default(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let output: Arc<Mutex<String>> = Arc::default();
    let out = output.clone();
    let sink = Arc::new(Sink(Mutex::default()));
    let start = RemoteStart {
        session: env.session.clone(),
        target,
        root: env.project.clone(),
        remote_root: "/home/dev/demo".into(),
        sync: None,
    };
    let info = runs.start(
        start,
        &config,
        sink.clone() as SharedSink,
        Box::new(move |chunk| match chunk {
            OutputChunk::Stdout { text } | OutputChunk::Stderr { text } | OutputChunk::System { text } => {
                out.lock().push_str(&text)
            }
        }),
    );
    assert!(runs.contains(info.id));
    for _ in 0..200 {
        if !sink.0.lock().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let events = sink.0.lock().clone();
    assert!(matches!(events.as_slice(), [IdeEvent::RunExited { code: Some(0), .. }]), "{events:?}");
    let text = output.lock().clone();
    assert!(text.contains("ran: cd /home/dev/demo && exec /usr/bin/python3 /home/dev/demo/src/main.py"), "{text}");
    assert!(text.contains("Process finished with exit code 0"), "{text}");
    assert!(!runs.list()[0].running);
}
