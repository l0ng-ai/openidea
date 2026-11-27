//! `ui.read-clipboard` (API 1.11) through the `test.clipboard` fixture and a
//! scripted window answering `ClipboardRequested`: commands and view actions the
//! user ran read the window's clipboard, anything unattended is denied.

use base64::Engine;
use ide_host::plugins::*;
use ide_plugin::{HostError, Invocation, Limits, ViewEvent};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const ID: &str = "test.clipboard";

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/clipboard")
}

struct Workspace {
    root: PathBuf,
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
    fn apply_edits(&self, _: &Path, _: u64, _: &[ide_core::TextEdit], _: bool) -> Result<u64, HostError> {
        Err(HostError::NotFound("not open".into()))
    }
    fn trusted(&self, _: &Path) -> bool {
        true
    }
    fn project_of(&self, _: &str) -> Option<PathBuf> {
        Some(self.root.clone())
    }
    fn publish_diagnostics(&self, _: &str, _: &Path, _: Vec<ide_core::Diagnostic>) -> Result<(), HostError> {
        Ok(())
    }
}

/// The window: what it answers, and the requests it got (`(window, request id)`).
#[derive(Default)]
struct Window {
    answer: Option<ClipboardAnswer>,
    /// Answer from this window instead of the one asked.
    answer_as: Option<String>,
    requests: Vec<(Option<String>, String)>,
}

struct Fixture {
    host: Arc<PluginHost>,
    window: Arc<Mutex<Window>>,
    project: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let window = Arc::new(Mutex::new(Window::default()));
        let host_slot: Arc<Mutex<Option<std::sync::Weak<PluginHost>>>> = Arc::default();
        let (w, slot) = (window.clone(), host_slot.clone());
        // Answers on another thread, as the UI does through `plugin_answer_clipboard`.
        let sink = Arc::new(move |client: Option<&str>, e: PluginEvent| {
            let PluginEvent::ClipboardRequested { request_id, .. } = e else { return };
            let (client, w, slot) = (client.map(str::to_owned), w.clone(), slot.clone());
            std::thread::spawn(move || {
                let (answer, from) = {
                    let mut w = w.lock();
                    w.requests.push((client.clone(), request_id.clone()));
                    (w.answer.clone(), w.answer_as.clone().or(client).unwrap_or_default())
                };
                let host = slot.lock().as_ref().and_then(std::sync::Weak::upgrade).unwrap();
                if let Some(answer) = answer {
                    host.answer_clipboard(&from, &request_id, answer);
                }
            });
        });
        let host = Arc::new(PluginHost::new(tmp.path().join("plugins"), sink, Limits::default()).unwrap());
        *host_slot.lock() = Some(Arc::downgrade(&host));
        host.set_workspace(Some(Arc::new(Workspace { root: project.clone() })));
        host.load_all();
        host.startup_finished();
        host.install_from_dir(&fixture_dir(), &Consent::all()).unwrap();
        Self { host, window, project, _tmp: tmp }
    }

    fn inv(&self) -> Invocation {
        Invocation { client: Some("main".into()), workspace_root: Some(self.project.clone()), ..Invocation::default() }
    }

    fn answer(&self, answer: ClipboardAnswer) {
        self.window.lock().answer = Some(answer);
    }

    fn read(&self) -> Result<String, String> {
        self.host.run_command(ID, "read", None, self.inv()).map(Option::unwrap_or_default).map_err(|e| e.message)
    }

    /// What the last view action or event handler read.
    fn last(&self) -> String {
        self.host.run_command(ID, "last", None, self.inv()).unwrap().unwrap_or_default()
    }

    fn requests(&self) -> usize {
        self.window.lock().requests.len()
    }
}

fn content(text: Option<&str>, png: Option<&[u8]>) -> ClipboardAnswer {
    ClipboardAnswer::Content {
        text: text.map(str::to_owned),
        png: png.map(|png| base64::engine::general_purpose::STANDARD.encode(png)),
    }
}

#[test]
fn a_command_reads_the_text_and_image_of_its_window() {
    let f = Fixture::new();
    f.answer(content(Some("curl https://example.com"), None));
    assert_eq!(f.read().unwrap(), "text=curl https://example.com image=-");
    assert_eq!(f.window.lock().requests[0].0.as_deref(), Some("main"), "the invoking window is asked");

    f.answer(content(None, Some(&[0x89, b'P', b'N', b'G', 1, 2])));
    assert_eq!(f.read().unwrap(), "text=- image=6");
    f.answer(content(Some("caption"), Some(&[1, 2, 3])));
    assert_eq!(f.read().unwrap(), "text=caption image=3");
    // Empty: neither kind, also when the window sends empty strings.
    f.answer(content(None, None));
    assert_eq!(f.read().unwrap(), "text=- image=-");
    f.answer(ClipboardAnswer::Content { text: Some(String::new()), png: Some(String::new()) });
    assert_eq!(f.read().unwrap(), "text=- image=-");
}

#[test]
fn refusals_failures_and_oversized_content_are_errors() {
    let f = Fixture::new();
    f.answer(ClipboardAnswer::Refused);
    let err = f.read().unwrap_err();
    assert!(err.contains("clipboard.read (the user refused)"), "{err}");

    f.answer(ClipboardAnswer::Failed { message: "the WebView refused".into() });
    assert!(f.read().unwrap_err().contains("the WebView refused"));

    let large = vec![0u8; ide_plugin::MAX_CLIPBOARD_BYTES + 1];
    f.answer(content(None, Some(&large)));
    assert!(f.read().unwrap_err().contains("16 MiB"));
    f.answer(content(Some(&"x".repeat(ide_plugin::MAX_CLIPBOARD_BYTES + 1)), None));
    assert!(f.read().unwrap_err().contains("16 MiB"));
}

#[test]
fn reading_needs_its_own_grant() {
    let f = Fixture::new();
    f.answer(content(Some("secret"), None));
    f.host.set_capability(ID, "clipboard.read", false).unwrap();
    let err = f.read().unwrap_err();
    assert!(err.contains("clipboard.read"), "{err}");
    assert_eq!(f.requests(), 0, "the window is not asked");
}

#[test]
fn only_calls_the_user_ran_read_it() {
    let f = Fixture::new();
    f.answer(content(Some("secret"), None));
    let denied = |out: &str| out.starts_with("error: ") && out.contains("clipboard.read");

    // A view's button is the user's; a web view message is the page's own.
    f.host.view_event(ID, "clipboard", ViewEvent::Button { id: "read".into() }, f.inv()).unwrap();
    assert_eq!(f.last(), "text=secret image=-");
    assert_eq!(f.requests(), 1);
    f.host.view_event(ID, "clipboard", ViewEvent::Message { text: "read".into() }, f.inv()).unwrap();
    let last = f.last();
    assert!(denied(&last), "{last}");

    // An event handler.
    let now = Instant::now();
    let focused = f.project.join("a.txt").to_string_lossy().into_owned();
    f.host.post_events(Some("main"), vec![WorkbenchEvent::EditorFocused(Some(focused))]);
    f.host.flush_events_at(now + Duration::from_secs(3));
    assert!(f.host.wait_events(Duration::from_secs(10)));
    let last = f.last();
    assert!(denied(&last), "{last}");

    // A command another plugin ran through `command-runner`, and one with no window.
    let nested = Invocation { command_chain: vec!["other.plugin".into()], ..f.inv() };
    assert!(f.host.run_command(ID, "read", None, nested).unwrap_err().message.contains("clipboard.read"));
    let headless = Invocation { client: None, ..f.inv() };
    assert!(f.host.run_command(ID, "read", None, headless).unwrap_err().message.contains("clipboard.read"));
    assert_eq!(f.requests(), 1, "only the view's button asked the window");
}

#[test]
fn only_the_asked_window_answers() {
    let f = Fixture::new();
    f.window.lock().answer_as = Some("other".into());
    f.answer(content(Some("other window"), None));
    let host = f.host.clone();
    let inv = f.inv();
    let read = std::thread::spawn(move || host.run_command(ID, "read", None, inv));
    let started = Instant::now();
    while f.requests() == 0 {
        assert!(started.elapsed() < Duration::from_secs(10), "the window was not asked");
        std::thread::sleep(Duration::from_millis(10));
    }
    // The other window's answer was ignored, so the call still waits for `main`.
    std::thread::sleep(Duration::from_millis(200));
    assert!(!read.is_finished());
    let request = f.window.lock().requests[0].1.clone();
    assert!(f.host.answer_clipboard("main", &request, content(Some("main window"), None)));
    assert_eq!(read.join().unwrap().unwrap().as_deref(), Some("text=main window image=-"));
}

#[test]
fn the_capability_needs_api_1_11() {
    let tmp = tempfile::tempdir().unwrap();
    let pkg = tmp.path().join("clipboard");
    std::fs::create_dir_all(pkg.join("dist")).unwrap();
    let manifest = std::fs::read_to_string(fixture_dir().join("plugin.toml")).unwrap();
    std::fs::write(pkg.join("plugin.toml"), manifest.replace("^1.11", "^1.10")).unwrap();
    std::fs::copy(fixture_dir().join("dist/plugin.wasm"), pkg.join("dist/plugin.wasm")).unwrap();
    let host =
        PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    let err = host.install_from_dir(&pkg, &Consent::all()).unwrap_err();
    assert!(err.message.contains("new in plugin API 1.11"), "{err:?}");
}
