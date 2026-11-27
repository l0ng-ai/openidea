mod common;

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
            local_data_dir: tmp.path().join("local"),
            ..common::host_config(tmp.path())
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
async fn problems_come_from_the_host_snapshot_whatever_window_published_them() {
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
    // Producers publish per (file, producer) through the event sink, like the
    // language servers and the spelling check do.
    let publish = |host: &Host, source: &str, items: Vec<Diagnostic>| {
        host.project("main").unwrap().sink.emit(ide_core::IdeEvent::Diagnostics {
            path: path.clone().into(),
            source: source.into(),
            items,
        });
    };
    publish(&f.host, "rust-analyzer", vec![diagnostic("lsp")]);
    publish(&f.host, "build", vec![diagnostic("plugin")]);
    // A file outside the window's project is visible too: annotations follow the file.
    let outside = f.host.diagnostics.problems().len();
    let workspace = f.workspace();
    let files = workspace.problems("main", Some(&path)).unwrap();
    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|f| f.diagnostics.len() == 1));
    assert!(workspace.problems("main", Some(&f.root.join("other.txt"))).unwrap().is_empty());
    assert_eq!(outside, 2);
    // A full replacement per producer clears only that producer.
    publish(&f.host, "rust-analyzer", vec![]);
    let files = workspace.problems("main", None).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].source, "build");
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
    let tool = f.root.with_file_name("wrapper");
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
    let run = ide_host::ops::run::run_start(
        &f.host,
        "main",
        config.clone(),
        ide_host::ops::Channel::new(move |chunk| {
            if let ide_run::OutputChunk::Stdout { text } = chunk {
                captured.lock().push_str(&text);
            }
        }),
        None,
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
    assert!(
        ide_host::ops::run::run_start(&f.host, "main", config.clone(), ide_host::ops::Channel::new(|_| {}), None)
            .await
            .is_err()
    );
    plugins.set_capability("execution", "process:execution-tool", false).unwrap();
    assert!(plugins.run_targets(&f.root).is_empty());
    assert!(
        ide_host::ops::run::run_start(&f.host, "main", config, ide_host::ops::Channel::new(|_| {}), None)
            .await
            .is_err()
    );
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

#[tokio::test(flavor = "multi_thread")]
async fn plugin_run_output_mode_precedence_and_disallowed_combinations() {
    use ide_host::plugins::{Consent, PluginEvent, PluginHost, WindowRequest};
    use ide_plugin::{Invocation, Limits};

    let f = Harness::new();
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    std::fs::write(f.root.join("execution-output.marker"), "").unwrap();

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

    let package = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/execution-output");
    plugins.install_from_dir(&package, &Consent::all()).unwrap();
    let exe = std::env::current_exe().unwrap();
    plugins.choose_program("test.execution-output", "process:execution-tool", Some(&f.root), Some(&exe)).unwrap();

    plugins.refresh_run_configurations(&f.root);
    let detected = plugins.run_detection().detect(&f.root);
    let by_id =
        |id: &str| detected.iter().find(|c| c.id == format!("plugin:test.execution-output:{id}")).unwrap().clone();
    assert!(by_id("detector-pty").extras.emulate_terminal);
    assert!(!by_id("detector-pipes").extras.emulate_terminal);
    assert!(by_id("pty-default").extras.emulate_terminal);
    assert!(!by_id("pipes-default").extras.emulate_terminal);
    assert!(!by_id("test-pipes").extras.emulate_terminal);

    let invoke = |cmd: &str, arg: &str| {
        events.lock().clear();
        let inv =
            Invocation { client: Some("main".into()), workspace_root: Some(f.root.clone()), ..Default::default() };
        let res = plugins.run_command("test.execution-output", cmd, Some(arg), inv);
        let req = events.lock().iter().find_map(|(client, event)| match event {
            PluginEvent::WindowRequest { request: WindowRequest::Run { config, debug, .. }, .. } => {
                assert_eq!(client.as_deref(), Some("main"));
                Some((config.as_ref().clone(), *debug))
            }
            _ => None,
        });
        (res, req)
    };

    // 1. Plugin default applies when invocation passes None (including legacy `run.start`).
    let (res, req) = invoke("start", "pty-default|default|run");
    assert!(res.is_ok());
    assert!(req.unwrap().0.extras.emulate_terminal);
    let (res, req) = invoke("start-legacy", "pty-default");
    assert!(res.is_ok());
    assert!(req.unwrap().0.extras.emulate_terminal);
    let (res, req) = invoke("start", "pipes-default|default|run");
    assert!(res.is_ok());
    assert!(!req.unwrap().0.extras.emulate_terminal);

    // 2. Per-invocation override wins over plugin default.
    let (res, req) = invoke("start", "pty-default|pipes|run");
    assert!(res.is_ok());
    assert!(!req.unwrap().0.extras.emulate_terminal);
    let (res, req) = invoke("start", "pipes-default|pty|run");
    assert!(res.is_ok());
    assert!(req.unwrap().0.extras.emulate_terminal);

    // 3. Disallowed combinations: debug + pty, test + pty, stdin_file + pty, remote target + pty.
    let (res, req) = invoke("start", "pty-default|pty|debug");
    assert!(res.unwrap_err().message.contains("debugging"));
    assert!(req.is_none());
    // Debug without explicit Pty keeps debugging working with pipes.
    let (res, req) = invoke("start", "pty-default|default|debug");
    assert!(res.is_ok());
    let (cfg, debug) = req.unwrap();
    assert!(debug && !cfg.extras.emulate_terminal);

    let (res, req) = invoke("start", "test-pipes|pty|run");
    assert!(res.unwrap_err().message.contains("test"));
    assert!(req.is_none());

    // Redirected stdin rejects PTY, whereas a user-saved Pipes override with stdin_file runs cleanly.
    let mut stdin_pty = by_id("pty-default");
    stdin_pty.extras.stdin_file = Some("input.txt".into());
    ide_run::save_user_configs(&f.root, &[stdin_pty]).unwrap();
    let (res, req) = invoke("start", "pty-default|default|run");
    assert!(res.unwrap_err().message.contains("redirected"));
    assert!(req.is_none());

    let mut stdin_pipes = by_id("pipes-default");
    stdin_pipes.extras.stdin_file = Some("input.txt".into());
    ide_run::save_user_configs(&f.root, &[stdin_pipes]).unwrap();
    let (res, req) = invoke("start", "pipes-default|pty|run");
    assert!(res.is_ok());
    assert!(!req.unwrap().0.extras.emulate_terminal);

    // Remote run target rejects PTY.
    let mut remote_pty = by_id("pty-default");
    remote_pty.extras.target = Some("ssh:prod".into());
    ide_run::save_user_configs(&f.root, &[remote_pty]).unwrap();
    let (res, req) = invoke("start", "pty-default|default|run");
    assert!(res.unwrap_err().message.contains("target"));
    assert!(req.is_none());

    // 4. User-saved output-mode override wins over both invocation and plugin default.
    let mut user_pipes = by_id("pty-default");
    user_pipes.extras.emulate_terminal = false;
    let mut user_pty = by_id("pipes-default");
    user_pty.extras.emulate_terminal = true;
    ide_run::save_user_configs(&f.root, &[user_pipes, user_pty]).unwrap();

    let (res, req) = invoke("start", "pty-default|pty|run");
    assert!(res.is_ok());
    assert!(!req.unwrap().0.extras.emulate_terminal);

    let (res, req) = invoke("start", "pipes-default|pipes|run");
    assert!(res.is_ok());
    assert!(req.unwrap().0.extras.emulate_terminal);

    // 5. Removing user overrides restores plugin default behavior; untrusted projects refuse launches.
    ide_run::save_user_configs(&f.root, &[]).unwrap();
    let (res, req) = invoke("start", "pty-default|default|run");
    assert!(res.is_ok());
    assert!(req.unwrap().0.extras.emulate_terminal);

    f.host.set_project_trust(&f.root, false, false).await.unwrap();
    assert!(invoke("start", "pty-default|default|run").0.is_err());

    plugins.shutdown();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn plugin_run_output_mode_executes_pty_and_pipes_with_input_exit_and_stop() {
    use ide_host::plugins::{Consent, PluginEvent, PluginHost, WindowRequest};
    use ide_plugin::{Invocation, Limits};
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;

    let f = Harness::new();
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    std::fs::write(f.root.join("execution-output.marker"), "").unwrap();

    let tool = f.root.with_file_name("exec-output-tool");
    std::fs::write(
        &tool,
        "#!/bin/sh\n\
         if [ \"$1\" = \"wait\" ]; then\n\
           read line\n\
           printf 'out:%s\\n' \"$line\"\n\
           printf 'err:%s\\n' \"$line\" >&2\n\
           exit 7\n\
         fi\n\
         if [ \"$1\" = \"hang\" ]; then\n\
           trap 'exit 0' INT TERM\n\
           printf 'ready\\n'\n\
           while true; do sleep 0.1; done\n\
         fi\n\
         printf 'out-line\\n'\n\
         printf 'err-line\\n' >&2\n\
         exit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();

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

    let package = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/execution-output");
    plugins.install_from_dir(&package, &Consent::all()).unwrap();
    plugins.choose_program("test.execution-output", "process:execution-tool", Some(&f.root), Some(&tool)).unwrap();
    plugins.refresh_run_configurations(&f.root);

    let launch_and_collect = |arg: &str, stdin: Option<&str>, stop_after_ready: bool| {
        let host = f.host.clone();
        let plugins = plugins.clone();
        let events = events.clone();
        let root = f.root.clone();
        let arg = arg.to_owned();
        let stdin = stdin.map(str::to_owned);
        async move {
            events.lock().clear();
            let inv = Invocation { client: Some("main".into()), workspace_root: Some(root), ..Default::default() };
            let op_id = plugins.run_command("test.execution-output", "start", Some(&arg), inv).unwrap().unwrap();
            let config = events
                .lock()
                .iter()
                .find_map(|(_, event)| match event {
                    PluginEvent::WindowRequest { request: WindowRequest::Run { config, .. }, .. } => {
                        Some(config.as_ref().clone())
                    }
                    _ => None,
                })
                .unwrap();
            let chunks = Arc::new(parking_lot::Mutex::new(Vec::<ide_run::OutputChunk>::new()));
            let out_chunks = chunks.clone();
            let info = ide_host::ops::run::run_start(
                &host,
                "main",
                config,
                ide_host::ops::Channel::new(move |c| out_chunks.lock().push(c)),
                None,
            )
            .await
            .unwrap();
            if let Some(data) = stdin {
                ide_host::ops::run::run_stdin(&host, info.id, data).unwrap();
            }
            if stop_after_ready {
                for _ in 0..100 {
                    if chunks
                        .lock()
                        .iter()
                        .any(|c| matches!(c, ide_run::OutputChunk::Stdout { text } if text.contains("ready")))
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                ide_host::ops::run::run_stop(&host, "main", info.id).unwrap();
            }
            for _ in 0..150 {
                if host.processes.list().iter().any(|r| r.id == info.id && !r.running) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let exit = host.processes.exit_code(info.id).unwrap();
            let collected = chunks.lock().clone();
            (op_id, info, exit, collected)
        }
    };

    // PTY run: combined stdout/stderr on stdout stream, stdin works, exit status 7 delivered.

    // Default PTY run (`args: ["pty", "extra"]`): stdout and stderr arrive combined as Stdout chunks.
    let (_op, info, exit, chunks) = launch_and_collect("pty-default|default|run", None, false).await;
    assert!(info.pty);
    assert_eq!(exit, Some(Some(0)));
    let pty_stdout: String = chunks
        .iter()
        .filter_map(|c| match c {
            ide_run::OutputChunk::Stdout { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let pty_stderr: String = chunks
        .iter()
        .filter_map(|c| match c {
            ide_run::OutputChunk::Stderr { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(pty_stdout.contains("out-line") && pty_stdout.contains("err-line"), "{pty_stdout:?}");
    assert!(pty_stderr.is_empty(), "ordinary PTYs combine stdout and stderr: {pty_stderr:?}");

    // Piped run (`args: ["pipes", "extra"]`): stdout and stderr stay separate.
    let (_op, info, exit, chunks) = launch_and_collect("pipes-default|default|run", None, false).await;
    assert!(!info.pty);
    assert_eq!(exit, Some(Some(0)));
    let pipe_stdout: String = chunks
        .iter()
        .filter_map(|c| match c {
            ide_run::OutputChunk::Stdout { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let pipe_stderr: String = chunks
        .iter()
        .filter_map(|c| match c {
            ide_run::OutputChunk::Stderr { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(pipe_stdout.contains("out-line"), "{pipe_stdout:?}");
    assert!(pipe_stderr.contains("err-line"), "{pipe_stderr:?}");

    // Interactive PTY run with input + non-zero exit code + run-exited event.
    let mut wait_cfg = plugins
        .run_detection()
        .detect(&f.root)
        .into_iter()
        .find(|c| c.id == "plugin:test.execution-output:pty-default")
        .unwrap();
    wait_cfg.args = vec!["wait".into()];
    ide_run::save_user_configs(&f.root, &[wait_cfg]).unwrap();
    let (op_wait, info, exit, chunks) = launch_and_collect("pty-default|default|run", Some("hi\n"), false).await;
    assert!(info.pty);
    assert_eq!(exit, Some(Some(7)));
    let combined: String = chunks
        .iter()
        .filter_map(|c| match c {
            ide_run::OutputChunk::Stdout { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(combined.contains("out:hi") && combined.contains("err:hi"), "{combined:?}");

    // Cancellation / stop on PTY run.
    let mut hang_cfg = plugins
        .run_detection()
        .detect(&f.root)
        .into_iter()
        .find(|c| c.id == "plugin:test.execution-output:pty-default")
        .unwrap();
    hang_cfg.args = vec!["hang".into()];
    ide_run::save_user_configs(&f.root, &[hang_cfg]).unwrap();
    let (op_stop, info, _exit, _chunks) = launch_and_collect("pty-default|default|run", None, true).await;
    assert!(info.pty);

    plugins.flush_events_at(std::time::Instant::now() + Duration::from_secs(3));
    for _ in 0..50 {
        if plugins.wait_events(Duration::from_millis(50)) {
            break;
        }
    }
    let recorded = plugins
        .run_command(
            "test.execution-output",
            "events",
            None,
            Invocation { client: Some("main".into()), workspace_root: Some(f.root.clone()), ..Default::default() },
        )
        .unwrap()
        .unwrap();
    let recorded: serde_json::Value = serde_json::from_str(&recorded).unwrap();
    let arr = recorded.as_array().unwrap();
    assert!(arr.iter().any(|e| {
        e["kind"] == "run-exited"
            && serde_json::from_str::<serde_json::Value>(e["data"].as_str().unwrap())
                .is_ok_and(|d| d["id"] == op_wait && d["status"] == 7 && d["killed"] == false)
    }));
    assert!(arr.iter().any(|e| {
        e["kind"] == "run-exited"
            && serde_json::from_str::<serde_json::Value>(e["data"].as_str().unwrap())
                .is_ok_and(|d| d["id"] == op_stop && d["killed"] == true)
    }));

    plugins.shutdown();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn run_target_api15_overrides_and_frozen_api14_registration() {
    use ide_host::plugins::{Consent, PluginHost};
    use ide_plugin::{Invocation, Limits, PluginEngine};
    use std::os::unix::fs::PermissionsExt;
    let f = Harness::new();
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    let plugins = Arc::new(
        PluginHost::new(f._tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), Limits::default()).unwrap(),
    );
    plugins.set_workspace(Some(Arc::new(f.workspace())));
    f.host.set_plugin_host(&plugins);
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures");
    let engine = PluginEngine::new().unwrap();
    let legacy = engine.compile(&fixtures.join("run-target-api14/dist/plugin.wasm")).unwrap();
    assert_eq!(engine.check_component(&legacy).unwrap().unwrap().to_string(), "1.4.0");
    let tool = f.root.with_file_name("wrapper");
    std::fs::write(&tool, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    let invocation =
        || Invocation { client: Some("main".into()), workspace_root: Some(f.root.clone()), ..Default::default() };
    let config: ide_run::RunConfig = serde_json::from_value(serde_json::json!({
        "id":"composer", "name":"Composer", "kind":"shell", "command":"composer", "args":["install"],
        "env":{}, "detected":false, "isTest":false,
    }))
    .unwrap();
    for (plugin, command) in [("run-target-api14", "target"), ("execution", "target-overrides")] {
        plugins.install_from_dir(&fixtures.join(plugin), &Consent::all()).unwrap();
        assert!(plugins.run_command(plugin, command, Some("empty"), invocation()).is_err());
        plugins.choose_program(plugin, "process:execution-tool", Some(&f.root), Some(&tool)).unwrap();
        let cases = if plugin == "execution" {
            vec![
                ("empty", vec!["composer", "install"]),
                ("own", vec!["composer", "--working-dir=/container", "install"]),
                ("inherit", vec!["composer", "--cwd=/container", "install"]),
            ]
        } else {
            vec![("inherit", vec!["composer", "--cwd=/container", "install"])]
        };
        for (arg, expected) in cases {
            plugins.run_command(plugin, command, Some(arg), invocation()).unwrap();
            let target = plugins.run_targets(&f.root).into_iter().find(|t| t.plugin_id == plugin).unwrap();
            let wrapped = plugins
                .prepare_run_target_launch(
                    &f.root,
                    &target.id,
                    &config,
                    ide_plugin::RunTargetOperation::Run,
                    &Default::default(),
                )
                .unwrap();
            assert_eq!(wrapped.args, expected);
            assert_eq!(PathBuf::from(wrapped.command), tool);
            assert_eq!(wrapped.cwd.unwrap(), f.root);
            let php = ide_run::RunConfig { command: "php".into(), args: vec!["x.php".into()], ..config.clone() };
            assert_eq!(
                plugins
                    .prepare_run_target_launch(
                        &f.root,
                        &target.id,
                        &php,
                        ide_plugin::RunTargetOperation::Run,
                        &Default::default()
                    )
                    .unwrap()
                    .args,
                ["wrapped", "--cwd=/container", "php", "x.php"]
            );
        }
        if plugin == "execution" {
            assert!(plugins.run_command(plugin, command, Some("invalid"), invocation()).is_err());
            // A failed replacement retains the previous valid registration.
            assert_eq!(plugins.run_targets(&f.root).iter().filter(|t| t.plugin_id == plugin).count(), 1);
        }
        plugins.set_capability(plugin, "process:execution-tool", false).unwrap();
        assert!(plugins.run_targets(&f.root).iter().all(|t| t.plugin_id != plugin));
        assert!(plugins.run_command(plugin, command, None, invocation()).is_err());
        plugins.choose_program(plugin, "process:execution-tool", Some(&f.root), Some(&tool)).unwrap();
        f.host.set_project_trust(&f.root, false, false).await.unwrap();
        assert!(plugins.run_command(plugin, command, None, invocation()).unwrap_err().to_string().contains("trusted"));
        f.host.set_project_trust(&f.root, true, false).await.unwrap();
    }
    plugins.shutdown();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn run_target_validation_gates_launches_and_preserves_selection() {
    use ide_host::plugins::{Consent, PluginHost};
    use ide_plugin::{Invocation, Limits, RunTargetOperation};
    use std::os::unix::fs::PermissionsExt;
    use std::time::Duration;
    let f = Harness::new();
    f.host.set_project_trust(&f.root, true, false).await.unwrap();
    let plugins = Arc::new(
        PluginHost::new(
            f._tmp.path().join("plugins"),
            Arc::new(|_: Option<&str>, _| {}),
            Limits {
                // Room for a reclaimed instance to start again on a slow runner.
                timeout: Duration::from_millis(750),
                idle_timeout: Some(Duration::from_millis(20)),
                restart_backoff: Duration::ZERO,
                ..Default::default()
            },
        )
        .unwrap(),
    );
    plugins.set_workspace(Some(Arc::new(f.workspace())));
    f.host.set_plugin_host(&plugins);
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/execution");
    plugins.install_from_dir(&fixture, &Consent::all()).unwrap();
    let tool = f.root.with_file_name("wrapper");
    std::fs::write(&tool, "#!/bin/sh\ntouch spawned\n").unwrap();
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    plugins.choose_program("execution", "process:execution-tool", Some(&f.root), Some(&tool)).unwrap();
    let invocation =
        || Invocation { client: Some("main".into()), workspace_root: Some(f.root.clone()), ..Default::default() };
    let config: ide_run::RunConfig = serde_json::from_value(serde_json::json!({
        "id":"composer", "name":"Composer", "kind":"shell", "command":"/tools/composer", "args":["install"],
        "env":{"SECRET":"not sent"}, "detected":false, "isTest":false,
    }))
    .unwrap();
    for id in ["allow", "refuse", "long-refusal", "timeout", "trap"] {
        plugins.run_command("execution", "target", Some(id), invocation()).unwrap();
    }
    let targets = plugins.run_targets(&f.root);
    let id = |name: &str| targets.iter().find(|t| t.target.id == name).unwrap().id.clone();
    for operation in [RunTargetOperation::Run, RunTargetOperation::Test] {
        plugins.prepare_run_target_launch(&f.root, &id("allow"), &config, operation, &Default::default()).unwrap();
        let snapshot = plugins.run_command("execution", "validation", None, invocation()).unwrap().unwrap();
        assert_eq!(snapshot, format!("{}|allow|{operation:?}|composer|{}", f.root.display(), f.root.display()));
    }
    tokio::time::sleep(Duration::from_millis(30)).await;
    plugins.tick();
    assert_eq!(plugins.info_of("execution").unwrap().status, ide_host::plugins::PluginStatus::Inactive);
    plugins
        .prepare_run_target_launch(&f.root, &id("allow"), &config, RunTargetOperation::Run, &Default::default())
        .unwrap();
    assert!(plugins.info_of("execution").unwrap().stats.reclaims > 0);
    let selected = id("refuse");
    ide_host::plugins::run_targets::answer(&f.host, &plugins, "main", &selected, true).unwrap();
    for is_test in [false, true] {
        let mut config = config.clone();
        config.is_test = is_test;
        config.extras.target = Some(selected.clone());
        let error = ide_host::ops::run::run_start(&f.host, "main", config, ide_host::ops::Channel::new(|_| {}), None)
            .await
            .unwrap_err();
        assert!(error.message.contains("Plugin execution tests: Project runtime is stopped"), "{error}");
        assert!(f.host.processes.list().is_empty());
        assert!(!f.root.join("spawned").exists());
        assert_eq!(f.host.project("main").unwrap().settings.effective().run.default_target, selected);
        assert_eq!(plugins.run_targets(&f.root).len(), targets.len());
    }
    let error = plugins
        .prepare_run_target_launch(&f.root, &id("long-refusal"), &config, RunTargetOperation::Run, &Default::default())
        .unwrap_err();
    assert!(error.message.len() < 4200);
    let request = ide_core::RequestId(2408);
    let mut cfg = config.clone();
    cfg.extras.target = Some(id("timeout"));
    let worker = f.host.clone();
    let pending = tokio::spawn(async move {
        ide_host::ops::run::run_start(&worker, "main", cfg, ide_host::ops::Channel::new(|_| {}), Some(request)).await
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    f.host.cancel_request(request);
    assert_eq!(pending.await.unwrap().unwrap_err().kind, ide_core::error::ErrorKind::Cancelled);
    for name in ["timeout", "trap"] {
        let started = std::time::Instant::now();
        let error = plugins
            .prepare_run_target_launch(&f.root, &id(name), &config, RunTargetOperation::Run, &Default::default())
            .unwrap_err();
        assert!(error.message.contains("Plugin execution tests"), "{error}");
        if name == "timeout" {
            assert!(error.message.contains("timed out"), "{error}");
            assert!(started.elapsed() < Duration::from_secs(2), "background tasks must not extend validation");
        }
        assert!(f.host.processes.list().is_empty());
    }
    // A cancelled launch never enters the wrapper.
    let cancel = ide_core::CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        plugins
            .prepare_run_target_launch(&f.root, &id("allow"), &config, RunTargetOperation::Run, &cancel)
            .unwrap_err()
            .kind,
        ide_core::error::ErrorKind::Cancelled
    );
    plugins.shutdown();
}
