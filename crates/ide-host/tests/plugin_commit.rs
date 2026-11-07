//! The `commit` interface and the `commit-checker` export, through the
//! `test.commit` fixture and a scripted window answering `CommitRequested`.

use ide_core::ipc_path::to_ipc;
use ide_host::plugins::*;
use ide_plugin::{HostError, Invocation, Limits};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/commit")
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(["-c", "init.defaultBranch=main", "-c", "user.name=T", "-c", "user.email=t@example.com"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

struct Workspace {
    root: PathBuf,
    trusted: AtomicBool,
}

impl PluginWorkspace for Workspace {
    fn projects(&self) -> Vec<PathBuf> {
        vec![self.root.clone()]
    }
    fn buffer_text(&self, _: &Path) -> Option<String> {
        None
    }
    fn document(&self, _: &Path) -> Option<(u64, String)> {
        None
    }
    fn apply_edits(&self, _: &Path, _: u64, _: &[ide_core::TextEdit]) -> Result<u64, HostError> {
        Err(HostError::NotFound("not open".into()))
    }
    fn trusted(&self, _: &Path) -> bool {
        self.trusted.load(Ordering::Relaxed)
    }
    fn project_of(&self, _: &str) -> Option<PathBuf> {
        Some(self.root.clone())
    }
    fn publish_diagnostics(&self, _: &str, _: &Path, _: Vec<ide_core::Diagnostic>) -> Result<(), HostError> {
        Ok(())
    }
}

/// The window's Commit view: its draft, and whether the user types between
/// the plugin reading it and writing the message.
#[derive(Default)]
struct Window {
    revision: u64,
    message: String,
    selection: Option<CommitSelection>,
    type_after_reading: bool,
    requests: Vec<CommitRequest>,
}

struct Fixture {
    host: Arc<PluginHost>,
    window: Arc<Mutex<Window>>,
    workspace: Arc<Workspace>,
    project: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        git(&project, &["init", "-q"]);
        std::fs::write(project.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        git(&project, &["add", "."]);
        git(&project, &["commit", "-qm", "base"]);
        std::fs::write(project.join("a.txt"), "one\nDO NOT COMMIT\nthree\n").unwrap();

        let window = Arc::new(Mutex::new(Window { revision: 7, ..Window::default() }));
        let host_slot: Arc<Mutex<Option<std::sync::Weak<PluginHost>>>> = Arc::default();
        let (w, slot) = (window.clone(), host_slot.clone());
        // Answers on another thread, as the UI does through `plugin_answer_commit`.
        let sink = Arc::new(move |_: Option<&str>, e: PluginEvent| {
            let PluginEvent::CommitRequested { request_id, request, .. } = e else { return };
            let (w, slot) = (w.clone(), slot.clone());
            std::thread::spawn(move || {
                let answer = {
                    let mut w = w.lock();
                    w.requests.push(request.clone());
                    match request {
                        CommitRequest::Selection => {
                            let selection = w.selection.clone();
                            if w.type_after_reading {
                                w.revision += 1;
                            }
                            match selection {
                                Some(s) => CommitAnswer::Selection { selection: s },
                                None => CommitAnswer::NoRepository,
                            }
                        }
                        CommitRequest::SetMessage { revision, message } if revision == w.revision => {
                            w.message = message;
                            w.revision += 1;
                            CommitAnswer::Done
                        }
                        CommitRequest::SetMessage { .. } => CommitAnswer::Stale,
                    }
                };
                let host = slot.lock().as_ref().and_then(std::sync::Weak::upgrade);
                assert!(host.unwrap().answer_commit(&request_id, answer));
            });
        });
        let host = Arc::new(PluginHost::new(tmp.path().join("plugins"), sink, Limits::default()).unwrap());
        *host_slot.lock() = Some(Arc::downgrade(&host));
        let workspace = Arc::new(Workspace { root: project.clone(), trusted: AtomicBool::new(true) });
        host.set_workspace(Some(workspace.clone()));
        host.install_from_dir(&fixture_dir(), &Consent::all()).unwrap();
        Self { host, window, workspace, project, _tmp: tmp }
    }

    fn inv(&self) -> Invocation {
        Invocation { client: Some("main".into()), workspace_root: Some(self.project.clone()), ..Invocation::default() }
    }

    /// `a.txt` included whole, with `message`.
    fn selection(&self, message: &str) -> CommitSelection {
        let revision = self.window.lock().revision;
        CommitSelection {
            revision,
            message: message.into(),
            amend: false,
            repositories: vec![CommitSelectionRepo {
                root: self.project.clone().into(),
                options: ide_vcs::CommitOptions {
                    stage: vec![self.project.join("a.txt").into()],
                    run_hooks: true,
                    ..Default::default()
                },
            }],
        }
    }

    fn markers(&self, message: &str) -> Vec<PluginCommitCheckResult> {
        let check = PluginCommitCheckRef { plugin_id: "test.commit".into(), check: "markers".into() };
        let cancel = ide_core::CancellationToken::new();
        self.host.commit_checks(self.inv(), self.selection(message), vec![check], &cancel).unwrap()
    }
}

#[test]
fn a_command_reads_the_pending_commit_and_writes_its_message() {
    let f = Fixture::new();
    let selection = f.selection("");
    f.window.lock().selection = Some(selection);
    let out = f.host.run_command("test.commit", "describe", None, f.inv()).unwrap();
    assert_eq!(out.as_deref(), Some("chore: modified a.txt"));
    let w = f.window.lock();
    assert_eq!(w.message, "chore: modified a.txt");
    assert_eq!(w.revision, 8);
    // Reading the draft left the index alone: nothing is staged.
    let staged = Command::new("git").current_dir(&f.project).args(["diff", "--cached", "--name-only"]).output();
    assert!(staged.unwrap().stdout.is_empty());
}

#[test]
fn typing_meanwhile_makes_the_write_stale() {
    let f = Fixture::new();
    let selection = f.selection("");
    {
        let mut w = f.window.lock();
        w.selection = Some(selection);
        w.type_after_reading = true;
    }
    let err = f.host.run_command("test.commit", "describe", None, f.inv()).unwrap_err();
    assert!(err.message.contains("stale") || err.message.contains("changed"), "{}", err.message);
    assert_eq!(f.window.lock().message, "");
}

#[test]
fn no_repository_and_restricted_mode() {
    let f = Fixture::new();
    let err = f.host.run_command("test.commit", "describe", None, f.inv()).unwrap_err();
    assert!(err.message.contains("no repository"), "{}", err.message);

    f.workspace.trusted.store(false, Ordering::Relaxed);
    f.window.lock().requests.clear();
    let err = f.host.run_command("test.commit", "describe", None, f.inv()).unwrap_err();
    assert!(err.message.contains("Restricted Mode"), "{}", err.message);
    assert!(f.window.lock().requests.is_empty(), "the window is not asked");

    // Outside a window's command there is no Commit view to ask.
    let headless = Invocation { client: None, ..f.inv() };
    let err = f.host.run_command("test.commit", "describe", None, headless).unwrap_err();
    assert!(err.message.contains("from a command"), "{}", err.message);
}

#[test]
fn checks_report_the_message_and_markers_in_the_included_changes() {
    let f = Fixture::new();
    let results = f.markers("wip");
    assert_eq!(results.len(), 1);
    let r = &results[0];
    assert_eq!((r.title.as_str(), r.error.as_deref()), ("Commit Markers", None));
    let found: Vec<_> =
        r.problems.iter().map(|p| (p.message.as_str(), p.path.clone(), p.range.map(|r| r.start.line))).collect();
    assert_eq!(
        found,
        [
            ("The message does not start with `type: `.", None, None),
            ("Remove the DO NOT COMMIT marker.", Some(to_ipc(&f.project.join("a.txt"))), Some(1)),
        ]
    );
    assert_eq!(f.markers("fix: drop marker")[0].problems.len(), 1);

    // Unknown checks are not run, nor those of a plugin that lost `vcs.read`.
    let other = PluginCommitCheckRef { plugin_id: "test.commit".into(), check: "other".into() };
    let cancel = ide_core::CancellationToken::new();
    assert!(f.host.commit_checks(f.inv(), f.selection("x"), vec![other], &cancel).unwrap().is_empty());
    f.host.set_capability("test.commit", "vcs.read", false).unwrap();
    assert!(f.markers("wip").iter().all(|r| r.problems.is_empty()));
}

#[test]
fn the_commit_points_need_plugin_api_1_3() {
    let tmp = tempfile::tempdir().unwrap();
    let host =
        PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    // The manifest surgery below matches on `\n`; normalize so a CRLF checkout (Windows) behaves the same.
    let manifest = std::fs::read_to_string(fixture_dir().join("plugin.toml")).unwrap().replace("\r\n", "\n");
    for (what, manifest) in [
        (
            "commit.message",
            manifest.replace("[[contributes.commitChecks]]\nid = \"markers\"\ntitle = \"Commit Markers\"\n", ""),
        ),
        (
            "commitChecks",
            manifest.replace("[[contributes.menus]]\nmenu = \"commit.message\"\ncommand = \"describe\"\n", ""),
        ),
    ] {
        let pkg = tmp.path().join(what);
        std::fs::create_dir_all(pkg.join("dist")).unwrap();
        std::fs::copy(fixture_dir().join("dist/plugin.wasm"), pkg.join("dist/plugin.wasm")).unwrap();
        std::fs::write(pkg.join("plugin.toml"), manifest.replace("\"^1.3\"", "\"^1.2\"")).unwrap();
        let err = host.install_from_dir(&pkg, &Consent::all()).unwrap_err();
        assert!(err.message.contains("new in plugin API 1.3") && err.message.contains(what), "{what}: {}", err.message);
    }
}
