//! Integration tests against real language servers. The server tests are
//! `#[ignore]`d; run with `cargo test -p ide-lsp --test real_servers -- --ignored`.

use ide_core::event::ServerStatus;
use ide_core::{DocId, IdeEvent, LanguageId, Pos, Range};
use ide_language::{LanguageConfig, LanguageRegistry, LanguageServerConfig};
use ide_lsp::LspManager;
use ide_lsp::types::GotoKind;
use ide_text::AppliedChange;
use parking_lot::Mutex;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

type Events = Arc<Mutex<Vec<IdeEvent>>>;

fn manager(root: &Path, registry: LanguageRegistry) -> (Arc<LspManager>, Events) {
    let events: Events = Arc::default();
    let sink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    (LspManager::new(root.to_path_buf(), Arc::new(registry), sink), events)
}

fn last_status(events: &Events, name: &str) -> Option<(ServerStatus, Option<String>)> {
    events.lock().iter().rev().find_map(|e| match e {
        IdeEvent::LanguageServer { name: n, status, message, .. } if n == name => Some((*status, message.clone())),
        _ => None,
    })
}

/// Retries `f` until it yields `Some` (servers answer emptily while indexing).
async fn retry<T, F: Future<Output = Option<T>>>(what: &str, timeout: Duration, mut f: impl FnMut() -> F) -> T {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(v) = f().await {
            return v;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn lang(id: &str, ext: &str, server: LanguageServerConfig) -> LanguageConfig {
    LanguageConfig {
        id: LanguageId::new(id),
        name: id.into(),
        extensions: vec![ext.into()],
        filenames: vec![],
        first_line: None,
        line_comment: None,
        block_comment: None,
        indent: None,
        ui_mode: None,
        tree_sitter: None,
        language_servers: vec![server],
        debugger: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_binary_is_reported_with_install_hint() {
    let dir = tempfile::tempdir().unwrap();
    let server = LanguageServerConfig {
        name: "nope-ls".into(),
        command: "openidea-definitely-not-installed-ls".into(),
        args: vec![],
        env: Default::default(),
        root_markers: vec![],
        initialization_options: None,
        install_hint: Some("npm i -g nope-ls".into()),
        fallback: false,
        launch_error: None,
    };
    let (mgr, events) = manager(dir.path(), LanguageRegistry::from_configs(vec![lang("nope", "nope", server)]));
    let path = dir.path().join("a.nope");
    mgr.did_open(DocId::next(), &path, &LanguageId::new("nope"), 1, "x");
    retry("missing status", Duration::from_secs(10), || {
        let s = last_status(&events, "nope-ls");
        async move { (s.as_ref().map(|s| s.0) == Some(ServerStatus::Missing)).then_some(()) }
    })
    .await;
    assert_eq!(last_status(&events, "nope-ls").unwrap().1.as_deref(), Some("npm i -g nope-ls"));
}

const MAIN_RS: &str = "struct Point {
    x: i32,
    y: i32,
}

/// Adds two numbers.
fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    let p = Point { x: 1, y: 2 };
    let s = add(p.x, p.y);
    println!(\"{s}\");
}
";

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires rust-analyzer"]
async fn rust_analyzer_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n")
        .unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    let main = root.join("src/main.rs");
    std::fs::write(&main, MAIN_RS).unwrap();

    // `OPENIDEA_TEST_RUST_ANALYZER` overrides the binary (e.g. when the rustup proxy
    // has no rust-analyzer component for the default toolchain).
    let mut rust = LanguageRegistry::load(None).unwrap().get(&LanguageId::new("rust")).unwrap();
    if let Ok(bin) = std::env::var("OPENIDEA_TEST_RUST_ANALYZER") {
        rust.language_servers[0].command = bin;
    }
    let (mgr, events) = manager(&root, LanguageRegistry::from_configs(vec![rust]));
    let doc = DocId::next();
    mgr.did_open(doc, &main, &LanguageId::new("rust"), 1, MAIN_RS);
    retry("rust-analyzer ready", Duration::from_secs(60), || {
        let s = last_status(&events, "rust-analyzer");
        if let Some((ServerStatus::Crashed | ServerStatus::Missing, msg)) = &s {
            panic!("rust-analyzer failed: {msg:?}");
        }
        async move { matches!(s, Some((ServerStatus::Ready | ServerStatus::Busy, _))).then_some(()) }
    })
    .await;
    let servers = mgr.servers();
    assert_eq!(servers[0].root, root);

    // Hover over `add` in `add(p.x, p.y)` (line 12, col 12).
    let hover = retry("hover", Duration::from_secs(120), || {
        let mgr = mgr.clone();
        async move { mgr.hover(doc, Pos::new(12, 13), Default::default()).await.ok().flatten() }
    })
    .await;
    assert!(hover.contents.value.contains("fn add"), "{}", hover.contents.value);
    assert!(hover.contents.value.contains("Adds two numbers"));

    let defs = retry("definition", Duration::from_secs(60), || {
        let mgr = mgr.clone();
        async move { mgr.goto(doc, Pos::new(12, 13), GotoKind::Definition).await.ok().filter(|d| !d.is_empty()) }
    })
    .await;
    assert_eq!(defs[0].path, main);
    assert_eq!(defs[0].range.start.line, 6);

    // Type `p.` on a new line inside main and complete fields.
    let insert_at = Pos::new(13, 0);
    mgr.did_change(
        doc,
        2,
        &[AppliedChange { range: Range::point(insert_at), text: "    p.\n".into() }],
        &|| unreachable!(),
    );
    let list = retry("completion", Duration::from_secs(60), || {
        let mgr = mgr.clone();
        async move {
            let list = mgr.completion(doc, Pos::new(13, 6), Some(".".into()), Default::default()).await.ok()?;
            list.items.iter().any(|i| i.label == "x").then_some(list)
        }
    })
    .await;
    let x = list.items.iter().find(|i| i.label == "x").unwrap();
    assert_eq!(x.replace_range.map(|r| r.start), Some(Pos::new(13, 6)));
    let resolved = mgr.resolve_completion(doc, x.clone()).await.unwrap();
    assert_eq!(resolved.label, "x");

    let symbols = mgr.document_symbols(doc).await.unwrap().unwrap();
    assert!(symbols.iter().any(|s| s.name == "add"));
    let tokens = mgr.semantic_tokens(doc).await.unwrap().unwrap();
    assert!(!tokens.data.is_empty() && tokens.data.len() % 5 == 0);

    tokio::time::timeout(Duration::from_secs(10), mgr.shutdown_all()).await.unwrap();
    assert_eq!(last_status(&events, "rust-analyzer").unwrap().0, ServerStatus::Stopped);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires typescript-language-server"]
async fn typescript_language_server_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("tsconfig.json"), "{ \"compilerOptions\": { \"strict\": true } }").unwrap();
    let file = root.join("a.ts");
    let text =
        "export function greet(name: string): string {\n  return `hi ${name}`;\n}\nconst n: number = greet(\"x\");\n";
    std::fs::write(&file, text).unwrap();
    let server = LanguageServerConfig {
        name: "typescript-language-server".into(),
        command: "typescript-language-server".into(),
        args: vec!["--stdio".into()],
        env: Default::default(),
        root_markers: vec!["tsconfig.json".into()],
        initialization_options: None,
        install_hint: None,
        fallback: false,
        launch_error: None,
    };
    let (mgr, events) = manager(&root, LanguageRegistry::from_configs(vec![lang("typescript", "ts", server)]));
    let doc = DocId::next();
    mgr.did_open(doc, &file, &LanguageId::new("typescript"), 1, text);

    let hover = retry("hover", Duration::from_secs(60), || {
        let mgr = mgr.clone();
        async move { mgr.hover(doc, Pos::new(3, 19), Default::default()).await.ok().flatten() }
    })
    .await;
    assert!(hover.contents.value.contains("greet"), "{}", hover.contents.value);

    let defs = mgr.goto(doc, Pos::new(3, 19), GotoKind::Definition).await.unwrap();
    assert_eq!(defs[0].path, file);
    assert_eq!(defs[0].range.start.line, 0);

    // Type error: string assigned to number.
    retry("diagnostics", Duration::from_secs(30), || {
        let found = events
            .lock()
            .iter()
            .any(|e| matches!(e, IdeEvent::Diagnostics { path, items, .. } if path == &file && !items.is_empty()));
        async move { found.then_some(()) }
    })
    .await;
    tokio::time::timeout(Duration::from_secs(10), mgr.shutdown_all()).await.unwrap();
}
