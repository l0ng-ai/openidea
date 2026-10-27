//! End-to-end tests against real components.
//!
//! The components are checked in (`plugins/hello/dist/plugin.wasm`,
//! `tests/fixtures/misbehave/dist/plugin.wasm`) so tests need no wasm
//! toolchain. Rebuild them with `plugins/build.sh hello` and
//! `plugins/build.sh crates/ide-plugin/tests/fixtures/misbehave` after
//! changing their source or `wit/plugin.wit`.

use ide_plugin::*;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

type Events = Arc<Mutex<Vec<(Option<String>, PluginEvent)>>>;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn sample(name: &str) -> PathBuf {
    repo().join("plugins").join(name)
}

fn misbehave_pkg() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/misbehave")
}

struct Fixture {
    host: PluginHost,
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
    Fixture { host, events, _tmp: tmp, plugins_dir, project }
}

impl Fixture {
    fn inv(&self) -> Invocation {
        Invocation { client: Some("main".into()), workspace_root: Some(self.project.clone()), buffer_text: None }
    }

    fn run(&self, plugin: &str, cmd: &str, arg: Option<&str>) -> Result<Option<String>, String> {
        self.host.run_command(plugin, cmd, arg, self.inv()).map_err(|e| e.message)
    }

    fn status(&self, id: &str) -> PluginStatus {
        self.host.info_of(id).unwrap().status
    }

    fn take_events(&self) -> Vec<(Option<String>, PluginEvent)> {
        std::mem::take(&mut *self.events.lock())
    }
}

#[test]
fn hello_plugin_commands() {
    let f = fixture(Limits::default());
    let info = f.host.install_from_dir(&sample("hello")).unwrap();
    assert_eq!(info.status, PluginStatus::Active, "{:?}", info.error);
    assert!(f.plugins_dir.join("hello/plugin.toml").is_file());
    assert!(f.plugins_dir.join("hello/dist/plugin.wasm").is_file());
    let titles: Vec<_> = info.commands.iter().map(|c| c.title.as_str()).collect();
    assert_eq!(titles, ["Hello: Insert Date", "Hello: Word Count of Active File"]);
    f.take_events();

    // Insert Date: returns YYYY-MM-DD and asks the invoking window to insert it.
    let date = f.run("hello", "insert-date", None).unwrap().unwrap();
    assert!(date.len() == 10 && date.as_bytes()[4] == b'-' && date.starts_with("20"), "{date}");
    let events = f.take_events();
    assert!(events.iter().any(|(client, e)| client.as_deref() == Some("main")
        && *e == PluginEvent::InsertText { plugin_id: "hello".into(), text: date.clone() }));

    // Word Count needs an active file.
    assert!(f.run("hello", "word-count", None).unwrap_err().contains("no file is open"));
    f.host.set_active_file("main", Some(f.project.join("src/notes.txt").to_string_lossy().into_owned()));
    let summary = f.run("hello", "word-count", None).unwrap().unwrap();
    assert!(summary.starts_with("5 words, 2 lines"), "{summary}");
    assert!(f.take_events().iter().any(|(_, e)| matches!(e,
        PluginEvent::Notification { title, level: NotificationLevel::Info, .. } if title == "Word count: notes.txt")));

    // Unsaved buffer contents win over disk.
    let mut inv = f.inv();
    inv.buffer_text = Some(Arc::new(|_: &Path| Some("just three words".to_owned())));
    let summary = f.host.run_command("hello", "word-count", None, inv).unwrap().unwrap();
    assert!(summary.starts_with("3 words"), "{summary}");

    // Guest errors don't disable the plugin.
    assert!(f.run("hello", "nope", None).unwrap_err().contains("unknown command"));
    assert_eq!(f.status("hello"), PluginStatus::Active);
}

#[test]
fn read_file_is_confined_to_the_project() {
    let f = fixture(Limits::default());
    f.host.install_from_dir(&misbehave_pkg()).unwrap();
    assert_eq!(f.run("misbehave", "read", Some("src/notes.txt")).unwrap().unwrap(), "one two three\nfour five\n");
    let abs = f.project.join("src/notes.txt");
    assert!(f.run("misbehave", "read", Some(abs.to_str().unwrap())).is_ok());
    let err = f.run("misbehave", "read", Some("../secret.txt")).unwrap_err();
    assert!(err.contains("outside the project root"), "{err}");
    let err = f.run("misbehave", "read", Some("src/../../secret.txt")).unwrap_err();
    assert!(err.contains("outside the project root"), "{err}");
    assert!(f.run("misbehave", "read", Some("/etc/hosts")).is_err());
    // Without a project there is nothing to read.
    let inv = Invocation { client: None, workspace_root: None, buffer_text: None };
    let err = f.host.run_command("misbehave", "read", Some("src/notes.txt"), inv).unwrap_err().message;
    assert!(err.contains("no project is open"), "{err}");
    assert_eq!(f.run("misbehave", "root", None).unwrap().unwrap(), f.project.to_string_lossy());
    assert_eq!(f.status("misbehave"), PluginStatus::Active);
}

#[test]
fn undeclared_permission_traps_and_disables() {
    let f = fixture(Limits::default());
    f.host.install_from_dir(&misbehave_pkg()).unwrap();
    let err = f.run("misbehave", "insert", None).unwrap_err();
    assert!(err.contains("permission denied") && err.contains("editor-write"), "{err}");
    assert_eq!(f.status("misbehave"), PluginStatus::Failed);
    assert!(!f.take_events().iter().any(|(_, e)| matches!(e, PluginEvent::InsertText { .. })));
}

#[test]
fn panic_is_isolated_and_plugin_can_be_restarted() {
    let f = fixture(Limits::default());
    f.host.install_from_dir(&sample("hello")).unwrap();
    f.host.install_from_dir(&misbehave_pkg()).unwrap();
    f.take_events();

    let err = f.run("misbehave", "panic", None).unwrap_err();
    assert!(err.contains("crashed"), "{err}");
    assert!(err.contains("boom"), "stderr panic message is surfaced: {err}");
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!(info.status, PluginStatus::Failed);
    assert!(info.enabled, "failure is per session, not persisted");
    let events = f.take_events();
    assert!(events.iter().any(|(client, e)| client.as_deref() == Some("main")
        && matches!(e, PluginEvent::Notification { level: NotificationLevel::Error, title, .. } if title.contains("was disabled"))));
    assert!(events.iter().any(|(_, e)| *e == PluginEvent::CommandsChanged));

    assert!(f.run("misbehave", "echo", Some("x")).unwrap_err().contains("not running"));
    // Other plugins are unaffected.
    assert!(f.run("hello", "insert-date", None).is_ok());

    // Toggling restarts it with a fresh instance.
    f.host.set_enabled("misbehave", true).unwrap();
    assert_eq!(f.status("misbehave"), PluginStatus::Active);
    assert_eq!(f.run("misbehave", "echo", Some("back")).unwrap().as_deref(), Some("back"));
}

#[test]
fn fuel_exhaustion_traps() {
    let f = fixture(Limits { fuel: 50_000_000, timeout: Duration::from_secs(30), ..Limits::default() });
    f.host.install_from_dir(&misbehave_pkg()).unwrap();
    let err = f.run("misbehave", "spin", None).unwrap_err();
    assert!(err.contains("CPU budget"), "{err}");
    assert_eq!(f.status("misbehave"), PluginStatus::Failed);
}

#[test]
fn wall_clock_timeout_traps() {
    let f = fixture(Limits { fuel: u64::MAX, timeout: Duration::from_millis(200), ..Limits::default() });
    f.host.install_from_dir(&misbehave_pkg()).unwrap();
    let started = std::time::Instant::now();
    let err = f.run("misbehave", "spin", None).unwrap_err();
    assert!(err.contains("timed out"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn memory_limit_traps() {
    let f = fixture(Limits { memory_bytes: 32 << 20, ..Limits::default() });
    f.host.install_from_dir(&misbehave_pkg()).unwrap();
    let err = f.run("misbehave", "alloc", None).unwrap_err();
    assert!(err.contains("memory"), "{err}");
    assert_eq!(f.status("misbehave"), PluginStatus::Failed);
}

#[test]
fn runtime_language_and_theme_registration() {
    let f = fixture(Limits::default());
    f.host.install_from_dir(&misbehave_pkg()).unwrap();
    let lang = "id = \"zz\"\nname = \"ZZ\"\nextensions = [\"zz\"]";
    f.run("misbehave", "language", Some(lang)).unwrap();
    assert!(f.run("misbehave", "language", Some("not toml [")).unwrap_err().contains("invalid language"));
    assert_eq!(f.host.languages().iter().map(|l| l.id.to_string()).collect::<Vec<_>>(), ["zz"]);

    let theme = r##"{"id":"t1","name":"T1","kind":"light","tokens":{"--bg-app":"#fff"}}"##;
    f.run("misbehave", "theme", Some(theme)).unwrap();
    assert!(
        f.run("misbehave", "theme", Some(r#"{"id":"t2","name":"x","kind":"dark","tokens":{"--a":"url(x)"}}"#)).is_err()
    );
    let info = f.host.info_of("misbehave").unwrap();
    assert_eq!(info.languages[0].extensions, ["zz"]);
    assert_eq!(info.themes[0].kind, ThemeKind::Light);
    let active = f.host.set_theme(Some(("misbehave", "t1"))).unwrap().unwrap();
    assert_eq!(active.theme.tokens["--bg-app"], "#fff");
    assert!(f.host.set_theme(Some(("misbehave", "nope"))).is_err());
}

#[test]
fn contribution_only_plugins() {
    let f = fixture(Limits::default());
    let theme = f.host.install_from_dir(&sample("theme-solarized-dark")).unwrap();
    assert_eq!(theme.status, PluginStatus::Static);
    assert!(!theme.has_code);
    assert_eq!(theme.themes[0].id, "solarized-dark");
    let lang = f.host.install_from_dir(&sample("language-toy")).unwrap();
    assert_eq!(lang.status, PluginStatus::Static);
    assert_eq!(lang.languages[0].id, "toy");
    assert_eq!(f.host.languages()[0].block_comment, Some(("(*".into(), "*)".into())));
    assert!(f.run("language-toy", "x", None).unwrap_err().contains("no code"));

    f.take_events();
    let active = f.host.set_theme(Some(("theme-solarized-dark", "solarized-dark"))).unwrap().unwrap();
    assert_eq!(active.theme.tokens["--bg-app"], "#002b36");
    assert!(f.take_events().iter().any(|(_, e)| matches!(e, PluginEvent::ThemeChanged { theme: Some(_) })));
    assert_eq!(f.host.list(None).active_theme, Some(active));

    // Disabling the plugin withdraws its theme and language.
    f.host.set_enabled("theme-solarized-dark", false).unwrap();
    assert!(f.host.active_theme().is_none());
    assert!(f.take_events().iter().any(|(_, e)| *e == PluginEvent::ThemeChanged { theme: None }));
    f.host.set_enabled("language-toy", false).unwrap();
    assert!(f.host.languages().is_empty());
    assert_eq!(f.status("language-toy"), PluginStatus::Disabled);
}

#[test]
fn theme_template_installs_with_its_editor_scheme() {
    let f = fixture(Limits::default());
    let info = f.host.install_from_dir(&repo().join("templates/theme-plugin")).unwrap();
    assert_eq!(info.status, PluginStatus::Static);
    assert!(!info.has_code);
    assert_eq!(info.themes[0].id, "harbor-night");
    assert_eq!(info.themes[0].kind, ThemeKind::Dark);
    // The scheme file is copied with the package and merged over the UI tokens.
    assert!(f.plugins_dir.join("theme-harbor-night/themes/harbor-night.scheme.json").is_file());
    let active = f.host.set_theme(Some(("theme-harbor-night", "harbor-night"))).unwrap().unwrap();
    let tokens = &active.theme.tokens;
    assert!(
        tokens.contains_key("--bg-app") && tokens.contains_key("--syn-keyword") && tokens.contains_key("--ansi-red")
    );
    assert!(tokens.len() > 150);
}

#[test]
fn theme_with_broken_editor_scheme_fails_to_load() {
    let f = fixture(Limits::default());
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("t")).unwrap();
    std::fs::write(
        dir.path().join("plugin.toml"),
        "id = \"bad-scheme\"\nname = \"B\"\nversion = \"1.0.0\"\nopenidea-api = \"0.1\"\n\
         [[contributes.themes]]\npath = \"t/a.json\"\neditor-scheme = \"t/a.scheme.json\"\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("t/a.json"), r##"{"id":"a","name":"A","kind":"light","tokens":{}}"##).unwrap();
    std::fs::write(dir.path().join("t/a.scheme.json"), "{\n  \"tokens\": { \"--caret\": \"url(x)\" }\n}").unwrap();
    let info = f.host.install_from_dir(dir.path()).unwrap();
    assert_eq!(info.status, PluginStatus::Failed);
    assert!(info.error.unwrap_or_default().contains("a.scheme.json"));
}

#[test]
fn state_persists_across_restarts() {
    let f = fixture(Limits::default());
    f.host.install_from_dir(&sample("hello")).unwrap();
    f.host.install_from_dir(&sample("theme-solarized-dark")).unwrap();
    f.host.set_enabled("hello", false).unwrap();
    f.host.set_theme(Some(("theme-solarized-dark", "solarized-dark"))).unwrap();

    let again = PluginHost::new(f.plugins_dir.clone(), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    again.load_all();
    let list = again.list(None);
    let hello = list.plugins.iter().find(|p| p.id == "hello").unwrap();
    assert!(!hello.enabled);
    assert_eq!(hello.status, PluginStatus::Disabled);
    assert_eq!(list.active_theme.unwrap().theme.id, "solarized-dark");
    assert!(
        again
            .run_command("hello", "insert-date", None, Invocation::default())
            .unwrap_err()
            .message
            .contains("disabled")
    );
}

#[test]
fn dev_plugins_follow_the_project() {
    let f = fixture(Limits::default());
    let dev = f.project.join(DEV_PLUGINS_DIR).join("toy");
    copy_dir(&sample("language-toy"), &dev);
    f.host.sync_project(&f.project);
    let mine = f.host.list(Some(&f.project));
    assert_eq!(mine.plugins.len(), 1);
    assert_eq!(mine.plugins[0].source, PluginSource::Dev);
    assert!(f.host.list(None).plugins.is_empty(), "dev plugins only show for their project");
    assert!(f.host.uninstall("language-toy").is_err());
    assert!(f.host.install_from_dir(&sample("language-toy")).is_err(), "id clash with a dev plugin");

    // Edit + reload picks up changes.
    let manifest = dev.join("plugin.toml");
    let src = std::fs::read_to_string(&manifest).unwrap().replace("Toy Language", "Toy Language (dev)");
    std::fs::write(&manifest, src).unwrap();
    assert_eq!(f.host.reload("language-toy").unwrap().name, "Toy Language (dev)");

    std::fs::remove_dir_all(&dev).unwrap();
    f.host.sync_project(&f.project);
    assert!(f.host.list(Some(&f.project)).plugins.is_empty());
}

#[test]
fn install_validation_and_uninstall() {
    let f = fixture(Limits::default());
    let tmp = tempfile::tempdir().unwrap();

    // Missing component file.
    let pkg = tmp.path().join("broken");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(
        pkg.join("plugin.toml"),
        "id = \"b\"\nname = \"B\"\nversion = \"1.0.0\"\nopenidea-api = \"0.1\"\nwasm = \"x.wasm\"",
    )
    .unwrap();
    assert!(f.host.install_from_dir(&pkg).unwrap_err().message.contains("missing"));
    // Not a component.
    std::fs::write(pkg.join("x.wasm"), b"\0asm garbage").unwrap();
    assert!(f.host.install_from_dir(&pkg).unwrap_err().message.contains("not a valid plugin component"));
    // Bad manifest.
    std::fs::write(pkg.join("plugin.toml"), "id = \"B!\"").unwrap();
    assert!(f.host.install_from_dir(&pkg).is_err());
    assert!(f.host.list(None).plugins.is_empty(), "failed installs leave nothing behind");

    // A broken package already in the plugins dir shows up as failed.
    std::fs::create_dir_all(f.plugins_dir.join("junk")).unwrap();
    std::fs::write(f.plugins_dir.join("junk/plugin.toml"), "garbage = ").unwrap();
    f.host.load_all();
    let junk = &f.host.list(None).plugins[0];
    assert_eq!(junk.status, PluginStatus::Failed);
    assert!(junk.error.is_some());

    // Reinstall replaces; uninstall removes the directory.
    f.host.install_from_dir(&sample("hello")).unwrap();
    f.host.install_from_dir(&sample("hello")).unwrap();
    assert_eq!(f.status("hello"), PluginStatus::Active);
    f.host.uninstall("hello").unwrap();
    assert!(!f.plugins_dir.join("hello").exists());
    assert!(f.host.info_of("hello").is_err());
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if src.is_dir() { copy_dir(&src, &dst) } else { std::fs::copy(&src, &dst).map(|_| ()).unwrap() }
    }
}

#[test]
fn catalog_lists_sample_packages() {
    let tmp = tempfile::tempdir().unwrap();
    let broken = tmp.path().join("broken");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(
        broken.join("plugin.toml"),
        "id = \"x\"\nname = \"X\"\nversion = \"1.0.0\"\nopenidea-api = \"0.1\"\nwasm = \"dist/plugin.wasm\"\n",
    )
    .unwrap();
    std::fs::create_dir_all(tmp.path().join("junk")).unwrap();
    std::fs::write(tmp.path().join("junk/plugin.toml"), "garbage = ").unwrap();

    let catalog = scan_catalog(&[repo().join("plugins"), tmp.path().to_path_buf()]);
    let ids: Vec<&str> = catalog.iter().map(|c| c.id.as_str()).collect();
    for id in ["hello", "theme-solarized-dark", "language-toy", "x"] {
        assert!(ids.contains(&id), "{id} missing from {ids:?}");
    }
    let hello = catalog.iter().find(|c| c.id == "hello").unwrap();
    assert!(hello.has_code && hello.problem.is_none() && hello.change_notes.is_some());
    assert_eq!(hello.commands.len(), 2);
    let theme = catalog.iter().find(|c| c.id == "theme-solarized-dark").unwrap();
    assert_eq!((theme.theme_count, theme.has_code), (1, false));
    let x = catalog.iter().find(|c| c.id == "x").unwrap();
    assert!(x.problem.as_deref().unwrap().contains("plugin.wasm"));
}
