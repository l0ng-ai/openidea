//! `events.watch-paths` (API 1.18): files outside a project, within `fs.read` grants,
//! per window project, ending with the project, the window, or the grant.
use ide_core::ipc_path::to_ipc;
use ide_host::plugins::{Consent, PluginHost, PluginWorkspace};
use ide_plugin::{FilesChanged, HostError, Invocation, Limits};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const ID: &str = "watch-paths";

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/watch-paths")
}

/// Windows and the project each shows.
#[derive(Default)]
struct Windows(Mutex<BTreeMap<String, PathBuf>>);

impl PluginWorkspace for Windows {
    fn projects(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = self.0.lock().values().cloned().collect();
        roots.sort();
        roots.dedup();
        roots
    }
    fn buffer_text(&self, _: &Path) -> Option<String> {
        None
    }
    fn document(&self, _: &Path) -> Option<(u64, String)> {
        None
    }
    fn apply_edits(&self, _: &Path, _: u64, _: &[ide_core::TextEdit], _: bool) -> Result<u64, HostError> {
        Err(HostError::NotFound("not open".into()))
    }
    fn trusted(&self, _: &Path) -> bool {
        true
    }
    fn project_of(&self, window: &str) -> Option<PathBuf> {
        self.0.lock().get(window).cloned()
    }
    fn publish_diagnostics(&self, _: &str, _: &Path, _: Vec<ide_core::Diagnostic>) -> Result<(), HostError> {
        Ok(())
    }
}

struct Setup {
    _tmp: tempfile::TempDir,
    host: PluginHost,
    windows: Arc<Windows>,
    outer: PathBuf,
    inner: PathBuf,
    external: PathBuf,
}

/// An `outer` project with an `inner` one nested in it, each in its own window, and
/// an `external` directory outside both that the plugin may read (and `outer` too
/// with `grant_outer`).
fn setup() -> Setup {
    setup_granting(false)
}

fn setup_granting(grant_outer: bool) -> Setup {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let (outer, external) = (base.join("outer"), base.join("external"));
    let inner = outer.join("inner");
    std::fs::create_dir_all(&inner).unwrap();
    std::fs::create_dir_all(external.join("inc")).unwrap();
    std::fs::write(external.join("Taskfile.yml"), "version: '3'\n").unwrap();
    std::fs::write(base.join("secret.yml"), "no").unwrap();
    let package = base.join("package");
    copy_dir(&fixture(), &package);
    let manifest = package.join("plugin.toml");
    let mut grants = format!("\"fs.read:{}\"", to_ipc(&external));
    if grant_outer {
        grants += &format!(", \"fs.read:{}\"", to_ipc(&outer));
    }
    let text = std::fs::read_to_string(&manifest).unwrap().replace("\"fs.read:/opt/watched\"", &grants);
    std::fs::write(&manifest, text).unwrap();
    let host = PluginHost::new(base.join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    let windows = Arc::new(Windows::default());
    windows.0.lock().insert("outer".into(), outer.clone());
    windows.0.lock().insert("inner".into(), inner.clone());
    host.set_workspace(Some(windows.clone()));
    host.load_all();
    host.startup_finished();
    host.install_from_dir(&package, &Consent::all()).unwrap();
    Setup { _tmp: tmp, host, windows, outer, inner, external }
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if entry.file_name() == "target" {
            continue;
        }
        if src.is_dir() { copy_dir(&src, &dst) } else { std::fs::copy(&src, &dst).map(|_| ()).unwrap() }
    }
}

impl Setup {
    fn watch(&self, window: &str, paths: &[&Path]) -> Result<(), String> {
        let arg = paths.iter().map(|p| to_ipc(p)).collect::<Vec<_>>().join("\n");
        let inv = Invocation {
            client: Some(window.into()),
            workspace_root: self.windows.project_of(window),
            ..Default::default()
        };
        self.host.run_command(ID, "watch", Some(&arg), inv).map(|_| ()).map_err(|e| e.message)
    }

    fn received(&self) -> Vec<FilesChanged> {
        let stored = self.host.run_command(ID, "events", None, Invocation::default()).unwrap();
        stored.map(|s| serde_json::from_str(&s).unwrap()).unwrap_or_default()
    }

    /// Delivers what the watchers saw until `done` holds (10 s at most).
    fn until(&self, mut done: impl FnMut(&[FilesChanged]) -> bool) -> Vec<FilesChanged> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            self.host.flush_events();
            self.host.wait_events(Duration::from_secs(5));
            let received = self.received();
            if done(&received) || Instant::now() > deadline {
                return received;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// What arrives within the time a watcher reports a change.
    fn settle(&self) -> Vec<FilesChanged> {
        let deadline = Instant::now() + Duration::from_millis(2500);
        while Instant::now() < deadline {
            self.host.flush_events();
            self.host.wait_events(Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(100));
        }
        self.received()
    }
}

fn changed(batches: &[FilesChanged]) -> Vec<String> {
    let mut paths: Vec<String> =
        batches.iter().flat_map(|b| b.created.iter().chain(&b.modified).chain(&b.removed).cloned()).collect();
    paths.sort();
    paths.dedup();
    paths
}

#[test]
fn changes_to_watched_files_and_directory_entries_reach_the_plugin() {
    let s = setup();
    let (taskfile, inc) = (s.external.join("Taskfile.yml"), s.external.join("inc"));
    s.watch("outer", &[&taskfile, &inc]).unwrap();
    // Let the watchers start before changing anything.
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(&taskfile, "version: '3'\ntasks: {}\n").unwrap();
    std::fs::write(inc.join("common.yml"), "tasks: {}\n").unwrap();
    std::fs::write(s.external.join("unwatched.yml"), "").unwrap();
    std::fs::create_dir_all(inc.join("deep")).unwrap();
    std::fs::write(inc.join("deep/below.yml"), "").unwrap();
    let want = [to_ipc(&taskfile), to_ipc(&inc.join("common.yml"))];
    let received = s.until(|b| want.iter().all(|w| changed(b).contains(w)));
    let paths = changed(&received);
    assert!(want.iter().all(|w| paths.contains(w)), "{paths:?}");
    assert!(!paths.contains(&to_ipc(&s.external.join("unwatched.yml"))), "{paths:?}");
    assert!(!paths.contains(&to_ipc(&inc.join("deep/below.yml"))), "directories are watched flat: {paths:?}");
    assert!(received.iter().all(|b| b.project.as_deref() == Some(to_ipc(&s.outer).as_str())));

    // Removal and re-creation of a watched file (an atomic save) keep it watched.
    std::fs::remove_file(&taskfile).unwrap();
    let gone = s.until(|b| b.iter().any(|b| b.removed.contains(&to_ipc(&taskfile))));
    assert!(gone.iter().any(|b| b.removed.contains(&to_ipc(&taskfile))));
    let before = gone.len();
    std::fs::write(&taskfile, "version: '3'\n").unwrap();
    let back = s.until(|b| {
        b[before..].iter().any(|b| b.created.contains(&to_ipc(&taskfile)) || b.modified.contains(&to_ipc(&taskfile)))
    });
    assert!(back.len() > before, "re-created file reported");

    // An empty list stops watching.
    s.watch("outer", &[]).unwrap();
    let count = s.received().len();
    std::fs::write(&taskfile, "version: '3'\n# stopped\n").unwrap();
    assert_eq!(s.settle().len(), count);
}

#[test]
fn watch_paths_refuses_what_the_plugin_may_not_read_or_already_gets() {
    let s = setup();
    let base = s.external.parent().unwrap().to_path_buf();
    let err = s.watch("outer", &[&base.join("secret.yml")]).unwrap_err();
    assert!(err.contains("fs.read"), "{err}");
    // Checked where it really is: a link inside the grant to a file outside it.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(base.join("secret.yml"), s.external.join("link.yml")).unwrap();
        let err = s.watch("outer", &[&s.external.join("link.yml")]).unwrap_err();
        assert!(err.contains("fs.read"), "{err}");
    }
    let err = s.watch("outer", &[&s.external.join("missing.yml")]).unwrap_err();
    assert!(err.contains("no such file"), "{err}");
    let many: Vec<PathBuf> = (0..33).map(|_| s.external.join("Taskfile.yml")).collect();
    let err = s.watch("outer", &many.iter().map(PathBuf::as_path).collect::<Vec<_>>()).unwrap_err();
    assert!(err.contains("at most 32"), "{err}");
    // No window project to belong to.
    let inv = Invocation { client: None, workspace_root: None, ..Default::default() };
    let err = s.host.run_command(ID, "watch", Some(&to_ipc(&s.external.join("Taskfile.yml"))), inv).unwrap_err();
    assert!(err.message.contains("window's project"), "{}", err.message);
}

#[test]
fn project_files_are_refused_and_nested_projects_watch_apart() {
    // The outer project is granted too: the refusal is about the project, not the grant.
    let s = setup_granting(true);
    std::fs::write(s.inner.join("Taskfile.yml"), "").unwrap();
    std::fs::write(s.outer.join("Taskfile.yml"), "").unwrap();
    let err = s.watch("inner", &[&s.inner.join("Taskfile.yml")]).unwrap_err();
    assert!(err.contains("inside the project"), "{err}");
    let err = s.watch("outer", &[&s.inner.join("Taskfile.yml")]).unwrap_err();
    assert!(err.contains("inside the project"), "a nested project's files are the outer project's too: {err}");
    // From the inner window, the outer project's files are outside its project.
    s.watch("inner", &[&s.outer.join("Taskfile.yml")]).unwrap();

    let (taskfile, inc) = (s.external.join("Taskfile.yml"), s.external.join("inc"));
    s.watch("inner", &[&taskfile]).unwrap();
    s.watch("outer", &[&inc]).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(&taskfile, "version: '3'\n# inner\n").unwrap();
    std::fs::write(inc.join("outer.yml"), "").unwrap();
    let received = s.until(|b| {
        b.iter().any(|b| b.project.as_deref() == Some(to_ipc(&s.inner).as_str()))
            && b.iter().any(|b| b.project.as_deref() == Some(to_ipc(&s.outer).as_str()))
    });
    for batch in &received {
        let paths = changed(std::slice::from_ref(batch));
        if batch.project.as_deref() == Some(to_ipc(&s.inner).as_str()) {
            assert_eq!(paths, [to_ipc(&taskfile)], "inner's watch sees only its file");
        } else {
            assert_eq!(batch.project.as_deref(), Some(to_ipc(&s.outer).as_str()));
            assert_eq!(paths, [to_ipc(&inc.join("outer.yml"))], "outer's watch sees only its directory");
        }
    }

    // Closing the inner project ends its watch only.
    s.windows.0.lock().remove("inner");
    s.host.project_closed(&s.inner, "inner");
    let count = s.received().len();
    std::fs::write(&taskfile, "version: '3'\n# closed\n").unwrap();
    std::fs::write(inc.join("still.yml"), "").unwrap();
    let after = s.until(|b| b.len() > count && changed(&b[count..]).contains(&to_ipc(&inc.join("still.yml"))));
    let later = changed(&after[count..]);
    assert!(later.contains(&to_ipc(&inc.join("still.yml"))), "{later:?}");
    assert!(!later.contains(&to_ipc(&taskfile)), "the closed project's watch ended: {later:?}");
}

#[test]
fn watches_end_when_the_window_closes_or_the_grant_is_revoked() {
    let s = setup();
    let taskfile = s.external.join("Taskfile.yml");
    s.watch("outer", &[&taskfile]).unwrap();
    s.host.forget_client("outer");
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(&taskfile, "version: '3'\n# window closed\n").unwrap();
    assert!(s.settle().is_empty(), "the closed window's watch ended");

    s.watch("inner", &[&taskfile]).unwrap();
    s.host.set_capability(ID, &format!("fs.read:{}", to_ipc(&s.external)), false).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(&taskfile, "version: '3'\n# revoked\n").unwrap();
    assert!(s.settle().is_empty(), "revoking the grant ends the watch");
    let err = s.watch("inner", &[&taskfile]).unwrap_err();
    assert!(err.contains("fs.read"), "{err}");
}
