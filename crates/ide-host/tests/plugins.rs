//! End-to-end tests of the plugin host against real components.
//!
//! The components are checked in (`dist/plugin.wasm` of the official plugins
//! and of the fixtures in `crates/ide-plugin/tests/fixtures/`: `hello`, `jobs`,
//! `misbehave`) so tests need no wasm toolchain. Rebuild them with
//! `plugins/build.sh <dir>` after changing their source or `wit/`.

use ide_core::error::ErrorKind;
use ide_core::ipc_path::to_ipc;
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
    other_roots: Mutex<Vec<PathBuf>>,
    documents: Arc<ide_workspace::Documents>,
    trusted: bool,
    project_queries_left: Mutex<Option<usize>>,
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
            other_roots: Mutex::default(),
            documents: Arc::new(documents),
            trusted: true,
            project_queries_left: Mutex::new(None),
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
        std::iter::once(self.root.clone()).chain(self.other_roots.lock().iter().cloned()).collect()
    }
    fn buffer_text(&self, path: &Path) -> Option<String> {
        self.documents.text_of(path)
    }
    fn buffer_dirty(&self, path: &Path) -> bool {
        self.documents.by_path(path).is_some_and(|doc| self.documents.is_dirty(doc).unwrap_or(false))
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
        if let Some(left) = self.project_queries_left.lock().as_mut() {
            if *left == 0 {
                return None;
            }
            *left -= 1;
        }
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

/// A test fixture plugin (`crates/ide-plugin/tests/fixtures/<name>`).
fn sample(name: &str) -> PathBuf {
    repo().join("crates/ide-plugin/tests/fixtures").join(name)
}

fn theme_template() -> PathBuf {
    repo().join("plugins/official/harbor-night")
}

fn misbehave_pkg() -> PathBuf {
    repo().join("crates/ide-plugin/tests/fixtures/misbehave")
}

/// `misbehave` with `fs.read:<granted>` added to its capabilities.
fn misbehave_granted(dir: &Path, granted: &Path) -> PathBuf {
    let pkg = dir.join("misbehave-granted");
    copy_dir(&misbehave_pkg(), &pkg);
    let manifest = pkg.join("plugin.toml");
    let text = std::fs::read_to_string(&manifest).unwrap();
    let path = granted.to_string_lossy().replace('\\', "/");
    let required = format!("required = [\"project.read\", \"fs.read:{path}\"]");
    let text = text.replace("required = [\"project.read\"]", &required);
    std::fs::write(&manifest, text).unwrap();
    pkg
}

/// `misbehave` requiring `capability` too, which is new in API 1.3.
fn misbehave_with(dir: &Path, name: &str, capability: &str) -> PathBuf {
    let pkg = dir.join(name);
    copy_dir(&misbehave_pkg(), &pkg);
    let manifest = pkg.join("plugin.toml");
    let text = std::fs::read_to_string(&manifest).unwrap();
    let required = format!("required = [\"project.read\", \"{capability}\"]");
    let text = text
        .replace("required = [\"project.read\"]", &required)
        .replace("engines.openidea = \"^1.0\"", "engines.openidea = \"^1.3\"");
    std::fs::write(&manifest, text).unwrap();
    pkg
}

/// Whether `f` holds within 5 s. A call a slow runner keeps waiting behind
/// another (or behind a new instance starting) holds once it caught up.
fn eventually(mut f: impl FnMut() -> bool) -> bool {
    let until = Instant::now() + Duration::from_secs(5);
    while !f() {
        if Instant::now() > until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    true
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
    // A Windows checkout may have CRLF line ends.
    text.replace("\r\n", "\n")
        .replace("engines.openidea = \"^1.0\"", "openidea-api = \"0.1\"")
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
    let project = dunce::canonicalize(project).unwrap();
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
        Invocation {
            client: Some("main".into()),
            workspace_root: Some(self.project.clone()),
            editor: None,
            selected_paths: Vec::new(),
        }
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
    let inv = Invocation { editor: Some(editor.clone()), ..f.inv() };
    let err = f.host.run_command("hello", "nope", None, inv).unwrap_err();
    assert_eq!(err.kind, ErrorKind::NotFound, "{err:?}");
    assert_eq!(f.status("hello"), PluginStatus::Active);
    let stats = f.host.info_of("hello").unwrap().stats;
    assert_eq!(stats.activations, 1);
    // "no file is open" is the plugin failing; an unknown command is not.
    assert!(stats.calls >= 4 && stats.errors == 1, "{stats:?}");
}

/// Edits name the document version they were computed for.
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
    // A missing path inside the project is `not-found`, like the mock reports.
    let err = f.run("misbehave", "read", Some("src/missing.txt")).unwrap_err();
    assert!(err.contains("not found"), "{err}");
    // Without a project there is nothing to read.
    let inv = Invocation::default();
    let err = f.host.run_command("misbehave", "read", Some("src/notes.txt"), inv).unwrap_err().message;
    assert!(err.contains("no project is open"), "{err}");
    assert_eq!(f.run("misbehave", "root", None).unwrap().unwrap(), to_ipc(&f.project));
    assert_eq!(f.status("misbehave"), PluginStatus::Active);
}

/// `fs.read` reaches the granted paths and nothing else, through the real
/// component: the same checks the runtime makes, against a real file system.
#[test]
fn fs_read_reaches_only_the_granted_paths() {
    let f = fixture(Limits::default());
    let shared = f._tmp.path().join("shared");
    std::fs::create_dir_all(&shared).unwrap();
    let notes = shared.join("notes.txt");
    std::fs::write(&notes, "outside the project\n").unwrap();
    // A sibling whose name starts with the grant's: not covered by it.
    let sibling = f._tmp.path().join("shared-other");
    std::fs::create_dir_all(&sibling).unwrap();
    let other = sibling.join("notes.txt");
    std::fs::write(&other, "not the same directory\n").unwrap();
    let secret = f._tmp.path().join("secret.txt");
    f.install(&misbehave_granted(f._tmp.path(), &shared));

    assert_eq!(f.run("misbehave", "fsread", Some(notes.to_str().unwrap())).unwrap().unwrap(), "outside the project\n");
    let err = f.run("misbehave", "fsread", Some(secret.to_str().unwrap())).unwrap_err();
    assert!(err.contains("fs.read:"), "the refusal names what to grant: {err}");
    let err = f.run("misbehave", "fsread", Some(other.to_str().unwrap())).unwrap_err();
    assert!(err.contains("fs.read:"), "a name prefix grants nothing: {err}");
    let err = f.run("misbehave", "fsread", Some("notes.txt")).unwrap_err();
    assert!(err.contains("absolute"), "{err}");
    let err = f.run("misbehave", "fsread", Some(shared.to_str().unwrap())).unwrap_err();
    assert!(err.contains("not a file"), "{err}");
    let missing = shared.join("gone.txt");
    let err = f.run("misbehave", "fsread", Some(missing.to_str().unwrap())).unwrap_err();
    assert!(err.contains("no such file"), "{err}");
    // A refusal is the plugin's to handle, like any other error it gets.
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!((info.status, info.stats.crashes, info.stats.errors), (PluginStatus::Active, 0, 0), "{info:?}");
}

/// `fs.read-dir` lists a granted directory, sorted, and refuses the rest.
#[test]
fn fs_read_dir_lists_a_granted_directory() {
    let f = fixture(Limits::default());
    let shared = f._tmp.path().join("shared");
    std::fs::create_dir_all(shared.join("zeta")).unwrap();
    std::fs::write(shared.join("beta.txt"), "b").unwrap();
    std::fs::write(shared.join("alpha.txt"), "a").unwrap();
    f.install(&misbehave_granted(f._tmp.path(), &shared));

    let listing = f.run("misbehave", "read-dir", Some(shared.to_str().unwrap())).unwrap().unwrap();
    let lines: Vec<&str> = listing.lines().collect();
    assert_eq!(lines, vec!["file alpha.txt", "file beta.txt", "dir zeta"], "{listing}");

    // A file is not a directory, and a path outside the grant is refused.
    let file = shared.join("alpha.txt");
    let err = f.run("misbehave", "read-dir", Some(file.to_str().unwrap())).unwrap_err();
    assert!(err.contains("not a directory"), "{err}");
    let err = f.run("misbehave", "read-dir", Some(f._tmp.path().to_str().unwrap())).unwrap_err();
    assert!(err.contains("fs.read:"), "{err}");
}

/// `project.write` creates and replaces files under the project root, and never
/// leaves it, through the real component.
#[test]
fn project_write_stays_inside_the_project() {
    let f = fixture(Limits::default());
    f.install(&misbehave_with(f._tmp.path(), "misbehave-project-writer", "project.write"));

    // A Run configuration: neither the file nor `.openidea/` exists yet.
    assert_eq!(f.run("misbehave", "projwrite", Some(".openidea/run.toml")).unwrap(), None);
    let conf = f.project.join(".openidea").join("run.toml");
    assert_eq!(std::fs::read_to_string(&conf).unwrap(), "written inside the project\n");
    // What it wrote reads back through the project.
    assert_eq!(
        f.run("misbehave", "read", Some(".openidea/run.toml")).unwrap().as_deref(),
        Some("written inside the project\n")
    );
    // An absolute path inside the root lands in the same place.
    let fresh = f.project.join("build").join("patch.txt");
    assert_eq!(f.run("misbehave", "projwrite", Some(fresh.to_str().unwrap())).unwrap(), None);
    assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "written inside the project\n");
    // Replacing an existing file rewrites it whole.
    assert_eq!(f.run("misbehave", "projwrite", Some("src/notes.txt")).unwrap(), None);
    assert_eq!(std::fs::read_to_string(f.project.join("src/notes.txt")).unwrap(), "written inside the project\n");
    // Unsaved changes in an editor are not overwritten.
    f.workspace.open("src/notes.txt", &[]);
    f.workspace.type_text("src/notes.txt", "typed ");
    let err = f.run("misbehave", "projwrite", Some("src/notes.txt")).unwrap_err();
    assert!(err.contains("unsaved changes"), "{err}");
    // Leaving the root is refused, and nothing is written.
    let err = f.run("misbehave", "projwrite", Some("../escape.txt")).unwrap_err();
    assert!(err.contains("outside the project root"), "{err}");
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!((info.status, info.stats.crashes, info.stats.errors), (PluginStatus::Active, 0, 0), "{info:?}");
}

/// `fs.write` replaces files the grant covers and nothing else, through the
/// real component.
#[test]
fn fs_write_reaches_only_the_granted_paths() {
    let f = fixture(Limits::default());
    let shared = f._tmp.path().join("shared");
    std::fs::create_dir_all(&shared).unwrap();
    let notes = shared.join("notes.txt");
    std::fs::write(&notes, "old\n").unwrap();
    let bommed = shared.join("bom.txt");
    std::fs::write(&bommed, b"\xef\xbb\xbfold").unwrap();
    let sibling = f._tmp.path().join("shared-other");
    std::fs::create_dir_all(&sibling).unwrap();
    let other = sibling.join("notes.txt");
    std::fs::write(&other, "not the same directory\n").unwrap();
    let secret = f._tmp.path().join("secret.txt");
    std::fs::write(&secret, "keep me\n").unwrap();
    let grant = format!("fs.write:{}", shared.to_string_lossy().replace('\\', "/"));
    f.install(&misbehave_with(f._tmp.path(), "misbehave-writable", &grant));

    // An existing file is replaced…
    assert_eq!(f.run("misbehave", "fswrite", Some(notes.to_str().unwrap())).unwrap(), None);
    assert_eq!(std::fs::read_to_string(&notes).unwrap(), "written by the plugin\n");
    // …a new one is created…
    let fresh = shared.join("fresh.txt");
    assert_eq!(f.run("misbehave", "fswrite", Some(fresh.to_str().unwrap())).unwrap(), None);
    assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "written by the plugin\n");
    // …and a file's encoding and BOM survive the write.
    assert_eq!(f.run("misbehave", "fswrite", Some(bommed.to_str().unwrap())).unwrap(), None);
    let bytes = std::fs::read(&bommed).unwrap();
    assert!(bytes.starts_with(b"\xef\xbb\xbf"), "the BOM stays: {bytes:?}");
    assert_eq!(String::from_utf8(bytes[3..].to_vec()).unwrap(), "written by the plugin\n");

    // Outside the grant nothing changes.
    let err = f.run("misbehave", "fswrite", Some(secret.to_str().unwrap())).unwrap_err();
    assert!(err.contains("fs.write:"), "the refusal names what to grant: {err}");
    assert_eq!(std::fs::read_to_string(&secret).unwrap(), "keep me\n");
    let err = f.run("misbehave", "fswrite", Some(other.to_str().unwrap())).unwrap_err();
    assert!(err.contains("fs.write:"), "a name prefix grants nothing: {err}");
    let err = f.run("misbehave", "fswrite", Some("notes.txt")).unwrap_err();
    assert!(err.contains("absolute"), "{err}");
    let missing_parent = shared.join("conf").join("web.xml");
    let err = f.run("misbehave", "fswrite", Some(missing_parent.to_str().unwrap())).unwrap_err();
    assert!(err.contains("directory does not exist"), "{err}");
    // Writing a directory fails rather than replacing it.
    assert!(f.run("misbehave", "fswrite", Some(shared.to_str().unwrap())).is_err(), "a directory is not a file");
    assert!(shared.is_dir(), "the directory is still there");

    // `fs.write` does not carry `fs.read`.
    let err = f.run("misbehave", "fsread", Some(notes.to_str().unwrap())).unwrap_err();
    assert!(err.contains("fs.read:"), "write does not imply read: {err}");
    // A refusal is the plugin's to handle, like any other error it gets.
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!((info.status, info.stats.crashes, info.stats.errors), (PluginStatus::Active, 0, 0), "{info:?}");
}

/// A program kept running behind a handle: the plugin writes its stdin, closes
/// it, and waits for the exit status and what the program printed. A one-off run
/// passes the environment it names.
#[test]
fn a_plugin_keeps_a_process_running_behind_a_handle() {
    let f = fixture(Limits::default());
    f.install(&misbehave_pkg());
    f.host.set_capability("misbehave", "process:git", false).unwrap();
    assert!(f.run("misbehave", "envrun", Some("legacy")).unwrap_err().contains("process:git"));
    for command in ["envrun", "envstart", "child"] {
        let err = f.run("misbehave", command, None).unwrap_err();
        assert!(err.contains("process:git"), "{command}: {err}");
    }
    // The fixture declares `process:git` as optional: it needs a program that
    // reads stdin and reports its environment. Machines running these tests have
    // git; without one, there is nothing to run and nothing to check.
    if f.host.set_capability("misbehave", "process:git", true).is_err() {
        return;
    }

    let out = f.run("misbehave", "child", None).expect("the handle works").expect("a result");
    let (hash, status) = out.split_once(' ').unwrap_or_else(|| panic!("{out}"));
    assert_eq!(hash.len(), 40, "a sha1 of what was written: {out}");
    assert!(hash.chars().all(|c| c.is_ascii_hexdigit()), "{out}");
    assert_eq!(status, "Some(0)", "it ended by itself: {out}");

    assert!(f.run("misbehave", "envrun", Some("legacy")).unwrap().unwrap().starts_with("git version"));
    let ident = f.run("misbehave", "envrun", None).expect("a run with extra environment").expect("a result");
    assert_eq!(ident.trim(), "added by the plugin");
    assert_eq!(f.run("misbehave", "envstart", None).unwrap().unwrap().trim(), "added by the plugin");
    for command in ["envdeny-run", "envdeny-start"] {
        let inherited = std::env::vars().find(|(key, _)| key != "PATH" && !key.contains('=')).unwrap().0;
        for key in ["PATH", inherited.as_str(), "", "BAD=KEY", "BAD\0KEY"] {
            let err = f.run("misbehave", command, Some(key)).unwrap_err();
            assert!(err.contains("environment variable"), "{command} {key:?}: {err}");
        }
    }
    // Dropping a resource returns the slot; the limit is simultaneous handles.
    for _ in 0..10 {
        f.run("misbehave", "childkeep", None).unwrap();
        assert_eq!(f.run("misbehave", "childpoll", None).unwrap().as_deref(), Some("None"));
        f.run("misbehave", "childdrop", None).unwrap();
    }
    for _ in 0..8 {
        f.run("misbehave", "childkeep", None).unwrap();
    }
    assert!(f.run("misbehave", "childkeep", None).unwrap_err().contains("at most 8"));
    f.run("misbehave", "childdrop", None).unwrap();
    f.run("misbehave", "childkeep", None).unwrap();
    f.host.forget_client("main");
    assert!(f.run("misbehave", "childpoll", None).unwrap_err().contains("no process"));
    assert!(f.run("misbehave", "childkeep", None).is_err(), "late starts are cancelled");
    f.host.reopen_client("main");
    f.run("misbehave", "childdrop", None).unwrap();

    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!((info.status, info.stats.crashes, info.stats.errors), (PluginStatus::Active, 0, 0), "{info:?}");
}

#[cfg(unix)]
#[test]
fn plugin_processes_end_with_their_owner() {
    for mode in ["disable", "unload", "shutdown", "reclaim", "trap", "window"] {
        let f = fixture(Limits { idle_timeout: Some(Duration::from_millis(50)), ..Limits::default() });
        f.install(&misbehave_pkg());
        f.host.set_capability("misbehave", "process:git", true).unwrap();
        let marker = format!("--path={}/process-{mode}", f.project.display());
        let alive = || {
            let ps = std::process::Command::new("ps").args(["-axo", "command="]).output().unwrap();
            assert!(ps.status.success());
            String::from_utf8_lossy(&ps.stdout).lines().any(|line| line.contains(&marker))
        };
        f.run("misbehave", "childkeep", marker.strip_prefix("--path=")).unwrap();
        assert!(alive(), "{mode}: the process started");
        match mode {
            "disable" => f.host.set_enabled("misbehave", false).unwrap(),
            "unload" => f.host.uninstall("misbehave").unwrap(),
            "shutdown" => f.host.shutdown(),
            "reclaim" => {
                std::thread::sleep(Duration::from_millis(75));
                f.host.tick();
                assert_eq!(f.host.instances(), 0);
            }
            "trap" => {
                assert!(f.run("misbehave", "panic", None).is_err());
            }
            "window" => f.host.forget_client("main"),
            _ => unreachable!(),
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!alive(), "{mode}: the process must end with its owner");
    }
}

/// A task that keeps reporting progress is still working: each report renews
/// the background budget, so the call outlives the 400 ms it began with. A task
/// that goes quiet is still cut off (see `tasks_that_stop_reporting_are_cut_off`).
#[test]
fn a_reporting_task_outlives_its_background_budget() {
    let f = fixture(Limits {
        timeout: Duration::from_millis(1_000),
        background: Duration::from_millis(2_000),
        ..Limits::default()
    });
    f.install(&misbehave_pkg());
    if f.host.set_capability("misbehave", "process:git", true).is_err() {
        return;
    }

    // Twenty-five waits of 100 ms: 2.5 s of wall time, more than the
    // budget, spent inside the host rather than the plugin.
    let started = std::time::Instant::now();
    let out = f.run("misbehave", "patient", None).expect("a patient task").expect("a result");
    let took = started.elapsed();
    assert_eq!(out, "still here");
    assert!(took >= Duration::from_millis(2_500), "it really ran the waits: {took:?}");

    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!((info.status, info.stats.crashes, info.stats.errors), (PluginStatus::Active, 0, 0), "{info:?}");
}

#[test]
fn private_directory_is_owned_persistent_and_removed_on_uninstall() {
    let f = fixture(Limits {
        timeout: Duration::from_secs(30),
        idle_timeout: Some(Duration::from_millis(100)),
        ..Limits::default()
    });
    let pkg = sample("private-dir");
    f.host.install_from_dir(&pkg, &Consent::default()).unwrap();
    let run = |cmd: &str, arg: Option<&str>| f.host.run_command("test.private-dir", cmd, arg, Invocation::default());
    let dir = PathBuf::from(run("directory", None).unwrap().unwrap());
    assert!(!dir.starts_with(f.installed("test.private-dir")));
    assert_eq!(run("roundtrip", None).unwrap().as_deref(), Some("fake private data\n"));
    assert_eq!(run("large-cache", None).unwrap().as_deref(), Some("83886080"));
    let file = dir.join("fake-secret.txt");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        for name in ["fake-secret.txt", "cache.bin"] {
            assert_eq!(std::fs::metadata(dir.join(name)).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
    for path in [f._tmp.path().join("secret.txt"), dir.parent().unwrap().join("adjacent.txt")] {
        std::fs::write(&path, "other content").unwrap();
        for cmd in ["read", "write"] {
            assert_eq!(run(cmd, path.to_str()).unwrap_err().kind, ErrorKind::PermissionDenied);
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "other content");
    }
    let other_pkg = f._tmp.path().join("other-plugin");
    copy_dir(&pkg, &other_pkg);
    let manifest = other_pkg.join("plugin.toml");
    let text = std::fs::read_to_string(&manifest).unwrap().replace("test.private-dir", "test.private-dir-other");
    std::fs::write(manifest, text).unwrap();
    f.host.install_from_dir(&other_pkg, &Consent::default()).unwrap();
    f.host.run_command("test.private-dir-other", "roundtrip", None, Invocation::default()).unwrap();
    let other_dir = PathBuf::from(
        f.host.run_command("test.private-dir-other", "directory", None, Invocation::default()).unwrap().unwrap(),
    );
    for cmd in ["read", "write"] {
        assert_eq!(run(cmd, other_dir.join("fake-secret.txt").to_str()).unwrap_err().kind, ErrorKind::PermissionDenied);
    }
    for path in [
        dir.join("../adjacent.txt"),
        dir.join("../../test.private-dir-other/files/fake-secret.txt"),
        dir.join("../../test.private-dir-other/files/new.txt"),
    ] {
        assert_eq!(run("write", path.to_str()).unwrap_err().kind, ErrorKind::PermissionDenied);
        if path.exists() {
            assert_eq!(run("read", path.to_str()).unwrap_err().kind, ErrorKind::PermissionDenied);
        }
    }
    assert!(!other_dir.join("new.txt").exists());
    assert_eq!(std::fs::read_to_string(dir.parent().unwrap().join("adjacent.txt")).unwrap(), "other content");
    assert_eq!(std::fs::read_to_string(other_dir.join("fake-secret.txt")).unwrap(), "fake private data\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(other_dir.join("fake-secret.txt"), dir.join("escape.txt")).unwrap();
        symlink(&other_dir, dir.join("escape-dir")).unwrap();
        for path in [dir.join("escape.txt"), dir.join("escape-dir/fake-secret.txt")] {
            for cmd in ["read", "write"] {
                assert_eq!(run(cmd, path.to_str()).unwrap_err().kind, ErrorKind::PermissionDenied);
            }
        }
        assert_eq!(
            run("write", dir.join("escape-dir/new.txt").to_str()).unwrap_err().kind,
            ErrorKind::PermissionDenied
        );
    }
    // The same real file opens and saves through Documents, preserving privacy.
    f.workspace.documents.open(&file).unwrap();
    let doc = f.workspace.documents.by_path(&file).unwrap();
    f.workspace
        .documents
        .apply_edits(doc, &[ide_core::TextEdit { range: ide_core::Range::default(), new_text: "edited ".into() }])
        .unwrap();
    assert!(run("write", None).unwrap_err().message.contains("unsaved changes"));
    assert_eq!(run("read", None).unwrap().as_deref(), Some("edited fake private data\n"));
    f.workspace.documents.save(doc).unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "edited fake private data\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // Reload and idle reclaim never remove content.
    f.host.reload("test.private-dir").unwrap();
    assert_eq!(run("directory", None).unwrap().as_deref(), dir.to_str());
    std::thread::sleep(Duration::from_millis(150));
    f.host.tick();
    assert_eq!(f.status("test.private-dir"), PluginStatus::Inactive);
    assert!(file.exists());
    f.host.uninstall("test.private-dir").unwrap();
    assert!(!dir.exists());
    assert!(other_dir.join("fake-secret.txt").exists());
    f.host.install_from_dir(&pkg, &Consent::default()).unwrap();
    assert!(run("read", None).unwrap_err().message.contains("no such file"));
}

#[test]
fn private_directory_is_available_to_providers_without_a_project() {
    let f = fixture(Limits::default());
    f.host.install_from_dir(&sample("private-dir"), &Consent::default()).unwrap();
    f.host.set_workspace(None);
    f.host.run_command("test.private-dir", "roundtrip", None, Invocation::default()).unwrap();
    let doc = ide_plugin::ProviderDocument {
        path: f._tmp.path().join("outside.txt"),
        language: "private-fixture".into(),
        version: 1,
        text: String::new(),
    };
    assert!(eventually(|| f
        .host
        .provide_completion(&doc, ide_core::Pos::new(0, 0), None)
        .iter()
        .any(|(_, item)| item.label == "fake private data\n")));
}

#[test]
fn private_directory_survives_host_restart_and_inactive_uninstall() {
    let f = fixture(Limits::default());
    f.host.install_from_dir(&sample("private-dir"), &Consent::default()).unwrap();
    f.run("test.private-dir", "roundtrip", None).unwrap();
    let dir = PathBuf::from(f.run("test.private-dir", "directory", None).unwrap().unwrap());
    f.host.shutdown();
    let host =
        PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _: PluginEvent| {}), Limits::default())
            .unwrap();
    host.load_all();
    host.startup_finished();
    assert_eq!(
        host.run_command("test.private-dir", "read", None, Invocation::default()).unwrap().as_deref(),
        Some("fake private data\n")
    );
    host.shutdown();
    host.uninstall("test.private-dir").unwrap();
    assert!(!dir.exists());
}

#[test]
fn private_uninstall_cleanup_failure_is_retryable() {
    for fail_data in [true, false] {
        let f = fixture(Limits::default());
        let id = "test.private-dir";
        f.host.install_from_dir(&sample("private-dir"), &Consent::default()).unwrap();
        f.run(id, "roundtrip", None).unwrap();
        let dir = PathBuf::from(f.run(id, "directory", None).unwrap().unwrap());
        let target = if fail_data { dir.parent().unwrap().to_path_buf() } else { f.plugins_dir.join(id) };
        let backup = target.with_extension("blocked-backup");
        // A regular file deterministically makes remove_dir_all fail, even as root.
        std::fs::rename(&target, &backup).unwrap();
        std::fs::write(&target, "controlled cleanup failure").unwrap();
        assert!(f.host.uninstall(id).is_err());
        assert!(f.host.info_of(id).is_ok(), "failed uninstall must retain its target");
        assert_eq!(f.status(id), PluginStatus::Failed);
        assert!(f.command_titles(id).is_empty());
        std::fs::remove_file(&target).unwrap();
        std::fs::rename(&backup, &target).unwrap();
        if fail_data {
            assert!(f.installed(id).join("plugin.toml").exists());
            f.host.shutdown();
            let host = PluginHost::new(
                f.plugins_dir.clone(),
                Arc::new(|_: Option<&str>, _: PluginEvent| {}),
                Limits::default(),
            )
            .unwrap();
            host.load_all();
            host.uninstall(id).unwrap();
        } else {
            f.host.uninstall(id).unwrap();
        }
        assert!(!dir.exists());
        assert!(!f.plugins_dir.join(id).exists());
    }
}

#[cfg(unix)]
#[test]
fn private_paths_work_with_open_location_and_approved_process_arguments() {
    let f = fixture(Limits::default());
    f.host.install_from_dir(&sample("private-dir"), &Consent::default()).unwrap();
    f.run("test.private-dir", "roundtrip", None).unwrap();
    let path = PathBuf::from(f.run("test.private-dir", "open", None).unwrap().unwrap());
    assert!(f.take_events().iter().any(|(client, event)| client.as_deref() == Some("main")
        && matches!(event, PluginEvent::OpenLocation { path: opened, line: 0, column: 0, .. } if opened.0 == path)));
    assert!(f.run("test.private-dir", "process", None).unwrap_err().contains("process:cat"));
    f.host.set_capability("test.private-dir", "process:cat", true).unwrap();
    assert_eq!(f.run("test.private-dir", "process", None).unwrap().as_deref(), Some("fake private data\n"));
}

/// A missing capability is an error the plugin can handle, not a trap.
#[test]
fn ungranted_capabilities_are_denied_not_trapped() {
    let f = fixture(Limits::default());
    f.install(&misbehave_pkg());
    let editor = f.workspace.open("src/notes.txt", &[]);
    let inv = Invocation { editor: Some(editor.clone()), ..f.inv() };
    let err = f.host.run_command("misbehave", "insert", None, inv).unwrap_err();
    assert_eq!(err.kind, ErrorKind::PermissionDenied, "{err:?}");
    assert!(err.message.contains("editor.write"), "{err:?}");
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!((info.status, info.stats.crashes), (PluginStatus::Active, 0), "the instance lives on");
    assert_eq!(info.stats.errors, 0, "a missing grant is not the plugin failing");
    let err = f.host.run_command("misbehave", "cancel", None, f.inv()).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Cancelled, "{err:?}");
    assert_eq!(f.host.info_of("misbehave").unwrap().stats.errors, 0, "nor is the user cancelling");
    assert_eq!(f.workspace.text("src/notes.txt"), "one two three\nfour five\n");
}

/// A trap drops the instance, which restarts on next use after a
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

    // Three in a row: stopped for the session, backing off between them (the wait
    // doubles: `Limits::backoff`, tested where it is defined; wall-clock waits on CI
    // are too noisy to compare).
    f.take_events();
    for crash in 0..3 {
        let err = loop {
            match f.run("misbehave", "panic", None) {
                Err(e) if e.contains("restarts in") => std::thread::sleep(Duration::from_millis(20)),
                other => break other.unwrap_err(),
            }
        };
        assert!(err.contains("crashed"), "{err}");
        if crash < 2 {
            assert!(f.run("misbehave", "echo", None).unwrap_err().contains("restarts in"), "backing off");
        }
    }
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

/// A running call can be interrupted from another thread; the
/// instance is rebuilt on next use without counting as a crash.
#[test]
fn running_calls_can_be_cancelled() {
    let f = Arc::new(fixture(Limits { fuel: u64::MAX, timeout: Duration::from_secs(30), ..Limits::default() }));
    f.install(&misbehave_pkg());
    let spinning = {
        let f = f.clone();
        std::thread::spawn(move || f.run("misbehave", "spin", None))
    };
    // A cancel before the call runs (the instance may still be starting) does nothing: repeat it.
    let until = Instant::now() + Duration::from_secs(5);
    while !spinning.is_finished() {
        assert!(Instant::now() < until, "the running call wasn't interrupted");
        f.host.cancel("misbehave");
        std::thread::sleep(Duration::from_millis(20));
    }
    let err = spinning.join().unwrap().unwrap_err();
    assert!(err.contains("was cancelled"), "{err}");
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

/// Edit-path calls stop waiting at the soft deadline (the result is
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

    // The first call starts the instance, which may take longer than the soft deadline.
    let mut tokens = None;
    assert!(eventually(|| {
        tokens = provider.highlights(&mis, "fast");
        tokens.is_some()
    }));
    let tokens = tokens.unwrap();
    assert_eq!((tokens[0].start, tokens[0].end, tokens[0].kind.as_str()), (0, 4, "keyword"));

    // Slower than the soft deadline: dropped (however late this thread gets
    // to look), but the instance lives on.
    assert!(provider.highlights(&mis, "sleep:150").is_none());
    assert!(eventually(|| provider.highlights(&mis, "fast").is_some()));
    let info = host.info_of("misbehave").unwrap();
    assert!(info.stats.slow_calls >= 1, "{:?}", info.stats);
    assert_eq!((info.stats.crashes, info.stats.activations), (0, 1));

    // Past the hard deadline: interrupted; the next call gets a new instance.
    assert!(provider.highlights(&mis, "spin").is_none());
    std::thread::sleep(Duration::from_millis(450));
    host.tick();
    let info = host.info_of("misbehave").unwrap();
    assert_eq!(info.stats.crashes, 1, "{:?}", info.error);
    assert!(info.error.as_deref().is_some_and(|e| e.contains("timed out after 400ms")), "{:?}", info.error);
    // The new instance may take longer to start than the soft deadline on a slow runner.
    assert!(eventually(|| provider.highlights(&mis, "fast").is_some()));
    assert_eq!(host.info_of("misbehave").unwrap().stats.activations, 2);
}

/// Editor providers of several plugins are asked at the same time: the wait
/// is the slowest plugin's, not the sum, so each has the whole budget.
#[test]
fn providers_of_several_plugins_run_concurrently() {
    let tmp = tempfile::tempdir().unwrap();
    // A budget no runner misses, so only the overlap is measured.
    let limits = Limits {
        edit_soft: Duration::from_secs(5),
        edit_hard: Duration::from_secs(10),
        fuel: u64::MAX,
        ..Limits::default()
    };
    let host =
        Arc::new(PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), limits).unwrap());
    host.load_all();
    host.startup_finished();
    for id in ["slow-a", "slow-b"] {
        let pkg = tmp.path().join(id);
        copy_dir(&misbehave_pkg(), &pkg);
        std::fs::write(
            pkg.join("plugin.toml"),
            format!(
                "id = \"{id}\"\nname = \"{id}\"\nversion = \"0.0.1\"\nengines.openidea = \"^1.0\"\n\
                 wasm = \"dist/plugin.wasm\"\nactivation = [\"on-language:text\"]\n\
                 [[contributes.providers]]\nkinds = [\"completion\"]\nlanguages = [\"text\"]\n"
            ),
        )
        .unwrap();
        host.install_from_dir(&pkg, &Consent::all()).unwrap();
    }
    let doc = |text: &str| ide_plugin::ProviderDocument {
        path: "/p/a.txt".into(),
        language: "text".into(),
        version: 1,
        text: text.into(),
    };
    let at = ide_core::Pos::new(0, 0);
    // Activation is not what is measured: a first call that starts an instance
    // can run past the edit-path budget, and its answer is dropped.
    assert!(eventually(|| host.provide_completion(&doc("fast"), at, None).len() == 2));

    let started = Instant::now();
    let items = host.provide_completion(&doc("sleep:500"), at, None);
    let elapsed = started.elapsed();
    let mut from: Vec<&str> = items.iter().map(|(p, _)| p.as_str()).collect();
    from.sort();
    assert_eq!(from, ["slow-a", "slow-b"], "both within the budget");
    assert!(elapsed < Duration::from_millis(950), "one after the other would take 1000ms: {elapsed:?}");
    assert_eq!(host.info_of("slow-b").unwrap().stats.slow_calls, 0);
}

/// Idle instances are reclaimed; the plugin activates again on its
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
    assert_eq!(f.command_titles("misbehave").len(), 24, "contributions stay");
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
fn contribution_only_plugins() {
    let f = fixture(Limits::default());
    let theme = f.install(&theme_template());
    assert_eq!(theme.status, PluginStatus::Static);
    assert!(!theme.has_code);
    assert!(theme.icon.is_none());
    assert_eq!(f.theme_kinds("openidea.harbor-night")[0].0, "harbor-night");
    let lang = f.install(&sample("language-toy"));
    assert_eq!(lang.status, PluginStatus::Static);
    assert_eq!(f.host.languages()[0].id.as_str(), "toy");
    assert_eq!(f.host.languages()[0].block_comment, Some(("(*".into(), "*)".into())));
    assert!(f.run("language-toy", "x", None).unwrap_err().contains("no code"));

    f.take_events();
    let active = f.host.set_theme(Some(("openidea.harbor-night", "harbor-night"))).unwrap().unwrap();
    assert_eq!(active.theme.tokens["--bg-app"], "#14171c");
    assert_eq!(active.theme.tokens["--syn-string"], "#9ccc7a");
    assert!(f.take_events().iter().any(|(_, e)| matches!(e, PluginEvent::ThemeChanged { theme: Some(_) })));
    assert_eq!(f.host.list(None).active_theme, Some(active));

    // Disabling the plugin withdraws its theme and language.
    f.host.set_enabled("openidea.harbor-night", false).unwrap();
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
    assert_eq!(f.theme_kinds("openidea.harbor-night"), [("harbor-night".to_owned(), ThemeKind::Dark)]);
    // The scheme file is copied with the package and merged over the UI tokens.
    assert!(f.installed("openidea.harbor-night").join("themes/harbor-night.scheme.json").is_file());
    let active = f.host.set_theme(Some(("openidea.harbor-night", "harbor-night"))).unwrap().unwrap();
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
    f.host.set_theme(Some(("openidea.harbor-night", "harbor-night"))).unwrap();
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
    let doc = ide_plugin::ProviderDocument {
        path: f.project.join("a.txt"),
        language: "text".into(),
        version: 1,
        text: "prompts".into(),
    };
    let action = ide_plugin::CodeAction {
        title: "Ask input".into(),
        kind: None,
        preferred: false,
        edits: Vec::new(),
        operations: Vec::new(),
        open: None,
        data: Some("input".into()),
        file_action: false,
    };
    let error = f.host.resolve_code_action("misbehave", &doc, action, f.inv()).unwrap_err();
    assert!(error.message.contains("Restricted Mode"), "{}", error.message);
    assert!(f.take_events().iter().all(|(_, e)| !matches!(e, PluginEvent::PromptRequested { .. })));
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

/// A declaration-only language plugin reaches detection and LSP of
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

/// A plugin provides the syntax of a language the IDE has no grammar
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
    // The first call of a new instance can run past the edit-path budget on a
    // slow machine; its answer is dropped and a later call asks again.
    let deadline = Instant::now() + Duration::from_secs(10);
    let tokens = loop {
        match provider.highlights(&sol, text) {
            Some(tokens) => break tokens,
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            None => panic!("no highlights"),
        }
    };
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

/// Plugins add run configurations to `ide-run`'s detection; the
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

/// Compiled components are cached across runs (keyed by module and
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
    // A corrupt entry is discarded and recompiled. The host that loaded it goes
    // first: its component maps the file (which Windows won't let anyone replace).
    drop(again);
    for e in std::fs::read_dir(&cache).unwrap().flatten() {
        std::fs::write(e.path(), b"junk").unwrap();
    }
    let third = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    third.load_all();
    assert!(
        third.run_command("hello", "word-count", None, Invocation::default()).is_err(),
        "no active file, but it runs"
    );
    assert_eq!(third.info_of("hello").unwrap().status, PluginStatus::Active);
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

/// An icon theme with thousands of SVGs (sanitising, package size, start-up).
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
    // Guards against work that grows faster than the icon count, not a
    // benchmark: a debug build takes ~1.6 s / ~0.35 s on a laptop; shared CI
    // runners running the suite in parallel take several times that (Windows
    // ~11 s to install).
    assert!(install < Duration::from_secs(30), "install took {install:?}");
    assert!(reload < Duration::from_secs(10), "start-up load took {reload:?}");

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

    let catalog = f.host.catalog(&[
        repo().join("crates/ide-plugin/tests/fixtures"),
        repo().join("plugins/official"),
        tmp.path().to_path_buf(),
    ]);
    let ids: Vec<&str> = catalog.iter().map(|c| c.id.as_str()).collect();
    for id in ["hello", "openidea.harbor-night", "language-toy", "x"] {
        assert!(ids.contains(&id), "{id} missing from {ids:?}");
    }
    let hello = catalog.iter().find(|c| c.id == "hello").unwrap();
    assert!(hello.has_code && hello.problem.is_none() && hello.change_notes.is_some());
    assert_eq!(hello.contributions.iter().find(|c| c.point == "commands").unwrap().count, 2);
    let theme = catalog.iter().find(|c| c.id == "openidea.harbor-night").unwrap();
    assert!(!theme.has_code);
    assert_eq!(theme.contributions[0].count, 1);
    let x = catalog.iter().find(|c| c.id == "x").unwrap();
    assert!(x.problem.as_deref().unwrap().contains("plugin.wasm"));
}

fn official(name: &str) -> PathBuf {
    repo().join("plugins/official").join(name)
}

/// String Tools: 26 commands show before the code loads; one command
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

/// Key Promoter: action events are batched; an idle plugin is
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
    let stored = stored(&f, "openidea.key-promoter");
    assert!(stored.contains(&("count:code.duplicate".into(), "3".into())), "{stored:?}");

    // Uninstalling removes its data.
    f.host.uninstall("openidea.key-promoter").unwrap();
    assert!(!f.plugins_dir.join(".data/openidea.key-promoter").exists());
    assert!(f.host.event_kinds().is_empty());
}

#[test]
fn storage_keeps_multimegabyte_indexes_after_idle_reclaim_and_removes_them_on_uninstall() {
    let f = fixture(Limits { idle_timeout: Some(Duration::from_millis(100)), ..Limits::default() });
    let pkg = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/storage");
    f.install(&pkg);
    f.run("test.storage", "save", None).unwrap();
    assert_eq!(f.host.instances(), 1);
    std::thread::sleep(Duration::from_millis(150));
    f.host.tick();
    assert_eq!(f.host.instances(), 0);
    assert_eq!(f.host.info_of("test.storage").unwrap().stats.reclaims, 1);
    assert_eq!(f.run("test.storage", "load", None).unwrap().as_deref(), Some("4194304"));
    assert_eq!(f.host.info_of("test.storage").unwrap().stats.activations, 2);
    let storage_dir = f.plugins_dir.join(".data/test.storage");
    assert_eq!(std::fs::read_dir(storage_dir.join("storage")).unwrap().count(), 1, "one file per key");
    f.host.uninstall("test.storage").unwrap();
    assert!(!storage_dir.exists());
    f.install(&pkg);
    assert!(f.run("test.storage", "load", None).unwrap_err().contains("missing index"));
}

/// A plugin's stored entries (key, value), read from its files.
fn stored(f: &Fixture, plugin: &str) -> Vec<(String, String)> {
    let dir = f.plugins_dir.join(".data").join(plugin).join("storage");
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let bytes = std::fs::read(e.unwrap().path()).unwrap();
            let len = usize::from(u16::from_le_bytes([bytes[0], bytes[1]]));
            let key = String::from_utf8(bytes[2..2 + len].to_vec()).unwrap();
            (key, String::from_utf8(bytes[2 + len..].to_vec()).unwrap())
        })
        .collect();
    entries.sort();
    entries
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

/// Git Toolbox's scheduled fetch still runs after the
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
    let stored = stored(&f, "openidea.git-toolbox");
    assert!(stored.iter().any(|(key, _)| key.starts_with("last-fetch:")), "{stored:?}");
}

/// Restricted Mode: git does not run in an untrusted project (no fetch).
#[test]
fn git_toolbox_does_not_fetch_untrusted_projects() {
    let f = fixture(Limits::default());
    git(&f.project, &["init", "-b", "main"]);
    f.install(&official("git-toolbox"));
    let untrusted = Arc::new(TestWorkspace {
        project_queries_left: Mutex::new(None),
        root: f.project.clone(),
        other_roots: Mutex::default(),
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

/// AI Completion: typing on cancels the previous request (the fetch
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
    // A slow request, superseded by the next keystroke's once the server has it
    // (starting the instance comes first, and takes longer on a slow runner).
    let first = ide_core::CancellationToken::new();
    let slow = {
        let (host, doc, first) = (host.clone(), doc.clone(), first.clone());
        std::thread::spawn(move || (host.host.provide_inline_completion(&doc, at, &first), Instant::now()))
    };
    assert!(eventually(|| seen.lock().len() == 1), "the first request reaches the server");
    let cancelled = Instant::now();
    first.cancel();
    let started = Instant::now();
    let second = host.host.provide_inline_completion(&doc, at, &ide_core::CancellationToken::new());
    let took = started.elapsed();
    let (old, old_done) = slow.join().unwrap();
    let old_took = old_done.saturating_duration_since(cancelled);
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

/// Checkstyle: a save runs the approved `checkstyle` and publishes
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
        f.host.post_events(Some("main"), vec![WorkbenchEvent::FileSaved(to_ipc(&java))]);
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

/// License Header: reported when a file opens, fixed through the provider,
/// and a project scan in a task reports the rest.
#[test]
fn official_license_header_reports_fixes_and_scans() {
    let f = fixture(Limits::default());
    let info = f.install(&official("license-header"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    let a = f.project.join("src/a.rs");
    let b = f.project.join("src/b.py");
    std::fs::write(&a, "fn a() {}\n").unwrap();
    std::fs::write(&b, "#!/usr/bin/env python3\nprint()\n").unwrap();
    let diagnostics = |path: &Path| {
        f.workspace.diagnostics.lock().get(&("openidea.license-header".into(), path.to_path_buf())).cloned()
    };

    f.host.post_events(Some("main"), vec![WorkbenchEvent::FileOpened(to_ipc(&a))]);
    f.host.flush_events_at(Instant::now() + Duration::from_secs(3));
    assert!(f.host.wait_events(Duration::from_secs(20)));
    let d = diagnostics(&a).expect("published on open");
    assert_eq!((d.len(), d[0].code.as_deref()), (1, Some("missing-license-header")));
    assert!(diagnostics(&b).is_none(), "only the opened file");

    let doc = ide_plugin::ProviderDocument {
        path: b.clone(),
        language: "python".into(),
        version: 1,
        text: std::fs::read_to_string(&b).unwrap(),
    };
    let actions = f.host.provide_code_actions(&doc, ide_core::Range::default());
    assert_eq!(actions.len(), 1, "{actions:?}");
    let edit = &actions[0].1.edits[0].1[0];
    assert_eq!(edit.range.start.line, 1, "after the shebang");
    assert!(
        edit.new_text.starts_with("# Copyright (c) 20")
            && edit.new_text.contains("# SPDX-License-Identifier: Apache-2.0")
    );

    f.host.run_command("openidea.license-header", "scan", None, f.inv()).unwrap();
    assert_eq!(diagnostics(&b).map(|d| d.len()), Some(1), "found by the scan");
    std::fs::write(&a, "// Copyright (c) 2026 X\nfn a() {}\n").unwrap();
    f.host.post_events(Some("main"), vec![WorkbenchEvent::FileSaved(to_ipc(&a))]);
    f.host.flush_events_at(Instant::now() + Duration::from_secs(3));
    assert!(f.host.wait_events(Duration::from_secs(20)));
    assert_eq!(diagnostics(&a).map(|d| d.len()), Some(0), "cleared once the header is there");

    // Disabling the plugin withdraws the problems it still shows.
    f.host.set_enabled("openidea.license-header", false).unwrap();
    assert_eq!(diagnostics(&b).map(|d| d.len()), Some(0), "withdrawn with the plugin");
}

/// MyBatis Navigator: interface ↔ XML through the providers, on a
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
    // The first call indexes the XML files; on a slow machine that runs past the
    // edit-path budget, so the answer is dropped (the index is kept) and calls
    // queued behind it are skipped. The editor asks again; so does this.
    let deadline = Instant::now() + Duration::from_secs(10);
    let markers = loop {
        let markers = f.host.provide_line_markers(&jdoc);
        if !markers.is_empty() || Instant::now() > deadline {
            break markers;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(markers.len(), 1, "{markers:?}");
    let target = markers[0].1.target.clone().unwrap();
    assert_eq!((target.path, target.range.start), (xml_path.clone(), ide_core::Pos::new(1, 14)));

    let xdoc = doc(&xml_path, "xml", xml);
    // Reads the interface from disk: on a slow machine that too can run past the budget.
    let mut to_java = Vec::new();
    assert!(eventually(|| {
        to_java = f.host.provide_definition(&xdoc, ide_core::Pos::new(1, 16));
        !to_java.is_empty()
    }));
    assert_eq!(
        to_java.iter().map(|l| (l.path.clone(), l.range.start)).collect::<Vec<_>>(),
        [(java_path.clone(), ide_core::Pos::new(3, 9))]
    );
    assert!(
        f.host.provide_definition(&doc(&f.project.join("src/a.rs"), "rust", ""), ide_core::Pos::new(0, 0)).is_empty(),
        "not its language"
    );

    // Warm (index cached): well inside the edit-path budget.
    let slow = f.host.info_of("openidea.mybatis").unwrap().stats.slow_calls;
    let mut times = Vec::new();
    for _ in 0..20 {
        let started = Instant::now();
        assert_eq!(f.host.provide_line_markers(&jdoc).len(), 1);
        times.push(started.elapsed());
    }
    times.sort();
    eprintln!("mybatis line markers p95: {:?}", times[18]);
    assert!(times[18] < Duration::from_millis(50), "{times:?}");
    assert_eq!(f.host.info_of("openidea.mybatis").unwrap().stats.slow_calls, slow);
}

/// CSV Editor: a custom editor renders the document as a table (the
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

#[test]
fn context_menu_entries_can_name_a_submenu() {
    fn with_menu(version: &'static str, extra: &'static str) -> impl Fn(&str) -> String {
        move |m: &str| {
            let m = m.replace("engines.openidea = \"^1.0\"", &format!("engines.openidea = \"{version}\""));
            format!("{m}\n[[contributes.menus]]\ncommand = \"word-count\"\n{extra}\n")
        }
    }
    let f = fixture(Limits::default());
    let dir = tempfile::tempdir().unwrap();
    let ok = hello_variant(dir.path(), with_menu("^1.3", "menu = \"editor.context\"\nsubmenu = \"Words\""));
    assert_eq!(f.install(&ok).status, PluginStatus::Inactive);
    let submenus: Vec<_> =
        f.host.ui_items("menus").into_iter().filter_map(|i| i.decl["submenu"].as_str().map(str::to_owned)).collect();
    assert_eq!(submenus, ["Words"]);
    f.host.uninstall("hello").unwrap();

    for (version, extra, message) in [
        ("^1.3", "menu = \"tools\"\nsubmenu = \"Words\"", "only for context menus"),
        ("^1.3", "menu = \"editor.context\"\nsubmenu = \" \"", "titles are"),
        ("^1.2", "menu = \"editor.context\"\nsubmenu = \"Words\"", "1.3"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let pkg = hello_variant(dir.path(), with_menu(version, extra));
        let err = f.host.install_from_dir(&pkg, &Consent::all()).unwrap_err();
        assert!(err.message.contains(message), "{extra}: {}", err.message);
    }
}

#[test]
fn view_item_menus_name_a_declared_view() {
    /// The menu is new in API 1.2.
    fn api_1_2(m: &str) -> String {
        m.replace("engines.openidea = \"^1.0\"", "engines.openidea = \"^1.2\"")
    }
    fn with_menu(extra: &str) -> impl Fn(&str) -> String + '_ {
        move |m: &str| format!("{}\n[[contributes.menus]]\ncommand = \"word-count\"\n{extra}\n", api_1_2(m))
    }
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();

    let second_view =
        "[[contributes.views]]\nid = \"more\"\ntitle = \"More\"\nicon = \"plugin\"\nlocation = \"right\"\n";
    let ok = hello_variant(tmp.path(), |m| {
        let on_greetings =
            with_menu("menu = \"viewItem.context\"\nview = \"greetings\"\nwhen = \"viewItemKind == English\"")(m);
        let on_more = with_menu("menu = \"viewItem.context\"\nview = \"more\"")("");
        format!("{on_greetings}\n{second_view}\n{on_more}")
    });
    assert_eq!(f.install(&ok).status, PluginStatus::Inactive);
    let item = f.host.ui_items("menus").into_iter().find(|i| i.decl["menu"] == "viewItem.context").unwrap();
    assert_eq!(
        (item.key.as_str(), item.decl["view"].as_str()),
        ("viewItem.context/greetings/word-count", Some("greetings"))
    );
    let keys: Vec<String> = f.host.ui_items("menus").into_iter().map(|i| i.key).collect();
    for view in ["greetings", "more"] {
        assert!(keys.contains(&format!("viewItem.context/{view}/word-count")), "{keys:?}");
    }
    f.host.uninstall("hello").unwrap();

    for (extra, message) in [
        ("menu = \"viewItem.context\"", "needs `view`"),
        ("menu = \"viewItem.context\"\nview = \"nope\"", "view \"nope\" is not declared"),
        ("menu = \"projectView.context\"\nview = \"greetings\"", "`view` is only for viewItem.context"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let err = f.host.install_from_dir(&hello_variant(dir.path(), with_menu(extra)), &Consent::all()).unwrap_err();
        assert!(err.message.contains(message), "{extra}: {}", err.message);
    }

    let dir = tempfile::tempdir().unwrap();
    let web_view = "[[contributes.views]]\nid = \"page\"\ntitle = \"Page\"\nicon = \"plugin\"\nlocation = \"right\"\nweb = \"web/index.html\"\n";
    let pkg = hello_variant(dir.path(), |m| {
        let on_page = with_menu("menu = \"viewItem.context\"\nview = \"page\"")("");
        format!("{}\n{web_view}\n{on_page}", api_1_2(m))
    });
    std::fs::create_dir_all(pkg.join("web")).unwrap();
    std::fs::write(pkg.join("web/index.html"), "<p>hi</p>").unwrap();
    let err = f.host.install_from_dir(&pkg, &Consent::all()).unwrap_err();
    assert!(err.message.contains("is a web view"), "{}", err.message);

    let dir = tempfile::tempdir().unwrap();
    let old = hello_variant(dir.path(), |m| {
        format!(
            "{m}\n[[contributes.menus]]\nmenu = \"viewItem.context\"\nview = \"greetings\"\ncommand = \"word-count\"\n"
        )
    });
    let err = f.host.install_from_dir(&old, &Consent::all()).unwrap_err();
    assert!(err.message.contains("new in plugin API 1.2"), "{}", err.message);
}

#[test]
fn conditional_and_grouped_views_need_api_1_3() {
    for field in ["group = \"spring\"", "when = \"workspaceContains:pom.xml || plugin.hello.ready\""] {
        let f = fixture(Limits::default());
        let tmp = tempfile::tempdir().unwrap();
        let old =
            hello_variant(tmp.path(), |m| m.replace("location = \"right\"", &format!("location = \"right\"\n{field}")));
        let err = f.host.install_from_dir(&old, &Consent::all()).unwrap_err();
        assert!(err.message.contains("new in plugin API 1.3"), "{err:?}");
    }
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = hello_variant(tmp.path(), |m| {
        m.replace("engines.openidea = \"^1.0\"", "engines.openidea = \"^1.3\"").replace(
            "location = \"right\"",
            "location = \"right\"\ngroup = \"spring\"\nwhen = \"workspaceContains:pom.xml || plugin.hello.ready\"",
        )
    });
    let info = f.install(&pkg);
    assert_eq!(info.status, PluginStatus::Inactive, "declaring views must not activate code");
    let view = f.host.ui_items("views").remove(0);
    assert_eq!(view.decl["group"], "spring");
    assert_eq!(view.decl["when"], "workspaceContains:pom.xml || plugin.hello.ready");
    f.host.set_enabled("hello", false).unwrap();
    assert!(f.host.ui_items("views").is_empty());
}

#[test]
fn grouped_views_fixture_renders_and_scopes_context_and_reveal() {
    let f = fixture(Limits::default());
    let info = f.install(&sample("grouped-views"));
    assert_eq!(info.status, PluginStatus::Inactive, "views stay lazy");
    assert!(info.error.is_none(), "{:?}", info.error);
    let views = f.host.ui_items("views");
    assert_eq!(views.len(), 3);
    assert_eq!(views[0].decl["group"], "demo");
    assert_eq!(views[1].decl["when"], "workspaceContains:grouped-views.txt");
    f.take_events();
    f.run("grouped-views", "show", None).unwrap();
    assert!(f.take_events().iter().any(|(client, event)| matches!(
        event,
        PluginEvent::ContextChanged { plugin_id, key, value }
            if client.as_deref() == Some("main") && plugin_id == "grouped-views"
                && key == "ready" && value.as_deref() == Some("true")
    )));
    assert!(f.host.context_keys(Some("other")).is_empty());
    for view in ["overview", "files", "legacy"] {
        let rendered = f.host.render_view("grouped-views", view, None, f.inv()).unwrap();
        assert!(matches!(rendered.body, ide_plugin::ViewBody::Message(_)));
        f.run("grouped-views", "reveal", Some(view)).unwrap();
        assert!(f.take_events().iter().any(|(client, event)| matches!(
            event,
            PluginEvent::RevealView { plugin_id, view: target }
                if client.as_deref() == Some("main") && plugin_id == "grouped-views" && target == view
        )));
    }
    assert!(f.run("grouped-views", "reveal", Some("plugin.hello.greetings")).is_err());
    f.host.set_enabled("grouped-views", false).unwrap();
    assert!(f.host.ui_items("views").is_empty());
    assert!(f.host.context_keys(Some("main")).is_empty());
}

#[test]
fn view_conditions_and_group_ids_are_validated() {
    for (field, message) in [
        ("group = \"\"", "invalid view group"),
        ("group = \"../other\"", "invalid view group"),
        ("when = \"ready && (\"", "when"),
    ] {
        let f = fixture(Limits::default());
        let tmp = tempfile::tempdir().unwrap();
        let pkg = hello_variant(tmp.path(), |m| {
            m.replace("engines.openidea = \"^1.0\"", "engines.openidea = \"^1.3\"")
                .replace("location = \"right\"", &format!("location = \"right\"\n{field}"))
        });
        let err = f.host.install_from_dir(&pkg, &Consent::all()).unwrap_err();
        assert!(err.message.contains(message), "{field}: {err:?}");
    }
}

/// The sample plugin makes a tool window with a tree view.
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

/// The tables fixture sorts its own rows: a `table` body sent through `other`
/// opts the headers in, and a header click leaves as an `other` view-event
/// (kind `sort`) the plugin decodes and answers with the rows in the asked
/// order (plugins/README.md §10: released types stay, `other` carries new
/// cases).
#[test]
fn sortable_plugin_table_round_trips_sort_events() {
    let f = fixture(Limits::default());
    let info = f.install(&sample("tables"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);

    let table = |f: &Fixture| match f.host.render_view("tables", "tables", None, f.inv()).unwrap().body {
        ide_plugin::ViewBody::Table(t) => t,
        other => panic!("{other:?}"),
    };
    // No sort yet: headers are clickable, rows in the plugin's own order.
    let t = table(&f);
    assert_eq!((t.columns.clone(), t.total_rows), (vec!["ext".to_owned(), "files".into()], 4));
    assert_eq!((t.sortable, t.sort), (true, None), "a `table` through `other` opts the headers in");
    assert_eq!(t.rows.iter().map(|r| r[0].clone()).collect::<Vec<_>>(), ["rs", "md", "java", "toml"]);

    f.take_events();
    let sort = |f: &Fixture, descending| {
        f.host.view_event("tables", "tables", ide_plugin::ViewEvent::Sort { column: 1, descending }, f.inv()).unwrap();
        assert!(f.take_events().into_iter().any(
            |(_, e)| matches!(e, PluginEvent::ViewChanged { ref plugin_id, ref view } if plugin_id == "tables" && view == "tables")
        ));
        table(f)
    };

    // The plugin reports the sort it ordered by, with the rows to match.
    let t = sort(&f, false);
    assert_eq!(t.sort, Some(ide_plugin::TableSort { column: 1, descending: false }));
    assert_eq!(t.rows.iter().map(|r| r[1].clone()).collect::<Vec<_>>(), ["3", "9", "12", "20"]);
    let t = sort(&f, true);
    assert_eq!(t.sort, Some(ide_plugin::TableSort { column: 1, descending: true }));
    assert_eq!(t.rows.iter().map(|r| r[1].clone()).collect::<Vec<_>>(), ["20", "12", "9", "3"]);
}

/// Regex Tester: an `html` body its script talks to; the plugin answers in
/// view messages, in UTF-16 offsets.
#[test]
fn official_regex_tester_answers_its_page() {
    let f = fixture(Limits::default());
    let info = f.install(&official("regex-tester"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    let view = f.host.render_view("openidea.regex-tester", "regex", None, f.inv()).unwrap();
    let ide_plugin::ViewBody::Html(page) = &view.body else { panic!("{view:?}") };
    assert!(page.contains("openidea.postMessage") && page.contains(r#"{"flags":"m"}"#));

    f.take_events();
    let run = serde_json::json!({ "op": "run", "seq": 3, "pattern": r"(\d+)", "flags": "", "text": "é 12 345" });
    let event = ide_plugin::ViewEvent::Message { text: run.to_string() };
    f.host.view_event("openidea.regex-tester", "regex", event, f.inv()).unwrap();
    let reply = f
        .take_events()
        .into_iter()
        .find_map(|(_, e)| match e {
            PluginEvent::ViewMessage { view, message, .. } if view == "regex" => Some(message),
            _ => None,
        })
        .expect("a reply");
    let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!((reply["seq"].clone(), reply["count"].clone()), (serde_json::json!(3), serde_json::json!(2)));
    assert_eq!(reply["matches"][0]["groups"][0], serde_json::json!([2, 4]));
}

/// A tree filled from a pinned program's output, and a terminal for the
/// activated entry in the invoking window, titled and sized by the plugin's
/// settings (the `jobs` fixture).
#[cfg(unix)]
#[test]
fn pinned_programs_fill_views_and_open_terminals() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(Limits::default());
    let bin = f.plugins_dir.parent().unwrap().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("jobs"), "#!/bin/sh\n[ \"$1\" = list ] && printf 'build\\ndeploy\\n'\n").unwrap();
    std::fs::set_permissions(bin.join("jobs"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = bin.clone();
    f.host.set_program_path(Arc::new(move || Some(path.clone().into_os_string())));
    let info = f.install(&sample("jobs"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);

    let view = f.host.render_view("jobs", "jobs", None, f.inv()).unwrap();
    let ide_plugin::ViewBody::Tree(items) = &view.body else { panic!("{view:?}") };
    assert_eq!(items.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(), ["build", "deploy"]);

    let open = |key: &str| {
        f.take_events();
        f.host.view_event("jobs", "jobs", ide_plugin::ViewEvent::Activate { key: key.into() }, f.inv()).unwrap();
        f.take_events().into_iter().find_map(|(client, e)| match e {
            PluginEvent::OpenTerminal { title, program, args, .. } => Some((client, title, program, args)),
            _ => None,
        })
    };
    let (client, title, program, args) = open("deploy").expect("a terminal");
    assert_eq!((client.as_deref(), title.as_str()), (Some("main"), "follow: deploy"));
    assert_eq!(program.0, bin.join("jobs").canonicalize().unwrap());
    assert_eq!(args, ["follow", "deploy", "--lines=20"]);

    // The plugin's settings, string and number.
    let values = serde_json::json!({ "title": "tail ", "lines": 5 }).as_object().unwrap().clone();
    f.workspace.settings.lock().insert("jobs".into(), values);
    let (_, title, _, args) = open("build").expect("a terminal");
    assert_eq!(title, "tail build");
    assert_eq!(args, ["follow", "build", "--lines=5"]);
}

#[test]
fn views_open_project_files_at_a_line() {
    let f = fixture(Limits::default());
    let info = f.install(&sample("jobs"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    std::fs::write(f.project.join("jobs.log"), "build\ndeploy\nfailed\n").unwrap();
    let press = |button: &str| {
        f.take_events();
        let result = f.host.view_event("jobs", "jobs", ide_plugin::ViewEvent::Button { id: button.into() }, f.inv());
        let opened = f.take_events().into_iter().find_map(|(client, e)| match e {
            PluginEvent::OpenLocation { path, line, column, .. } => Some((client, path.0, line, column)),
            _ => None,
        });
        (result, opened)
    };

    let (result, opened) = press("log");
    assert!(result.is_ok(), "{result:?}");
    let (client, path, line, column) = opened.expect("a location");
    assert_eq!((client.as_deref(), line, column), (Some("main"), 2, 4));
    assert_eq!(path.canonicalize().unwrap(), f.project.join("jobs.log").canonicalize().unwrap());

    let (result, opened) = press("outside");
    assert!(result.is_err(), "a path outside the project is refused");
    assert!(opened.is_none());

    f.host.set_capability("jobs", "project.read", false).unwrap();
    let (result, opened) = press("log");
    assert!(result.unwrap_err().message.contains("project.read"), "needs project.read");
    assert!(opened.is_none());
}

#[test]
fn commands_see_the_paths_they_were_run_on() {
    let f = fixture(Limits::default());
    f.install(&sample("jobs"));
    let (a, b) = (f.project.join("src/a.txt"), f.project.join("src/b.txt"));
    let inv = Invocation { selected_paths: vec![a.clone(), b.clone()], ..f.inv() };
    let out = f.host.run_command("jobs", "selection", Some(&to_ipc(&a)), inv).unwrap();
    assert_eq!(out.as_deref(), Some(format!("{}\n{}", to_ipc(&a), to_ipc(&b)).as_str()));
    assert_eq!(f.run("jobs", "selection", None).unwrap().as_deref(), Some(""));
}

#[test]
fn vcs_remotes_clipboard_and_open_url() {
    let f = fixture(Limits::default());
    let info = f.install(&sample("jobs"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);

    // Not a git repository yet: `vcs-remotes` returns an empty list.
    assert_eq!(f.run("jobs", "remotes", None).unwrap().as_deref(), Some(""));

    git(&f.project, &["init", "-b", "main"]);
    git(&f.project, &["remote", "add", "origin", "git@github.com:l0ng-ai/openidea.git"]);
    git(&f.project, &["remote", "add", "upstream", "https://github.com/org/openidea"]);
    assert_eq!(
        f.run("jobs", "remotes", None).unwrap().as_deref(),
        Some("origin=git@github.com:l0ng-ai/openidea.git\nupstream=https://github.com/org/openidea")
    );

    f.host.set_capability("jobs", "vcs.read", false).unwrap();
    assert!(f.run("jobs", "remotes", None).unwrap_err().contains("vcs.read"), "needs vcs.read");

    // `ui.copy-to-clipboard` requires `clipboard` and addresses the calling window.
    f.take_events();
    f.run("jobs", "copy", Some("https://github.com/l0ng-ai/openidea")).unwrap();
    let copied = f.take_events().into_iter().find_map(|(client, e)| match e {
        PluginEvent::CopyToClipboard { plugin_id, text } => Some((client, plugin_id, text)),
        _ => None,
    });
    assert_eq!(copied, Some((Some("main".into()), "jobs".into(), "https://github.com/l0ng-ai/openidea".into())));

    f.host.set_capability("jobs", "clipboard", false).unwrap();
    f.take_events();
    assert!(f.run("jobs", "copy", Some("secret")).unwrap_err().contains("clipboard"), "needs clipboard");
    assert!(f.take_events().iter().all(|(_, e)| !matches!(e, PluginEvent::CopyToClipboard { .. })));

    // `ui.open-url` accepts http(s) URLs and rejects other schemes.
    f.take_events();
    f.run("jobs", "open-url", Some("https://github.com/l0ng-ai/openidea/blob/main/README.md#L1")).unwrap();
    let opened = f.take_events().into_iter().find_map(|(client, e)| match e {
        PluginEvent::OpenUrl { plugin_id, url } => Some((client, plugin_id, url)),
        _ => None,
    });
    assert_eq!(
        opened,
        Some(
            (Some("main".into()), "jobs".into(), "https://github.com/l0ng-ai/openidea/blob/main/README.md#L1".into(),)
        )
    );

    for bad in ["javascript:alert(1)", "file:///etc/passwd", ""] {
        f.take_events();
        let err = f.run("jobs", "open-url", Some(bad)).unwrap_err();
        assert!(err.contains("http:// or https://"), "{bad:?}: {err}");
        assert!(f.take_events().iter().all(|(_, e)| !matches!(e, PluginEvent::OpenUrl { .. })));
    }
}

/// Runs `cmd` of the jobs plugin; once it asks the user, answers after `delay`
/// (`None`: dismisses). Returns the command's result and what it asked.
fn run_and_answer(
    f: &Fixture,
    cmd: &str,
    arg: Option<&str>,
    answer: Option<&[&str]>,
    delay: Duration,
) -> (Result<Option<String>, String>, ide_plugin::Prompt) {
    std::thread::scope(|scope| {
        let running = scope.spawn(|| f.run("jobs", cmd, arg));
        let deadline = Instant::now() + Duration::from_secs(10);
        let (client, prompt_id, prompt) = loop {
            let asked = f.take_events().into_iter().find_map(|(client, e)| match e {
                PluginEvent::PromptRequested { prompt_id, prompt, .. } => Some((client, prompt_id, prompt)),
                _ => None,
            });
            if let Some(asked) = asked {
                break asked;
            }
            assert!(Instant::now() < deadline && !running.is_finished(), "the command never asked");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(client.as_deref(), Some("main"), "asks in the window that ran the command");
        std::thread::sleep(delay);
        let answer = answer.map(|a| a.iter().map(|s| (*s).to_owned()).collect());
        assert!(f.host.answer_prompt(&prompt_id, answer));
        assert!(!f.host.answer_prompt(&prompt_id, None), "an answer counts once");
        (running.join().unwrap(), prompt)
    })
}

#[test]
fn commands_ask_the_user_and_reveal_their_views() {
    use ide_plugin::{PickItem, Prompt};
    let f = fixture(Limits { timeout: Duration::from_millis(500), ..Limits::default() });
    let info = f.install(&sample("jobs"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    let none = Duration::ZERO;

    let (result, prompt) = run_and_answer(&f, "pick", None, Some(&["b"]), none);
    assert_eq!(result.unwrap().as_deref(), Some("b"));
    let items = vec![
        PickItem { key: "a".into(), label: "Alpha".into(), description: Some("first".into()) },
        PickItem { key: "b".into(), label: "Beta".into(), description: None },
        PickItem { key: "c".into(), label: "Gamma".into(), description: None },
    ];
    assert_eq!(prompt, Prompt::QuickPick { title: "Pick".into(), items, multiple: false });

    let (result, prompt) = run_and_answer(&f, "pick-many", None, Some(&["a", "c"]), none);
    assert_eq!(result.unwrap().as_deref(), Some("a,c"));
    assert!(matches!(prompt, Prompt::QuickPick { multiple: true, .. }));
    assert_eq!(run_and_answer(&f, "pick", None, None, none).0.unwrap().as_deref(), Some("none"));

    let (result, prompt) = run_and_answer(&f, "input", Some("Main"), Some(&["Other"]), none);
    assert_eq!(result.unwrap().as_deref(), Some("Other"));
    assert_eq!(prompt, Prompt::Input { prompt: "Name".into(), value: Some("Main".into()), multiline: false });
    assert_eq!(run_and_answer(&f, "input", None, None, none).0.unwrap().as_deref(), Some("none"));

    let (result, prompt) = run_and_answer(&f, "input-multiline", Some("one\ntwo"), Some(&["a\nb"]), none);
    assert_eq!(result.unwrap().as_deref(), Some("a\nb"));
    assert_eq!(prompt, Prompt::Input { prompt: "Name".into(), value: Some("one\ntwo".into()), multiline: true });
    assert_eq!(run_and_answer(&f, "input-multiline", None, None, none).0.unwrap().as_deref(), Some("none"));

    let (result, prompt) = run_and_answer(&f, "confirm", None, Some(&[]), none);
    assert_eq!(result.unwrap().as_deref(), Some("true"));
    assert_eq!(prompt, Prompt::Confirm { title: "Delete".into(), message: "Really?".into() });
    assert_eq!(run_and_answer(&f, "confirm", None, None, none).0.unwrap().as_deref(), Some("false"));

    // The wait is not part of the call's 500 ms budget.
    let (result, _) = run_and_answer(&f, "confirm", None, Some(&[]), Duration::from_millis(1200));
    assert_eq!(result.unwrap().as_deref(), Some("true"));

    // Keys come back as given: one that doesn't fit is refused, not cut.
    f.take_events();
    let err = f.run("jobs", "pick", Some("long-key")).unwrap_err();
    assert!(err.contains("item key is longer"), "{err}");
    assert!(f.take_events().iter().all(|(_, e)| !matches!(e, PluginEvent::PromptRequested { .. })));

    // Without a window there is nothing to attach the dialog to.
    f.take_events();
    let no_window = Invocation { client: None, ..f.inv() };
    for cmd in ["pick", "input", "input-multiline", "confirm"] {
        let err = f.host.run_command("jobs", cmd, None, no_window.clone()).unwrap_err().message;
        assert!(err.contains("from a command the user invoked"), "{cmd}: {err}");
    }
    assert!(f.take_events().iter().all(|(_, e)| !matches!(e, PluginEvent::PromptRequested { .. })));

    // `views.reveal` only knows the plugin's own declared views.
    f.take_events();
    f.run("jobs", "reveal", Some("jobs")).unwrap();
    let revealed = f.take_events().into_iter().find_map(|(client, e)| match e {
        PluginEvent::RevealView { plugin_id, view } => Some((client, plugin_id, view)),
        _ => None,
    });
    assert_eq!(revealed, Some((Some("main".into()), "jobs".into(), "jobs".into())));
    for view in ["greetings", ""] {
        let err = f.run("jobs", "reveal", Some(view)).unwrap_err();
        assert!(err.contains("declares no view"), "{view:?}: {err}");
    }
    assert!(f.run("jobs", "reveal", Some("jobs")).is_ok(), "the instance survives");
}

#[test]
fn disabling_a_plugin_that_waits_for_an_answer_does_not_hang() {
    let f = fixture(Limits::default());
    let info = f.install(&sample("jobs"));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    std::thread::scope(|scope| {
        let running = scope.spawn(|| f.run("jobs", "confirm", None));
        let deadline = Instant::now() + Duration::from_secs(10);
        while !f.take_events().iter().any(|(_, e)| matches!(e, PluginEvent::PromptRequested { .. })) {
            assert!(Instant::now() < deadline && !running.is_finished(), "the command never asked");
            std::thread::sleep(Duration::from_millis(10));
        }
        let started = Instant::now();
        f.host.set_enabled("jobs", false).unwrap();
        assert!(started.elapsed() < Duration::from_secs(5), "disabling waited for the user");
        assert!(running.join().unwrap().is_err(), "the waiting command ends with an error");
    });
    f.host.set_enabled("jobs", true).unwrap();
    let (result, _) = run_and_answer(&f, "confirm", None, Some(&[]), Duration::ZERO);
    assert_eq!(result.unwrap().as_deref(), Some("true"), "prompts work again after the restart");
}

#[test]
fn views_can_use_an_svg_icon_from_the_package() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let clean = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#08f"/></svg>"##;
    let package = |dir: &str, icon: &str, svg: &str| {
        let pkg = tmp.path().join(dir);
        for (path, text) in [("panel/index.html", "<p>panel</p>"), ("icons/panel.svg", svg)] {
            std::fs::create_dir_all(pkg.join(path).parent().unwrap()).unwrap();
            std::fs::write(pkg.join(path), text).unwrap();
        }
        std::fs::write(
            pkg.join("plugin.toml"),
            format!(
                r#"id = "panel-icon"
name = "Panel Icon"
version = "1.0.0"
engines.openidea = "^1.0"

[[contributes.views]]
id = "panel"
title = "Panel"
icon = "{icon}"
location = "bottom"
web = "panel/index.html"
"#
            ),
        )
        .unwrap();
        pkg
    };

    assert!(f.host.install_from_dir(&package("missing", "icons/missing.svg", clean), &Consent::all()).is_err());
    let scripted = clean.replace("<rect", "<script>alert(1)</script><rect");
    assert!(f.host.install_from_dir(&package("scripted", "icons/panel.svg", &scripted), &Consent::all()).is_err());

    let info = f.install(&package("clean", "icons/panel.svg", clean));
    assert!(info.error.is_none(), "{:?}", info.error);
    let view = f.host.ui_items("views").into_iter().find(|v| v.key == "panel").expect("the view");
    assert_eq!(view.decl["icon"].as_str(), Some("icons/panel.svg"));
    let assets = f.host.assets("panel-icon", "viewIcon/panel").unwrap();
    assert_eq!(assets.len(), 1);
    assert!(assets[0].1.contains("<rect"));
}

#[test]
fn a_package_ships_translations_in_locales() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let package = |id: &str, catalogs: &[(&str, &str)]| {
        let pkg = tmp.path().join(id);
        std::fs::create_dir_all(pkg.join("locales")).unwrap();
        for (name, text) in catalogs {
            std::fs::write(pkg.join("locales").join(name), text).unwrap();
        }
        std::fs::write(
            pkg.join("plugin.toml"),
            format!(
                "id = \"{id}\"\nname = \"Words\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n\n\
                 [[contributes.commands]]\nid = \"count\"\ntitle = \"Count Words\"\n"
            ),
        )
        .unwrap();
        pkg
    };

    for bad in ["{", "[]", r#"{"Count Words": 1}"#] {
        let pkg = package("bad-catalog", &[("fr.json", bad)]);
        assert!(f.host.install_from_dir(&pkg, &Consent::all()).is_err(), "{bad}");
    }

    let pkg = package("words", &[("fr.json", r#"{"Count Words": "Compter les mots"}"#), ("zh-CN.json", "{}")]);
    let info = f.install(&pkg);
    assert!(info.error.is_none(), "{:?}", info.error);
    let item = f.host.ui_items("locales").into_iter().find(|i| i.plugin_id == "words").expect("the catalogs");
    assert_eq!(item.decl["tags"], serde_json::json!(["fr", "zh-CN"]));
    let assets = f.host.assets("words", "locale/fr").unwrap();
    assert_eq!(assets.len(), 1);
    assert!(assets[0].1.contains("Compter les mots"));

    let other = f.install(&package("other", &[]));
    assert!(other.error.is_none(), "{:?}", other.error);
    assert!(f.host.assets("other", "locale/").unwrap().is_empty());
}

/// A plugin with web views and no code: its pages and their files are
/// installed with it and served only from the declared directories, while
/// it is enabled and only for the installed version; file icons and
/// templates are projected too.
#[test]
fn web_views_serve_only_their_own_files() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = tmp.path().join("web-demo");
    for (path, text) in [
        ("web/index.html", "<!doctype html><html><head></head><body>draw</body></html>"),
        ("web/assets/app.js", "console.log(1)"),
        ("panel/index.html", "<p>panel</p>"),
        (
            "icons/draw.svg",
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#08f"/></svg>"##,
        ),
        ("templates/new.draw", "{\"type\": \"drawing\"}\n"),
        ("secret.txt", "not served"),
    ] {
        std::fs::create_dir_all(pkg.join(path).parent().unwrap()).unwrap();
        std::fs::write(pkg.join(path), text).unwrap();
    }
    std::fs::write(
        pkg.join("plugin.toml"),
        r#"id = "web-demo"
name = "Web Demo"
version = "1.0.0"
engines.openidea = "^1.0"

[capabilities]
optional = ["clipboard"]

[[contributes.customEditors]]
id = "draw"
title = "Drawing"
patterns = ["*.draw"]
layout = "preview"
web = "web/index.html"

[[contributes.views]]
id = "panel"
title = "Panel"
web = "panel/index.html"

[[contributes.fileIcons]]
id = "draw"
patterns = ["*.draw"]
icon = "icons/draw.svg"

[[contributes.fileTemplates]]
id = "draw"
name = "Drawing"
extension = "draw"
path = "templates/new.draw"
"#,
    )
    .unwrap();
    let info = f.install(&pkg);
    assert_eq!(info.status, PluginStatus::Static, "{:?}", info.error);
    assert!(info.capabilities.iter().any(|c| c.id == "clipboard" && c.granted), "{:?}", info.capabilities);
    // The pages' directories are installed with the plugin; files nothing declares are not.
    let installed = f.installed("web-demo");
    assert!(installed.join("web/assets/app.js").is_file() && installed.join("panel/index.html").is_file());
    assert!(!installed.join("secret.txt").exists());

    let page = f.host.web_page("web-demo", "draw").unwrap();
    let (rev, entry) = page.path.strip_prefix("web-demo/").unwrap().split_once('/').unwrap();
    assert_eq!(entry, "web/index.html");
    let file = |path: &str| f.host.web_file("web-demo", path);
    let js = file(&format!("{rev}/web/assets/app.js")).unwrap();
    assert_eq!((js.bytes.as_slice(), js.mime), (b"console.log(1)".as_slice(), "text/javascript; charset=utf-8"));
    assert!(file(&format!("{rev}/panel/index.html")).is_ok());
    assert_eq!(f.host.web_page("web-demo", "panel").unwrap().path, format!("web-demo/{rev}/panel/index.html"));
    for denied in [
        format!("{rev}/secret.txt"),
        format!("{rev}/plugin.toml"),
        format!("{rev}/web/../secret.txt"),
        format!("{rev}/icons/draw.svg"),
        "stale-revision/web/index.html".to_owned(),
    ] {
        assert!(file(&denied).is_err(), "{denied} was served");
    }
    assert!(f.host.web_page("web-demo", "nope").is_err());

    // File icons and templates.
    let icon = f.host.assets("web-demo", "fileIcon/draw/").unwrap();
    assert_eq!(icon.len(), 1);
    assert!(icon[0].0 == "fileIcon/draw/light" && icon[0].1.contains("<rect"));
    let templates = f.host.ui_items("fileTemplates");
    assert_eq!(templates[0].decl["body"], "{\"type\": \"drawing\"}\n");
    assert_eq!(f.host.ui_items("customEditors")[0].decl["layout"], "preview");

    // Disabled: nothing is served.
    f.host.set_enabled("web-demo", false).unwrap();
    assert!(file(&format!("{rev}/web/index.html")).is_err());
    assert!(f.host.web_page("web-demo", "draw").is_err());
}

#[test]
fn file_templates_fixture_installs_without_write_capabilities() {
    let f = fixture(Limits::default());
    let info = f.install(&sample("file-templates"));
    assert!(info.capabilities.is_empty());
    let templates = f.host.ui_items("fileTemplates");
    assert_eq!(templates.len(), 4);
    let template = |id: &str| templates.iter().find(|t| t.decl["id"] == id).unwrap();
    assert_eq!(template("dockerignore").decl["fileName"], ".dockerignore");
    assert_eq!(template("attributes").decl["variables"].as_array().unwrap().len(), 2);
    assert!(template("repository").decl["body"].as_str().unwrap().contains("$PACKAGE$"));
    assert!(f.installed("file-templates").join("templates/repository.txt").is_file());
    assert_eq!(f.run("file-templates", "ping", None).unwrap().as_deref(), Some("File templates ready"));
    f.host.set_enabled("file-templates", false).unwrap();
    assert!(f.host.ui_items("fileTemplates").is_empty());
}

#[test]
fn file_templates_api_13_names_and_variables() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = tmp.path().join("template-demo");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(pkg.join("body.txt"), "$ENTITY$ $PACKAGE$\n").unwrap();
    let install = |api: &str, fields: &str| {
        std::fs::write(
            pkg.join("plugin.toml"),
            format!(
                r#"id = "template-demo"
name = "Templates"
version = "1.0.0"
engines.openidea = "{api}"
[[contributes.fileTemplates]]
id = "template"
name = "Template"
path = "body.txt"
{fields}
"#
            ),
        )
        .unwrap();
        f.host.install_from_dir(&pkg, &Consent::all())
    };
    for fields in [r#"fileName = ".dockerignore""#, "extension = \"java\"\nvariables = []"] {
        let err = install("^1.2", fields).unwrap_err().message;
        assert!(err.contains("1.3"), "{err}");
    }
    for name in ["", ".", "..", "../escape", "a/b", r"a\b", "/absolute", "C:evil", "a?", " a", "a.", "NUL.txt", "COM1"]
    {
        let fields = format!("fileName = {}", serde_json::to_string(name).unwrap());
        assert!(install("^1.3", &fields).is_err(), "accepted {name:?}");
    }
    for vars in [
        r#"[{ name = "", prompt = "Entity" }]"#,
        r#"[{ name = "1bad", prompt = "Entity" }]"#,
        r#"[{ name = "bad-name", prompt = "Entity" }]"#,
        r#"[{ name = "PACKAGE", prompt = "Entity" }]"#,
        r#"[{ name = "ENTITY", prompt = "" }]"#,
        r#"[{ name = "ENTITY", prompt = "Entity" }, { name = "ENTITY", prompt = "Again" }]"#,
    ] {
        assert!(install("^1.3", &format!("extension = \"java\"\nvariables = {vars}")).is_err(), "accepted {vars}");
    }
    install(
        "^1.3",
        r#"fileName = ".dockerignore"
variables = [{ name = "ENTITY", prompt = "Entity class" }]"#,
    )
    .unwrap();
    let items = f.host.ui_items("fileTemplates");
    assert_eq!(items[0].decl["fileName"], ".dockerignore");
    assert_eq!(items[0].decl["extension"], "");
    assert_eq!(items[0].decl["variables"][0]["prompt"], "Entity class");
    assert_eq!(items[0].decl["body"], "$ENTITY$ $PACKAGE$\n");
}

/// A view needs a page or code to render it; a page's directory can't be the package itself.
#[test]
fn web_view_declarations_are_checked() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = tmp.path().join("bad-web");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(pkg.join("index.html"), "x").unwrap();
    let manifest = |decl: &str| {
        std::fs::write(
            pkg.join("plugin.toml"),
            format!("id = \"bad-web\"\nname = \"B\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.0\"\n{decl}"),
        )
        .unwrap();
        f.host.install_from_dir(&pkg, &Consent::all()).unwrap_err().message
    };
    let err = manifest("[[contributes.customEditors]]\nid = \"e\"\ntitle = \"E\"\npatterns = [\"*.x\"]\n");
    assert!(err.contains("give a web page (`web`) or the code"), "{err}");
    let err = manifest("[[contributes.views]]\nid = \"v\"\ntitle = \"V\"\nweb = \"index.html\"\n");
    assert!(err.contains("directory of its own"), "{err}");
    let err = manifest(
        "[[contributes.customEditors]]\nid = \"e\"\ntitle = \"E\"\npatterns = [\"*.x\"]\nlayout = \"side\"\nweb = \"w/i.html\"\n",
    );
    assert!(err.contains("no such file") || err.contains("`layout`"), "{err}");
}

/// Listing plugins (each plugin's state, then its grants) while another
/// window's project changes (the grants, then each plugin's state) must not
/// deadlock: both take the grant ledger first.
#[test]
fn listing_while_projects_change_does_not_deadlock() {
    let f = fixture(Limits::default());
    f.install(&misbehave_pkg());
    f.install(&sample("hello"));
    let host = Arc::new(f.host);
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let workers: Vec<_> = (0..4)
        .map(|i| {
            let (host, done) = (host.clone(), done.clone());
            let root = f._tmp.path().join(format!("p{i}"));
            std::thread::spawn(move || {
                while !done.load(std::sync::atomic::Ordering::Relaxed) {
                    if i % 2 == 0 {
                        host.list(None);
                    } else {
                        host.restrict_project(&root);
                    }
                }
            })
        })
        .collect();
    std::thread::sleep(Duration::from_millis(500));
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    let started = Instant::now();
    for w in workers {
        while !w.is_finished() {
            assert!(started.elapsed() < Duration::from_secs(10), "deadlocked");
            std::thread::sleep(Duration::from_millis(10));
        }
        w.join().unwrap();
    }
}

/// Excalidraw: a web custom editor beside the text editor, with its fonts,
/// file icon, template and language — no code.
#[test]
fn official_excalidraw_installs_and_serves_its_page() {
    let tmp = tempfile::tempdir().unwrap();
    let pkg = with_stand_in_page(&official("excalidraw"), tmp.path());
    let f = fixture(Limits::default());
    let info = f.install(&pkg);
    assert_eq!(info.status, PluginStatus::Static, "{:?}", info.error);
    let page = f.host.web_page("openidea.excalidraw", "canvas").unwrap();
    let (rev, entry) = page.path.strip_prefix("openidea.excalidraw/").unwrap().split_once('/').unwrap();
    assert_eq!(entry, "web/index.html");
    let html = f.host.web_file("openidea.excalidraw", &format!("{rev}/{entry}")).unwrap();
    let html = String::from_utf8(html.bytes).unwrap();
    // Relative URLs only: the page is served from the package.
    let script = html.split("src=\"").nth(1).unwrap().split('"').next().unwrap();
    assert!(script.starts_with("./assets/"), "{script}");
    assert!(f.host.web_file("openidea.excalidraw", &format!("{rev}/web/{}", &script[2..])).is_ok());
    let font = f.host.web_file("openidea.excalidraw", &format!("{rev}/web/fonts/Virgil/Virgil-Regular.woff2")).unwrap();
    assert_eq!(font.mime, "font/woff2");
    assert_eq!(f.host.ui_items("customEditors")[0].decl["layout"], "preview");
    assert!(f.host.languages().iter().any(|l| l.id.as_str() == "excalidraw"));
    assert_eq!(f.host.assets("openidea.excalidraw", "fileIcon/excalidraw/").unwrap().len(), 2);
}

/// A copy of the official plugin at `src` in `dir`, with a stand-in for its
/// built page (`web/` is built by plugins/build.sh, not checked in; build.sh
/// checks what the build produces): an entry loading a script and a font by
/// relative URL.
fn with_stand_in_page(src: &Path, dir: &Path) -> PathBuf {
    let pkg = dir.join(src.file_name().unwrap());
    std::fs::create_dir_all(&pkg).unwrap();
    for entry in std::fs::read_dir(src).unwrap().flatten() {
        let name = entry.file_name();
        if ["web", "web-src", "web.sources", "target"].iter().any(|n| name == *n) {
            continue;
        }
        let to = pkg.join(&name);
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &to)
        } else {
            std::fs::copy(entry.path(), to).map(|_| ()).unwrap()
        }
    }
    std::fs::create_dir_all(pkg.join("web/assets")).unwrap();
    std::fs::create_dir_all(pkg.join("web/fonts/Virgil")).unwrap();
    std::fs::write(
        pkg.join("web/index.html"),
        r#"<!doctype html><html><head><script type="module" src="./assets/index.js"></script></head></html>"#,
    )
    .unwrap();
    std::fs::write(pkg.join("web/assets/index.js"), "export {};").unwrap();
    std::fs::write(pkg.join("web/fonts/Virgil/Virgil-Regular.woff2"), b"wOF2").unwrap();
    pkg
}

/// Graphviz: a web view with code. What the page reports about the graph
/// becomes the previewed file's problems.
#[test]
fn official_graphviz_turns_its_pages_reports_into_problems() {
    let tmp = tempfile::tempdir().unwrap();
    let f = fixture(Limits::default());
    let info = f.install(&with_stand_in_page(&official("graphviz"), tmp.path()));
    assert_eq!(info.status, PluginStatus::Inactive, "{:?}", info.error);
    assert_eq!(f.host.ui_items("customEditors")[0].decl["layout"], "split");
    assert!(f.host.languages().iter().any(|l| l.id.as_str() == "dot"));
    assert!(f.host.web_page("openidea.graphviz", "preview").is_ok());

    std::fs::write(f.project.join("flow.dot"), "digraph {\n  a -> \n}\n").unwrap();
    let editor = f.workspace.open("flow.dot", &[]);
    let inv = Invocation { editor: Some(editor), ..f.inv() };
    let report =
        r#"{"op":"problems","items":[{"line":3,"message":"syntax error in line 3 near '}'","level":"error"}]}"#;
    let event = ide_plugin::ViewEvent::Message { text: report.into() };
    f.host.view_event("openidea.graphviz", "preview", event, inv.clone()).unwrap();
    let path = f.project.join("flow.dot");
    let problems =
        |f: &Fixture| f.workspace.diagnostics.lock().get(&("openidea.graphviz".into(), path.clone())).cloned();
    let d = problems(&f).expect("published");
    assert_eq!((d.len(), d[0].range.start.line), (1, 2));
    let cleared = ide_plugin::ViewEvent::Message { text: r#"{"op":"problems","items":[]}"#.into() };
    f.host.view_event("openidea.graphviz", "preview", cleared, inv).unwrap();
    assert_eq!(problems(&f).map(|d| d.len()), Some(0));
}

/// Zips `dir` as an archiver does: the folder itself at the top, plus macOS metadata.
fn zip_folder(dir: &Path, out: &Path) {
    use std::io::Write;
    let name = dir.file_name().unwrap().to_string_lossy().into_owned();
    let mut zip = zip::ZipWriter::new(std::fs::File::create(out).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    let mut stack = vec![(dir.to_path_buf(), name.clone())];
    while let Some((real, rel)) = stack.pop() {
        for entry in std::fs::read_dir(&real).unwrap().flatten() {
            let (path, rel) = (entry.path(), format!("{rel}/{}", entry.file_name().to_string_lossy()));
            if path.is_dir() {
                stack.push((path, rel));
            } else {
                zip.start_file(rel, options).unwrap();
                zip.write_all(&std::fs::read(&path).unwrap()).unwrap();
            }
        }
    }
    zip.start_file(format!("__MACOSX/{name}/._plugin.toml"), options).unwrap();
    zip.write_all(b"metadata").unwrap();
    zip.finish().unwrap();
}

#[test]
fn a_zipped_plugin_folder_installs_like_the_folder() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("language-toy.zip");
    zip_folder(&sample("language-toy"), &archive);

    let dir = f.host.unpack_package(&archive).unwrap();
    let preview = f.host.preview_install(&dir).unwrap();
    assert_eq!(preview.id, "language-toy");
    assert!(preview.unsigned);
    let info = f.host.install_from_dir(&dir, &Consent::all()).unwrap();
    assert_eq!(info.id, "language-toy");
    assert_eq!(f.host.languages().len(), 1);

    // A zip that isn't an OpenIDEA plugin says so.
    let other = tmp.path().join("intellij-plugin.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&other).unwrap());
    zip.start_file("my-plugin/lib/my-plugin.jar", zip::write::SimpleFileOptions::default()).unwrap();
    zip.finish().unwrap();
    let err = f.host.unpack_package(&other).unwrap_err().message;
    assert!(err.contains("is not an OpenIDEA plugin"), "{err}");
}

/// What the UI writes for an imported IntelliJ theme goes through the install page.
#[test]
fn a_generated_package_is_staged_for_the_install_page() {
    let f = fixture(Limits::default());
    let file = |path: &str, text: &str| PackageFile { path: path.into(), text: text.into() };
    let manifest = r#"id = "intellij.deep-sea"
name = "Deep Sea"
version = "2.3.0"
engines.openidea = "^1.0"

[[contributes.themes]]
path = "themes/deep-sea.theme.json"
editor-scheme = "themes/deep-sea.scheme.json"
"#;
    let files = [
        file("plugin.toml", manifest),
        file(
            "themes/deep-sea.theme.json",
            r##"{"id":"deep-sea","name":"Deep Sea","kind":"dark","tokens":{"--bg-app":"#101820"}}"##,
        ),
        file("themes/deep-sea.scheme.json", r##"{"name":"Deep Sea","tokens":{"--syn-keyword":"#cc7832"}}"##),
    ];
    let dir = f.host.stage_package("intellij.deep-sea", &files).unwrap();
    let preview = f.host.preview_install(&dir).unwrap();
    assert_eq!((preview.id.as_str(), preview.has_code, preview.unsigned), ("intellij.deep-sea", false, true));
    assert!(preview.capabilities.is_empty());
    f.install(&dir);
    let active = f.host.set_theme(Some(("intellij.deep-sea", "deep-sea"))).unwrap().unwrap();
    assert_eq!(active.theme.tokens["--bg-app"], "#101820");
    assert_eq!(active.theme.tokens["--syn-keyword"], "#cc7832");

    // Staging the same package again starts from an empty folder; importing it again replaces it.
    assert_eq!(f.host.stage_package("intellij.deep-sea", &files[..1]).unwrap(), dir);
    assert!(!dir.join("themes").exists());
    let mut changed = files.clone();
    changed[2] = file("themes/deep-sea.scheme.json", r##"{"tokens":{"--syn-keyword":"#ff8800"}}"##);
    f.install(&f.host.stage_package("intellij.deep-sea", &changed).unwrap());
    let active = f.host.set_theme(Some(("intellij.deep-sea", "deep-sea"))).unwrap().unwrap();
    assert_eq!(active.theme.tokens["--syn-keyword"], "#ff8800");

    for bad in ["../x", "/abs", "a//b", r"a\b", "C:x", ".hidden", "a/./b", ""] {
        let err = f.host.stage_package("p", &[file("plugin.toml", manifest), file(bad, "x")]).unwrap_err().message;
        assert!(err.contains("invalid package path"), "{bad:?}: {err}");
    }
    let err = f.host.stage_package("p", &[file("x.json", "{}")]).unwrap_err().message;
    assert!(err.contains("needs a plugin.toml"), "{err}");
    let err = f.host.stage_package("p", &[file("plugin.toml", ""), file("PLUGIN.toml", "")]).unwrap_err().message;
    assert!(err.contains("twice"), "{err}");
    assert!(f.host.stage_package("../p", &files).is_err());
}

/// Secrets live outside the plugin's directory (the OS keychain on the
/// desktop): uninstalling the plugin deletes the ones it declares.
#[test]
fn uninstalling_deletes_the_plugins_secrets() {
    #[derive(Default)]
    struct Keychain(Mutex<std::collections::HashMap<(String, String), String>>);
    impl SecretStore for Keychain {
        fn get(&self, plugin: &str, name: &str) -> Option<String> {
            self.0.lock().get(&(plugin.into(), name.into())).cloned()
        }
        fn set(&self, plugin: &str, name: &str, value: Option<&str>) -> Result<(), String> {
            let key = (plugin.to_owned(), name.to_owned());
            match value {
                Some(v) => self.0.lock().insert(key, v.into()),
                None => self.0.lock().remove(&key),
            };
            Ok(())
        }
    }
    let f = fixture(Limits::default());
    let keychain = Arc::new(Keychain::default());
    f.host.set_secret_store(keychain.clone());
    f.install(&official("ai-completion"));
    f.host.set_secret("openidea.ai-completion", "api-key", Some("sk-test")).unwrap();
    assert!(keychain.get("openidea.ai-completion", "api-key").is_some());
    f.host.uninstall("openidea.ai-completion").unwrap();
    assert!(keychain.0.lock().is_empty(), "{:?}", keychain.0.lock().keys().collect::<Vec<_>>());
}

/// Plugin API 1.0 leaves room to grow: event kinds are names, and the editor
/// providers carry snippets, imports, lazily computed quick fixes and tagged
/// problems.
#[test]
fn completion_quick_fixes_problems_and_event_kinds_of_api_1() {
    let f = fixture(Limits::default());
    let pkg = f._tmp.path().join("misbehave-providers");
    copy_dir(&misbehave_pkg(), &pkg);
    let manifest = std::fs::read_to_string(pkg.join("plugin.toml")).unwrap();
    std::fs::write(
        pkg.join("plugin.toml"),
        format!("{manifest}\n[[contributes.providers]]\nkinds = [\"completion\", \"code-actions\"]\nlanguages = [\"text\"]\n"),
    )
    .unwrap();
    f.install(&pkg);
    let doc = |text: &str| ide_plugin::ProviderDocument {
        path: f.project.join("a.txt"),
        language: "text".into(),
        version: 1,
        text: text.into(),
    };
    let at = ide_core::Pos::new(0, 0);

    // The first call starts the instance, which may take longer than the edit-path budget.
    let mut items = Vec::new();
    assert!(eventually(|| {
        items = f.host.provide_completion(&doc("rich"), at, None);
        !items.is_empty()
    }));
    let item = &items[0].1;
    assert_eq!(
        (item.insert_text.as_str(), item.snippet, item.filter_text.as_deref()),
        ("f(${1:x})$0", true, Some("fun"))
    );
    assert_eq!(item.additional_edits[0].new_text, "use f;\n");

    // Offered without edits; computed when picked.
    let actions = f.host.provide_code_actions(&doc("lazy"), ide_core::Range::default());
    let (plugin, action) = actions.into_iter().next().expect("offered");
    assert!(action.edits.is_empty() && action.data.as_deref() == Some("fix"));
    let resolved = f.host.resolve_code_action(&plugin, &doc("lazy"), action.clone(), f.inv()).unwrap();
    assert_eq!(resolved.edits[0].1[0].new_text, "fixed ");
    let foreign = ide_plugin::CodeAction { data: Some("other".into()), ..action };
    assert!(f.host.resolve_code_action(&plugin, &doc("lazy"), foreign, f.inv()).is_err());

    // File operations come from the `file-actions` export, next to the providers' own.
    let mut actions = f.host.provide_code_actions(&doc("files"), ide_core::Range::default()).into_iter();
    let (_, action) = actions.next().expect("offered");
    let (plugin, later) = actions.next().expect("a lazy one too");
    let dir = f.project.clone();
    assert_eq!(action.title, "Reorganise");
    assert_eq!(
        action.operations,
        vec![
            ide_plugin::FileOperation::Create { path: dir.join("created.txt"), text: "hello".into(), overwrite: false },
            ide_plugin::FileOperation::Rename { from: dir.join("old.txt"), to: dir.join("renamed.txt") },
            ide_plugin::FileOperation::Delete { path: dir.join("gone.txt") },
        ]
    );
    assert_eq!(action.open, Some(dir.join("created.txt")));
    // Listed with `data` only: `resolve` on the same export computes its operations.
    assert!(later.file_action && later.operations.is_empty() && later.data.is_some());
    let resolved = f.host.resolve_code_action(&plugin, &doc("files"), later, f.inv()).unwrap();
    assert_eq!(
        resolved.operations,
        vec![ide_plugin::FileOperation::Create { path: dir.join("later.txt"), text: "later".into(), overwrite: false }]
    );
    assert!(f.host.provide_code_actions(&doc("rich"), ide_core::Range::default()).is_empty());

    // A kind this IDE doesn't know is refused, not a trap.
    let err = f.host.run_command("misbehave", "subscribe", Some("file-deleted"), f.inv()).unwrap_err();
    assert!(err.message.contains("no event kind"), "{}", err.message);
    let err = f.host.run_command("misbehave", "subscribe", Some("file-saved"), f.inv()).unwrap_err();
    assert!(err.message.contains("events"), "known, but not granted: {}", err.message);

    // Tags the IDE knows, the tool that found it.
    let path = f.project.join("a.txt");
    f.host.run_command("misbehave", "diagnose", Some(&path.to_string_lossy()), f.inv()).unwrap();
    let d = f.workspace.diagnostics.lock().get(&("misbehave".into(), path)).cloned().unwrap();
    assert_eq!((d[0].unnecessary, d[0].deprecated, d[0].source.as_deref()), (true, false, Some("lint")));
}

fn interactive_actions_fixture() -> (Fixture, ide_plugin::ProviderDocument) {
    let f = fixture(Limits { timeout: Duration::from_millis(500), ..Limits::default() });
    let pkg = f._tmp.path().join("interactive-actions");
    copy_dir(&misbehave_pkg(), &pkg);
    let manifest = std::fs::read_to_string(pkg.join("plugin.toml"))
        .unwrap()
        .replace("required = [\"project.read\"]", "required = [\"project.read\", \"clipboard\"]");
    std::fs::write(pkg.join("plugin.toml"), format!(
        "{manifest}\n[[contributes.providers]]\nkinds = [\"completion\", \"code-actions\"]\nlanguages = [\"text\"]\n"
    )).unwrap();
    f.install(&pkg);
    f.host.run_command("misbehave", "echo", None, f.inv()).unwrap();
    let doc = ide_plugin::ProviderDocument {
        path: f.project.join("a.txt"),
        language: "text".into(),
        version: 1,
        text: "prompts".into(),
    };
    (f, doc)
}

fn action_prompt(f: &Fixture) -> (String, ide_plugin::Prompt) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some((client, id, prompt)) = f.take_events().into_iter().find_map(|(client, event)| match event {
            PluginEvent::PromptRequested { prompt_id, prompt, .. } => Some((client, prompt_id, prompt)),
            _ => None,
        }) {
            assert_eq!(client.as_deref(), Some("editor-window"));
            return (id, prompt);
        }
        assert!(Instant::now() < deadline, "code-action resolution never asked");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn action_invocation() -> Invocation {
    Invocation { client: Some("editor-window".into()), ..Default::default() }
}

#[test]
fn code_action_resolution_prompts_in_the_editor_window_under_the_command_budget() {
    use ide_plugin::Prompt;
    let (f, doc) = interactive_actions_fixture();
    let actions = f.host.provide_code_actions(&doc, ide_core::Range::default());
    assert_eq!(actions.len(), 10);
    for (kind, answer, expected) in [
        ("pick", vec!["b"], "b"),
        ("pick-many", vec!["a", "b"], "a,b"),
        ("input", vec!["Service😀"], "Service😀"),
        ("confirm", vec![], "confirmed"),
    ] {
        let action = actions.iter().find(|(_, a)| a.data.as_deref() == Some(kind)).unwrap().1.clone();
        std::thread::scope(|scope| {
            let running = scope.spawn(|| f.host.resolve_code_action("misbehave", &doc, action, action_invocation()));
            let (id, prompt) = action_prompt(&f);
            assert!(match kind {
                "pick" => matches!(prompt, Prompt::QuickPick { multiple: false, .. }),
                "pick-many" => matches!(prompt, Prompt::QuickPick { multiple: true, .. }),
                "input" => matches!(prompt, Prompt::Input { multiline: false, .. }),
                _ => matches!(prompt, Prompt::Confirm { .. }),
            });
            // More than the command budget; waiting for the user is excluded.
            std::thread::sleep(Duration::from_millis(650));
            assert!(f.host.answer_prompt(&id, Some(answer.iter().map(|s| (*s).into()).collect())));
            let resolved = running.join().unwrap().unwrap();
            assert_eq!(resolved.edits[0].1[0].new_text, expected);
        });
    }
    for kind in ["input-multiline", "reveal", "open-url", "clipboard", "pick-directory", "open-project"] {
        let action = actions.iter().find(|(_, a)| a.data.as_deref() == Some(kind)).unwrap().1.clone();
        let err = std::thread::scope(|scope| {
            let running = scope.spawn(|| f.host.resolve_code_action("misbehave", &doc, action, action_invocation()));
            let mut prompted = false;
            while !running.is_finished() {
                for (_, event) in f.take_events() {
                    if let PluginEvent::PromptRequested { prompt_id, .. } = event {
                        prompted = true;
                        f.host.answer_prompt(&prompt_id, None);
                    }
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let result = running.join().unwrap();
            assert!(!prompted, "{kind} must remain restricted to commands and events");
            result.unwrap_err()
        });
        assert_eq!(err.kind, ErrorKind::InvalidInput, "{kind}: {}", err.message);
    }
    let doc = ide_plugin::ProviderDocument { text: "prompt-provider".into(), ..doc };
    assert!(eventually(|| !f.host.provide_completion(&doc, ide_core::Pos::new(0, 0), None).is_empty()));
    assert!(f.take_events().iter().all(|(_, e)| !matches!(e, PluginEvent::PromptRequested { .. })));
}

#[test]
fn code_action_prompts_dismiss_cancel_and_close_without_edits_or_hanging() {
    for (how, kind) in [
        ("dismiss", "pick"),
        ("dismiss", "pick-many"),
        ("dismiss", "input"),
        ("dismiss", "confirm"),
        ("disable", "pick"),
        ("close", "pick"),
        ("close-reopen", "pick"),
        ("no-window", "pick"),
    ] {
        let (f, doc) = interactive_actions_fixture();
        let action = f
            .host
            .provide_code_actions(&doc, ide_core::Range::default())
            .into_iter()
            .find(|(_, action)| action.data.as_deref() == Some(kind))
            .unwrap()
            .1;
        if how == "no-window" {
            assert!(f.host.resolve_code_action("misbehave", &doc, action, Invocation::default()).is_err());
            assert!(f.take_events().iter().all(|(_, e)| !matches!(e, PluginEvent::PromptRequested { .. })));
            continue;
        }
        std::thread::scope(|scope| {
            let running = scope.spawn(|| f.host.resolve_code_action("misbehave", &doc, action, action_invocation()));
            let (id, _) = action_prompt(&f);
            let started = Instant::now();
            match how {
                "dismiss" => {
                    assert!(f.host.answer_prompt(&id, None));
                }
                "disable" => {
                    f.host.set_enabled("misbehave", false).unwrap();
                }
                "close" => f.host.forget_client("editor-window"),
                "close-reopen" => {
                    f.host.forget_client("editor-window");
                    f.host.reopen_client("editor-window");
                }
                _ => unreachable!(),
            }
            assert!(running.join().unwrap().is_err());
            assert!(started.elapsed() < Duration::from_secs(5));
            assert!(!f.host.answer_prompt(&id, Some(vec!["late".into()])));
        });
        assert!(!f.project.join("a.txt").exists(), "resolution must only return edits");
        if how == "close-reopen" {
            let action = f.host.provide_code_actions(&doc, ide_core::Range::default()).remove(0).1;
            std::thread::scope(|scope| {
                let running =
                    scope.spawn(|| f.host.resolve_code_action("misbehave", &doc, action, action_invocation()));
                let (id, _) = action_prompt(&f);
                assert!(f.host.answer_prompt(&id, Some(vec!["b".into()])));
                assert_eq!(running.join().unwrap().unwrap().edits[0].1[0].new_text, "b");
            });
        }
    }
}

#[test]
fn file_action_resolution_can_ask_before_returning_resource_operations() {
    let (f, doc) = interactive_actions_fixture();
    let doc = ide_plugin::ProviderDocument { text: "prompt-files".into(), ..doc };
    let action = f.host.provide_code_actions(&doc, ide_core::Range::default()).remove(0).1;
    assert!(action.file_action && action.operations.is_empty());
    std::thread::scope(|scope| {
        let running = scope.spawn(|| f.host.resolve_code_action("misbehave", &doc, action, action_invocation()));
        let (id, _) = action_prompt(&f);
        assert!(f.host.answer_prompt(&id, Some(vec!["Service".into()])));
        let resolved = running.join().unwrap().unwrap();
        assert_eq!(
            resolved.operations,
            vec![ide_plugin::FileOperation::Create {
                path: f.project.join("Service.txt"),
                text: "Service".into(),
                overwrite: false,
            }]
        );
        assert_eq!(resolved.open, Some(f.project.join("Service.txt")));
        assert!(!f.project.join("Service.txt").exists(), "resolution does not apply the edit");
    });
}

/// `hello` as a services view, which needs API 1.3.
fn services_variant(text: &str) -> String {
    text.replace("location = \"right\"", "location = \"services\"")
        .replace("engines.openidea = \"^1.0\"", "engines.openidea = \"^1.3\"")
}

#[test]
fn services_views_need_api_1_3_and_code() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let info = f.install(&hello_variant(tmp.path(), services_variant));
    assert!(info.error.is_none(), "{:?}", info.error);
    assert_eq!(f.host.ui_items("views").remove(0).decl["location"].as_str(), Some("services"));

    for (edit, message) in [
        (
            Box::new(|t: &str| t.replace("location = \"right\"", "location = \"services\""))
                as Box<dyn Fn(&str) -> String>,
            "new in plugin API 1.3",
        ),
        (
            Box::new(|t: &str| t.replace("location = \"right\"", "location = \"middle\"")),
            "left, right, bottom or services",
        ),
        (
            Box::new(|t: &str| {
                services_variant(t)
                    .replace("location = \"services\"", "location = \"services\"\nweb = \"web/index.html\"")
            }),
            "a services view is rendered by the plugin's code (no `web`)",
        ),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let pkg = hello_variant(tmp.path(), edit);
        std::fs::create_dir_all(pkg.join("web")).unwrap();
        std::fs::write(pkg.join("web/index.html"), "<p>x</p>").unwrap();
        let err = f.host.install_from_dir(&pkg, &Consent::all()).unwrap_err();
        assert!(err.message.contains(message), "{message}: {err:?}");
    }
}

#[test]
fn services_views_have_a_detail_pane() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    f.install(&hello_variant(tmp.path(), services_variant));
    let tabs = f.host.service_detail("hello", "greetings", "pod:default/nginx", f.inv()).unwrap();
    assert_eq!(tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["log", "info"]);
    assert_eq!(tabs[1].body, ide_plugin::ServicePane::Text("greetings: pod:default/nginx".into()));
    let ide_plugin::ServicePane::Log(log) = &tabs[0].body else { panic!("a log: {:?}", tabs[0].body) };
    assert_eq!(
        (log.program.as_str(), log.args.as_slice()),
        ("sh", ["-c".to_owned(), "pod:default/nginx".to_owned()].as_slice())
    );

    let f = fixture(Limits::default());
    f.install(&sample("hello"));
    let err = f.host.service_detail("hello", "greetings", "x", f.inv()).unwrap_err();
    assert!(err.message.contains("declares no detail view"), "a right view has no pane: {err:?}");
}

#[test]
fn detail_views_work_in_every_location_and_require_api_1_3_code() {
    for location in ["left", "right", "bottom", "services"] {
        let f = fixture(Limits::default());
        let tmp = tempfile::tempdir().unwrap();
        let pkg = hello_variant(tmp.path(), |t| {
            t.replace("engines.openidea = \"^1.0\"", "engines.openidea = \"^1.3\"")
                .replace("location = \"right\"", &format!("location = {location:?}\ndetail = true"))
        });
        assert!(f.install(&pkg).error.is_none());
        assert_eq!(f.host.ui_items("views")[0].decl["detail"], true);
        let tabs = f.host.service_detail("hello", "greetings", "item:😀", f.inv()).unwrap();
        assert_eq!(tabs[1].body, ide_plugin::ServicePane::Text("greetings: item:😀".into()));
        assert!(f.host.service_detail("hello", "missing", "x", f.inv()).is_err());
    }
    for (api, web, message) in
        [("^1.0", false, "new in plugin API 1.3"), ("^1.3", true, "`detail` needs a tree or list")]
    {
        let f = fixture(Limits::default());
        let tmp = tempfile::tempdir().unwrap();
        let pkg = hello_variant(tmp.path(), |t| {
            t.replace("engines.openidea = \"^1.0\"", &format!("engines.openidea = {api:?}")).replace(
                "location = \"right\"",
                if web {
                    "location = \"right\"\ndetail = true\nweb = \"web/index.html\""
                } else {
                    "location = \"right\"\ndetail = true"
                },
            )
        });
        if web {
            std::fs::create_dir_all(pkg.join("web")).unwrap();
            std::fs::write(pkg.join("web/index.html"), "<p>x</p>").unwrap();
        }
        let error = f.host.install_from_dir(&pkg, &Consent::all()).unwrap_err();
        assert!(error.message.contains(message), "{error:?}");
    }
}

#[test]
fn detail_fixture_tracks_selection_and_refresh_for_tree_list_and_services() {
    let f = fixture(Limits::default());
    assert!(f.install(&sample("detail-views")).error.is_none());
    for view in ["tree", "list", "services"] {
        assert!(matches!(
            f.host.render_view("test.detail-views", view, None, f.inv()).unwrap().body,
            ide_plugin::ViewBody::Tree(_) | ide_plugin::ViewBody::List(_)
        ));
        f.host
            .view_event("test.detail-views", view, ide_plugin::ViewEvent::Select { key: "beta".into() }, f.inv())
            .unwrap();
        let tabs = f.host.service_detail("test.detail-views", view, "beta", f.inv()).unwrap();
        let ide_plugin::ServicePane::Text(text) = &tabs[0].body else { panic!("text detail") };
        assert!(text.starts_with(&format!("{view}: beta")));
        f.host
            .view_event("test.detail-views", view, ide_plugin::ViewEvent::Button { id: "refresh".into() }, f.inv())
            .unwrap();
        let refreshed = f.host.service_detail("test.detail-views", view, "beta", f.inv()).unwrap();
        assert_ne!(tabs, refreshed);
    }
    let selections = [("tree", "alpha"), ("list", "beta"), ("services", "alpha")];
    for (view, key) in selections {
        f.host
            .view_event("test.detail-views", view, ide_plugin::ViewEvent::Select { key: key.into() }, f.inv())
            .unwrap();
    }
    for (view, key) in selections {
        let tabs = f.host.service_detail("test.detail-views", view, key, f.inv()).unwrap();
        let ide_plugin::ServicePane::Text(text) = &tabs[0].body else { panic!("text detail") };
        assert!(text.starts_with(&format!("{view}: {key}")));
    }
}

/// `hello` as a services view that may run `sh`, granted or not.
#[cfg(unix)]
fn services_with_sh(f: &Fixture, dir: &Path, grant: bool) {
    let sh = PathBuf::from("/bin");
    f.host.set_program_path(Arc::new(move || Some(sh.clone().into_os_string())));
    let pkg = hello_variant(dir, |t| {
        services_variant(t).replace(
            "required = [\"editor.read\", \"editor.write\"]",
            "required = [\"editor.read\", \"editor.write\"]\noptional = [\"process:sh\"]",
        )
    });
    f.install(&pkg);
    f.host.set_capability("hello", "process:sh", grant).unwrap();
}

/// Follows the Log tab of the node whose key is `script`.
#[cfg(unix)]
fn stream(
    f: &Fixture,
    script: &str,
    on: &[&str],
    cancel: &ide_core::CancellationToken,
    lines: impl Fn(PluginOutputLine),
) -> ide_core::IdeResult<Option<i32>> {
    let on: Vec<String> = on.iter().map(|s| (*s).to_owned()).collect();
    f.host.stream_service_log("hello", "greetings", script, "log", &on, f.inv(), cancel, &lines)
}

#[cfg(unix)]
#[test]
fn service_logs_stream_lines_with_the_toggles_args() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    services_with_sh(&f, tmp.path(), true);
    let lines = Mutex::new(Vec::new());
    let script = "printf 'a\\nb\\n'; printf 'e\\n' >&2; exit 3";
    let status = stream(&f, script, &[], &Default::default(), |l| lines.lock().push(l));
    assert_eq!(status.unwrap(), Some(3));
    let mut lines = lines.into_inner();
    lines.sort_by_key(|l| l.stderr);
    let line = |stderr: bool, text: &str| PluginOutputLine { stderr, text: text.into() };
    assert_eq!(lines, [line(false, "a"), line(false, "b"), line(true, "e")]);

    // `sh -c script arg` names the script `arg` ($0): the toggle's args are appended.
    let named = Mutex::new(Vec::new());
    stream(&f, "echo $0", &["named"], &Default::default(), |l| named.lock().push(l.text)).unwrap();
    assert_eq!(named.into_inner(), ["named"]);

    let long = Mutex::new(Vec::new());
    stream(&f, "head -c 40000 /dev/zero | tr '\\0' x; echo; echo next", &[], &Default::default(), |l| {
        long.lock().push(l.text.len())
    })
    .unwrap();
    assert_eq!(long.into_inner(), [16 << 10, 4], "a long line is cut, the next one is whole");
}

#[cfg(unix)]
#[test]
fn service_logs_need_the_grant_and_a_log_tab() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    services_with_sh(&f, tmp.path(), false);
    let marker = tmp.path().join("ran");
    let script = format!("touch {}", marker.display());
    let err = stream(&f, &script, &[], &Default::default(), |_| {}).unwrap_err();
    assert_eq!(err.kind, ErrorKind::PermissionDenied);
    assert!(err.message.contains("permission denied: process:sh is not granted"), "{err:?}");
    assert!(!marker.exists(), "nothing was started");

    f.host.set_capability("hello", "process:sh", true).unwrap();
    let info =
        f.host.stream_service_log("hello", "greetings", &script, "info", &[], f.inv(), &Default::default(), &|_| {});
    assert_eq!(info.unwrap_err().kind, ErrorKind::NotFound, "a text tab runs nothing");
    let cancelled = ide_core::CancellationToken::default();
    cancelled.cancel();
    assert_eq!(stream(&f, &script, &[], &cancelled, |_| {}).unwrap_err().kind, ErrorKind::Cancelled);
    assert!(!marker.exists(), "a cancelled request starts nothing");
}

#[cfg(unix)]
#[test]
fn ordinary_detail_views_reuse_log_grants_and_streaming() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = hello_variant(tmp.path(), |t| {
        services_variant(t).replace("location = \"services\"", "location = \"right\"\ndetail = true").replace(
            "required = [\"editor.read\", \"editor.write\"]",
            "required = [\"editor.read\", \"editor.write\"]\noptional = [\"process:sh\"]",
        )
    });
    f.install(&pkg);
    f.host.set_capability("hello", "process:sh", false).unwrap();
    assert_eq!(
        stream(&f, "echo allowed", &[], &Default::default(), |_| {}).unwrap_err().kind,
        ErrorKind::PermissionDenied
    );
    f.host.set_capability("hello", "process:sh", true).unwrap();
    f.host.set_program_path(Arc::new(|| Some(PathBuf::from("/bin").into_os_string())));
    let lines = Mutex::new(Vec::new());
    assert_eq!(stream(&f, "echo allowed", &[], &Default::default(), |l| lines.lock().push(l.text)).unwrap(), Some(0));
    assert_eq!(lines.into_inner(), ["allowed"]);
}

#[cfg(unix)]
#[test]
fn service_log_cancel_kills_the_child() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    services_with_sh(&f, tmp.path(), true);
    let cancel = ide_core::CancellationToken::default();
    let started = Instant::now();
    let result = stream(&f, "echo up; sleep 30.4321", &[], &cancel, |l| {
        if l.text == "up" {
            cancel.cancel();
        }
    });
    assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
    let orphan = || std::process::Command::new("pgrep").args(["-f", "sleep 30.4321"]).status().unwrap().success();
    assert!(eventually(|| !orphan()), "what the program started is killed too");
}

#[cfg(unix)]
#[test]
fn service_log_stops_when_the_grant_is_revoked() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    services_with_sh(&f, tmp.path(), true);
    let started = Instant::now();
    let watchdog = ide_core::CancellationToken::default();
    let timer = watchdog.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        timer.cancel();
    });
    let result = stream(&f, "while :; do echo tick; sleep 0.05; done", &[], &watchdog, |l| {
        if l.text == "tick" && started.elapsed() < Duration::from_secs(1) {
            f.host.set_capability("hello", "process:sh", false).unwrap();
        }
    });
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    let err = result.unwrap_err();
    assert_eq!(err.kind, ErrorKind::PermissionDenied, "{err:?}");
}

#[test]
fn plugins_set_their_own_context_keys() {
    let f = fixture(Limits::default());
    f.install(&sample("jobs"));
    f.take_events();
    f.run("jobs", "context", Some("connected=true")).unwrap();
    let changed: Vec<_> = f
        .take_events()
        .into_iter()
        .filter_map(|(client, e)| match e {
            PluginEvent::ContextChanged { plugin_id, key, value } => Some((client, plugin_id, key, value)),
            _ => None,
        })
        .collect();
    assert_eq!(changed, [(Some("main".into()), "jobs".into(), "connected".into(), Some("true".into()))]);
    assert_eq!(f.host.context_keys(Some("main")).len(), 1);
    assert!(f.host.context_keys(Some("other")).is_empty(), "window-scoped");

    for bad in ["bad key=true", "a.b=true", "x=NaN"] {
        assert!(f.run("jobs", "context", Some(bad)).unwrap_err().contains("invalid"), "{bad}");
    }

    f.run("jobs", "context", Some("connected=")).unwrap();
    assert!(f.host.context_keys(Some("main")).is_empty());

    f.run("jobs", "context", Some("connected=true")).unwrap();
    f.host.set_enabled("jobs", false).unwrap();
    assert!(f.host.context_keys(Some("main")).is_empty(), "cleared when the plugin stops");
}

#[test]
fn context_keys_are_capped_and_windows_overlay_global_ones() {
    let f = fixture(Limits::default());
    f.install(&sample("jobs"));
    for i in 0..100 {
        f.run("jobs", "context", Some(&format!("k{i}=1"))).unwrap();
    }
    assert!(f.run("jobs", "context", Some("k100=1")).unwrap_err().contains("invalid"));
    f.run("jobs", "context", Some("k0=2")).unwrap();
    for i in 1..4 {
        f.run("jobs", "context", Some(&format!("k{i}="))).unwrap();
    }

    let global = Invocation { client: None, ..f.inv() };
    f.host.run_command("jobs", "context", Some("g=1"), global.clone()).unwrap();
    f.host.run_command("jobs", "context", Some("w=global"), global).unwrap();
    f.run("jobs", "context", Some("w=window")).unwrap();
    let w = |client| f.host.context_keys(Some(client)).into_iter().find(|k| k.key == "w").map(|k| k.value);
    assert_eq!(w("main").as_deref(), Some("\"window\""));
    assert_eq!(w("other").as_deref(), Some("\"global\""));

    f.run("jobs", "context", Some("w=")).unwrap();
    assert_eq!(w("main").as_deref(), Some("\"global\""), "removing the window key reveals the global one");
}

#[test]
fn context_values_are_stored_as_json_and_bounded() {
    let f = fixture(Limits::default());
    f.install(&sample("jobs"));
    let value = |arg: &str| {
        f.run("jobs", "context", Some(arg)).unwrap();
        f.host.context_keys(Some("main")).into_iter().find(|k| k.key == "x").unwrap().value
    };
    assert_eq!(value("x=true"), "true");
    assert_eq!(value("x=2.5"), "2.5");
    assert_eq!(value("x=say \"hi\""), "\"say \\\"hi\\\"\"");
    assert_eq!(value("x=1"), "1");
    f.take_events();
    f.run("jobs", "context", Some("x=1.0")).unwrap();
    assert!(f.take_events().is_empty(), "the same value emits nothing");
    let long = format!("x={}", "a".repeat(1025));
    assert!(f.run("jobs", "context", Some(&long)).unwrap_err().contains("invalid"));
}

#[test]
fn forgetting_a_window_drops_its_context_keys_silently() {
    let f = fixture(Limits::default());
    f.install(&sample("jobs"));
    f.run("jobs", "context", Some("w=1")).unwrap();
    f.take_events();
    f.host.forget_client("main");
    assert!(f.host.context_keys(Some("main")).is_empty());
    assert!(f.take_events().is_empty());
}

#[test]
fn a_closed_window_ignores_late_context_writes_until_its_label_is_reused() {
    let f = fixture(Limits::default());
    f.install(&sample("jobs"));
    f.host.forget_client("main");
    f.take_events();
    f.run("jobs", "context", Some("late=1")).unwrap();
    assert!(f.host.context_keys(Some("main")).is_empty());
    let events = f.take_events();
    assert!(
        !events.iter().any(|(_, e)| matches!(e, PluginEvent::ContextChanged { .. })),
        "no context event: {events:?}"
    );

    f.host.reopen_client("main");
    f.run("jobs", "context", Some("fresh=1")).unwrap();
    assert_eq!(f.host.context_keys(Some("main"))[0].key, "fresh");
}

#[test]
fn stopping_a_plugin_withdraws_each_context_key_in_its_own_scope() {
    let f = fixture(Limits::default());
    f.install(&sample("jobs"));
    let global = Invocation { client: None, ..f.inv() };
    f.host.run_command("jobs", "context", Some("g=1"), global).unwrap();
    f.run("jobs", "context", Some("w=1")).unwrap();
    f.take_events();
    f.host.set_enabled("jobs", false).unwrap();
    let mut removed: Vec<_> = f
        .take_events()
        .into_iter()
        .filter_map(|(client, e)| match e {
            PluginEvent::ContextChanged { key, value: None, .. } => Some((client, key)),
            _ => None,
        })
        .collect();
    removed.sort();
    assert_eq!(removed, [(None, "g".to_owned()), (Some("main".to_owned()), "w".to_owned())]);
}

/// A data-only package `id` in `dir` whose manifest ends with `extra`, plus `files`.
fn icon_package(dir: &Path, id: &str, extra: &str, files: &[(&str, &str)]) -> PathBuf {
    let pkg = dir.join(id);
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(
        pkg.join("plugin.toml"),
        format!("id = \"{id}\"\nname = \"Iconic\"\nversion = \"1.0.0\"\nengines.openidea = \"^1.2\"\n{extra}"),
    )
    .unwrap();
    for (name, text) in files {
        std::fs::write(pkg.join(name), text).unwrap();
    }
    pkg
}

const RECT: &str = r#"<svg viewBox="0 0 16 16"><rect width="16" height="16"/></svg>"#;
const CIRCLE: &str = r#"<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>"#;

#[test]
fn plugin_icons_install_with_the_package() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = icon_package(
        tmp.path(),
        "iconic",
        "icon = \"icon.svg\"\nicon-dark = \"icon_dark.svg\"\n",
        &[("icon.svg", RECT), ("icon_dark.svg", CIRCLE)],
    );
    let info = f.install(&pkg);
    assert_eq!(info.status, PluginStatus::Static, "{:?}", info.error);
    let icon = info.icon.expect("icon");
    assert!(icon.light.contains("<rect"), "{}", icon.light);
    assert!(icon.dark.unwrap().contains("<circle"));
    assert!(f.installed("iconic").join("icon_dark.svg").is_file());

    f.host.set_enabled("iconic", false).unwrap();
    assert!(f.host.info_of("iconic").unwrap().icon.is_some(), "disabled plugins keep their icon");
}

#[test]
fn invalid_plugin_icons_refuse_the_package() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let big = format!("<svg>{}</svg>", "<path d=\"M0 0h1v1z\"/>".repeat(1000));
    let padded = format!("<svg><!--{}--><rect/></svg>", " ".repeat(20 << 10));
    let cases = [
        ("scripted", "icon = \"icon.svg\"\n", "<svg><script>alert(1)</script></svg>".to_owned(), "icon.svg"),
        ("oversized", "icon = \"icon.svg\"\n", big, "16 KiB"),
        ("padded", "icon = \"icon.svg\"\n", padded, "16 KiB"),
        ("missing", "icon = \"missing.svg\"\n", RECT.to_owned(), "missing.svg"),
    ];
    for (id, extra, svg, expected) in cases {
        let pkg = icon_package(tmp.path(), id, extra, &[("icon.svg", &svg)]);
        let err = f.host.preview_install(&pkg).map(|_| ()).unwrap_err().message;
        assert!(err.contains(expected), "{id}: {err}");
    }
}

#[test]
fn endpoint_exports_refresh_matching_files_and_follow_plugin_lifecycle() {
    let f = fixture(Limits { idle_timeout: Some(Duration::from_millis(50)), ..Limits::default() });
    let routes = f.project.join("routes.txt");
    std::fs::write(&routes, "/users/{id}\n").unwrap();
    f.install(&sample("endpoints"));
    let id = "test.endpoints";
    let paths = || f.host.endpoints(id, &f.project).unwrap().iter().map(|e| e.path.clone()).collect::<Vec<_>>();
    let first = f.host.endpoints(id, &f.project).unwrap();
    assert_eq!(first[0].path, "/users/{id}");
    assert!(first[0].method.is_none(), "any method is preserved");
    assert_eq!(first[0].location.path, ide_core::IpcPath::from(to_ipc(&routes)));
    std::thread::sleep(Duration::from_millis(70));
    f.host.tick();
    assert_eq!(f.host.instances(), 0);
    assert_eq!(paths(), ["/users/{id}"]);
    assert_eq!(f.host.instances(), 0, "a cached list doesn't wake the plugin");
    let changed = |f: &Fixture| {
        f.take_events()
            .iter()
            .any(|(_, e)| matches!(e, PluginEvent::EndpointsChanged { plugin_id, .. } if plugin_id == id))
    };
    std::fs::write(&routes, "/updated\n").unwrap();
    f.take_events();
    f.host.invalidate_endpoints(&f.project, &[f.project.join("unrelated.txt")]);
    assert!(!changed(&f));
    assert_eq!(paths(), ["/users/{id}"]);
    f.host.invalidate_endpoints(&f.project, std::slice::from_ref(&routes));
    assert!(changed(&f), "windows are told to ask again");
    assert_eq!(paths(), ["/updated"]);
    std::fs::write(&routes, "not-a-path\n").unwrap();
    f.host.invalidate_endpoints(&f.project, std::slice::from_ref(&routes));
    assert_eq!(paths(), ["/updated"], "an invalid list doesn't replace the last valid one");
    f.host.set_enabled(id, false).unwrap();
    assert!(paths().is_empty());
    std::fs::write(&routes, "/enabled\n").unwrap();
    f.host.set_enabled(id, true).unwrap();
    assert_eq!(paths(), ["/enabled"]);
    f.take_events();
    assert!(f.run(id, "crash", None).is_err());
    assert!(changed(&f), "a crash withdraws the routes");
    f.host.uninstall(id).unwrap();
    assert!(f.host.endpoints(id, &f.project).is_err());
}

struct EndpointWorkspace {
    reads: std::sync::atomic::AtomicUsize,
    inner: Arc<TestWorkspace>,
    roots: Mutex<Vec<PathBuf>>,
    entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}
impl PluginWorkspace for EndpointWorkspace {
    fn projects(&self) -> Vec<PathBuf> {
        self.roots.lock().clone()
    }
    fn buffer_text(&self, path: &Path) -> Option<String> {
        if self.reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed) > 0
            && let Some(entered) = self.entered.lock().take()
        {
            entered.send(()).unwrap();
            self.release.lock().recv().unwrap();
        }
        self.inner.buffer_text(path)
    }
    fn document(&self, path: &Path) -> Option<(u64, String)> {
        self.inner.document(path)
    }
    fn trusted(&self, root: &Path) -> bool {
        self.roots.lock().iter().any(|r| r == root)
    }
    fn project_of(&self, _: &str) -> Option<PathBuf> {
        self.roots.lock().first().cloned()
    }
    fn apply_edits(&self, path: &Path, version: u64, edits: &[ide_core::TextEdit]) -> Result<u64, HostError> {
        self.inner.apply_edits(path, version, edits)
    }
    fn publish_diagnostics(
        &self,
        source: &str,
        path: &Path,
        items: Vec<ide_core::Diagnostic>,
    ) -> Result<(), HostError> {
        self.inner.publish_diagnostics(source, path, items)
    }
}

#[test]
fn late_endpoint_results_cannot_restore_a_disabled_plugin_or_closed_project() {
    for close_project in [false, true] {
        let f = fixture(Limits::default());
        std::fs::write(f.project.join("routes.txt"), "/late\n").unwrap();
        f.install(&sample("endpoints"));
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let workspace = Arc::new(EndpointWorkspace {
            reads: std::sync::atomic::AtomicUsize::new(0),
            inner: f.workspace.clone(),
            roots: Mutex::new(vec![f.project.clone()]),
            entered: Mutex::new(Some(entered_tx)),
            release: Mutex::new(release_rx),
        });
        f.host.set_workspace(Some(workspace.clone()));
        let late = std::thread::scope(|scope| {
            // The plugin reads the file, then the host's check reads it again and waits here.
            let query = scope.spawn(|| f.host.endpoints("test.endpoints", &f.project).unwrap());
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            if close_project {
                workspace.roots.lock().clear();
            } else {
                f.host.set_enabled("test.endpoints", false).unwrap();
            }
            release_tx.send(()).unwrap();
            query.join().unwrap()
        });
        assert!(late.is_empty());
        assert!(f.host.endpoints("test.endpoints", &f.project).unwrap().is_empty());
    }
}

#[test]
fn endpoint_results_are_isolated_per_root_and_withdraw_closed_roots() {
    let f = fixture(Limits::default());
    let other = f.project.parent().unwrap().join("other");
    std::fs::create_dir(&other).unwrap();
    std::fs::write(f.project.join("routes.txt"), "/first\n").unwrap();
    std::fs::write(other.join("routes.txt"), "/second\n").unwrap();
    let (_, release_rx) = std::sync::mpsc::channel();
    let workspace = Arc::new(EndpointWorkspace {
        reads: std::sync::atomic::AtomicUsize::new(0),
        inner: f.workspace.clone(),
        roots: Mutex::new(vec![f.project.clone(), other.clone()]),
        entered: Mutex::new(None),
        release: Mutex::new(release_rx),
    });
    f.host.set_workspace(Some(workspace.clone()));
    f.install(&sample("endpoints"));
    for (root, route) in [(&f.project, "/first"), (&other, "/second")] {
        let list = f.host.endpoints("test.endpoints", root).unwrap();
        assert_eq!(list.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), [route]);
    }
    workspace.roots.lock().retain(|r| r != &other);
    assert!(f.host.endpoints("test.endpoints", &other).unwrap().is_empty(), "a closed project has no routes");
    assert_eq!(f.host.endpoints("test.endpoints", &f.project).unwrap()[0].path, "/first");
}

#[test]
fn notification_actions_keep_commands_and_window_scope() {
    let f = fixture(Limits::default());
    f.install(&sample("jobs"));
    f.take_events();
    f.host
        .run_command("jobs", "notify-actions", None, Invocation { client: Some("second".into()), ..f.inv() })
        .unwrap();
    let notifications = f
        .take_events()
        .into_iter()
        .filter_map(|(client, event)| match event {
            PluginEvent::Notification { plugin_id, actions, .. } => Some((client, plugin_id, actions)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0].0.as_deref(), Some("second"));
    assert_eq!(notifications[0].1, "jobs");
    assert_eq!(notifications[0].2.len(), 3);
    assert_eq!(notifications[0].2[0].command, "context");
    assert_eq!(notifications[0].2[0].argument.as_deref(), Some("notification-action=1\nvalue"));
    for invalid in ["four", "unknown"] {
        let error = f.run("jobs", "notify-actions", Some(invalid)).unwrap_err();
        assert!(error.contains(if invalid == "four" { "at most 3" } else { "declares no command" }), "{error}");
        assert!(f.take_events().iter().all(|(_, e)| !matches!(e, PluginEvent::Notification { .. })));
    }
    assert_eq!(f.status("jobs"), PluginStatus::Active, "a refused notification leaves the plugin running");
}

#[test]
fn directory_prompts_and_project_requests_use_the_calling_window_without_a_capability() {
    use ide_plugin::Prompt;
    let f = fixture(Limits { timeout: Duration::from_millis(500), ..Limits::default() });
    f.install(&sample("jobs"));
    f.host.set_capability("jobs", "project.read", false).unwrap();
    let (result, prompt) =
        run_and_answer(&f, "pick-directory", Some("C:/work"), Some(&["C:/work/repo"]), Duration::from_millis(700));
    assert_eq!(result.unwrap().as_deref(), Some("C:/work/repo"));
    assert_eq!(prompt, Prompt::PickDirectory { title: "Clone target".into(), initial: Some("C:/work".into()) });
    assert_eq!(run_and_answer(&f, "pick-directory", None, None, Duration::ZERO).0.unwrap().as_deref(), Some("none"));
    assert!(run_and_answer(&f, "pick-directory", None, Some(&["relative"]), Duration::ZERO).0.is_err());
    assert!(f.run("jobs", "pick-directory", Some("relative")).is_err());
    for (cmd, new_window) in [("open-project", false), ("open-project-new", true)] {
        f.take_events();
        let inv = Invocation { client: Some("second".into()), ..f.inv() };
        f.host.run_command("jobs", cmd, Some("C:/work/repo"), inv).unwrap();
        let requests = f
            .take_events()
            .into_iter()
            .filter_map(|(client, event)| match event {
                PluginEvent::OpenProject { plugin_id, path, new_window } => Some((client, plugin_id, path, new_window)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(requests, vec![(Some("second".into()), "jobs".into(), "C:/work/repo".into(), new_window)]);
        let error = f.host.run_command("jobs", cmd, Some("/work/repo"), Invocation::default()).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidInput, "{error:?}");
    }
    assert!(f.host.run_command("jobs", "pick-directory", None, Invocation::default()).is_err());
    for path in ["relative", "/bad\npath", ""] {
        f.take_events();
        assert!(f.run("jobs", "open-project", Some(path)).is_err());
        assert!(!f.take_events().iter().any(|(_, event)| matches!(event, PluginEvent::OpenProject { .. })));
    }
}

#[test]
fn plugin_readonly_fields_and_table_row_extensions_round_trip() {
    let f = fixture(Limits::default());
    f.install(&sample("tables"));
    let view = f.host.render_view("tables", "fields", None, f.inv()).unwrap();
    let ide_plugin::ViewBody::Form(fields) = view.body else { panic!("form") };
    assert_eq!(fields[0].value, ide_plugin::FieldValue::Label("Merge request #42".into()));
    assert_eq!(fields[1].value, ide_plugin::FieldValue::ReadonlyText { text: "Ada Lovelace".into(), multiline: false });
    assert_eq!(
        fields[2].value,
        ide_plugin::FieldValue::ReadonlyText { text: "Ready for review\nAll checks passed".into(), multiline: true }
    );
    assert!(matches!(fields[3].value, ide_plugin::FieldValue::Text(_)));
    for (event, status) in [
        (ide_plugin::ViewEvent::TableSelect { row: 2 }, "select:2"),
        (ide_plugin::ViewEvent::TableActivate { row: 2 }, "activate:2"),
    ] {
        f.take_events();
        f.host.view_event("tables", "tables", event, f.inv()).unwrap();
        assert!(f.take_events().iter().any(|(_, e)| matches!(e, PluginEvent::ViewChanged { plugin_id, view } if plugin_id == "tables" && view == "tables")));
        assert_eq!(f.host.render_view("tables", "tables", None, f.inv()).unwrap().status.as_deref(), Some(status));
    }
}

#[test]
fn path_filtered_events_do_not_wake_idle_plugins_and_recheck_queued_filters() {
    let f = fixture(Limits { idle_timeout: Some(Duration::from_millis(100)), ..Limits::default() });
    f.install(&sample("path-events"));
    f.run("test.path-events", "count", None).unwrap();
    let matched = to_ipc(&f.project.join("config/app.yaml"));
    let other = to_ipc(&f.project.join("src/main.rs"));
    let deliver = |events| {
        f.host.post_events(Some("main"), events);
        f.host.flush_events_at(Instant::now() + Duration::from_secs(3));
        assert!(f.host.wait_events(Duration::from_secs(10)));
    };
    std::thread::sleep(Duration::from_millis(150));
    f.host.tick();
    assert_eq!(f.status("test.path-events"), PluginStatus::Inactive);
    let activations = f.host.info_of("test.path-events").unwrap().stats.activations;
    deliver(vec![WorkbenchEvent::FileOpened(other.clone()), WorkbenchEvent::FileSaved(other.clone())]);
    assert_eq!(f.host.info_of("test.path-events").unwrap().stats.activations, activations);
    deliver(vec![WorkbenchEvent::FileOpened(matched.clone()), WorkbenchEvent::FileSaved(matched.clone())]);
    assert_eq!(f.run("test.path-events", "count", None).unwrap().as_deref(), Some("2"));
    assert!(f.run("test.path-events", "filter", Some("../*")).is_err());
    deliver(vec![WorkbenchEvent::FileOpened(matched.clone())]);
    assert_eq!(
        f.run("test.path-events", "count", None).unwrap().as_deref(),
        Some("3"),
        "invalid filter preserves previous one"
    );

    f.host.post_events(Some("main"), vec![WorkbenchEvent::FileOpened(matched.clone())]);
    f.run("test.path-events", "filter", None).unwrap();
    f.host.flush_events_at(Instant::now() + Duration::from_secs(3));
    assert!(f.host.wait_events(Duration::from_secs(10)));
    assert_eq!(
        f.run("test.path-events", "count", None).unwrap().as_deref(),
        Some("3"),
        "queued event uses current filter"
    );
    deliver(vec![WorkbenchEvent::FileOpened(matched.clone())]);
    assert_eq!(f.run("test.path-events", "count", None).unwrap().as_deref(), Some("3"));
    f.run("test.path-events", "all", None).unwrap();
    deliver(vec![WorkbenchEvent::FileOpened(other.clone())]);
    assert_eq!(f.run("test.path-events", "count", None).unwrap().as_deref(), Some("4"));
    f.host.post_events(Some("main"), vec![WorkbenchEvent::FileOpened(other.clone())]);
    f.run("test.path-events", "off", None).unwrap();
    f.host.flush_events_at(Instant::now() + Duration::from_secs(3));
    assert!(f.host.wait_events(Duration::from_secs(10)));
    deliver(vec![WorkbenchEvent::FileOpened(other)]);
    assert_eq!(f.run("test.path-events", "count", None).unwrap().as_deref(), Some("4"));

    f.host.set_enabled("test.path-events", false).unwrap();
    assert!(!f.host.event_kinds().contains(&WorkbenchEvent::FileOpened(String::new()).kind()));
}

#[test]
fn project_lookup_works_in_commands_and_provider_calls_without_an_invocation_project() {
    let f = fixture(Limits::default());
    f.install(&sample("path-events"));
    let path = f.project.join("src/notes.txt");
    assert_eq!(f.run("test.path-events", "project", Some(&to_ipc(&path))).unwrap(), Some(to_ipc(&f.project)));
    assert_eq!(f.run("test.path-events", "project", Some("src/notes.txt")).unwrap(), None);
    assert_eq!(
        f.run("test.path-events", "project", Some(&to_ipc(&f.project.with_extension("other").join("a")))).unwrap(),
        None
    );
    let doc = ide_plugin::ProviderDocument { path, language: "text".into(), version: 1, text: "one".into() };
    let hovers = f.host.provide_hover(&doc, ide_core::Pos::new(0, 0));
    assert_eq!(hovers.len(), 1);
    assert_eq!(hovers[0].markdown, to_ipc(&f.project));
    let nested = f.project.join("nested");
    std::fs::create_dir(&nested).unwrap();
    f.workspace.other_roots.lock().push(nested.clone());
    assert_eq!(
        f.run("test.path-events", "project", Some(&to_ipc(&nested.join("new.txt")))).unwrap(),
        Some(to_ipc(&nested))
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&nested, f.project.join("alias")).unwrap();
        assert_eq!(
            f.run("test.path-events", "project", Some(&to_ipc(&f.project.join("alias/new.txt")))).unwrap(),
            Some(to_ipc(&nested))
        );
        std::os::unix::fs::symlink(f._tmp.path(), f.project.join("outside")).unwrap();
        assert_eq!(
            f.run("test.path-events", "project", Some(&to_ipc(&f.project.join("outside/new.txt")))).unwrap(),
            None
        );
    }
    f.host.set_capability("test.path-events", "project.read", false).unwrap();
    assert!(f.run("test.path-events", "project", Some(&to_ipc(&doc.path))).unwrap_err().contains("project.read"));
    f.host.set_capability("test.path-events", "events", false).unwrap();
    assert!(f.run("test.path-events", "filter", Some("*")).unwrap_err().contains("events"));
}

#[test]
fn view_messages_accept_multi_megabyte_snapshots_and_cap_at_8_mib() {
    let f = fixture(Limits::default());
    f.install(&sample("jobs"));
    f.take_events();
    let two_mib = "x".repeat(2 << 20);
    f.host.view_event("jobs", "jobs", ide_plugin::ViewEvent::Message { text: two_mib.clone() }, f.inv()).unwrap();
    let echoed = f
        .take_events()
        .into_iter()
        .find_map(|(_, e)| match e {
            PluginEvent::ViewMessage { view, message, .. } if view == "jobs" => Some(message),
            _ => None,
        })
        .expect("2 MiB view message round-trips");
    assert_eq!(echoed.len(), 2 << 20);

    let too_large = "x".repeat((8 << 20) + 1);
    let err =
        f.host.view_event("jobs", "jobs", ide_plugin::ViewEvent::Message { text: too_large }, f.inv()).unwrap_err();
    assert!(err.message.contains("limited to"), "{}", err.message);
}

#[test]
fn web_log_tabs_use_the_web_pty_permission_boundary() {
    use ide_host::plugins::web::WebPtyCommand;
    let f = fixture(Limits::default());
    let info = f.host.install_from_dir(&sample("web-log"), &Consent::default()).unwrap();
    assert!(info.capabilities.iter().any(|c| c.id == "process:bash" && !c.granted));
    assert_eq!(f.run("web-log", "ping", None).unwrap().as_deref(), Some("Web log ready"));
    for command in ["open", "denied"] {
        f.take_events();
        assert_eq!(f.run("web-log", command, None).unwrap(), None);
        assert!(
            f.take_events()
                .iter()
                .any(|(_, event)| matches!(event, PluginEvent::ViewMessage { plugin_id, view, message }
                if plugin_id == "web-log" && view == "logs" && message == command))
        );
    }
    let command = |program: &str| WebPtyCommand {
        program: program.into(),
        args: vec!["--noprofile".into(), "--norc".into()],
        env: Default::default(),
        cols: 240,
        rows: 40,
    };
    for program in ["bash", "sh", "/bin/bash"] {
        assert_eq!(
            f.host.web_pty_options("web-log", "logs", "main", command(program)).unwrap_err().kind,
            ErrorKind::PermissionDenied
        );
    }
    #[cfg(unix)]
    {
        f.host.set_capability("web-log", "process:bash", true).unwrap();
        let options = f.host.web_pty_options("web-log", "logs", "main", command("bash")).unwrap();
        assert_eq!(options.shell.as_deref(), f.host.program_for("web-log", "bash").unwrap().to_str());
        assert_eq!(options.cwd.0, f.project);
        assert!(options.env.is_empty());
        assert!(!options.shell_integration);
        assert!(f.host.web_pty_options("web-log", "logs", "main", command("sh")).is_err());
        f.host.set_capability("web-log", "process:bash", false).unwrap();
        assert!(f.host.web_pty_options("web-log", "logs", "main", command("bash")).is_err());
    }
}

#[test]
fn web_ptys_require_a_current_exact_program_grant_and_project() {
    use ide_host::plugins::web::WebPtyCommand;
    let f = fixture(Limits::default());
    let info = f.host.install_from_dir(&sample("web-pty"), &Consent::default()).unwrap();
    assert!(info.capabilities.iter().any(|c| c.id == "process:git" && !c.granted));
    let command = || WebPtyCommand {
        program: "git".into(),
        args: vec!["--version".into()],
        env: Default::default(),
        cols: 80,
        rows: 24,
    };
    let options = |cmd| f.host.web_pty_options("web-pty", "terminal", "main", cmd);
    assert_eq!(options(command()).unwrap_err().kind, ErrorKind::PermissionDenied);
    f.host.set_capability("web-pty", "process:git", true).unwrap();
    let approved = f.host.program_for("web-pty", "git").unwrap();
    let got = options(command()).unwrap();
    assert_eq!(got.shell.as_deref(), approved.to_str());
    assert!(approved.is_absolute());
    assert_eq!(got.cwd.0, f.project);
    assert!(!got.shell_integration);
    assert_eq!(f.run("web-pty", "ping", None).unwrap().as_deref(), Some("Web PTY ready"));
    for program in ["sh", "bash", "git-other", "./git", "/tmp/git"] {
        let cmd = WebPtyCommand { program: program.into(), ..command() };
        assert!(options(cmd).is_err(), "{program}");
    }
    for cmd in [
        WebPtyCommand { cols: 0, ..command() },
        WebPtyCommand { rows: 501, ..command() },
        WebPtyCommand { args: vec!["x".repeat(4097)], ..command() },
        WebPtyCommand { args: vec!["x".into(); 257], ..command() },
        WebPtyCommand { args: vec!["\0".into()], ..command() },
        WebPtyCommand { env: [("PATH".into(), "/tmp".into())].into(), ..command() },
        WebPtyCommand { env: [("a=b".into(), "x".into())].into(), ..command() },
        WebPtyCommand { env: [("a".into(), "x".repeat(4097))].into(), ..command() },
    ] {
        assert!(options(cmd).is_err());
    }
    let got = options(WebPtyCommand { env: [("OPENIDEA_WEB_PTY_TEST_NEW".into(), "yes".into())].into(), ..command() })
        .unwrap();
    assert_eq!(got.env["OPENIDEA_WEB_PTY_TEST_NEW"], "yes");
    assert!(f.host.web_pty_options("web-pty", "missing", "main", command()).is_err());
    f.host.set_workspace(None);
    assert!(options(command()).is_err());
    let mut untrusted = TestWorkspace::new(&f.project);
    Arc::get_mut(&mut untrusted).unwrap().trusted = false;
    f.host.set_workspace(Some(untrusted));
    assert_eq!(options(command()).unwrap_err().kind, ErrorKind::PermissionDenied);
    f.host.set_workspace(Some(f.workspace.clone()));
    std::fs::rename(&f.project, f.project.with_extension("moved")).unwrap();
    assert!(options(command()).unwrap_err().message.contains("no longer exists"));
    std::fs::rename(f.project.with_extension("moved"), &f.project).unwrap();
    f.host.set_capability("web-pty", "process:git", false).unwrap();
    assert_eq!(options(command()).unwrap_err().kind, ErrorKind::PermissionDenied);
    f.host.set_enabled("web-pty", false).unwrap();
    assert!(options(command()).is_err());
    f.host.uninstall("web-pty").unwrap();
    assert!(options(command()).is_err());
}

#[cfg(unix)]
#[test]
fn web_ptys_keep_the_approved_file_and_require_api_1_3() {
    use ide_host::plugins::web::WebPtyCommand;
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(Limits::default());
    let bin = f.plugins_dir.parent().unwrap().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let executable = bin.join("git");
    std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = bin.clone();
    f.host.set_program_path(Arc::new(move || Some(path.clone().into_os_string())));
    f.install(&sample("web-pty"));
    let command = || WebPtyCommand { program: "git".into(), args: vec![], env: Default::default(), cols: 80, rows: 24 };
    f.host.set_program_path(Arc::new(|| Some("/unapproved-path".into())));
    assert_eq!(
        f.host.web_pty_options("web-pty", "terminal", "main", command()).unwrap().shell.unwrap(),
        executable.canonicalize().unwrap().to_string_lossy()
    );
    std::fs::write(&executable, "#!/bin/sh\nexit 42\n").unwrap();
    assert!(f.host.web_pty_options("web-pty", "terminal", "main", command()).unwrap_err().message.contains("changed"));
    std::fs::remove_file(&executable).unwrap();
    assert!(f.host.web_pty_options("web-pty", "terminal", "main", command()).is_err());

    let old = tempfile::tempdir().unwrap();
    let pkg = old.path().join("old");
    copy_dir(&sample("web-pty"), &pkg);
    let manifest = pkg.join("plugin.toml");
    let text = std::fs::read_to_string(&manifest).unwrap().replace("^1.3", "^1.2");
    std::fs::write(manifest, text).unwrap();
    let f = fixture(Limits::default());
    f.install(&pkg);
    assert!(f.host.web_pty_options("web-pty", "terminal", "main", command()).unwrap_err().message.contains("1.3"));
}

#[tokio::test]
async fn web_ptys_are_capped_across_windows_and_end_with_the_plugin() {
    use ide_host::{Host, HostConfig, plugins::web::WebPtyCommand};
    let f = fixture(Limits::default());
    f.install(&sample("web-pty"));
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: root.path().join("config"),
        data_dir: root.path().join("data"),
        local_data_dir: root.path().join("local"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    let spawn = |window: &str| {
        f.host.spawn_web_pty(
            &host,
            "web-pty",
            "terminal",
            window,
            WebPtyCommand {
                program: "git".into(),
                args: vec!["hash-object".into(), "--stdin".into()],
                env: Default::default(),
                cols: 80,
                rows: 24,
            },
            Arc::new(|_| {}),
        )
    };
    *f.workspace.project_queries_left.lock() = Some(1);
    assert!(spawn("main").is_err(), "project closed while spawning");
    assert!(host.terminals.list().is_empty());
    *f.workspace.project_queries_left.lock() = None;
    let mut ids = Vec::new();
    for i in 0..8 {
        ids.push(spawn(&format!("window-{i}")).unwrap().id);
    }
    assert!(spawn("ninth-window").unwrap_err().message.contains("8 PTYs"));
    host.terminals.kill(ids[0]).unwrap();
    let replacement = spawn("another-window").unwrap();
    f.host.reload("web-pty").unwrap();
    assert!(!host.terminals.contains(replacement.id));
    assert!(ids.into_iter().all(|id| !host.terminals.contains(id)));
    let id = spawn("main").unwrap().id;
    f.host.set_capability("web-pty", "process:git", false).unwrap();
    assert!(!host.terminals.contains(id));
    assert!(spawn("main").is_err());
    f.host.set_capability("web-pty", "process:git", true).unwrap();
    let id = spawn("main").unwrap().id;
    f.host.set_enabled("web-pty", false).unwrap();
    assert!(!host.terminals.contains(id));
    f.host.set_enabled("web-pty", true).unwrap();
    let id = spawn("main").unwrap().id;
    f.host.forget_client("main");
    assert!(!host.terminals.contains(id));
    assert!(spawn("main").is_err());
    f.host.reopen_client("main");
    let id = spawn("main").unwrap().id;
    f.host.uninstall("web-pty").unwrap();
    assert!(!host.terminals.contains(id));
}

#[test]
fn marker_icons_ship_sanitized_light_and_dark_assets() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = tmp.path().join("plugin");
    std::fs::create_dir_all(pkg.join("icons")).unwrap();
    let manifest = |engine: &str, icon: &str, dark: &str| {
        format!(
            r#"
id = "marker-icons"
name = "Marker Icons"
version = "1.0.0"
engines.openidea = "{engine}"
[[contributes.markerIcons]]
id = "resource"
icon = "{icon}"
iconDark = "{dark}"
"#
        )
    };
    let clean = r#"<svg viewBox="0 0 16 16"><rect width="16" height="16"/></svg>"#;
    std::fs::write(pkg.join("icons/resource.svg"), clean).unwrap();
    std::fs::write(pkg.join("icons/resource_dark.svg"), clean.replace("rect", "circle")).unwrap();
    for (engine, icon, dark) in [
        ("^1.0", "icons/resource.svg", "icons/resource_dark.svg"),
        ("^1.3", "../outside.svg", "icons/resource_dark.svg"),
        ("^1.3", "icons/missing.svg", "icons/resource_dark.svg"),
        ("^1.3", "icons/resource.svg", "icons/missing.svg"),
    ] {
        std::fs::write(pkg.join("plugin.toml"), manifest(engine, icon, dark)).unwrap();
        assert!(f.host.install_from_dir(&pkg, &Consent::all()).is_err());
    }
    std::fs::write(pkg.join("plugin.toml"), manifest("^1.3", "icons/resource.svg", "icons/resource_dark.svg")).unwrap();
    #[cfg(unix)]
    {
        let outside = tmp.path().join("outside.svg");
        std::fs::write(&outside, clean).unwrap();
        std::fs::remove_file(pkg.join("icons/resource_dark.svg")).unwrap();
        std::os::unix::fs::symlink(outside, pkg.join("icons/resource_dark.svg")).unwrap();
        assert!(f.host.install_from_dir(&pkg, &Consent::all()).is_err());
        std::fs::remove_file(pkg.join("icons/resource_dark.svg")).unwrap();
    }
    let mut unsafe_svgs = vec![
        "<svg><script>alert(1)</script></svg>".to_owned(),
        "<svg onload=\"alert(1)\"/>".to_owned(),
        "<svg><foreignObject/></svg>".to_owned(),
        "<svg><rect style=\"fill:url(https://evil/x)\"/></svg>".to_owned(),
        "<svg><rect style=\"background-image:image-set('https://evil/x' 1x)\"/></svg>".to_owned(),
        format!("<svg>{}</svg>", " ".repeat(64 << 10)),
    ];
    for attr in ["href", "xlink:href"] {
        for scheme in ["http://evil/x", "data:image/svg+xml,x", "javascript:alert(1)"] {
            unsafe_svgs.push(format!("<svg><use {attr}=\"{scheme}\"/></svg>"));
        }
    }
    for path in ["icons/resource.svg", "icons/resource_dark.svg"] {
        for svg in &unsafe_svgs {
            std::fs::write(pkg.join(path), svg).unwrap();
            assert!(f.host.install_from_dir(&pkg, &Consent::all()).is_err(), "accepted {path}: {svg}");
        }
        std::fs::write(pkg.join(path), clean).unwrap();
    }
    std::fs::write(pkg.join("icons/resource_dark.svg"), clean.replace("rect", "circle")).unwrap();
    let info = f.install(&pkg);
    assert!(info.error.is_none(), "{:?}", info.error);
    let assets = f.host.assets("marker-icons", "markerIcon/resource/").unwrap();
    assert_eq!(assets.len(), 2);
    assert!(assets.iter().any(|(id, svg)| id.ends_with("/light") && svg.contains("<rect")));
    assert!(assets.iter().any(|(id, svg)| id.ends_with("/dark") && svg.contains("<circle")));
    let revision = f.host.ui_items("markerIcons")[0].decl["revision"].clone();
    std::fs::write(pkg.join("icons/resource.svg"), clean.replace("width=\"16\"", "width=\"14\"")).unwrap();
    let updated = f.install(&pkg);
    assert!(updated.error.is_none(), "{:?}", updated.error);
    assert_ne!(f.host.ui_items("markerIcons")[0].decl["revision"], revision);
    let assets = f.host.assets("marker-icons", "markerIcon/resource/").unwrap();
    assert!(assets.iter().any(|(id, svg)| id.ends_with("/light") && svg.contains("width=\"14\"")));
    std::fs::remove_dir_all(pkg).unwrap();
    assert_eq!(f.host.assets("marker-icons", "markerIcon/resource/").unwrap(), assets);
    f.host.set_enabled("marker-icons", false).unwrap();
    assert!(f.host.assets("marker-icons", "markerIcon/resource/").is_err());
}

#[test]
fn marker_providers_preserve_names_and_package_paths() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();
    let pkg = tmp.path().join("plugin");
    copy_dir(&misbehave_pkg(), &pkg);
    let manifest = std::fs::read_to_string(pkg.join("plugin.toml")).unwrap();
    std::fs::write(
        pkg.join("plugin.toml"),
        format!("{manifest}\n[[contributes.providers]]\nkinds = [\"line-markers\"]\nlanguages = [\"text\"]\n"),
    )
    .unwrap();
    f.install(&pkg);
    let doc = ide_plugin::ProviderDocument {
        path: f.project.join("markers.txt"),
        language: "text".into(),
        version: 1,
        text: "marker-icons\nordinary\ncustom\nlegacy".into(),
    };
    assert!(eventually(|| f.host.provide_line_markers(&doc).len() == 4));
    let markers = f.host.provide_line_markers(&doc);
    assert_eq!(
        markers.iter().map(|(_, m)| m.icon.as_deref().unwrap()).collect::<Vec<_>>(),
        ["run", "database", "icons/very-long-resource-marker-icon.svg", "overriding"]
    );
}
