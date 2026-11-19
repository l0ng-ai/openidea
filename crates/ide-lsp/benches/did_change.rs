//! `cargo bench -p ide-lsp`: an incremental LSP change on a 1 MB document.

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use ide_core::event::ServerStatus;
use ide_core::{DocId, IdeEvent, LanguageId, Pos, Range};
use ide_jsonrpc::{Handler, Peer};
use ide_language::{LanguageConfig, LanguageRegistry, LanguageServerConfig};
use ide_lsp::{Launcher, LspManager};
use ide_text::AppliedChange;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

struct MockServer;

impl Handler for MockServer {
    fn on_notification(&self, _method: &str, _params: Value) {}

    fn on_request(&self, method: &str, _params: Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => Ok(json!({
                "capabilities": {
                    "textDocumentSync": { "openClose": true, "change": 2 }
                }
            })),
            "shutdown" => Ok(Value::Null),
            _ => Ok(Value::Null),
        }
    }
}

#[derive(Default)]
struct MockLauncher {
    servers: Mutex<Vec<Peer>>,
}

impl Launcher for MockLauncher {
    fn launch(
        &self,
        _config: &LanguageServerConfig,
        _root: &Path,
        handler: Arc<dyn Handler>,
        _on_stderr: Box<dyn Fn(String) + Send + Sync>,
    ) -> Result<Peer, ide_lsp::LaunchError> {
        let (server_io, client_io) = tokio::io::duplex(1 << 20);
        let (server_read, server_write) = tokio::io::split(server_io);
        let (client_read, client_write) = tokio::io::split(client_io);
        let server = Peer::connect(server_read, server_write, Arc::new(MockServer));
        self.servers.lock().unwrap().push(server);
        Ok(Peer::connect(client_read, client_write, handler))
    }
}

fn server_config() -> LanguageServerConfig {
    LanguageServerConfig {
        name: "mock".into(),
        command: "mock".into(),
        args: vec![],
        env: Default::default(),
        requires_env: Vec::new(),
        root_markers: vec!["mock.toml".into()],
        require_root_marker: false,
        initialization_options: None,
        settings: None,
        install_hint: None,
        connect: None,
        fallback: false,
        replaces: Vec::new(),
        features: Vec::new(),
        code_action_kinds: Vec::new(),
        max_java: None,
        launch_error: None,
        tsserver_project: false,
        tsserver_project_extras: Default::default(),
        resync_on_configuration: false,
        display_name: None,
        pinned: None,
    }
}

fn language_config() -> LanguageConfig {
    LanguageConfig {
        id: LanguageId::new("mock"),
        name: "Mock".into(),
        extensions: vec!["mk".into()],
        filenames: vec![],
        first_line: None,
        line_comment: None,
        block_comment: None,
        indent: None,
        ui_mode: None,
        framework_ui_modes: Vec::new(),
        framework_files: Vec::new(),
        formatter: None,
        scratch_template: None,
        rainbow_brackets: Default::default(),
        tree_sitter: None,
        language_servers: vec![server_config()],
        debugger: None,
    }
}

fn sample_text(bytes: usize) -> String {
    let mut text = String::with_capacity(bytes);
    let mut i = 0;
    while text.len() < bytes {
        text.push_str(&format!("    let value_{i} = compute({i});\n"));
        i += 1;
    }
    text
}

fn wait_until_ready(manager: &LspManager) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while manager.servers().iter().all(|server| server.status != ServerStatus::Ready) {
        assert!(std::time::Instant::now() < deadline, "mock language server did not become ready");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn bench(c: &mut Criterion) {
    let root = tempfile::tempdir().unwrap();
    let registry = Arc::new(LanguageRegistry::from_configs(vec![language_config()]));
    let manager = LspManager::with_launcher(
        root.path().to_owned(),
        registry,
        Arc::new(|_: IdeEvent| {}),
        Arc::new(MockLauncher::default()),
    );
    let text = sample_text(1 << 20);
    let path: PathBuf = root.path().join("large.mk");
    std::fs::write(&path, &text).unwrap();
    let doc = DocId::next();
    manager.did_open(doc, &path, &LanguageId::new("mock"), 1, &text);
    wait_until_ready(&manager);

    let changes = [AppliedChange { range: Range::new(Pos::new(0, 4), Pos::new(0, 8)), text: "same".into() }];
    let mut version = 2;
    c.bench_function("lsp/did_change_incremental_1mb", |b| {
        b.iter(|| {
            manager.did_change(doc, version, black_box(&changes), &|| unreachable!("valid incremental edit"));
            version = version.wrapping_add(1);
        });
    });

    tokio::runtime::Runtime::new().unwrap().block_on(manager.shutdown_all());
}

criterion_group! {
    name = benches;
    config = Criterion::default()
        .sample_size(30)
        .warm_up_time(std::time::Duration::from_secs(1))
        .measurement_time(std::time::Duration::from_secs(3));
    targets = bench
}

criterion_main!(benches);
