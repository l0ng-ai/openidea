//! End-to-end tests of the plugin host against real components.
//!
//! The components are checked in (`plugins/hello/dist/plugin.wasm`,
//! `crates/ide-plugin/tests/fixtures/misbehave/dist/plugin.wasm`) so tests need no
//! wasm toolchain. Rebuild them with `plugins/build.sh hello` and
//! `plugins/build.sh crates/ide-plugin/tests/fixtures/misbehave` after
//! changing their source or `wit/`.

use ide_host::plugins::*;
use ide_plugin::{EditorContext, HostError, Invocation, Limits};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

type Events = Arc<Mutex<Vec<(Option<String>, PluginEvent)>>>;

/// What plugins see of the test project: real `Documents`, as in the IDE.
struct TestWorkspace {
    root: PathBuf,
    documents: Arc<ide_workspace::Documents>,
    trusted: bool,
    /// (producer, path) → published diagnostics.
    diagnostics: Mutex<std::collections::BTreeMap<(String, PathBuf), Vec<ide_core::Diagnostic>>>,
    /// plugin → its settings as the user set them.
    settings: Mutex<std::collections::BTreeMap<String, serde_json::Map<String, serde_json::Value>>>,
}

impl TestWorkspace {
    fn new(root: &Path) -> Arc<Self> {
        let documents = ide_workspace::Documents::new(
            Arc::new(ide_core::NullSink),
            Box::new(|_: &Path, _: Option<&str>| ide_core::LanguageId::new("text")),
        );
        Arc::new(Self {
            root: root.to_path_buf(),
            documents: Arc::new(documents),
            trusted: true,
            diagnostics: Mutex::default(),
            settings: Mutex::default(),
        })
    }

    /// Opens `rel` in an "editor": the invocation's focused editor.
    fn open(&self, rel: &str, selections: &[(u32, u32, u32, u32)]) -> EditorContext {
        let path = self.root.join(rel);
        self.documents.open(&path).unwrap();
        let selections = selections
            .iter()
            .map(|&(a, b, c, d)| ide_core::Range::new(ide_core::Pos::new(a, b), ide_core::Pos::new(c, d)))
            .collect();
        EditorContext { path, language: "text".into(), selections }
    }

    fn text(&self, rel: &str) -> String {
        self.documents.text_of(&self.root.join(rel)).unwrap()
    }

    /// The user types at the start of the document.
    fn type_text(&self, rel: &str, text: &str) {
        let doc = self.documents.by_path(&self.root.join(rel)).unwrap();
        let edit = ide_core::TextEdit { range: ide_core::Range::default(), new_text: text.into() };
        self.documents.apply_edits(doc, &[edit]).unwrap();
    }
}

impl PluginWorkspace for TestWorkspace {
    fn projects(&self) -> Vec<PathBuf> {
        vec![self.root.clone()]
    }
    fn buffer_text(&self, path: &Path) -> Option<String> {
        self.documents.text_of(path)
    }
    fn document(&self, path: &Path) -> Option<(u64, String)> {
        let snap = self.documents.snapshot(self.documents.by_path(path)?).ok()?;
        Some((u64::from(snap.version), snap.text))
    }
    fn apply_edits(&self, path: &Path, version: u64, edits: &[ide_core::TextEdit]) -> Result<u64, HostError> {
        let doc = self.documents.by_path(path).ok_or_else(|| HostError::NotFound("not open".into()))?;
        match self.documents.apply_edits_at(doc, version as u32, edits) {
            Ok(Some(v)) => Ok(u64::from(v)),
            Ok(None) => Err(HostError::Stale),
            Err(e) => Err(HostError::Failed(e.message)),
        }
    }
    fn trusted(&self, _root: &Path) -> bool {
        self.trusted
    }
    fn project_of(&self, _window: &str) -> Option<PathBuf> {
        Some(self.root.clone())
    }
    fn publish_diagnostics(
        &self,
        source: &str,
        path: &Path,
        items: Vec<ide_core::Diagnostic>,
    ) -> Result<(), HostError> {
        if !path.starts_with(&self.root) {
            return Err(HostError::Invalid("not in the project".into()));
        }
        self.diagnostics.lock().insert((source.to_owned(), path.to_path_buf()), items);
        Ok(())
    }
    fn plugin_settings(&self, plugin: &str, _root: Option<&Path>) -> serde_json::Map<String, serde_json::Value> {
        self.settings.lock().get(plugin).cloned().unwrap_or_default()
    }
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn sample(name: &str) -> PathBuf {
    repo().join("plugins").join(name)
}

fn theme_template() -> PathBuf {
    repo().join("templates/theme-plugin")
}

fn misbehave_pkg() -> PathBuf {
    repo().join("crates/ide-plugin/tests/fixtures/misbehave")
}

/// A theme package with a light and a dark theme, plus licence files, in `dir`.
fn write_theme_pair(dir: &Path) {
    std::fs::create_dir_all(dir.join("t")).unwrap();
    std::fs::write(
        dir.join("plugin.toml"),
        "id = \"theme-pair\"\nname = \"Pair\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n\
         [[contributes.themes]]\npath = \"t/day.json\"\n[[contributes.themes]]\npath = \"t/night.json\"\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("t/day.json"),
        r##"{"id":"day","name":"Day","kind":"light","tokens":{"--bg-frame":"#eeeeee"}}"##,
    )
    .unwrap();
    std::fs::write(
        dir.join("t/night.json"),
        r##"{"id":"night","name":"Night","kind":"dark","tokens":{"--bg-frame":"#111111"}}"##,
    )
    .unwrap();
    std::fs::write(dir.join("LICENSE"), "MIT License\n").unwrap();
    std::fs::write(dir.join("NOTICE"), "Palette notice\n").unwrap();
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

/// A copy of `hello` whose manifest is rewritten by `f`.
fn hello_variant(dir: &Path, f: impl Fn(&str) -> String) -> PathBuf {
    let pkg = dir.join("hello");
    copy_dir(&sample("hello"), &pkg);
    let manifest = pkg.join("plugin.toml");
    let text = std::fs::read_to_string(&manifest).unwrap();
    std::fs::write(&manifest, f(&text)).unwrap();
    pkg
}

/// `hello` requiring `required`, activated by `insert-date` only.
fn hello_02(text: &str, required: &str) -> String {
    text.replace("activation = [\"on-command:*\", \"on-view:greetings\"]", "activation = [\"on-command:insert-date\"]")
        .replace("required = [\"editor.read\", \"editor.write\"]", &format!("required = [{required}]"))
}

/// `hello` with a 0.1 manifest (`openidea-api`, `permissions`, no activation).
fn hello_01(text: &str) -> String {
    text.replace("engines.openidea = \"^1.0\"", "openidea-api = \"0.1\"")
        .replace("activation = [\"on-command:*\", \"on-view:greetings\"]\n", "")
        .replace(
            "[capabilities]\nrequired = [\"editor.read\", \"editor.write\"]",
            "permissions = [\"project-read\", \"editor-read\", \"editor-write\"]",
        )
}

struct Fixture {
    host: PluginHost,
    workspace: Arc<TestWorkspace>,
    events: Events,
    _tmp: tempfile::TempDir,
    plugins_dir: PathBuf,
    project: PathBuf,
}

fn fixture(limits: Limits) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let plugins_dir = tmp.path().join("plugins");
    let project = tmp.path().join("project");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join("src/notes.txt"), "one two three\nfour five\n").unwrap();
    std::fs::write(tmp.path().join("secret.txt"), "top secret").unwrap();
    let project = project.canonicalize().unwrap();
    let events: Events = Arc::default();
    let sink = {
        let events = events.clone();
        move |client: Option<&str>, e: PluginEvent| events.lock().push((client.map(str::to_owned), e))
    };
    let host = PluginHost::new(plugins_dir.clone(), Arc::new(sink), limits).unwrap();
    let workspace = TestWorkspace::new(&project);
    host.set_workspace(Some(workspace.clone()));
    host.load_all();
    host.startup_finished();
    Fixture { host, workspace, events, _tmp: tmp, plugins_dir, project }
}

impl Fixture {
    fn inv(&self) -> Invocation {
        Invocation { client: Some("main".into()), workspace_root: Some(self.project.clone()), editor: None }
    }

    fn install(&self, dir: &Path) -> PluginInfo {
        self.host.install_from_dir(dir, &Consent::all()).unwrap()
    }

    /// The installed copy of a plugin (its active version's directory).
    fn installed(&self, id: &str) -> PathBuf {
        self.host.info_of(id).unwrap().path.0
    }

    fn run(&self, plugin: &str, cmd: &str, arg: Option<&str>) -> Result<Option<String>, String> {
        self.host.run_command(plugin, cmd, arg, self.inv()).map_err(|e| e.message)
    }

    /// Runs a command with `editor` focused.
    fn run_in(&self, editor: &EditorContext, plugin: &str, cmd: &str) -> Result<Option<String>, String> {
        let inv = Invocation { editor: Some(editor.clone()), ..self.inv() };
        self.host.run_command(plugin, cmd, None, inv).map_err(|e| e.message)
    }

    fn status(&self, id: &str) -> PluginStatus {
        self.host.info_of(id).unwrap().status
    }

    fn take_events(&self) -> Vec<(Option<String>, PluginEvent)> {
        std::mem::take(&mut *self.events.lock())
    }

    /// Titles of the `commands` UI contributions of `plugin`.
    fn command_titles(&self, plugin: &str) -> Vec<String> {
        self.host
            .ui_items(COMMANDS)
            .into_iter()
            .filter(|c| c.plugin_id == plugin)
            .map(|c| c.decl["title"].as_str().unwrap().to_owned())
            .collect()
    }

    fn theme_kinds(&self, plugin: &str) -> Vec<(String, ThemeKind)> {
        self.host
            .ui_items("themes")
            .into_iter()
            .filter(|c| c.plugin_id == plugin)
            .map(|c| {
                let t: ThemeDef = serde_json::from_value(c.decl).unwrap();
                (t.id, t.kind)
            })
            .collect()
    }
}

#[test]
fn hello_plugin_commands() {
    let f = fixture(Limits::default());
    let info = f.install(&sample("hello"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    assert!(f.installed("hello").join("plugin.toml").is_file());
    assert!(f.installed("hello").join("dist/plugin.wasm").is_file());
    assert_eq!(f.command_titles("hello"), ["Hello: Insert Date", "Hello: Word Count of Active File"]);

    // Insert Date: one versioned edit replacing every selection (one undo step).
    let editor = f.workspace.open("src/notes.txt", &[(0, 0, 0, 0), (1, 0, 1, 4)]);
    let date = f.run_in(&editor, "hello", "insert-date").unwrap().unwrap();
    assert!(date.len() == 10 && date.as_bytes()[4] == b'-' && date.starts_with("20"), "{date}");
    assert_eq!(f.workspace.text("src/notes.txt"), format!("{date}one two three\n{date} five\n"));
    assert_eq!(f.status("hello"), PluginStatus::Active, "activated by its command");

    // Word Count reads the document, unsaved changes included.
    let summary = f.run_in(&editor, "hello", "word-count").unwrap().unwrap();
    assert!(summary.starts_with("5 words, 2 lines"), "{summary}");
    assert!(f.take_events().iter().any(|(client, e)| client.as_deref() == Some("main")
        && matches!(e,
        PluginEvent::Notification { title, level: NotificationLevel::Info, .. } if title == "Word count: notes.txt")));

    // Without an editor it fails cleanly; guest errors don't disable the plugin.
    assert!(f.run("hello", "word-count", None).unwrap_err().contains("no file is open"));
    assert!(f.run_in(&editor, "hello", "nope").unwrap_err().contains("unknown command"));
    assert_eq!(f.status("hello"), PluginStatus::Active);
    let stats = f.host.info_of("hello").unwrap().stats;
    assert_eq!(stats.activations, 1);
    assert!(stats.calls >= 4 && stats.errors >= 2, "{stats:?}");
}

/// Plan P5: edits name the document version they were computed for.
#[test]
fn edits_are_refused_when_the_document_changed() {
    use ide_plugin::{HostApi, Runtime, RuntimeSetup};
    let f = fixture(Limits::default());
    f.install(&sample("hello"));
    let editor = f.workspace.open("src/notes.txt", &[(0, 0, 0, 3)]);
    let doc = f.workspace.document(&editor.path).unwrap();
    f.workspace.type_text("src/notes.txt", "typed ");
    let edit = ide_core::TextEdit {
        range: ide_core::Range::new(ide_core::Pos::new(0, 0), ide_core::Pos::new(0, 3)),
        new_text: "ONE".into(),
    };
    assert_eq!(f.workspace.apply_edits(&editor.path, doc.0, std::slice::from_ref(&edit)), Err(HostError::Stale));
    assert_eq!(f.workspace.text("src/notes.txt"), "typed one two three\nfour five\n");
    let now = f.workspace.document(&editor.path).unwrap().0;
    assert_eq!(f.workspace.apply_edits(&editor.path, now, &[edit]), Ok(now + 1));
    assert_eq!(f.workspace.text("src/notes.txt"), "ONEed one two three\nfour five\n");
    let _ = (
        std::any::type_name::<Runtime>(),
        std::any::type_name::<RuntimeSetup>(),
        std::any::type_name::<&dyn HostApi>(),
    );
}

#[test]
fn read_file_is_confined_to_the_project() {
    let f = fixture(Limits::default());
    f.install(&misbehave_pkg());
    assert_eq!(f.run("misbehave", "read", Some("src/notes.txt")).unwrap().unwrap(), "one two three\nfour five\n");
    let abs = f.project.join("src/notes.txt");
    assert!(f.run("misbehave", "read", Some(abs.to_str().unwrap())).is_ok());
    let err = f.run("misbehave", "read", Some("../secret.txt")).unwrap_err();
    assert!(err.contains("outside the project root"), "{err}");
    let err = f.run("misbehave", "read", Some("src/../../secret.txt")).unwrap_err();
    assert!(err.contains("outside the project root"), "{err}");
    assert!(f.run("misbehave", "read", Some("/etc/hosts")).is_err());
    // Without a project there is nothing to read.
    let inv = Invocation { client: None, workspace_root: None, editor: None };
    let err = f.host.run_command("misbehave", "read", Some("src/notes.txt"), inv).unwrap_err().message;
    assert!(err.contains("no project is open"), "{err}");
    assert_eq!(f.run("misbehave", "root", None).unwrap().unwrap(), f.project.to_string_lossy());
    assert_eq!(f.status("misbehave"), PluginStatus::Active);
}

/// Plan P5: a missing capability is an error the plugin can handle, not a trap.
#[test]
fn ungranted_capabilities_are_denied_not_trapped() {
    let f = fixture(Limits::default());
    f.install(&misbehave_pkg());
    let editor = f.workspace.open("src/notes.txt", &[]);
    let err = f.run_in(&editor, "misbehave", "insert").unwrap_err();
    assert!(err.contains("Denied") && err.contains("editor.write"), "{err}");
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!((info.status, info.stats.crashes), (PluginStatus::Active, 0), "the instance lives on");
    assert_eq!(f.workspace.text("src/notes.txt"), "one two three\nfour five\n");
}

/// Plan P4: a trap drops the instance, which restarts on next use after a
/// backoff that doubles; only consecutive crashes stop the plugin.
#[test]
fn crashes_restart_with_backoff_until_the_circuit_opens() {
    let backoff = Duration::from_millis(150);
    let f = fixture(Limits { restart_backoff: backoff, max_failures: 3, ..Limits::default() });
    f.install(&sample("hello"));
    f.install(&misbehave_pkg());
    f.take_events();

    let err = f.run("misbehave", "panic", None).unwrap_err();
    assert!(err.contains("crashed"), "{err}");
    assert!(err.contains("boom"), "stderr panic message is surfaced: {err}");
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!(info.status, PluginStatus::Inactive);
    assert!(info.error.as_deref().is_some_and(|e| e.contains("boom")));
    assert!(!info.contributions.is_empty(), "contributions stay while it can restart");
    let events = f.take_events();
    assert!(events.iter().any(|(client, e)| client.as_deref() == Some("main")
        && matches!(e, PluginEvent::Notification { level: NotificationLevel::Warning, title, .. } if title.contains("crashed"))));

    // Backing off, then a fresh instance; a call that returns resets the count.
    assert!(f.run("misbehave", "echo", Some("x")).unwrap_err().contains("restarts in"));
    std::thread::sleep(backoff + Duration::from_millis(50));
    assert_eq!(f.run("misbehave", "echo", Some("back")).unwrap().as_deref(), Some("back"));
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!((info.status, info.stats.activations, info.error), (PluginStatus::Active, 2, None));

    // Three in a row: stopped for the session, with growing waits between.
    f.take_events();
    let mut waits = Vec::new();
    for _ in 0..3 {
        let started = Instant::now();
        let err = loop {
            match f.run("misbehave", "panic", None) {
                Err(e) if e.contains("restarts in") => std::thread::sleep(Duration::from_millis(20)),
                other => break other.unwrap_err(),
            }
        };
        assert!(err.contains("crashed"), "{err}");
        waits.push(started.elapsed());
    }
    assert!(waits[2] >= backoff * 2 && waits[2] > waits[1], "{waits:?}");
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!(info.status, PluginStatus::Failed);
    assert!(info.error.as_deref().is_some_and(|e| e.contains("3 times in a row")), "{:?}", info.error);
    assert!(info.enabled, "failure is per session, not persisted");
    assert!(info.contributions.is_empty(), "a failed plugin's contributions are withdrawn");
    let events = f.take_events();
    assert!(events.iter().any(|(_, e)| matches!(e,
        PluginEvent::Notification { level: NotificationLevel::Error, title, .. } if title.contains("was disabled"))));
    assert_eq!(
        events
            .iter()
            .filter(|(_, e)| matches!(e, PluginEvent::Notification { level: NotificationLevel::Warning, .. }))
            .count(),
        1,
        "one crash notice per streak"
    );
    assert!(f.run("misbehave", "echo", Some("x")).unwrap_err().contains("not running"));
    // Other plugins are unaffected.
    let editor = f.workspace.open("src/notes.txt", &[(0, 0, 0, 0)]);
    assert!(f.run_in(&editor, "hello", "insert-date").is_ok());

    // Toggling restarts it with a fresh instance.
    f.host.set_enabled("misbehave", true).unwrap();
    assert_eq!(f.run("misbehave", "echo", Some("again")).unwrap().as_deref(), Some("again"));
    assert_eq!(f.status("misbehave"), PluginStatus::Active);
}

#[test]
fn fuel_exhaustion_traps() {
    let f =
        fixture(Limits { fuel: 50_000_000, timeout: Duration::from_secs(30), max_failures: 1, ..Limits::default() });
    f.install(&misbehave_pkg());
    let err = f.run("misbehave", "spin", None).unwrap_err();
    assert!(err.contains("CPU budget"), "{err}");
    assert_eq!(f.status("misbehave"), PluginStatus::Failed, "max_failures 1: the first crash stops it");
}

#[test]
fn wall_clock_timeout_traps() {
    let f = fixture(Limits { fuel: u64::MAX, timeout: Duration::from_millis(200), ..Limits::default() });
    f.install(&misbehave_pkg());
    let started = std::time::Instant::now();
    let err = f.run("misbehave", "spin", None).unwrap_err();
    assert!(err.contains("timed out after 200ms"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(f.host.info_of("misbehave").unwrap().stats.crashes, 1);
}

#[test]
fn memory_limit_traps() {
    let f = fixture(Limits { memory_bytes: 32 << 20, ..Limits::default() });
    f.install(&misbehave_pkg());
    let err = f.run("misbehave", "alloc", None).unwrap_err();
    assert!(err.contains("memory"), "{err}");
    assert_eq!(f.host.info_of("misbehave").unwrap().stats.crashes, 1);
}

/// Plan P4: a running call can be interrupted from another thread; the
/// instance is rebuilt on next use without counting as a crash.
#[test]
fn running_calls_can_be_cancelled() {
    let f = Arc::new(fixture(Limits { fuel: u64::MAX, timeout: Duration::from_secs(30), ..Limits::default() }));
    f.install(&misbehave_pkg());
    let spinning = {
        let f = f.clone();
        std::thread::spawn(move || f.run("misbehave", "spin", None))
    };
    std::thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    f.host.cancel("misbehave");
    let err = spinning.join().unwrap().unwrap_err();
    assert!(err.contains("was cancelled"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(f.run("misbehave", "echo", Some("x")).unwrap().as_deref(), Some("x"), "no backoff");
    let stats = f.host.info_of("misbehave").unwrap().stats;
    assert_eq!((stats.crashes, stats.activations), (0, 2));
}

/// `misbehave` contributing a language, so its `syntax-provider` serves it.
fn misbehave_with_language(dir: &Path) -> PathBuf {
    let pkg = dir.join("misbehave");
    copy_dir(&misbehave_pkg(), &pkg);
    std::fs::write(
        pkg.join("plugin.toml"),
        "id = \"misbehave\"\nname = \"Misbehave\"\nversion = \"0.0.1\"\nengines.openidea = \"^1.0\"\n\
         wasm = \"dist/plugin.wasm\"\nactivation = [\"on-language:mis\"]\n\
         [[contributes.languages]]\npath = \"mis.toml\"\n",
    )
    .unwrap();
    std::fs::write(pkg.join("mis.toml"), "id = \"mis\"\nname = \"Mis\"\nextensions = [\"mis\"]\n").unwrap();
    pkg
}

/// Plan P4: edit-path calls stop waiting at the soft deadline (the result is
/// dropped, the instance kept) and are interrupted at the hard one.
#[test]
fn edit_path_calls_have_soft_and_hard_deadlines() {
    use ide_core::LanguageId;
    let tmp = tempfile::tempdir().unwrap();
    let limits = Limits {
        edit_soft: Duration::from_millis(50),
        edit_hard: Duration::from_millis(400),
        fuel: u64::MAX,
        restart_backoff: Duration::ZERO,
        ..Limits::default()
    };
    let host =
        Arc::new(PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), limits).unwrap());
    host.load_all();
    host.startup_finished();
    host.install_from_dir(&misbehave_with_language(tmp.path()), &Consent::all()).unwrap();
    let provider = host.syntax_provider();
    let mis = LanguageId::new("mis");

    let tokens = provider.highlights(&mis, "fast").unwrap();
    assert_eq!((tokens[0].start, tokens[0].end, tokens[0].kind.as_str()), (0, 4, "keyword"));

    // Slower than the soft deadline: dropped, but the instance lives on.
    let started = Instant::now();
    assert!(provider.highlights(&mis, "sleep:150").is_none());
    assert!(started.elapsed() < Duration::from_millis(120), "{:?}", started.elapsed());
    std::thread::sleep(Duration::from_millis(150));
    assert!(provider.highlights(&mis, "fast").is_some());
    let info = host.info_of("misbehave").unwrap();
    assert_eq!((info.stats.slow_calls, info.stats.crashes, info.stats.activations), (1, 0, 1));

    // Past the hard deadline: interrupted; the next call gets a new instance.
    assert!(provider.highlights(&mis, "spin").is_none());
    std::thread::sleep(Duration::from_millis(450));
    host.tick();
    let info = host.info_of("misbehave").unwrap();
    assert_eq!(info.stats.crashes, 1, "{:?}", info.error);
    assert!(info.error.as_deref().is_some_and(|e| e.contains("timed out after 400ms")), "{:?}", info.error);
    assert!(provider.highlights(&mis, "fast").is_some());
    assert_eq!(host.info_of("misbehave").unwrap().stats.activations, 2);
}

/// Plan P4: idle instances are reclaimed; the plugin activates again on its
/// next use, and `on-schedule` activations don't keep it alive.
#[test]
fn idle_instances_are_reclaimed_and_schedules_reactivate() {
    let tmp = tempfile::tempdir().unwrap();
    let f = fixture(Limits { idle_timeout: Some(Duration::from_millis(100)), ..Limits::default() });
    f.install(&misbehave_pkg());
    assert_eq!(f.run("misbehave", "echo", Some("x")).unwrap().as_deref(), Some("x"));
    assert_eq!(f.host.instances(), 1);
    f.host.tick();
    assert_eq!(f.host.instances(), 1, "not idle yet");
    std::thread::sleep(Duration::from_millis(150));
    f.host.tick();
    assert_eq!(f.host.instances(), 0);
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!((info.status, info.stats.reclaims), (PluginStatus::Inactive, 1));
    assert_eq!(f.command_titles("misbehave").len(), 9, "runtime contributions stay");
    assert_eq!(f.run("misbehave", "echo", Some("y")).unwrap().as_deref(), Some("y"));
    assert_eq!(f.host.info_of("misbehave").unwrap().stats.activations, 2);

    let pkg = hello_variant(tmp.path(), |t| {
        hello_02(t, "\"editor.read\"")
            .replace("activation = [\"on-command:insert-date\"]", "activation = [\"on-schedule:60\"]")
    });
    f.install(&pkg);
    assert_eq!(f.status("hello"), PluginStatus::Inactive);
    let now = Instant::now();
    f.host.tick_at(now);
    f.host.tick_at(now + Duration::from_secs(59));
    assert_eq!(f.status("hello"), PluginStatus::Inactive, "not due yet");
    f.host.tick_at(now + Duration::from_secs(61));
    assert!(f.host.wait_events(Duration::from_secs(10)));
    assert_eq!(f.status("hello"), PluginStatus::Active, "due");
    std::thread::sleep(Duration::from_millis(150));
    f.host.tick();
    assert_eq!(f.status("hello"), PluginStatus::Inactive, "reclaimed again");
}

#[test]
fn runtime_language_and_theme_registration() {
    let f = fixture(Limits::default());
    f.install(&misbehave_pkg());
    let lang = "id = \"zz\"\nname = \"ZZ\"\nextensions = [\"zz\"]";
    f.run("misbehave", "language", Some(lang)).unwrap();
    assert!(f.run("misbehave", "language", Some("not toml [")).unwrap_err().contains("invalid language"));
    assert_eq!(f.host.languages().iter().map(|l| l.id.to_string()).collect::<Vec<_>>(), ["zz"]);
    assert_eq!(f.host.languages()[0].extensions, ["zz"]);

    let theme = r##"{"id":"t1","name":"T1","kind":"light","tokens":{"--bg-app":"#fff"}}"##;
    f.run("misbehave", "theme", Some(theme)).unwrap();
    assert!(
        f.run("misbehave", "theme", Some(r#"{"id":"t2","name":"x","kind":"dark","tokens":{"--a":"url(x)"}}"#)).is_err()
    );
    assert_eq!(f.theme_kinds("misbehave"), [("t1".to_owned(), ThemeKind::Light)]);
    let active = f.host.set_theme(Some(("misbehave", "t1"))).unwrap().unwrap();
    assert_eq!(active.theme.tokens["--bg-app"], "#fff");
    assert!(f.host.set_theme(Some(("misbehave", "nope"))).is_err());
}

#[test]
fn contribution_only_plugins() {
    let f = fixture(Limits::default());
    let theme = f.install(&theme_template());
    assert_eq!(theme.status, PluginStatus::Static);
    assert!(!theme.has_code);
    assert_eq!(f.theme_kinds("theme-harbor-night")[0].0, "harbor-night");
    let lang = f.install(&sample("language-toy"));
    assert_eq!(lang.status, PluginStatus::Static);
    assert_eq!(f.host.languages()[0].id.as_str(), "toy");
    assert_eq!(f.host.languages()[0].block_comment, Some(("(*".into(), "*)".into())));
    assert!(f.run("language-toy", "x", None).unwrap_err().contains("no code"));

    f.take_events();
    let active = f.host.set_theme(Some(("theme-harbor-night", "harbor-night"))).unwrap().unwrap();
    assert_eq!(active.theme.tokens["--bg-app"], "#14171c");
    assert_eq!(active.theme.tokens["--syn-string"], "#9ccc7a");
    assert!(f.take_events().iter().any(|(_, e)| matches!(e, PluginEvent::ThemeChanged { theme: Some(_) })));
    assert_eq!(f.host.list(None).active_theme, Some(active));

    // Disabling the plugin withdraws its theme and language.
    f.host.set_enabled("theme-harbor-night", false).unwrap();
    assert!(f.host.active_theme().is_none());
    assert!(f.take_events().iter().any(|(_, e)| *e == PluginEvent::ThemeChanged { theme: None }));
    f.host.set_enabled("language-toy", false).unwrap();
    assert!(f.host.languages().is_empty());
    assert_eq!(f.status("language-toy"), PluginStatus::Disabled);
}

#[test]
fn theme_template_installs_with_its_editor_scheme() {
    let f = fixture(Limits::default());
    let info = f.install(&theme_template());
    assert_eq!(info.status, PluginStatus::Static);
    assert_eq!(f.theme_kinds("theme-harbor-night"), [("harbor-night".to_owned(), ThemeKind::Dark)]);
    // The scheme file is copied with the package and merged over the UI tokens.
    assert!(f.installed("theme-harbor-night").join("themes/harbor-night.scheme.json").is_file());
    let active = f.host.set_theme(Some(("theme-harbor-night", "harbor-night"))).unwrap().unwrap();
    let tokens = &active.theme.tokens;
    assert!(
        tokens.contains_key("--bg-app") && tokens.contains_key("--syn-keyword") && tokens.contains_key("--ansi-red")
    );
    assert!(tokens.len() > 150);
}

#[test]
fn theme_packages_install_with_their_licence() {
    let f = fixture(Limits::default());
    let dir = tempfile::tempdir().unwrap();
    write_theme_pair(dir.path());
    let info = f.install(dir.path());
    assert_eq!(info.status, PluginStatus::Static, "{:?}", info.error);
    let installed = f.installed("theme-pair");
    assert!(std::fs::read_to_string(installed.join("LICENSE")).unwrap().contains("MIT License"));
    assert!(installed.join("NOTICE").is_file());
    for (theme, kind) in [("day", ThemeKind::Light), ("night", ThemeKind::Dark)] {
        let active = f.host.set_theme(Some(("theme-pair", theme))).unwrap().unwrap();
        assert_eq!(active.theme.kind, kind);
    }
}

#[test]
fn theme_frame_follows_the_selection() {
    let f = fixture(Limits::default());
    let dir = tempfile::tempdir().unwrap();
    write_theme_pair(dir.path());
    f.install(dir.path());
    // Nothing to attach it to without a selected theme.
    f.host.set_theme_frame(Some("#111111")).unwrap();
    assert_eq!(f.host.startup_frame(), None);
    f.host.set_theme(Some(("theme-pair", "night"))).unwrap();
    assert!(f.host.set_theme_frame(Some("hsl(220, 13%, 15%)")).is_err());
    f.host.set_theme_frame(Some("#111111")).unwrap();
    assert_eq!(f.host.startup_frame().as_deref(), Some("#111111"));
    f.host.set_enabled("theme-pair", false).unwrap();
    assert_eq!(f.host.startup_frame(), None);
    f.host.set_enabled("theme-pair", true).unwrap();
    assert_eq!(f.host.startup_frame().as_deref(), Some("#111111"));
    // A new selection drops the old theme's colour until the UI reports the new one.
    f.host.set_theme(Some(("theme-pair", "day"))).unwrap();
    assert_eq!(f.host.startup_frame(), None);
    f.host.set_theme_frame(Some("#eeeeee")).unwrap();
    f.host.set_theme(None).unwrap();
    assert_eq!(f.host.startup_frame(), None);
}

#[test]
fn theme_with_broken_editor_scheme_is_rejected() {
    let f = fixture(Limits::default());
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("t")).unwrap();
    std::fs::write(
        dir.path().join("plugin.toml"),
        "id = \"bad-scheme\"\nname = \"B\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n\
         [[contributes.themes]]\npath = \"t/a.json\"\neditor-scheme = \"t/a.scheme.json\"\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("t/a.json"), r##"{"id":"a","name":"A","kind":"light","tokens":{}}"##).unwrap();
    std::fs::write(dir.path().join("t/a.scheme.json"), "{\n  \"tokens\": { \"--caret\": \"url(x)\" }\n}").unwrap();
    // Validation happens before anything is copied.
    let err = f.host.install_from_dir(dir.path(), &Consent::all()).unwrap_err().message;
    assert!(err.contains("a.scheme.json"), "{err}");
    assert!(!f.plugins_dir.join("bad-scheme").exists());
    // Already on disk (copied by hand): listed as failed.
    copy_dir(dir.path(), &f.plugins_dir.join("bad-scheme"));
    f.host.load_all();
    let info = f.host.info_of("bad-scheme").unwrap();
    assert_eq!(info.status, PluginStatus::Failed);
    assert!(info.error.unwrap_or_default().contains("a.scheme.json"));
}

#[test]
fn state_persists_across_restarts() {
    let f = fixture(Limits::default());
    f.install(&sample("hello"));
    f.install(&theme_template());
    f.host.set_enabled("hello", false).unwrap();
    f.host.set_theme(Some(("theme-harbor-night", "harbor-night"))).unwrap();
    f.host.set_theme_frame(Some("#1f252e")).unwrap();

    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    // Known before the plugins are loaded: new windows open in the theme's frame colour.
    assert_eq!(again.startup_frame().as_deref(), Some("#1f252e"));
    assert!(!again.wait_initial_load(Duration::from_millis(1)));
    again.load_all();
    assert!(again.wait_initial_load(Duration::ZERO));
    let list = again.list(None);
    let hello = list.plugins.iter().find(|p| p.id == "hello").unwrap();
    assert!(!hello.enabled);
    assert_eq!(hello.status, PluginStatus::Disabled);
    assert_eq!(list.active_theme.unwrap().theme.id, "harbor-night");
    assert!(
        again
            .run_command("hello", "insert-date", None, Invocation::default())
            .unwrap_err()
            .message
            .contains("disabled")
    );
}

#[test]
fn startup_loads_without_instantiating_wasm() {
    let f = fixture(Limits::default());
    f.install(&sample("hello"));
    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    again.load_all();
    let hello = again.info_of("hello").unwrap();
    assert_eq!(hello.status, PluginStatus::Inactive, "no instance before start-up finished");
    assert_eq!(hello.stats.activations, 0);
    assert_eq!(again.ui_items(COMMANDS).len(), 2, "commands are shown without running code");
    again.startup_finished();
    assert_eq!(again.instances(), 0, "hello waits for its commands");

    // `on-startup-finished` plugins are activated then, not before.
    let tmp = tempfile::tempdir().unwrap();
    let eager = hello_variant(tmp.path(), |t| t.replace("on-command:*", "on-startup-finished"));
    f.install(&eager);
    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    again.load_all();
    assert_eq!(again.instances(), 0);
    again.startup_finished();
    assert_eq!(again.info_of("hello").unwrap().status, PluginStatus::Active);
}

#[test]
fn lazy_activation_on_command() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = hello_variant(tmp.path(), |t| hello_02(t, "\"project.read\", \"editor.read\", \"editor.write\""));
    let info = f.install(&pkg);
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    assert_eq!(info.activation, ["on-command:insert-date"]);
    assert_eq!(f.command_titles("hello").len(), 2);
    let editor = f.workspace.open("src/notes.txt", &[(0, 0, 0, 0)]);
    assert!(f.run_in(&editor, "hello", "insert-date").unwrap().is_some());
    assert_eq!(f.status("hello"), PluginStatus::Active);
}

#[test]
fn project_plugins_need_consent_even_in_trusted_projects() {
    let f = fixture(Limits::default());
    f.host.set_project_policy(Arc::new(|_| true));
    let dev = f.project.join(DEV_PLUGINS_DIR).join("toy");
    copy_dir(&sample("language-toy"), &dev);
    f.host.sync_project(&f.project);
    let mine = f.host.list(Some(&f.project));
    assert_eq!(mine.plugins.len(), 1);
    assert_eq!(mine.plugins[0].source, PluginSource::Dev);
    assert_eq!(mine.plugins[0].status, PluginStatus::NeedsConsent);
    assert!(f.host.languages().is_empty(), "nothing takes effect before consent");
    assert!(f.host.list(None).plugins.is_empty(), "project plugins only show for their project");

    f.host.grant("language-toy", &Consent::default()).unwrap();
    assert_eq!(f.status("language-toy"), PluginStatus::Static);
    assert_eq!(f.host.languages().len(), 1);
    assert!(f.host.uninstall("language-toy").is_err());
    assert!(f.host.install_from_dir(&sample("language-toy"), &Consent::all()).is_err(), "id clash with a dev plugin");

    // Edit + reload picks up changes; the grant is by path, so no new prompt.
    let manifest = dev.join("plugin.toml");
    let src = std::fs::read_to_string(&manifest).unwrap().replace("Toy Language", "Toy Language (dev)");
    std::fs::write(&manifest, src).unwrap();
    let info = f.host.reload("language-toy").unwrap();
    assert_eq!(info.name, "Toy Language (dev)");
    assert_eq!(info.status, PluginStatus::Static);

    std::fs::remove_dir_all(&dev).unwrap();
    f.host.sync_project(&f.project);
    assert!(f.host.list(Some(&f.project)).plugins.is_empty());
}

#[test]
fn untrusted_or_unconfirmed_project_plugins_never_run() {
    let f = fixture(Limits::default());
    // Its commands are registered by `activate` only.
    let dev = f.project.join(DEV_PLUGINS_DIR).join("misbehave");
    copy_dir(&misbehave_pkg(), &dev);
    let trusted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let policy = trusted.clone();
    f.host.set_project_policy(Arc::new(move |_| policy.load(std::sync::atomic::Ordering::Acquire)));
    f.host.sync_project(&f.project);
    assert!(f.host.list(Some(&f.project)).plugins.is_empty());
    assert!(f.host.info_of("misbehave").is_err());

    // Trusted but not confirmed: listed, nothing runs, activation registers nothing.
    trusted.store(true, std::sync::atomic::Ordering::Release);
    f.host.sync_project(&f.project);
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!(info.status, PluginStatus::NeedsConsent);
    assert!(f.command_titles("misbehave").is_empty(), "unconfirmed plugin registered its activation witness");
    assert!(f.run("misbehave", "echo", None).unwrap_err().contains("permission"));

    // Positive control: after consent, activation itself registers the commands.
    let info = f.host.grant("misbehave", &Consent::default()).unwrap();
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    assert_eq!(f.run("misbehave", "echo", Some("x")).unwrap().as_deref(), Some("x"));
    assert!(f.command_titles("misbehave").iter().any(|t| t == "echo"));

    trusted.store(false, std::sync::atomic::Ordering::Release);
    assert!(f.host.reload("misbehave").is_err());
    assert!(f.host.set_enabled("misbehave", true).is_err());
    assert!(f.run("misbehave", "echo", None).is_err());
    f.host.sync_project(&f.project);
    assert!(f.host.list(Some(&f.project)).plugins.is_empty());
}

#[test]
fn new_capabilities_require_consent_again() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let v1 = hello_variant(&tmp.path().join("v1"), |t| hello_02(t, "\"project.read\""));
    let info = f.install(&v1);
    assert_eq!(info.status, PluginStatus::Inactive);
    assert!(info.capabilities.iter().all(|c| c.granted));

    // Same capabilities, new version: accepted silently.
    let v2 = hello_variant(&tmp.path().join("v2"), |t| {
        hello_02(t, "\"project.read\"").replace("version = \"0.3.0\"", "version = \"0.3.1\"")
    });
    f.host.load_all();
    std::fs::remove_dir_all(f.plugins_dir.join("hello")).unwrap();
    copy_dir(&v2, &f.plugins_dir.join("hello"));
    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    again.load_all();
    assert_eq!(again.info_of("hello").unwrap().status, PluginStatus::Inactive);
    drop(again);

    // A new required capability: waits for consent, nothing contributed.
    let v3 = hello_variant(&tmp.path().join("v3"), |t| {
        hello_02(t, "\"project.read\", \"editor.write\"").replace("version = \"0.3.0\"", "version = \"0.4.0\"")
    });
    std::fs::remove_dir_all(f.plugins_dir.join("hello")).unwrap();
    copy_dir(&v3, &f.plugins_dir.join("hello"));
    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    again.load_all();
    let info = again.info_of("hello").unwrap();
    assert_eq!(info.status, PluginStatus::NeedsConsent);
    let write = info.capabilities.iter().find(|c| c.id == "editor.write").unwrap();
    assert!(!write.granted);
    assert!(again.ui_items(COMMANDS).is_empty());
    again.grant("hello", &Consent::default()).unwrap();
    assert_eq!(again.info_of("hello").unwrap().status, PluginStatus::Inactive);

    // Revoking a required capability stops it again.
    let info = again.set_capability("hello", "editor.write", false).unwrap();
    assert_eq!(info.status, PluginStatus::NeedsConsent);
}

#[test]
fn migrated_plugins_get_low_risk_capabilities_and_ask_on_first_use() {
    let tmp = tempfile::tempdir().unwrap();
    let plugins_dir = tmp.path().join("plugins");
    // Installed by a version without the grant ledger (a 0.1 manifest).
    copy_dir(&sample("hello"), &plugins_dir.join("hello"));
    let manifest = plugins_dir.join("hello/plugin.toml");
    std::fs::write(&manifest, hello_01(&std::fs::read_to_string(&manifest).unwrap())).unwrap();
    let events: Events = Arc::default();
    let sink = {
        let events = events.clone();
        move |client: Option<&str>, e: PluginEvent| events.lock().push((client.map(str::to_owned), e))
    };
    let host = PluginHost::new(plugins_dir.clone(), Arc::new(sink), Limits::default()).unwrap();
    host.load_all();
    let info = host.info_of("hello").unwrap();
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    let granted: Vec<_> = info.capabilities.iter().filter(|c| c.granted).map(|c| c.id.as_str()).collect();
    assert_eq!(granted, ["project.read", "editor.read"]);
    let inv = Invocation { client: Some("w".into()), ..Invocation::default() };
    let err = host.run_command("hello", "insert-date", None, inv.clone()).unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::PermissionDenied);
    assert!(events.lock().iter().any(|(c, e)| c.as_deref() == Some("w")
        && matches!(e, PluginEvent::ConsentRequested { capabilities, .. } if capabilities[0].id == "editor.write")));
    host.grant("hello", &Consent::default()).unwrap();
    // Runs now (and fails only for want of an editor).
    let err = host.run_command("hello", "insert-date", None, inv).unwrap_err();
    assert!(err.message.contains("no file is open"), "{err:?}");
}

#[cfg(unix)]
#[test]
fn replaced_binaries_are_refused() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    std::fs::write(bin.join("toylsp"), "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(bin.join("toylsp"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = bin.clone();
    f.host.set_program_path(Arc::new(move || Some(path.clone().into_os_string())));

    let pkg = tmp.path().join("pkg");
    copy_dir(&sample("language-toy"), &pkg);
    let lang = pkg.join("languages/toy.toml");
    let text = std::fs::read_to_string(&lang).unwrap();
    std::fs::write(&lang, format!("{text}\n[[language-servers]]\nname = \"toylsp\"\ncommand = \"toylsp\"\n")).unwrap();

    let preview = f.host.preview_install(&pkg).unwrap();
    let lsp = preview.capabilities.iter().find(|c| c.id == "process:toylsp").unwrap();
    assert_eq!(lsp.risk, ide_extension::Risk::High);
    assert!(lsp.optional, "declaration-derived capabilities can be refused");

    // Refused: the language still works.
    f.host.install_from_dir(&pkg, &Consent::default()).unwrap();
    assert_eq!(f.host.languages().len(), 1);
    assert!(f.host.program_for("language-toy", "toylsp").is_err());

    // Accepted: pinned to the resolved file.
    f.host.set_capability("language-toy", "process:toylsp", true).unwrap();
    let resolved = f.host.program_for("language-toy", "toylsp").unwrap();
    assert!(resolved.ends_with("toylsp"));
    std::fs::write(bin.join("toylsp"), "#!/bin/sh\necho replaced\n").unwrap();
    let err = f.host.program_for("language-toy", "toylsp").unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::PermissionDenied);
    assert!(err.message.contains("confirm"), "{}", err.message);
}

/// Plan P3: a declaration-only language plugin reaches detection and LSP of
/// every project; its server starts only while `process:` is granted, from
/// the approved file.
#[cfg(unix)]
#[test]
fn plugin_languages_join_the_registry_and_start_only_granted_servers() {
    use ide_core::LanguageId;
    use ide_language::LanguageRegistry;
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    std::fs::write(bin.join("toylsp"), "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(bin.join("toylsp"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = bin.clone();
    f.host.set_program_path(Arc::new(move || Some(path.clone().into_os_string())));

    let registry = LanguageRegistry::load(None).unwrap();
    registry.attach_plugins(f.host.language_store().clone());
    let project = registry.fork();
    let toy = LanguageId::new("toy");
    assert_eq!(project.detect(Path::new("/p/a.toy"), None), LanguageId::plain_text());

    let pkg = tmp.path().join("pkg");
    copy_dir(&sample("language-toy"), &pkg);
    let lang = pkg.join("languages/toy.toml");
    let text = std::fs::read_to_string(&lang).unwrap();
    std::fs::write(&lang, format!("{text}\n[[language-servers]]\nname = \"toylsp\"\ncommand = \"toylsp\"\n")).unwrap();

    // Refused: detected and listed, no server.
    f.host.install_from_dir(&pkg, &Consent::default()).unwrap();
    assert_eq!(project.detect(Path::new("/p/a.toy"), None), toy);
    assert!(registry.all().iter().any(|l| l.id == toy), "the UI language list includes it");
    assert!(project.get(&toy).unwrap().language_servers.is_empty());

    // Granted: the server is pinned to the approved file.
    f.host.set_capability("language-toy", "process:toylsp", true).unwrap();
    let server = project.get(&toy).unwrap().language_servers[0].clone();
    let pin = server.pinned.expect("pinned");
    assert_eq!(pin.verify().unwrap(), dunce::canonicalize(bin.join("toylsp")).unwrap());
    // Replaced afterwards: refused when it would start.
    std::fs::write(bin.join("toylsp"), "#!/bin/sh\necho replaced\n").unwrap();
    assert!(pin.verify().unwrap_err().contains("changed since it was approved"));

    // Revoked, then disabled.
    f.host.set_capability("language-toy", "process:toylsp", false).unwrap();
    assert!(project.get(&toy).unwrap().language_servers.is_empty());
    f.host.set_enabled("language-toy", false).unwrap();
    assert_eq!(project.detect(Path::new("/p/a.toy"), None), LanguageId::plain_text());
}

/// Plan P3: a plugin provides the syntax of a language the IDE has no grammar
/// for (the official Solidity plugin, built with the SDK), activated on first use.
#[test]
fn plugin_syntax_for_languages_without_a_grammar() {
    use ide_core::{DocId, LanguageId, SymbolKind};
    use ide_language::{Syntax, SyntaxCache, SyntaxHighlightKind};
    let tmp = tempfile::tempdir().unwrap();
    let host = Arc::new(
        PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap(),
    );
    host.load_all();
    host.startup_finished();
    let info = host.install_from_dir(&repo().join("plugins/official/solidity"), &Consent::default()).unwrap();
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    assert!(info.capabilities.iter().all(|c| c.optional && !c.granted), "language servers were refused");

    let provider = host.syntax_provider();
    let sol = LanguageId::new("solidity");
    let text = "// c\ncontract A {\n    uint256 public x;\n    function f() public {}\n}\n";
    assert!(provider.highlights(&LanguageId::new("rust"), text).is_none(), "only its own languages");
    let tokens = provider.highlights(&sol, text).unwrap();
    let kind_at =
        |s: &str| tokens.iter().find(|t| &text[t.start as usize..t.end as usize] == s).map(|t| t.kind.as_str());
    assert_eq!(kind_at("contract"), Some("keyword"));
    assert_eq!(kind_at("uint256"), Some("type"));
    assert_eq!(kind_at("// c"), Some("comment"));
    assert_eq!(host.info_of("openidea.solidity").unwrap().status, PluginStatus::Active, "activated on first use");

    // As the editor gets it: through a project's syntax cache.
    ide_language::set_external_syntax(Some(provider.clone()));
    let cache = SyntaxCache::new(Arc::new(Syntax::new()));
    let outline = cache.outline(DocId(1), &sol, 1, text);
    assert_eq!(outline.len(), 1);
    assert_eq!((outline[0].name.as_str(), outline[0].kind), ("A", SymbolKind::Class));
    let members: Vec<_> = outline[0].children.iter().map(|c| (c.name.as_str(), c.kind)).collect();
    assert_eq!(members, [("x", SymbolKind::Field), ("f", SymbolKind::Method)]);
    assert_eq!(outline[0].selection_range.start.line, 1);
    let folds = cache.folding(DocId(1), &sol, 1, text);
    assert!(folds.iter().any(|f| f.start_line == 1 && f.end_line == 4));
    let highlights = cache.highlights(DocId(1), &sol, 1, text);
    let keyword = SyntaxHighlightKind::ALL.iter().position(|k| *k == SyntaxHighlightKind::Keyword).unwrap() as u32;
    assert!(highlights.data.chunks(3).any(|t| t == [5, 13, keyword]), "UTF-16 offsets of `contract`");
    ide_language::set_external_syntax(None);
}

/// Plan P3: plugins add run configurations to `ide-run`'s detection; the
/// command runs only while granted, from the approved file.
#[cfg(unix)]
#[test]
fn run_detectors_offer_granted_commands_in_marked_projects() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    std::fs::write(bin.join("forge"), "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(bin.join("forge"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = bin.clone();
    f.host.set_program_path(Arc::new(move || Some(path.clone().into_os_string())));

    let pkg = tmp.path().join("pkg");
    std::fs::create_dir(&pkg).unwrap();
    std::fs::write(
        pkg.join("plugin.toml"),
        "id = \"acme.forge\"\nname = \"Forge\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n\
         [[contributes.runDetectors]]\nid = \"test\"\nname = \"forge test\"\nfiles = [\"foundry.toml\"]\n\
         command = \"forge\"\nargs = [\"test\"]\ntest = true\n",
    )
    .unwrap();
    let preview = f.host.preview_install(&pkg).unwrap();
    assert!(preview.capabilities.iter().any(|c| c.id == "process:forge" && c.optional));
    f.host.install_from_dir(&pkg, &Consent::default()).unwrap();

    let detection = f.host.run_detection();
    let project = tmp.path().join("chain");
    std::fs::create_dir(&project).unwrap();
    assert!(detection.detect(&project).is_empty(), "no marker");
    std::fs::write(project.join("foundry.toml"), "").unwrap();
    assert!(detection.detect(&project).is_empty(), "not granted");

    f.host.set_capability("acme.forge", "process:forge", true).unwrap();
    let configs = detection.detect(&project);
    assert_eq!(configs.len(), 1);
    let config = &configs[0];
    assert_eq!(
        (config.id.as_str(), config.name.as_str(), config.is_test),
        ("plugin:acme.forge:test", "forge test", true)
    );
    assert_eq!(detection.launch(config).unwrap(), dunce::canonicalize(bin.join("forge")).unwrap());

    std::fs::write(bin.join("forge"), "#!/bin/sh\necho swapped\n").unwrap();
    assert!(detection.launch(config).unwrap_err().contains("changed since it was approved"));
    f.host.set_enabled("acme.forge", false).unwrap();
    assert!(detection.detect(&project).is_empty());
    assert!(detection.launch(config).unwrap_err().contains("no longer enabled"));
}

/// Plan P4: compiled components are cached across runs (keyed by module and
/// engine), so a cold activation only deserializes.
#[test]
fn precompiled_components_make_cold_activation_cheap() {
    let f = fixture(Limits::default());
    f.install(&sample("hello"));
    let cache = f.plugins_dir.join(".cache/components");
    let cached = || std::fs::read_dir(&cache).map(|d| d.count()).unwrap_or(0);
    assert_eq!(cached(), 1, "install validation compiled it once, into the cache");

    // Another run of the IDE: activation deserializes.
    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    again.load_all();
    let started = Instant::now();
    let _ = again.run_command("hello", "word-count", None, Invocation::default());
    let cold = started.elapsed();
    let stats = again.info_of("hello").unwrap().stats;
    assert_eq!(stats.activations, 1);
    eprintln!("cold activation with a precompiled component: {:.1} ms (wall {cold:?})", stats.activation_ms);
    assert!(stats.activation_ms < 250.0, "{} ms", stats.activation_ms);

    // A stale entry (other engine or uninstalled plugin) is pruned by the warm-up.
    std::fs::write(cache.join("0000-stale.cwasm"), b"junk").unwrap();
    again.warm_component_cache();
    assert_eq!(cached(), 1);
    // A corrupt entry is discarded and recompiled.
    for e in std::fs::read_dir(&cache).unwrap().flatten() {
        std::fs::write(e.path(), b"junk").unwrap();
    }
    again.reload("hello").unwrap();
    assert!(
        again.run_command("hello", "word-count", None, Invocation::default()).is_err(),
        "no active file, but it runs"
    );
    assert_eq!(again.info_of("hello").unwrap().status, PluginStatus::Active);
}

#[test]
fn install_validation_atomic_replace_and_uninstall() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();

    // Missing component file.
    let pkg = tmp.path().join("broken");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(
        pkg.join("plugin.toml"),
        "id = \"b\"\nname = \"B\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\nwasm = \"x.wasm\"",
    )
    .unwrap();
    let install = |p: &Path| f.host.install_from_dir(p, &Consent::all());
    assert!(install(&pkg).unwrap_err().message.contains("missing"));
    // Not a component.
    std::fs::write(pkg.join("x.wasm"), b"\0asm garbage").unwrap();
    assert!(install(&pkg).unwrap_err().message.contains("not a valid plugin component"));
    // Bad manifest.
    std::fs::write(pkg.join("plugin.toml"), "id = \"B!\"").unwrap();
    assert!(install(&pkg).is_err());
    assert!(f.host.list(None).plugins.is_empty(), "failed installs leave nothing behind");

    // A broken package already in the plugins dir shows up as failed.
    std::fs::create_dir_all(f.plugins_dir.join("junk")).unwrap();
    std::fs::write(f.plugins_dir.join("junk/plugin.toml"), "garbage = ").unwrap();
    f.host.load_all();
    let junk = &f.host.list(None).plugins[0];
    assert_eq!(junk.status, PluginStatus::Failed);
    assert!(junk.error.is_some());

    // Reinstall replaces; a failing reinstall keeps the installed version.
    f.install(&sample("hello"));
    f.install(&sample("hello"));
    assert_eq!(f.status("hello"), PluginStatus::Inactive);
    let bad = hello_variant(tmp.path(), |t| t.replace("version = \"0.3.0\"", "version = \"0.9.0\""));
    std::fs::write(bad.join("dist/plugin.wasm"), b"not wasm").unwrap();
    assert!(install(&bad).is_err());
    assert_eq!(f.host.info_of("hello").unwrap().version, "0.3.0");
    assert!(f.installed("hello").join("dist/plugin.wasm").is_file());
    assert!(f.installed("hello").join(".package-hash").is_file());
    let leftovers: Vec<_> = std::fs::read_dir(&f.plugins_dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(".staging"))
        .collect();
    assert!(leftovers.is_empty());

    f.host.uninstall("hello").unwrap();
    assert!(!f.plugins_dir.join("hello").exists());
    assert!(f.host.info_of("hello").is_err());
}

#[test]
fn unknown_contribution_points_are_skipped_with_a_warning() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = tmp.path().join("future");
    copy_dir(&sample("language-toy"), &pkg);
    let manifest = pkg.join("plugin.toml");
    let text = std::fs::read_to_string(&manifest).unwrap();
    std::fs::write(&manifest, format!("{text}\n[[contributes.holograms]]\nshape = \"cube\"\n")).unwrap();
    let info = f.install(&pkg);
    assert_eq!(info.status, PluginStatus::Static);
    assert!(info.warnings.iter().any(|w| w.contains("holograms")));
    assert_eq!(f.host.languages().len(), 1);
}

#[test]
fn icon_themes_are_a_contribution_type_like_any_other() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = tmp.path().join("icons");
    std::fs::create_dir_all(pkg.join("svg")).unwrap();
    std::fs::write(pkg.join("svg/rust.svg"), r#"<svg viewBox="0 0 16 16"><path d="M0 0h16"/></svg>"#).unwrap();
    std::fs::write(pkg.join("svg/file.svg"), r#"<svg viewBox="0 0 16 16"><rect width="9" height="9"/></svg>"#).unwrap();
    std::fs::write(
        pkg.join("theme.json"),
        r#"{"iconDefinitions":{"rust":"svg/rust.svg","file":"svg/file.svg"},"file":"file","fileExtensions":{"rs":"rust"}}"#,
    )
    .unwrap();
    std::fs::write(
        pkg.join("plugin.toml"),
        "id = \"acme.icons\"\nname = \"Icons\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n\
         [[contributes.iconThemes]]\nid = \"acme\"\nlabel = \"Acme Icons\"\npath = \"theme.json\"\n",
    )
    .unwrap();
    let info = f.install(&pkg);
    assert_eq!(info.status, PluginStatus::Static, "{:?}", info.error);
    assert!(f.installed("acme.icons").join("svg/rust.svg").is_file(), "referenced files are installed");
    let items = f.host.ui_items("iconThemes");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].decl["label"], "Acme Icons");
    let svgs = f.host.assets("acme.icons", &icon_theme_svg_prefix("acme")).unwrap();
    assert_eq!(svgs.len(), 2);
    let map = f.host.assets("acme.icons", &icon_theme_map_asset("acme")).unwrap();
    assert!(map[0].1.contains("\"rs\":\"rust\""));
    f.host.set_enabled("acme.icons", false).unwrap();
    assert!(f.host.ui_items("iconThemes").is_empty());
    assert!(f.host.assets("acme.icons", "").is_err());
}

#[test]
fn official_material_icons_install() {
    let f = fixture(Limits::default());
    let info = f.install(&repo().join("plugins/official/material-icons"));
    assert_eq!(info.status, PluginStatus::Static, "{:?}", info.error);
    let theme: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(repo().join("plugins/official/material-icons/icons/theme.json")).unwrap(),
    )
    .unwrap();
    let defined = theme["iconDefinitions"].as_object().unwrap().len();
    let svgs = f.host.assets("openidea.material-icons", &icon_theme_svg_prefix("material")).unwrap();
    assert_eq!(svgs.len(), defined, "every icon survives the sanitiser");
    let map = &f.host.assets("openidea.material-icons", &icon_theme_map_asset("material")).unwrap()[0].1;
    assert!(map.contains("\"src\":\"folder-src\""), "folder names are part of the mapping");
    assert!(
        !f.installed("openidea.material-icons").join("generate.py").exists(),
        "only referenced files are installed"
    );
}

/// Plan P1: an icon theme with thousands of SVGs (sanitising, package size, start-up).
#[test]
fn thousands_of_icons_install_and_reload_within_budget() {
    const ICONS: usize = 3000;
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = tmp.path().join("many");
    std::fs::create_dir_all(pkg.join("svg")).unwrap();
    let mut defs = serde_json::Map::new();
    let mut exts = serde_json::Map::new();
    for i in 0..ICONS {
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3" fill="#{:06x}"/><path fill="#fff" fill-opacity=".4" d="M4 1h5.6L13 4.4V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"/><text x="8" y="11" font-family="system-ui, sans-serif" font-size="7" font-weight="700" text-anchor="middle" fill="#fff">{}</text></svg>"##,
            i * 2654435 % 0xff_ffff,
            i % 100
        );
        std::fs::write(pkg.join(format!("svg/i{i}.svg")), svg).unwrap();
        defs.insert(format!("i{i}"), format!("svg/i{i}.svg").into());
        exts.insert(format!("x{i}"), format!("i{i}").into());
    }
    let theme = serde_json::json!({ "iconDefinitions": defs, "file": "i0", "fileExtensions": exts });
    std::fs::write(pkg.join("theme.json"), theme.to_string()).unwrap();
    std::fs::write(
        pkg.join("plugin.toml"),
        "id = \"acme.many\"\nname = \"Many\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n\
         [[contributes.iconThemes]]\nid = \"many\"\nlabel = \"Many\"\npath = \"theme.json\"\n",
    )
    .unwrap();

    let started = Instant::now();
    let info = f.install(&pkg);
    let install = started.elapsed();
    assert_eq!(info.status, PluginStatus::Static, "{:?}", info.error);
    assert_eq!(f.host.assets("acme.many", &icon_theme_svg_prefix("many")).unwrap().len(), ICONS);

    let started = Instant::now();
    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    again.load_all();
    let reload = started.elapsed();
    assert_eq!(again.assets("acme.many", &icon_theme_svg_prefix("many")).unwrap().len(), ICONS);
    eprintln!("{ICONS} icons: install {install:?}, load at start-up {reload:?} (from the contribution index)");
    // Generous for debug builds; release is several times faster.
    assert!(install < Duration::from_secs(5), "install took {install:?}");
    assert!(reload < Duration::from_secs(3), "start-up load took {reload:?}");

    // Start-up reads the validated declaration from the index, not the SVGs:
    // a tampered icon file is not even looked at...
    let index = f.plugins_dir.join(".cache/contributions");
    assert_eq!(std::fs::read_dir(&index).unwrap().count(), 1);
    std::fs::write(f.installed("acme.many").join("svg/i1.svg"), "<svg><script>alert(1)</script></svg>").unwrap();
    let third = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    third.load_all();
    let icon = third.assets("acme.many", &icon_theme_svg_prefix("many")).unwrap();
    assert!(icon.iter().all(|(_, svg)| !svg.contains("script")));
    // ...and without the index everything is validated again.
    std::fs::remove_dir_all(&index).unwrap();
    let fourth = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    fourth.load_all();
    assert_eq!(fourth.info_of("acme.many").unwrap().status, PluginStatus::Failed, "the tampered icon is rejected");
}

#[test]
fn linked_development_plugins() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = tmp.path().join("toy");
    copy_dir(&sample("language-toy"), &pkg);
    let info = f.host.link(&pkg).unwrap();
    assert_eq!(info.source, PluginSource::Linked);
    assert_eq!(info.status, PluginStatus::NeedsConsent);
    f.host.grant("language-toy", &Consent::default()).unwrap();
    assert_eq!(f.host.languages().len(), 1);
    // Survives a restart (links.json) and keeps its grant (by path).
    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    again.load_all();
    assert_eq!(again.info_of("language-toy").unwrap().status, PluginStatus::Static);
    again.unlink("language-toy").unwrap();
    assert!(again.info_of("language-toy").is_err());
}

#[test]
fn catalog_lists_sample_packages() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let broken = tmp.path().join("broken");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(
        broken.join("plugin.toml"),
        "id = \"x\"\nname = \"X\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\nwasm = \"dist/plugin.wasm\"\n",
    )
    .unwrap();
    std::fs::create_dir_all(tmp.path().join("junk")).unwrap();
    std::fs::write(tmp.path().join("junk/plugin.toml"), "garbage = ").unwrap();

    let catalog = f.host.catalog(&[repo().join("plugins"), repo().join("templates"), tmp.path().to_path_buf()]);
    let ids: Vec<&str> = catalog.iter().map(|c| c.id.as_str()).collect();
    for id in ["hello", "theme-harbor-night", "language-toy", "x"] {
        assert!(ids.contains(&id), "{id} missing from {ids:?}");
    }
    let hello = catalog.iter().find(|c| c.id == "hello").unwrap();
    assert!(hello.has_code && hello.problem.is_none() && hello.change_notes.is_some());
    assert_eq!(hello.contributions.iter().find(|c| c.point == "commands").unwrap().count, 2);
    let theme = catalog.iter().find(|c| c.id == "theme-harbor-night").unwrap();
    assert!(!theme.has_code);
    assert_eq!(theme.contributions[0].count, 1);
    let x = catalog.iter().find(|c| c.id == "x").unwrap();
    assert!(x.problem.as_deref().unwrap().contains("plugin.wasm"));
}

fn official(name: &str) -> PathBuf {
    repo().join("plugins/official").join(name)
}

/// Plan P5, String Tools: 26 commands show before the code loads; one command
/// edits every selection as one versioned change.
#[test]
fn official_string_tools() {
    let f = fixture(Limits::default());
    let info = f.install(&official("string-tools"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    let titles = f.command_titles("openidea.string-tools");
    assert_eq!(titles.len(), 26);
    assert!(titles.contains(&"String Tools: To snake_case".to_owned()));
    let categories: std::collections::BTreeSet<String> =
        f.host.ui_items(COMMANDS).iter().filter_map(|c| c.decl["category"].as_str().map(str::to_owned)).collect();
    assert_eq!(categories.len(), 4, "{categories:?}");

    let editor = f.workspace.open("src/notes.txt", &[(0, 0, 0, 3), (1, 5, 1, 5)]);
    let before = f.workspace.document(&editor.path).unwrap().0;
    f.run_in(&editor, "openidea.string-tools", "upper-case").unwrap();
    assert_eq!(f.workspace.text("src/notes.txt"), "ONE two three\nfour FIVE\n");
    assert_eq!(f.workspace.document(&editor.path).unwrap().0, before + 1, "both selections in one change");
}

/// Plan P5, Key Promoter: action events are batched; an idle plugin is
/// woken once per batch, and its counts persist in storage.
#[test]
fn official_key_promoter() {
    let f = fixture(Limits::default());
    f.install(&official("key-promoter"));
    assert!(f.host.event_kinds().contains(&EventKind::ActionPerformed), "subscribed by its manifest");
    let menu = |action: &str| {
        WorkbenchEvent::ActionPerformed(ActionPerformed {
            action: action.into(),
            title: "Duplicate Line".into(),
            source: ActionSource::Menu,
            shortcut: Some("Ctrl+D".into()),
        })
    };
    let typed = WorkbenchEvent::ActionPerformed(ActionPerformed {
        action: "editor.copy".into(),
        title: "Copy".into(),
        source: ActionSource::Keyboard,
        shortcut: Some("Ctrl+C".into()),
    });
    f.take_events();
    let now = Instant::now();
    f.host.post_events(Some("main"), vec![menu("code.duplicate"), typed]);
    f.host.flush_events_at(now);
    assert_eq!(f.host.instances(), 0, "an idle plugin collects a batch first");
    f.host.post_events(Some("main"), vec![menu("code.duplicate"), menu("code.duplicate")]);
    f.host.flush_events_at(now + Duration::from_secs(3));
    assert!(f.host.wait_events(Duration::from_secs(10)));
    let info = f.host.info_of("openidea.key-promoter").unwrap();
    assert_eq!((info.status, info.stats.activations, info.stats.calls), (PluginStatus::Active, 1, 1), "one wake-up");
    let tips: Vec<_> = f
        .take_events()
        .into_iter()
        .filter_map(|(client, e)| match e {
            PluginEvent::Notification { title, body, .. } => Some((client, title, body)),
            _ => None,
        })
        .collect();
    assert_eq!(tips.len(), 1, "{tips:?}");
    assert_eq!(tips[0].0.as_deref(), Some("main"), "shown in the window the actions came from");
    assert!(tips[0].1.contains("Ctrl+D") && tips[0].2.contains("3 times"), "{tips:?}");
    let stored = std::fs::read_to_string(f.plugins_dir.join(".data/openidea.key-promoter/storage.json")).unwrap();
    assert!(stored.contains("\"count:code.duplicate\":\"3\""), "{stored}");

    // Uninstalling removes its data.
    f.host.uninstall("openidea.key-promoter").unwrap();
    assert!(!f.plugins_dir.join(".data/openidea.key-promoter").exists());
    assert!(f.host.event_kinds().is_empty());
}

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// Plan P5 acceptance: Git Toolbox's scheduled fetch still runs after the
/// instance was reclaimed while idle, and the status bar follows.
#[test]
fn official_git_toolbox_fetches_on_schedule_after_idle_reclaim() {
    let f = fixture(Limits { idle_timeout: Some(Duration::from_millis(50)), ..Limits::default() });
    let tmp = tempfile::tempdir().unwrap();
    // The project tracks a remote that gets one more commit.
    let remote = tmp.path().join("remote.git");
    std::fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "--bare", "-b", "main"]);
    git(&f.project, &["init", "-b", "main"]);
    git(&f.project, &["add", "."]);
    git(&f.project, &["commit", "-m", "one"]);
    git(&f.project, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&f.project, &["push", "-u", "origin", "main"]);
    let other = tmp.path().join("other");
    git(tmp.path(), &["clone", remote.to_str().unwrap(), other.to_str().unwrap()]);
    std::fs::write(other.join("b.txt"), "b").unwrap();
    git(&other, &["add", "."]);
    git(&other, &["commit", "-m", "two"]);
    git(&other, &["push"]);

    f.install(&official("git-toolbox"));
    // Focusing an editor wakes it to show the branch (nothing fetched yet).
    let now = Instant::now();
    f.host.post_events(Some("main"), vec![WorkbenchEvent::EditorFocused(Some("src/notes.txt".into()))]);
    f.host.flush_events_at(now + Duration::from_secs(3));
    assert!(f.host.wait_events(Duration::from_secs(10)));
    let item = |host: &PluginHost| {
        host.status_items().into_iter().find(|(p, id, _)| p == "openidea.git-toolbox" && id == "branch")
    };
    assert_eq!(item(&f.host).map(|(_, _, i)| i.text), Some("main".into()));

    // Idle: reclaimed.
    std::thread::sleep(Duration::from_millis(100));
    f.host.tick();
    assert_eq!(f.host.instances(), 0);
    assert_eq!(f.status("openidea.git-toolbox"), PluginStatus::Inactive);
    assert!(item(&f.host).is_some(), "its status item stays while it sleeps");

    // Five minutes later: activated by its schedule, fetches, shows ↓1.
    f.take_events();
    f.host.tick_at(Instant::now() + Duration::from_secs(301));
    assert!(f.host.wait_events(Duration::from_secs(30)));
    let info = f.host.info_of("openidea.git-toolbox").unwrap();
    assert_eq!(info.stats.activations, 2, "{:?}", info.error);
    assert_eq!(item(&f.host).map(|(_, _, i)| i.text), Some("main ↓1".into()));
    let events = f.take_events();
    assert!(
        events.iter().any(
            |(_, e)| matches!(e, PluginEvent::TaskStarted { title, cancellable: true, .. } if title == "Fetching")
        )
    );
    assert!(events.iter().any(|(_, e)| matches!(e, PluginEvent::TaskEnded { .. })));
    let stored = std::fs::read_to_string(f.plugins_dir.join(".data/openidea.git-toolbox/storage.json")).unwrap();
    assert!(stored.contains("last-fetch:"), "{stored}");
}

/// Restricted Mode: git does not run in an untrusted project (no fetch).
#[test]
fn git_toolbox_does_not_fetch_untrusted_projects() {
    let f = fixture(Limits::default());
    git(&f.project, &["init", "-b", "main"]);
    f.install(&official("git-toolbox"));
    let untrusted = Arc::new(TestWorkspace {
        root: f.project.clone(),
        documents: f.workspace.documents.clone(),
        trusted: false,
        diagnostics: Mutex::default(),
        settings: Mutex::default(),
    });
    f.host.set_workspace(Some(untrusted));
    let err = f.run("openidea.git-toolbox", "fetch", None).unwrap_err();
    assert!(err.contains("Restricted Mode"), "{err}");
}

/// A tiny HTTP server: each request is answered after `delay(n)` (n counts
/// requests) with `body`. Returns its port and the request bodies it got.
fn http_server(
    body: &'static str,
    delay: impl Fn(usize) -> Duration + Send + Sync + 'static,
) -> (u16, Arc<Mutex<Vec<String>>>) {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let (log, delay) = (seen.clone(), Arc::new(delay));
    std::thread::spawn(move || {
        for (n, stream) in listener.incoming().flatten().enumerate() {
            let (log, delay) = (log.clone(), delay.clone());
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut len = 0;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut req = vec![0; len];
                let _ = reader.read_exact(&mut req);
                log.lock().push(String::from_utf8_lossy(&req).into_owned());
                std::thread::sleep(delay(n));
                let mut stream = stream;
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });
    (port, seen)
}

/// Plan P6, AI Completion: typing on cancels the previous request (the fetch
/// returns `cancelled`, the instance stays); the plugin's own work stays
/// within the edit-path budget.
#[test]
fn official_ai_completion_cancels_superseded_requests() {
    let f = fixture(Limits::default());
    f.install(&official("ai-completion"));
    let (port, seen) = http_server(r#"{"choices":[{"text":"a + b\n"}]}"#, |n| {
        if n == 0 { Duration::from_secs(3) } else { Duration::ZERO }
    });
    f.run("openidea.ai-completion", "set-endpoint", Some(&format!("http://localhost:{port}"))).unwrap();
    let doc = ide_plugin::ProviderDocument {
        path: f.project.join("src/a.rs"),
        language: "rust".into(),
        version: 1,
        text: "fn add(a: i32, b: i32) -> i32 {\n    \n}\n".into(),
    };
    let at = ide_core::Pos::new(1, 4);
    let host = Arc::new(f);
    // A slow request, superseded 200 ms later by the next keystroke's.
    let first = ide_core::CancellationToken::new();
    let slow = {
        let (host, doc, first) = (host.clone(), doc.clone(), first.clone());
        std::thread::spawn(move || {
            let started = Instant::now();
            let r = host.host.provide_inline_completion(&doc, at, &first);
            (r, started.elapsed())
        })
    };
    std::thread::sleep(Duration::from_millis(200));
    first.cancel();
    let started = Instant::now();
    let second = host.host.provide_inline_completion(&doc, at, &ide_core::CancellationToken::new());
    let took = started.elapsed();
    let (old, old_took) = slow.join().unwrap();
    assert!(old.is_none(), "the superseded request yields nothing");
    assert!(old_took < Duration::from_secs(1), "cancelled, not waited out: {old_took:?}");
    assert_eq!(second.map(|(_, s)| s.insert_text).as_deref(), Some("a + b"));
    eprintln!("inline completion after cancelling the previous request: {took:?}");
    let info = host.host.info_of("openidea.ai-completion").unwrap();
    assert_eq!((info.stats.crashes, info.stats.activations), (0, 1), "cooperative: same instance");
    assert!(seen.lock()[1].contains("\"prompt\":\"fn add(a: i32, b: i32) -> i32 {\\n    \""), "{:?}", seen.lock());

    // The plugin's own share of a call (local server, no delay): edit-path budget.
    let mut times = Vec::new();
    for _ in 0..10 {
        let started = Instant::now();
        assert!(host.host.provide_inline_completion(&doc, at, &ide_core::CancellationToken::new()).is_some());
        times.push(started.elapsed());
    }
    times.sort();
    eprintln!("inline completion round trip p95 (local server): {:?}", times[9]);
    assert!(times[9] < Duration::from_millis(500), "{times:?}");
}

/// Plan P6, Checkstyle: a save runs the approved `checkstyle` and publishes
/// diagnostics; quick fixes come through the code-action provider; saving
/// again cancels the check still running.
#[cfg(unix)]
#[test]
fn official_checkstyle_checks_on_save() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(Limits::default());
    let bin = f.plugins_dir.parent().unwrap().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // Reports a tab on line 2; files containing SLOW take 5 s.
    std::fs::write(
        bin.join("checkstyle"),
        "#!/bin/sh\nfor a; do file=\"$a\"; done\ngrep -q SLOW \"$file\" && sleep 5\n\
         echo '<?xml version=\"1.0\"?><checkstyle><file name=\"'\"$file\"'\">'\n\
         echo '<error line=\"2\" column=\"1\" severity=\"warning\" message=\"Line contains a tab character.\" source=\"com.puppycrawl.tools.checkstyle.checks.whitespace.FileTabCharacterCheck\"/>'\n\
         echo '</file></checkstyle>'\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(bin.join("checkstyle"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = bin.clone();
    f.host.set_program_path(Arc::new(move || Some(path.clone().into_os_string())));
    let info = f.install(&official("checkstyle"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);

    let java = f.project.join("src/A.java");
    std::fs::write(&java, "class A {\n\tint x;\n}\n").unwrap();
    let saved = |f: &Fixture| {
        f.host.post_events(Some("main"), vec![WorkbenchEvent::FileSaved(java.to_string_lossy().into_owned())]);
        f.host.flush_events_at(Instant::now() + Duration::from_secs(3));
    };
    saved(&f);
    assert!(f.host.wait_events(Duration::from_secs(20)));
    let diagnostics =
        |f: &Fixture| f.workspace.diagnostics.lock().get(&("openidea.checkstyle".into(), java.clone())).cloned();
    let d = diagnostics(&f).expect("published");
    assert_eq!((d.len(), d[0].code.as_deref(), d[0].range.start.line), (1, Some("FileTabCharacter"), 1));

    // The quick fix, through the provider (as the editor asks for it).
    let doc = ide_plugin::ProviderDocument {
        path: java.clone(),
        language: "java".into(),
        version: 1,
        text: std::fs::read_to_string(&java).unwrap(),
    };
    let range = ide_core::Range::new(ide_core::Pos::new(1, 0), ide_core::Pos::new(1, 0));
    let actions = f.host.provide_code_actions(&doc, range);
    assert_eq!(actions.len(), 1, "{actions:?}");
    assert_eq!(actions[0].1.title, "Checkstyle: Replace tabs with spaces");
    assert_eq!(actions[0].1.edits[0].1[0].new_text, "    int x;");

    // A slow check is cancelled by the next save.
    f.workspace.diagnostics.lock().clear();
    std::fs::write(&java, "class A { // SLOW\n\tint x;\n}\n").unwrap();
    let started = Instant::now();
    saved(&f);
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(&java, "class A {\n\tint y;\n}\n").unwrap();
    saved(&f);
    assert!(f.host.wait_events(Duration::from_secs(20)));
    assert!(started.elapsed() < Duration::from_secs(4), "the slow run was killed: {:?}", started.elapsed());
    assert_eq!(diagnostics(&f).map(|d| d.len()), Some(1), "published by the second check");
    let info = f.host.info_of("openidea.checkstyle").unwrap();
    assert_eq!(info.stats.crashes, 0);
}

/// Plan P6, MyBatis Navigator: interface ↔ XML through the providers, on a
/// real project tree (`find-files`), within the edit-path budget.
#[test]
fn official_mybatis_navigates_between_interface_and_xml() {
    let f = fixture(Limits::default());
    f.install(&official("mybatis"));
    let java_path = f.project.join("src/main/java/com/acme/UserMapper.java");
    let xml_path = f.project.join("src/main/resources/mapper/UserMapper.xml");
    std::fs::create_dir_all(java_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(xml_path.parent().unwrap()).unwrap();
    let java = "package com.acme;\n\npublic interface UserMapper {\n    User findById(long id);\n}\n";
    let xml = "<mapper namespace=\"com.acme.UserMapper\">\n  <select id=\"findById\">select 1</select>\n</mapper>\n";
    std::fs::write(&java_path, java).unwrap();
    std::fs::write(&xml_path, xml).unwrap();
    // Noise the index has to skip.
    for i in 0..200 {
        std::fs::write(f.project.join(format!("src/f{i}.xml")), "<beans/>").unwrap();
    }
    let doc = |path: &Path, language: &str, text: &str| ide_plugin::ProviderDocument {
        path: path.to_path_buf(),
        language: language.into(),
        version: 1,
        text: text.into(),
    };
    let jdoc = doc(&java_path, "java", java);
    let markers = f.host.provide_line_markers(&jdoc);
    assert_eq!(markers.len(), 1, "{markers:?}");
    let target = markers[0].1.target.clone().unwrap();
    assert_eq!((target.path, target.range.start), (xml_path.clone(), ide_core::Pos::new(1, 14)));

    let xdoc = doc(&xml_path, "xml", xml);
    let to_java = f.host.provide_definition(&xdoc, ide_core::Pos::new(1, 16));
    assert_eq!(
        to_java.iter().map(|l| (l.path.clone(), l.range.start)).collect::<Vec<_>>(),
        [(java_path.clone(), ide_core::Pos::new(3, 9))]
    );
    assert!(
        f.host.provide_definition(&doc(&f.project.join("src/a.rs"), "rust", ""), ide_core::Pos::new(0, 0)).is_empty(),
        "not its language"
    );

    // Warm (index cached): well inside the edit-path budget.
    let mut times = Vec::new();
    for _ in 0..20 {
        let started = Instant::now();
        assert_eq!(f.host.provide_line_markers(&jdoc).len(), 1);
        times.push(started.elapsed());
    }
    times.sort();
    eprintln!("mybatis line markers p95: {:?}", times[18]);
    assert!(times[18] < Duration::from_millis(50), "{times:?}");
    assert_eq!(f.host.info_of("openidea.mybatis").unwrap().stats.slow_calls, 0);
}

/// Plan P7, CSV Editor: a custom editor renders the document as a table (the
/// rows asked for), and edits the document itself — versioned, so a text edit
/// made meanwhile is never overwritten.
#[test]
fn official_csv_editor_edits_the_shared_document() {
    let f = fixture(Limits::default());
    let info = f.install(&official("csv-editor"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    std::fs::write(f.project.join("people.csv"), "name,city\nAda,London\nBob,Oslo\n").unwrap();
    let editor = f.workspace.open("people.csv", &[]);
    let inv = Invocation { editor: Some(editor.clone()), ..f.inv() };
    let viewport = Some(ide_plugin::Viewport { first_row: 1, rows: 10 });
    let view = f.host.render_view("openidea.csv-editor", "table", viewport, inv.clone()).unwrap();
    let ide_plugin::ViewBody::Table(t) = &view.body else { panic!("{view:?}") };
    assert_eq!((t.columns.clone(), t.total_rows, t.first_row), (vec!["name".to_owned(), "city".into()], 2, 1));
    assert_eq!(t.rows, [vec!["Bob".to_owned(), "Oslo".into()]]);
    assert_eq!(view.status.as_deref(), Some("2 rows × 2 columns, delimiter ','"));

    let cell = ide_plugin::ViewEvent::Cell { row: 0, column: 1, value: "Paris, FR".into() };
    f.host.view_event("openidea.csv-editor", "table", cell, inv.clone()).unwrap();
    assert_eq!(f.workspace.text("people.csv"), "name,city\nAda,\"Paris, FR\"\nBob,Oslo\n");

    // Settings: without a header row every record is a row.
    let mut values = serde_json::Map::new();
    values.insert("firstRowIsHeader".into(), serde_json::Value::Bool(false));
    f.workspace.settings.lock().insert("openidea.csv-editor".into(), values);
    let view = f.host.render_view("openidea.csv-editor", "table", None, inv.clone()).unwrap();
    let ide_plugin::ViewBody::Table(t) = &view.body else { panic!("{view:?}") };
    assert_eq!((t.columns[0].as_str(), t.total_rows), ("Column 1", 3));

    // Undeclared views are refused before any code runs.
    let err = f.host.render_view("openidea.csv-editor", "other", None, inv).unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::NotFound);
}

/// Plan P7 acceptance: the sample plugin makes a tool window with a tree view.
/// Its menus, shortcut and status bar item are declarations, listed before
/// any code runs; the tree is rendered by the code, which loads on first show.
#[test]
fn sample_plugin_tool_window_with_a_tree() {
    let f = fixture(Limits::default());
    let info = f.install(&sample("hello"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    for point in ["menus", "keymaps", "statusBar", "views"] {
        assert_eq!(f.host.ui_items(point).len(), 1, "{point}");
    }
    let view = f.host.ui_items("views").remove(0);
    assert_eq!((view.key.as_str(), view.decl["location"].as_str()), ("greetings", Some("right")));
    assert_eq!(f.status("hello"), PluginStatus::Inactive, "declarations need no code");

    let tree = |f: &Fixture| match f.host.render_view("hello", "greetings", None, f.inv()).unwrap().body {
        ide_plugin::ViewBody::Tree(items) => items,
        other => panic!("{other:?}"),
    };
    assert_eq!(tree(&f).iter().map(|i| i.label.as_str()).collect::<Vec<_>>(), ["English", "Deutsch", "日本語"]);
    assert_eq!(f.status("hello"), PluginStatus::Active, "activated on show (on-view)");
    f.take_events();
    f.host.view_event("hello", "greetings", ide_plugin::ViewEvent::Expand { key: "English".into() }, f.inv()).unwrap();
    let refreshed = f.take_events().into_iter().any(|(_, e)| {
        matches!(e, PluginEvent::ViewChanged { ref plugin_id, ref view } if plugin_id == "hello" && view == "greetings")
    });
    assert!(refreshed, "the plugin asked for a refresh");
    let items = tree(&f);
    assert_eq!(items.len(), 6);
    assert_eq!(items[1].parent.as_deref(), Some("English"));
    f.host
        .view_event("hello", "greetings", ide_plugin::ViewEvent::Activate { key: "English/Hi".into() }, f.inv())
        .unwrap();
    assert!(f.take_events().iter().any(|(_, e)| matches!(e, PluginEvent::Notification { title, .. } if title == "Hi")));

    // Disabling withdraws every declaration.
    f.host.set_enabled("hello", false).unwrap();
    for point in ["menus", "keymaps", "statusBar", "views"] {
        assert!(f.host.ui_items(point).is_empty(), "{point}");
    }
}

/// Plan P7, Kubernetes: the cluster tree through `kubectl` (pinned), logs in
/// the terminal of the invoking window.
#[test]
fn official_kubernetes_browses_the_cluster_and_opens_logs() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(Limits::default());
    let bin = f.plugins_dir.parent().unwrap().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(
        bin.join("kubectl"),
        "#!/bin/sh\ncase \"$*\" in\n\
         *'get namespaces'*) echo '{\"items\":[{\"metadata\":{\"name\":\"default\"}}]}' ;;\n\
         *'get pods'*) echo '{\"items\":[{\"metadata\":{\"name\":\"web-1\"},\"status\":{\"phase\":\"Running\",\"containerStatuses\":[{\"ready\":true}]}}]}' ;;\n\
         *) echo '{\"items\":[]}' ;;\nesac\n",
    )
    .unwrap();
    std::fs::set_permissions(bin.join("kubectl"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = bin.clone();
    f.host.set_program_path(Arc::new(move || Some(path.clone().into_os_string())));
    let info = f.install(&official("kubernetes"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    let ev = |e: ide_plugin::ViewEvent| f.host.view_event("openidea.kubernetes", "cluster", e, f.inv()).unwrap();
    ev(ide_plugin::ViewEvent::Expand { key: "default".into() });
    ev(ide_plugin::ViewEvent::Expand { key: "default/pods".into() });
    let view = f.host.render_view("openidea.kubernetes", "cluster", None, f.inv()).unwrap();
    let ide_plugin::ViewBody::Tree(items) = &view.body else { panic!("{view:?}") };
    let pod = items.iter().find(|i| i.key == "default/pods/web-1").expect("the pod");
    assert_eq!(pod.detail.as_deref(), Some("Running 1/1"));
    f.take_events();
    ev(ide_plugin::ViewEvent::Activate { key: "default/pods/web-1".into() });
    let terminal = f.take_events().into_iter().find_map(|(client, e)| match e {
        PluginEvent::OpenTerminal { title, program, args, .. } => Some((client, title, program, args)),
        _ => None,
    });
    let (client, title, program, args) = terminal.expect("a terminal");
    assert_eq!((client.as_deref(), title.as_str()), (Some("main"), "logs: web-1"));
    assert_eq!(program.0, bin.join("kubectl").canonicalize().unwrap());
    assert_eq!(args, ["logs", "-f", "--tail=200", "-n", "default", "web-1"]);
}
