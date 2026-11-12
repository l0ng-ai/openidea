//! Opt-in compatibility test using a Git AI package built for this host, not a fixture.
//! All installations/storage are temporary. No GUI, production project, process or network access.
use ide_host::plugins::{Consent, PluginHost, PluginStatus, PluginWorkspace};
use ide_plugin::{HostError, Invocation, Limits};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// No open projects means activate cannot post a bridge session event. An ungranted
/// server hostname makes the plugin's update check fail at the real capability gate.
struct OfflineWorkspace;
impl PluginWorkspace for OfflineWorkspace {
    fn projects(&self) -> Vec<PathBuf> {
        Vec::new()
    }
    fn buffer_text(&self, _: &Path) -> Option<String> {
        None
    }
    fn document(&self, _: &Path) -> Option<(u64, String)> {
        None
    }
    fn apply_edits(&self, _: &Path, _: u64, _: &[ide_core::TextEdit], _: bool) -> Result<u64, HostError> {
        Err(HostError::Denied("no project in ABI test".into()))
    }
    fn trusted(&self, _: &Path) -> bool {
        false
    }
    fn project_of(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn publish_diagnostics(&self, _: &str, _: &Path, _: Vec<ide_core::Diagnostic>) -> Result<(), HostError> {
        Err(HostError::Denied("no project in ABI test".into()))
    }
    fn plugin_settings(&self, _: &str, _: Option<&Path>) -> serde_json::Map<String, serde_json::Value> {
        serde_json::from_value(serde_json::json!({"serverUrl": "https://abi-test.invalid"})).unwrap()
    }
}

#[test]
#[ignore = "requires an existing Git AI package; run with GITAI_PLUGIN_PACKAGE set"]
fn released_gitai_instantiates_and_renders_in_reference_host() {
    let package = PathBuf::from(std::env::var_os("GITAI_PLUGIN_PACKAGE").expect("set GITAI_PLUGIN_PACKAGE"));
    let tmp = tempfile::tempdir().unwrap();
    let host =
        PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    host.set_workspace(Some(Arc::new(OfflineWorkspace)));
    host.set_program_path(Arc::new(|| Some(std::ffi::OsString::new())));
    host.load_all();
    // Do not announce startup before installation: install/check alone is NOT instantiation proof.
    let info = host.install_from_dir(&package, &Consent::all()).expect("released WASM must link against this host");
    assert_eq!(info.id, "cvte.git-ai-enterprise");
    assert_eq!(info.status, PluginStatus::Inactive);
    let view = host
        .render_view(&info.id, "conversation", None, Invocation::default())
        .expect("released WASM must instantiate, activate and render through the real PluginHost");
    assert!(
        view.toolbar.iter().any(|button| button.id == "refresh"),
        "expected the existing conversation view: {view:?}"
    );
    assert_eq!(host.info_of(&info.id).unwrap().status, PluginStatus::Active);
    println!("GITAI_ABI_ACCEPTED: real PluginHost install + activate + render");
}

/// The release scenario: a real repository, a project workspace, the packaged
/// 1.8.x plugin and a `file-opened` event must publish decorations and gutter
/// markers through the actual host.
#[cfg(unix)]
#[test]
#[ignore = "requires an existing Git AI package and git; run with GITAI_PLUGIN_PACKAGE set"]
fn released_gitai_publishes_labels_and_markers_for_an_open_file() {
    use ide_host::plugins::{PluginEditor, WorkbenchEvent};
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    struct Repo {
        root: PathBuf,
        file: PathBuf,
        text: String,
    }
    impl PluginWorkspace for Repo {
        fn projects(&self) -> Vec<PathBuf> {
            vec![self.root.clone()]
        }
        fn buffer_text(&self, path: &Path) -> Option<String> {
            (path == self.file).then(|| self.text.clone())
        }
        fn document(&self, path: &Path) -> Option<(u64, String)> {
            (path == self.file).then(|| (1, self.text.clone()))
        }
        fn apply_edits(&self, _: &Path, _: u64, _: &[ide_core::TextEdit], _: bool) -> Result<u64, HostError> {
            Err(HostError::Denied("read-only ABI workspace".into()))
        }
        fn trusted(&self, _: &Path) -> bool {
            true
        }
        fn project_of(&self, _window: &str) -> Option<PathBuf> {
            Some(self.root.clone())
        }
        fn publish_diagnostics(&self, _: &str, _: &Path, _: Vec<ide_core::Diagnostic>) -> Result<(), HostError> {
            Ok(())
        }
        fn plugin_settings(&self, _: &str, _: Option<&Path>) -> serde_json::Map<String, serde_json::Value> {
            // An ungranted host: the activation-time update check is denied at once.
            serde_json::from_value(serde_json::json!({"serverUrl": "https://abi-test.invalid"})).unwrap()
        }
    }

    let package = PathBuf::from(std::env::var_os("GITAI_PLUGIN_PACKAGE").expect("set GITAI_PLUGIN_PACKAGE"));
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("a.rs");
    std::fs::write(&file, "alpha\nbeta\n").unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .current_dir(&root)
            .args(["-c", "user.name=ABI", "-c", "user.email=abi@example.invalid"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q"]);
    git(&["add", "a.rs"]);
    git(&["commit", "-q", "-m", "init"]);

    let bin = tmp.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let script = bin.join("git-ai");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         if [ \"$1\" = version ]; then echo 1.8.2; exit 0; fi\n\
         if [ \"$1\" = blame ]; then cat >/dev/null; \
         printf '%s' '{\"lines\":{\"1\":\"p1\",\"2\":\"p1\"},\"prompts\":{\"p1\":{\"agent_id\":{\"tool\":\"claude\",\"model\":\"opus\"},\"messages\":[]}}}'; exit 0; fi\n\
         if [ \"$1\" = show-prompt ]; then \
         printf '%s' '{\"prompt_id\":\"p1\",\"prompt\":{\"messages\":[{\"type\":\"user\",\"text\":\"the real conversation\"}]}}'; exit 0; fi\n\
         exit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let bin_path = bin.clone();

    let host =
        PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap();
    host.set_workspace(Some(Arc::new(Repo { root: root.clone(), file: file.clone(), text: "alpha\nbeta\n".into() })));
    host.set_program_path(Arc::new(move || Some(bin_path.clone().into_os_string())));
    host.load_all();
    let info = host.install_from_dir(&package, &Consent::all()).expect("package installs");
    assert_eq!(info.id, "cvte.git-ai-enterprise");

    let path = file.to_string_lossy().into_owned();
    host.post_window_events(
        "main",
        vec![WorkbenchEvent::FileOpened(path.clone())],
        Some(PluginEditor {
            path: path.clone(),
            language: "rust".into(),
            selections: vec![ide_core::Range::new(ide_core::Pos::new(0, 0), ide_core::Pos::new(0, 0))],
        }),
    );
    host.flush_events_at(Instant::now() + Duration::from_secs(5));
    assert!(host.wait_events(Duration::from_secs(20)), "event batch did not finish");

    let live = host.info_of(&info.id).unwrap();
    assert_eq!(live.status, PluginStatus::Active, "{live:?}");
    let sets = host.decoration_sets();
    eprintln!("decoration sets: {sets:#?}");
    let canonical = dunce::canonicalize(&file).unwrap();
    let items = sets
        .get(&info.id)
        .and_then(|sets| sets.iter().find(|set| set.path.0 == canonical))
        .map(|set| set.items.as_slice())
        .unwrap_or_default();
    assert!(!items.is_empty(), "file-opened must publish line-end labels");
    assert_eq!(items[0].after.as_deref(), Some(" + AI opus"));
    assert!(
        items[0].markdown_hover.as_deref().is_some_and(|markdown| markdown.contains("the real conversation")),
        "the label carries the loaded conversation Markdown: {items:?}"
    );
    assert_eq!(items[0].range.start.line, 0, "the opened editor's caret line is labelled");

    // Focusing a tab carries its caret: line mode must move the label rather
    // than expand it to every attributed line.
    host.set_active_file(
        "main",
        Some(path.clone()),
        Some(PluginEditor {
            path: path.clone(),
            language: "rust".into(),
            selections: vec![ide_core::Range::new(ide_core::Pos::new(1, 0), ide_core::Pos::new(1, 0))],
        }),
    );
    host.flush_events_at(Instant::now() + Duration::from_secs(5));
    assert!(host.wait_events(Duration::from_secs(20)), "focus batch did not finish");
    let sets = host.decoration_sets();
    let items = sets
        .get(&info.id)
        .and_then(|sets| sets.iter().find(|set| set.path.0 == canonical))
        .map(|set| set.items.as_slice())
        .unwrap_or_default();
    assert_eq!(items.len(), 1, "line mode labels only the focused line: {items:?}");
    assert_eq!(items[0].range.start.line, 1, "the focused caret line is labelled");

    // A caret event moves the label with the caret, without a new CLI run.
    host.post_window_events(
        "main",
        vec![WorkbenchEvent::CaretMoved(ide_host::plugins::CaretMoved { path: path.clone(), line: 0, col: 0 })],
        Some(PluginEditor {
            path: path.clone(),
            language: "rust".into(),
            selections: vec![ide_core::Range::new(ide_core::Pos::new(0, 0), ide_core::Pos::new(0, 0))],
        }),
    );
    host.flush_events_at(Instant::now() + Duration::from_secs(5));
    assert!(host.wait_events(Duration::from_secs(20)), "caret batch did not finish");
    let sets = host.decoration_sets();
    let items = sets
        .get(&info.id)
        .and_then(|sets| sets.iter().find(|set| set.path.0 == canonical))
        .map(|set| set.items.as_slice())
        .unwrap_or_default();
    assert_eq!(items.len(), 1, "caret-moved keeps one label: {items:?}");
    assert_eq!(items[0].range.start.line, 0, "the label follows the caret");

    let doc = ide_plugin::ProviderDocument {
        path: file.clone(),
        language: "rust".into(),
        version: 1,
        text: "alpha\nbeta\n".into(),
    };
    assert!(!host.provide_line_markers(&doc).is_empty(), "the gutter markers keep working");
    println!("GITAI_DECORATIONS_ACCEPTED: labels + Markdown hover + gutter markers");
}
