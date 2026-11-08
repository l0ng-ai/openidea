use ide_core::{CancellationToken, Diagnostic, Pos, Range, Severity};
use ide_host::plugins::{HostWorkspace, PluginWorkspace};
use ide_host::{Host, HostConfig};
use ide_plugin::TextQuery;
use std::path::PathBuf;
use std::sync::Arc;

struct Harness {
    host: Arc<Host>,
    root: PathBuf,
    _tmp: tempfile::TempDir,
}
impl Harness {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let host = Arc::new(Host::new(HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            local_data_dir: tmp.path().join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        host.open_project("main", &root).unwrap();
        host.open_project("second", &root).unwrap();
        Self { host, root, _tmp: tmp }
    }
    fn workspace(&self) -> HostWorkspace {
        HostWorkspace(Arc::downgrade(&self.host))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn window_editor_reports_use_document_language_dirty_state_and_focus() {
    let f = Harness::new();
    let path = f.root.join("main.rs");
    std::fs::write(&path, "fn main() {}\n").unwrap();
    let p = f.host.project("main").unwrap();
    let doc = p.documents.open(&path).unwrap();
    p.documents
        .apply_edits(doc.id, &[ide_core::TextEdit { range: Range::default(), new_text: "// unsaved\n".into() }])
        .unwrap();
    f.host.mcp_reports.set_open_editors("main", vec![path.clone()]);
    f.host.mcp_reports.set_focused_editor(
        "main",
        Some(ide_host::mcp::FocusedEditor {
            path: path.clone().into(),
            selection: Range::default(),
            selected_text: String::new(),
        }),
        true,
    );
    let workspace = f.workspace();
    let editors = workspace.open_editors("main").unwrap();
    assert_eq!(editors.len(), 1);
    assert!(editors[0].dirty && editors[0].active);
    assert_eq!(editors[0].language, "rust");
    assert!(workspace.open_editors("second").unwrap().is_empty());
    let second = f.host.project("second").unwrap();
    second.documents.open(&path).unwrap();
    f.host.mcp_reports.set_open_editors("second", vec![path.clone()]);
    assert!(!workspace.open_editors("second").unwrap()[0].dirty);
    assert!(workspace.open_editors("main").unwrap()[0].dirty);
    assert!(workspace.buffer_text_in(Some("main"), &path).unwrap().contains("unsaved"));
    assert!(!workspace.buffer_text_in(Some("second"), &path).unwrap().contains("unsaved"));
    assert_ne!(workspace.document_in("main", &path), workspace.document_in("second", &path));
    f.host.mcp_reports.forget_window("main");
    assert!(workspace.open_editors("main").unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn text_search_uses_overlay_excludes_utf16_and_limits() {
    let f = Harness::new();
    let path = f.root.join("a.txt");
    std::fs::write(&path, "disk\n").unwrap();
    std::fs::create_dir(f.root.join("target")).unwrap();
    std::fs::write(f.root.join("target/ignored.txt"), "needle").unwrap();
    let p = f.host.project("main").unwrap();
    p.settings
        .set(ide_workspace::settings::SettingsScope::Project, "files.ignoredNames", serde_json::json!(["target"]))
        .unwrap();
    let doc = p.documents.open(&path).unwrap();
    p.documents
        .apply_edits(doc.id, &[ide_core::TextEdit { range: Range::default(), new_text: "😀needle\nneedle\n".into() }])
        .unwrap();
    f.host.project("second").unwrap().documents.open(&path).unwrap();
    let workspace = f.workspace();
    let query = TextQuery { pattern: "needle".into(), case_sensitive: true, ..Default::default() };
    let found = workspace.search_text(Some("main"), &f.root, query.clone(), 10, &CancellationToken::new()).unwrap();
    assert_eq!(found.matches.len(), 2, "{found:?}; text={:?}", workspace.buffer_text(&path));
    assert_eq!(found.matches[0].location.range, Range::new(Pos::new(0, 2), Pos::new(0, 8)));
    assert!(found.matches.iter().all(|m| m.location.path == path));
    let only_file = TextQuery { include: vec!["a.txt".into()], ..query.clone() };
    assert!(
        workspace
            .search_text(Some("second"), &f.root, only_file, 10, &CancellationToken::new())
            .unwrap()
            .matches
            .is_empty()
    );
    let capped = workspace.search_text(Some("main"), &f.root, query.clone(), 1, &CancellationToken::new()).unwrap();
    assert_eq!(capped.matches.len(), 1);
    assert!(capped.limit_hit);
    let excluded = TextQuery { exclude: vec!["*.txt".into()], ..query.clone() };
    assert!(
        workspace
            .search_text(Some("main"), &f.root, excluded, 10, &CancellationToken::new())
            .unwrap()
            .matches
            .is_empty()
    );
    for query in [
        TextQuery { pattern: "NEEDLE".into(), case_sensitive: true, ..Default::default() },
        TextQuery { pattern: "need".into(), whole_word: true, ..Default::default() },
        TextQuery { include: vec!["*.rs".into()], ..query.clone() },
    ] {
        assert!(
            workspace
                .search_text(Some("main"), &f.root, query, 10, &CancellationToken::new())
                .unwrap()
                .matches
                .is_empty()
        );
    }
    let multiline = TextQuery { pattern: "needle\nneedle".into(), regex: true, ..Default::default() };
    let found = workspace.search_text(Some("main"), &f.root, multiline, 10, &CancellationToken::new()).unwrap();
    assert_eq!(found.matches[0].location.range, Range::new(Pos::new(0, 2), Pos::new(1, 6)));
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        workspace.search_text(Some("main"), &f.root, query, 10, &cancelled),
        Err(ide_plugin::HostError::Cancelled)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn problems_share_project_reports_and_keep_sources_separate() {
    let f = Harness::new();
    let path = f.root.join("a.txt");
    std::fs::write(&path, "text").unwrap();
    let diagnostic = |source: &str| Diagnostic {
        range: Range::default(),
        severity: Severity::Warning,
        message: source.into(),
        source: Some(source.into()),
        code: None,
        unnecessary: false,
        deprecated: false,
        server: None,
    };
    f.host.mcp_reports.report_problems(
        "second",
        true,
        vec![ide_host::mcp::FileProblems {
            path: path.clone().into(),
            items: vec![diagnostic("lsp"), diagnostic("plugin")],
        }],
    );
    let workspace = f.workspace();
    let files = workspace.problems("main", Some(&path)).unwrap();
    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|f| f.diagnostics.len() == 1));
    assert!(workspace.problems("main", Some(&f.root.join("other.txt"))).unwrap().is_empty());
    f.host.mcp_reports.forget_window("second");
    assert!(workspace.problems("main", None).unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn search_decodes_closed_documents_the_same_way_as_the_editor() {
    let f = Harness::new();
    let path = f.root.join("utf16.txt");
    let mut bytes = vec![0xff, 0xfe];
    for unit in "😀needle\r\n".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(&path, bytes).unwrap();
    let query = TextQuery { pattern: "needle".into(), ..Default::default() };
    let result = f.workspace().search_text(Some("main"), &f.root, query, 10, &CancellationToken::new()).unwrap();
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].location.range, Range::new(Pos::new(0, 2), Pos::new(0, 8)));
    assert_eq!(result.matches[0].line, "😀needle");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn plugin_debug_uses_the_source_language_and_revalidates_its_owned_program() {
    use ide_host::plugins::{Consent, PluginEvent, PluginHost, WindowRequest};
    use ide_plugin::{Invocation, Limits};
    let f = Harness::new();
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    std::fs::write(f.root.join("execution.marker"), "").unwrap();
    std::fs::write(f.root.join("entry.py"), "print('test')\n").unwrap();
    let events = Arc::new(parking_lot::Mutex::new(Vec::new()));
    let captured = events.clone();
    let plugins = Arc::new(
        PluginHost::new(
            f._tmp.path().join("plugins"),
            Arc::new(move |client: Option<&str>, event: PluginEvent| {
                captured.lock().push((client.map(str::to_owned), event))
            }),
            Limits::default(),
        )
        .unwrap(),
    );
    plugins.set_workspace(Some(Arc::new(f.workspace())));
    f.host.set_plugin_host(&plugins);
    let package = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/execution");
    plugins.install_from_dir(&package, &Consent::all()).unwrap();
    plugins
        .choose_program("execution", "process:execution-tool", Some(&f.root), Some(std::path::Path::new("/bin/cat")))
        .unwrap();
    let mut config =
        plugins.run_detection().detect(&f.root).into_iter().find(|c| c.id == "plugin:execution:detected").unwrap();
    config.args = vec!["entry.py".into()];
    ide_run::save_user_configs(&f.root, &[config]).unwrap();
    let config = f.workspace().run_configuration("main", "execution", "detected").unwrap();
    assert_eq!(config.debug_adapter.as_deref(), Some("debugpy"));
    let pinned = plugins.program_for_project("execution", "execution-tool", Some(&f.root)).unwrap();
    assert_eq!(plugins.prepare_debug_run("main", config.clone()).unwrap().command, pinned.to_string_lossy());
    let invocation =
        Invocation { client: Some("main".into()), workspace_root: Some(f.root.clone()), ..Default::default() };
    assert!(plugins.run_command("execution", "debug", None, invocation).unwrap().is_some());
    assert!(events.lock().iter().any(|(client, event)| client.as_deref() == Some("main") && matches!(event, PluginEvent::WindowRequest { request: WindowRequest::Run { config, debug: true, .. }, .. } if config.command == pinned.to_string_lossy())));
    plugins.set_capability("execution", "process:execution-tool", false).unwrap();
    assert!(plugins.prepare_debug_run("main", config).is_err());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn plugin_run_targets_register_prompt_route_revalidate_and_withdraw() {
    use ide_host::plugins::{Consent, PluginEvent, PluginHost, run_targets};
    use ide_plugin::{Invocation, Limits};
    use std::os::unix::fs::PermissionsExt;
    let f = Harness::new();
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    let plugins = Arc::new(
        PluginHost::new(
            f._tmp.path().join("plugins"),
            Arc::new(|_: Option<&str>, _: PluginEvent| {}),
            Limits { idle_timeout: Some(std::time::Duration::from_millis(10)), ..Default::default() },
        )
        .unwrap(),
    );
    plugins.set_workspace(Some(Arc::new(f.workspace())));
    f.host.set_plugin_host(&plugins);
    let package = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/execution");
    plugins.install_from_dir(&package, &Consent::all()).unwrap();
    let tool = f._tmp.path().join("wrapper");
    std::fs::write(&tool, "#!/bin/sh\nprintf 'cwd=%s\\n' \"$PWD\"\nprintf '<%s>\\n' \"$@\"\n").unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    let invocation =
        || Invocation { client: Some("main".into()), workspace_root: Some(f.root.clone()), ..Default::default() };
    assert!(plugins.run_command("execution", "target", None, invocation()).is_err());
    plugins.choose_program("execution", "process:execution-tool", Some(&f.root), Some(&tool)).unwrap();
    plugins.run_command("execution", "target", None, invocation()).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    plugins.tick_at(std::time::Instant::now());
    assert_eq!(plugins.info_of("execution").unwrap().status, ide_host::plugins::PluginStatus::Inactive);
    let targets = run_targets::list(&f.host, &plugins, "main").unwrap();
    assert_eq!(targets.len(), 1);
    assert!(targets[0].prompt);
    assert!(f.host.project("main").unwrap().settings.effective().run.default_target.is_empty());
    let id = &targets[0].id;
    let settings = run_targets::answer(&f.host, &plugins, "main", id, false).unwrap();
    assert!(settings.run.default_target.is_empty());
    // A stale prompt in a second window cannot change an answered selection.
    assert!(run_targets::answer(&f.host, &plugins, "second", id, true).unwrap().run.default_target.is_empty());
    plugins.run_command("execution", "untarget", None, invocation()).unwrap();
    assert!(plugins.run_targets(&f.root).is_empty());
    plugins.run_command("execution", "target", None, invocation()).unwrap();
    assert!(!plugins.run_targets(&f.root)[0].prompt);
    plugins.run_command("execution", "target", Some("preferred"), invocation()).unwrap();
    let preferred = plugins.run_targets(&f.root).into_iter().find(|t| t.target.id == "preferred").unwrap();
    let settings = run_targets::answer(&f.host, &plugins, "main", &preferred.id, true).unwrap();
    assert_eq!(settings.run.default_target, preferred.id);
    assert_eq!(settings.languages.php.run_target, preferred.id);
    assert_eq!(settings.languages.node.run_target, preferred.id);
    assert_eq!(f.host.project("second").unwrap().settings.effective().run.default_target, preferred.id);
    std::fs::write(f.root.join("execution.marker"), "").unwrap();
    std::fs::write(f.root.join("entry.py"), "print('test')\n").unwrap();
    let mut detected =
        plugins.run_detection().detect(&f.root).into_iter().find(|c| c.id == "plugin:execution:detected").unwrap();
    detected.args = vec!["entry.py".into()];
    ide_run::save_user_configs(&f.root, &[detected]).unwrap();
    let mut debug = f.workspace().run_configuration("main", "execution", "detected").unwrap();
    debug.extras.target = None;
    let error = plugins.prepare_debug_run("main", debug).unwrap_err();
    assert_eq!(error.kind, ide_core::error::ErrorKind::InvalidInput);
    assert!(error.to_string().contains("target"));
    assert!(plugins.run_command("execution", "debug", None, invocation()).unwrap_err().to_string().contains("target"));
    let output = Arc::new(parking_lot::Mutex::new(String::new()));
    let captured = output.clone();
    let config = ide_run::RunConfig {
        id: "php-target".into(),
        name: "PHP target".into(),
        kind: "php".into(),
        command: "php".into(),
        args: vec!["x.php".into(), "a b; $(touch forbidden)".into()],
        cwd: None,
        env: Default::default(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let run = ide_host::ops::run::start(
        &f.host,
        "main",
        config.clone(),
        Arc::new(move |chunk| {
            if let ide_run::OutputChunk::Stdout { text } = chunk {
                captured.lock().push_str(&text);
            }
        }),
    )
    .await
    .unwrap();
    for _ in 0..100 {
        if f.host.processes.list().iter().any(|r| r.id == run.id && !r.running) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let text = output.lock().clone();
    assert!(text.contains("<wrapped>\n<--cwd=/container>\n<php>\n<x.php>\n<a b; $(touch forbidden)>"), "{text}");
    assert!(text.contains(&format!("cwd={}", f.root.display())), "{text}");
    assert!(!f.root.join("forbidden").exists());
    // Pin checks are repeated at launch, not only at registration.
    std::fs::write(&tool, "#!/bin/sh\nexit 99\n").unwrap();
    assert!(ide_host::ops::run::start(&f.host, "main", config.clone(), Arc::new(|_| {})).await.is_err());
    plugins.set_capability("execution", "process:execution-tool", false).unwrap();
    assert!(plugins.run_targets(&f.root).is_empty());
    assert!(ide_host::ops::run::start(&f.host, "main", config, Arc::new(|_| {})).await.is_err());
    plugins.choose_program("execution", "process:execution-tool", Some(&f.root), Some(&tool)).unwrap();
    plugins.run_command("execution", "target", None, invocation()).unwrap();
    f.host.set_project_trust(&f.root, false, false).await.unwrap();
    assert!(plugins.run_targets(&f.root).is_empty());
    assert!(
        plugins.run_command("execution", "target", None, invocation()).unwrap_err().to_string().contains("trusted")
    );
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    plugins.run_command("execution", "target", None, invocation()).unwrap();
    f.host.close_project_detached("main");
    assert_eq!(plugins.run_targets(&f.root).len(), 1);
    f.host.close_project_detached("second");
    assert!(plugins.run_targets(&f.root).is_empty());
    plugins.shutdown();
}
