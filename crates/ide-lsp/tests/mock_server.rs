//! Protocol tests against in-memory mock language servers.

use ide_core::event::ServerStatus;
use ide_core::{DocId, FileEdit, IdeEvent, LanguageId, Pos, Range, ServerId, Severity, WorkspaceEdit};
use ide_jsonrpc::{Handler, NoopHandler, Peer};
use ide_language::{LanguageConfig, LanguageRegistry, LanguageServerConfig};
use ide_lsp::types::*;
use ide_lsp::{LaunchError, Launcher, LspManager};
use ide_text::AppliedChange;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

// ------------------------------------------------------------------ mock server

#[derive(Default)]
struct MockState {
    caps: Mutex<Value>,
    missing: std::sync::atomic::AtomicBool,
    launches: AtomicUsize,
    notifications: Mutex<Vec<(String, Value)>>,
    requests: Mutex<Vec<(String, Value)>>,
    /// uri → text as reconstructed by the mock from didOpen/didChange.
    docs: Mutex<HashMap<String, String>>,
    responses: Mutex<HashMap<String, Value>>,
    /// Computes a response from the request and the open documents (before `responses`).
    responder: Mutex<Option<Responder>>,
    peer: Mutex<Option<Peer>>,
}

type Responder = Arc<dyn Fn(&MockState, &str, &Value) -> Option<Value> + Send + Sync>;

impl MockState {
    fn notified(&self, method: &str) -> Vec<Value> {
        self.notifications.lock().iter().filter(|(m, _)| m == method).map(|(_, p)| p.clone()).collect()
    }
    fn requested(&self, method: &str) -> Vec<Value> {
        self.requests.lock().iter().filter(|(m, _)| m == method).map(|(_, p)| p.clone()).collect()
    }
    fn respond(&self, method: &str, v: Value) {
        self.responses.lock().insert(method.to_owned(), v);
    }
    fn peer(&self) -> Peer {
        self.peer.lock().clone().expect("server running")
    }
}

fn utf16_to_byte(text: &str, line: u64, col: u64) -> usize {
    let mut offset = 0;
    for (i, l) in text.split('\n').enumerate() {
        if i as u64 == line {
            let mut units = 0u64;
            for (b, c) in l.char_indices() {
                if units >= col {
                    return offset + b;
                }
                units += c.len_utf16() as u64;
            }
            return offset + l.len();
        }
        offset += l.len() + 1;
    }
    text.len()
}

struct MockHandler(Arc<MockState>);

impl Handler for MockHandler {
    fn on_notification(&self, method: &str, params: Value) {
        let s = &self.0;
        // Held throughout: a test that sees the effect (a document, the peer gone) also sees the record.
        let mut log = s.notifications.lock();
        let uri = params["textDocument"]["uri"].as_str().unwrap_or_default().to_owned();
        match method {
            "textDocument/didOpen" => {
                s.docs.lock().insert(uri, params["textDocument"]["text"].as_str().unwrap().to_owned());
            }
            "textDocument/didChange" => {
                let mut docs = s.docs.lock();
                let text = docs.get_mut(&uri).expect("didChange before didOpen");
                for change in params["contentChanges"].as_array().unwrap() {
                    let new = change["text"].as_str().unwrap();
                    match change.get("range") {
                        Some(r) => {
                            let a = utf16_to_byte(
                                text,
                                r["start"]["line"].as_u64().unwrap(),
                                r["start"]["character"].as_u64().unwrap(),
                            );
                            let b = utf16_to_byte(
                                text,
                                r["end"]["line"].as_u64().unwrap(),
                                r["end"]["character"].as_u64().unwrap(),
                            );
                            text.replace_range(a..b, new);
                        }
                        None => *text = new.to_owned(),
                    }
                }
            }
            "textDocument/didClose" => {
                s.docs.lock().remove(&uri);
            }
            "exit" => {
                if let Some(p) = s.peer.lock().take() {
                    p.kill();
                }
            }
            _ => {}
        }
        log.push((method.to_owned(), params));
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        let s = &self.0;
        s.requests.lock().push((method.to_owned(), params.clone()));
        match method {
            "initialize" => Ok(json!({ "capabilities": s.caps.lock().clone(), "serverInfo": { "name": "mock" } })),
            "shutdown" => Ok(Value::Null),
            _ => {
                let responder = s.responder.lock().clone();
                if let Some(v) = responder.and_then(|f| f(s, method, &params)) {
                    return Ok(v);
                }
                Ok(s.responses.lock().get(method).cloned().unwrap_or(Value::Null))
            }
        }
    }
}

#[derive(Default)]
struct MockLauncher {
    servers: Mutex<HashMap<String, Arc<MockState>>>,
}

impl MockLauncher {
    fn state(&self, name: &str) -> Arc<MockState> {
        self.servers.lock().entry(name.to_owned()).or_default().clone()
    }
}

impl Launcher for MockLauncher {
    fn launch(
        &self,
        config: &LanguageServerConfig,
        _root: &Path,
        handler: Arc<dyn Handler>,
        _on_stderr: Box<dyn Fn(String) + Send + Sync>,
    ) -> Result<Peer, LaunchError> {
        let state = self.state(&config.name);
        if state.missing.load(Ordering::SeqCst) {
            return Err(LaunchError::Missing);
        }
        state.launches.fetch_add(1, Ordering::SeqCst);
        state.docs.lock().clear();
        let (client_io, server_io) = tokio::io::duplex(1 << 20);
        let (sr, sw) = tokio::io::split(server_io);
        let server = Peer::connect(sr, sw, Arc::new(MockHandler(state.clone())));
        *state.peer.lock() = Some(server);
        let (cr, cw) = tokio::io::split(client_io);
        Ok(Peer::connect(cr, cw, handler))
    }
}

// ------------------------------------------------------------------ harness

fn incremental_caps() -> Value {
    json!({
        "textDocumentSync": { "openClose": true, "change": 2, "save": { "includeText": true } },
        "completionProvider": { "resolveProvider": true, "triggerCharacters": ["."] },
        "hoverProvider": true,
        "definitionProvider": true,
        "referencesProvider": true,
        "codeActionProvider": { "resolveProvider": true },
        "renameProvider": { "prepareProvider": true },
        "documentFormattingProvider": true,
        "executeCommandProvider": { "commands": ["mock.run"] },
        "semanticTokensProvider": { "legend": { "tokenTypes": ["function", "variable"], "tokenModifiers": ["declaration"] }, "full": true },
        "codeLensProvider": { "resolveProvider": true },
        "callHierarchyProvider": true,
        "inlayHintProvider": true
    })
}

struct Harness {
    _dir: tempfile::TempDir,
    root: PathBuf,
    mgr: Arc<LspManager>,
    launcher: Arc<MockLauncher>,
    events: Arc<Mutex<Vec<IdeEvent>>>,
    lang: LanguageId,
}

fn server_cfg(name: &str) -> LanguageServerConfig {
    LanguageServerConfig {
        name: name.into(),
        command: name.into(),
        args: vec![],
        env: Default::default(),
        root_markers: vec!["mock.toml".into()],
        require_root_marker: false,
        initialization_options: Some(toml::Value::Table(toml::toml! { flag = true nested = { deep = 1 } })),
        settings: None,
        install_hint: Some(format!("install {name}")),
        connect: None,
        fallback: false,
        max_java: None,
        launch_error: None,
    }
}

fn harness(servers: &[(&str, Value)]) -> Harness {
    harness_with_fallbacks(servers, &[])
}

/// `fallbacks`: servers configured as alternatives to the ones listed before them.
fn harness_with_fallbacks(servers: &[(&str, Value)], fallbacks: &[&str]) -> Harness {
    harness_for("mock", "mk", servers, fallbacks)
}

fn harness_for(lang_id: &str, ext: &str, servers: &[(&str, Value)], fallbacks: &[&str]) -> Harness {
    harness_configured(lang_id, ext, servers, |cfg| cfg.fallback = fallbacks.contains(&cfg.name.as_str()))
}

/// `adjust` changes each server's configuration.
fn harness_configured(
    lang_id: &str,
    ext: &str,
    servers: &[(&str, Value)],
    adjust: impl Fn(&mut LanguageServerConfig),
) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let lang = LanguageConfig {
        id: LanguageId::new(lang_id),
        name: "Mock".into(),
        extensions: vec![ext.into()],
        filenames: vec![],
        first_line: None,
        line_comment: None,
        block_comment: None,
        indent: None,
        ui_mode: None,
        tree_sitter: None,
        language_servers: servers
            .iter()
            .map(|(n, _)| {
                let mut cfg = server_cfg(n);
                adjust(&mut cfg);
                cfg
            })
            .collect(),
        debugger: None,
    };
    let registry = Arc::new(LanguageRegistry::from_configs(vec![lang]));
    let launcher = Arc::new(MockLauncher::default());
    for (name, caps) in servers {
        *launcher.state(name).caps.lock() = caps.clone();
    }
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let events = events.clone();
        Arc::new(move |e: IdeEvent| events.lock().push(e))
    };
    let mgr = LspManager::with_launcher(root.clone(), registry, sink, launcher.clone());
    Harness { _dir: dir, root, mgr, launcher, events, lang: LanguageId::new(lang_id) }
}

impl Harness {
    fn open(&self, name: &str, text: &str) -> (DocId, PathBuf) {
        let path = self.root.join(name);
        std::fs::write(&path, text).unwrap();
        let doc = DocId::next();
        self.mgr.did_open(doc, &path, &self.lang, 1, text);
        (doc, path)
    }

    fn statuses(&self, name: &str) -> Vec<ServerStatus> {
        self.events
            .lock()
            .iter()
            .filter_map(|e| match e {
                IdeEvent::LanguageServer { name: n, status, .. } if n == name => Some(*status),
                _ => None,
            })
            .collect()
    }

    /// Whether every instance of `name` was reported as removed from the server list.
    fn removed(&self, name: &str) -> bool {
        let events = self.events.lock();
        let ids: HashSet<ServerId> = events
            .iter()
            .filter_map(|e| match e {
                IdeEvent::LanguageServer { server, name: n, .. } if n == name => Some(*server),
                _ => None,
            })
            .collect();
        !ids.is_empty()
            && ids.iter().all(|id| {
                events.iter().any(|e| matches!(e, IdeEvent::LanguageServerRemoved { server } if server == id))
            })
    }

    async fn wait_status(&self, name: &str, status: ServerStatus) {
        eventually(|| self.statuses(name).last() == Some(&status)).await;
    }
}

/// Waits for `f`; the bound only keeps a broken test from hanging (machines under load are slow).
async fn eventually(mut f: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !f() {
        assert!(std::time::Instant::now() < deadline, "condition not reached in time");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Holds mock request handlers until the test opens it.
#[derive(Default)]
struct Gate {
    entered: std::sync::atomic::AtomicBool,
    open: std::sync::atomic::AtomicBool,
}

impl Gate {
    /// Called from a handler: blocks until [`Gate::open`] (or a generous bound).
    fn hold(&self) {
        self.entered.store(true, Ordering::SeqCst);
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !self.open.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    fn entered(&self) -> bool {
        self.entered.load(Ordering::SeqCst)
    }
    fn open(&self) {
        self.open.store(true, Ordering::SeqCst);
    }
}

fn uri_of(path: &Path) -> String {
    ide_lsp::path_to_uri_string(path)
}

fn rng(l0: u32, c0: u32, l1: u32, c1: u32) -> Range {
    Range::new(Pos::new(l0, c0), Pos::new(l1, c1))
}

fn change(range: Range, text: &str) -> AppliedChange {
    AppliedChange { range, text: text.into() }
}

// ------------------------------------------------------------------ tests

#[tokio::test(flavor = "multi_thread")]
async fn initialize_and_incremental_sync() {
    let h = harness(&[("mock", incremental_caps())]);
    let (doc, path) = h.open("a.mk", "fn main() {\n}\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    let s = h.launcher.state("mock");

    let init = &s.requested("initialize")[0];
    assert_eq!(init["clientInfo"]["name"], "OpenIDEA");
    assert_eq!(init["capabilities"]["general"]["positionEncodings"], json!(["utf-16"]));
    assert_eq!(init["capabilities"]["textDocument"]["completion"]["completionItem"]["snippetSupport"], true);
    assert_eq!(init["initializationOptions"], json!({ "flag": true, "nested": { "deep": 1 } }));
    assert_eq!(init["rootUri"], json!(uri_of(&h.root)));
    eventually(|| s.notified("initialized").len() == 1).await;
    assert_eq!(h.statuses("mock"), vec![ServerStatus::Starting, ServerStatus::Ready]);

    let uri = uri_of(&path);
    eventually(|| s.docs.lock().get(&uri).map(String::as_str) == Some("fn main() {\n}\n")).await;
    let open = &s.notified("textDocument/didOpen")[0];
    assert_eq!(open["textDocument"]["languageId"], "mock");
    assert_eq!(open["textDocument"]["version"], 1);

    let full = || -> String { panic!("full text must not be needed") };
    h.mgr.did_change(doc, 2, &[change(rng(0, 11, 0, 11), "\n    let é😀 = 1;")], &full);
    h.mgr.did_change(doc, 3, &[change(rng(1, 10, 1, 10), "x"), change(rng(1, 4, 1, 7), "const")], &full);
    let expected = "fn main() {\n    const é😀x = 1;\n}\n";
    eventually(|| s.docs.lock().get(&uri).map(String::as_str) == Some(expected)).await;
    let changes = s.notified("textDocument/didChange");
    assert_eq!(changes.last().unwrap()["textDocument"]["version"], 3);
    assert_eq!(changes.last().unwrap()["contentChanges"].as_array().unwrap().len(), 2);

    h.mgr.did_save(doc, expected);
    eventually(|| s.notified("textDocument/didSave").len() == 1).await;
    assert_eq!(s.notified("textDocument/didSave")[0]["text"], expected);

    h.mgr.did_close(doc);
    eventually(|| s.notified("textDocument/didClose").len() == 1).await;
    assert!(s.docs.lock().is_empty());

    let infos = h.mgr.servers();
    assert_eq!(infos.len(), 1);
    assert_eq!(infos[0].name, "mock");
    assert_eq!(infos[0].root, h.root);
    assert_eq!(infos[0].status, ServerStatus::Ready);
}

#[tokio::test(flavor = "multi_thread")]
async fn full_sync_and_desync_recovery() {
    let h = harness(&[("full", json!({ "textDocumentSync": 1 })), ("inc", json!({ "textDocumentSync": 2 }))]);
    let (doc, path) = h.open("a.mk", "abc");
    h.wait_status("full", ServerStatus::Ready).await;
    h.wait_status("inc", ServerStatus::Ready).await;
    let (full, inc) = (h.launcher.state("full"), h.launcher.state("inc"));
    let uri = uri_of(&path);
    eventually(|| full.docs.lock().contains_key(&uri) && inc.docs.lock().contains_key(&uri)).await;

    h.mgr.did_change(doc, 2, &[change(rng(0, 3, 0, 3), "d")], &|| unreachable!());
    eventually(|| full.docs.lock()[&uri] == "abcd" && inc.docs.lock()[&uri] == "abcd").await;
    assert!(full.notified("textDocument/didChange")[0]["contentChanges"][0].get("range").is_none());
    assert!(inc.notified("textDocument/didChange")[0]["contentChanges"][0].get("range").is_some());

    // A change that does not fit the tracked text forces a full resync from the source of truth.
    h.mgr.did_change(doc, 3, &[change(rng(7, 0, 7, 0), "zz")], &|| "truth".to_owned());
    eventually(|| full.docs.lock()[&uri] == "truth" && inc.docs.lock()[&uri] == "truth").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn completion_mapping_merge_and_resolve() {
    let h = harness(&[("a", incremental_caps()), ("b", json!({ "textDocumentSync": 2, "completionProvider": {} }))]);
    let (doc, _) = h.open("a.mk", "let x = foo.ba");
    h.wait_status("a", ServerStatus::Ready).await;
    h.wait_status("b", ServerStatus::Ready).await;
    let (a, b) = (h.launcher.state("a"), h.launcher.state("b"));
    a.respond(
        "textDocument/completion",
        json!({
            "isIncomplete": false,
            "itemDefaults": { "data": { "from": "defaults" } },
            "items": [{
                "label": "bar", "kind": 2, "detail": "fn() -> u8", "labelDetails": { "detail": "()" },
                "textEdit": { "newText": "bar()$0", "insert": {"start":{"line":0,"character":12},"end":{"line":0,"character":14}},
                              "replace": {"start":{"line":0,"character":12},"end":{"line":0,"character":15}} },
                "insertTextFormat": 2, "sortText": "0001"
            }]
        }),
    );
    b.respond("textDocument/completion", json!({ "isIncomplete": true, "items": [{ "label": "baz" }] }));
    a.respond("completionItem/resolve", json!({
        "label": "bar", "documentation": { "kind": "markdown", "value": "**docs**" },
        "additionalTextEdits": [{ "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":0}}, "newText": "use foo;\n" }]
    }));

    let list = h.mgr.completion(doc, Pos::new(0, 14), Some(".".into()), Default::default()).await.unwrap();
    assert!(list.is_incomplete);
    assert_eq!(list.items.len(), 2);
    let bar = list.items.iter().find(|i| i.label == "bar").unwrap().clone();
    assert_eq!(bar.kind, Some(CompletionKind::Method));
    assert_eq!(bar.insert_text, "bar()$0");
    assert!(bar.is_snippet);
    assert_eq!(bar.label_detail.as_deref(), Some("()"));
    assert_eq!(bar.replace_range, Some(rng(0, 12, 0, 14)));
    assert_eq!(bar.replace_range_tab, Some(rng(0, 12, 0, 15)));
    assert_eq!(bar.data, Some(json!({ "from": "defaults" })));
    let baz = list.items.iter().find(|i| i.label == "baz").unwrap();
    assert_eq!(baz.insert_text, "baz");
    assert_ne!(baz.server, bar.server);

    let req = &a.requested("textDocument/completion")[0];
    assert_eq!(req["context"], json!({ "triggerKind": 2, "triggerCharacter": "." }));
    assert_eq!(b.requested("textDocument/completion")[0]["context"], json!({ "triggerKind": 1 }));

    let resolved = h.mgr.resolve_completion(doc, bar.clone()).await.unwrap();
    assert_eq!(resolved.documentation.as_ref().unwrap().value, "**docs**");
    assert_eq!(resolved.additional_edits[0].new_text, "use foo;\n");
    assert_eq!(resolved.insert_text, "bar()$0", "fields absent from the resolve reply are kept");
    assert_eq!(resolved.replace_range_tab, Some(rng(0, 12, 0, 15)));
    let sent = &a.requested("completionItem/resolve")[0];
    assert_eq!(sent["data"], json!({ "from": "defaults" }));
    assert_eq!(sent["textEdit"]["replace"]["end"]["character"], 15);

    // Server b has no resolve support: the item comes back unchanged.
    let baz2 = h.mgr.resolve_completion(doc, baz.clone()).await.unwrap();
    assert_eq!(baz2.label, "baz");
    assert!(b.requested("completionItem/resolve").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn inline_completion_only_from_servers_that_advertise_it() {
    let h = harness(&[
        ("plain", incremental_caps()),
        ("ghost", json!({ "textDocumentSync": 2, "inlineCompletionProvider": {} })),
        ("late", json!({ "textDocumentSync": 2 })),
    ]);
    let (doc, _) = h.open("a.mk", "let x = fo");
    for name in ["plain", "ghost", "late"] {
        h.wait_status(name, ServerStatus::Ready).await;
    }
    let (plain, ghost) = (h.launcher.state("plain"), h.launcher.state("ghost"));
    let init = &plain.requested("initialize")[0];
    assert_eq!(init["capabilities"]["textDocument"]["inlineCompletion"], json!({ "dynamicRegistration": true }));
    ghost.respond(
        "textDocument/inlineCompletion",
        json!({ "items": [
            { "insertText": "foo(1)", "range": {"start":{"line":0,"character":8},"end":{"line":0,"character":10}},
              "command": { "title": "accepted", "command": "ghost.accepted", "arguments": [7] } },
            { "insertText": { "kind": "snippet", "value": "foo(${1:a}, $2)$0" }, "filterText": "fo" },
            { "insertText": "" }
        ] }),
    );
    let items = h.mgr.inline_completion(doc, Pos::new(0, 10), true, Default::default()).await.unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].insert_text, "foo(1)");
    assert_eq!(items[0].range, Some(rng(0, 8, 0, 10)));
    assert_eq!(items[0].command.as_ref().unwrap().command, "ghost.accepted");
    assert_eq!(items[1].insert_text, "foo(a, )");
    assert_eq!(items[1].filter_text.as_deref(), Some("fo"));
    let req = &ghost.requested("textDocument/inlineCompletion")[0];
    assert_eq!(req["context"], json!({ "triggerKind": 2 }));
    assert_eq!(req["position"], json!({ "line": 0, "character": 10 }));
    assert!(plain.requested("textDocument/inlineCompletion").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn unsupported_feature_names_the_running_servers_that_lack_it() {
    let h = harness(&[("plain", incremental_caps()), ("other", json!({ "textDocumentSync": 2 }))]);
    let (doc, _) = h.open("a.mk", "let x = fo");
    for name in ["plain", "other"] {
        h.wait_status(name, ServerStatus::Ready).await;
    }
    let e = h.mgr.inline_completion(doc, Pos::new(0, 10), false, Default::default()).await.unwrap_err();
    assert_eq!(e.kind, ide_core::error::ErrorKind::Unavailable);
    assert_eq!(e.message, "plain, other doesn't support inline completion");
    let e = h.mgr.type_hierarchy(doc, Pos::new(0, 4), HierarchyDirection::Incoming).await.unwrap_err();
    assert_eq!(e.message, "plain, other doesn't support type hierarchy");
}

#[tokio::test(flavor = "multi_thread")]
async fn diagnostics_become_events_and_feed_code_actions() {
    let h = harness(&[("mock", incremental_caps())]);
    let (doc, path) = h.open("a.mk", "let unused = 1;\nlet y = 2;\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    let s = h.launcher.state("mock");
    let diag = |line: u32| {
        json!({
            "range": {"start":{"line":line,"character":4},"end":{"line":line,"character":10}},
            "severity": 2, "code": "W1", "message": "unused variable", "tags": [1], "data": { "fix": line }
        })
    };
    s.peer()
        .notify("textDocument/publishDiagnostics", json!({ "uri": uri_of(&path), "diagnostics": [diag(0), diag(1)] }))
        .unwrap();
    eventually(|| h.events.lock().iter().any(|e| matches!(e, IdeEvent::Diagnostics { .. }))).await;
    {
        let events = h.events.lock();
        let (p, source, items) = events
            .iter()
            .find_map(|e| match e {
                IdeEvent::Diagnostics { path, source, items } => Some((path.clone(), source.clone(), items.clone())),
                _ => None,
            })
            .unwrap();
        assert_eq!(p, path);
        assert_eq!(source, "mock");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].severity, Severity::Warning);
        assert_eq!(items[0].code.as_deref(), Some("W1"));
        assert!(items[0].unnecessary);
        assert_eq!(items[0].range, rng(0, 4, 0, 10));
    }

    // A reloaded UI asks for them again.
    h.events.lock().clear();
    h.mgr.resend_diagnostics();
    let again = h.events.lock().iter().find_map(|e| match e {
        IdeEvent::Diagnostics { path, items, .. } => Some((path.clone(), items.len())),
        _ => None,
    });
    assert_eq!(again, Some((path.clone().into(), 2)));

    s.respond(
        "textDocument/codeAction",
        json!([
            { "title": "Remove", "kind": "quickfix", "isPreferred": true, "data": { "id": 7 } },
            { "title": "Run", "command": "mock.run", "arguments": [1] }
        ]),
    );
    s.respond(
        "codeAction/resolve",
        json!({
            "title": "Remove", "edit": { "changes": { uri_of(&path): [
                { "range": {"start":{"line":0,"character":0},"end":{"line":1,"character":0}}, "newText": "" } ] } }
        }),
    );
    let actions = h.mgr.code_actions(doc, rng(0, 5, 0, 5), vec!["quickfix".into()]).await.unwrap();
    assert_eq!(actions.len(), 2);
    assert_eq!(actions[0].kind.as_deref(), Some("quickfix"));
    assert!(actions[0].is_preferred);
    assert_eq!(actions[1].command.as_ref().unwrap().command, "mock.run");
    let req = &s.requested("textDocument/codeAction")[0];
    assert_eq!(req["context"]["only"], json!(["quickfix"]));
    let ctx = req["context"]["diagnostics"].as_array().unwrap();
    assert_eq!(ctx.len(), 1, "only diagnostics overlapping the range");
    assert_eq!(ctx[0]["data"], json!({ "fix": 0 }));

    let resolved = h.mgr.resolve_code_action(doc, actions[0].clone()).await.unwrap();
    assert_eq!(s.requested("codeAction/resolve")[0]["data"], json!({ "id": 7 }));
    let edit = resolved.edit.unwrap();
    assert!(
        matches!(&edit.files[0], FileEdit::Edit { path: p, edits } if p == &path && edits[0].range == rng(0, 0, 1, 0))
    );

    h.mgr.execute_command(doc, actions[1].command.clone().unwrap()).await.unwrap();
    assert_eq!(s.requested("workspace/executeCommand")[0], json!({ "command": "mock.run", "arguments": [1] }));
    let err = h
        .mgr
        .execute_command(doc, Command { title: "x".into(), command: "other".into(), arguments: vec![] })
        .await
        .unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable);
}

#[tokio::test(flavor = "multi_thread")]
async fn apply_edit_hook_and_server_requests() {
    let h = harness(&[("mock", incremental_caps())]);
    let (_doc, path) = h.open("a.mk", "abc\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    let s = h.launcher.state("mock");
    let applied: Arc<Mutex<Vec<WorkspaceEdit>>> = Arc::default();
    {
        let applied = applied.clone();
        h.mgr.set_apply_edit_hook(Box::new(move |e| {
            applied.lock().push(e);
            true
        }));
    }
    let new_file = h.root.join("new.mk");
    let reply: Value = s
        .peer()
        .request(
            "workspace/applyEdit",
            json!({ "edit": { "documentChanges": [
                { "kind": "create", "uri": uri_of(&new_file) },
                { "textDocument": { "uri": uri_of(&path), "version": 1 },
                  "edits": [{ "range": {"start":{"line":0,"character":1},"end":{"line":0,"character":2}}, "newText": "X" }] }
            ] } }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(reply, json!({ "applied": true }));
    let edits = applied.lock().clone();
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0].files[0], FileEdit::Create { path: new_file.into(), overwrite: false });
    assert!(matches!(&edits[0].files[1], FileEdit::Edit { path: p, edits } if p == &path && edits[0].new_text == "X"));

    let peer = s.peer();
    let cfg: Value = peer
        .request(
            "workspace/configuration",
            json!({ "items": [{ "section": "mock" }, { "section": "nested.deep" }, { "section": "nope" }] }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(cfg, json!([{ "flag": true, "nested": { "deep": 1 } }, 1, null]));
    let folders: Value = peer.request("workspace/workspaceFolders", Value::Null, None).await.unwrap();
    assert_eq!(folders[0]["uri"], json!(uri_of(&h.root)));
    let v: Value = peer.request("window/workDoneProgress/create", json!({ "token": "t" }), None).await.unwrap();
    assert_eq!(v, Value::Null);
    let v: Value = peer
        .request(
            "window/showMessageRequest",
            json!({ "type": 1, "message": "boom", "actions": [{ "title": "OK" }] }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(v, Value::Null);
    let v: Value = peer
        .request(
            "client/registerCapability",
            json!({ "registrations": [{ "id": "1", "method": "textDocument/documentHighlight" }] }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(v, Value::Null);
    assert!(peer.request::<_, Value>("unknown/method", Value::Null, None).await.is_err());

    peer.notify("window/showMessage", json!({ "type": 2, "message": "careful" })).unwrap();
    peer.notify("window/showMessage", json!({ "type": 3, "message": "info only" })).unwrap();
    peer.notify("window/logMessage", json!({ "type": 1, "message": "log" })).unwrap();
    eventually(|| {
        h.events.lock().iter().any(|e| matches!(e, IdeEvent::Notify { level: ide_core::event::NotifyLevel::Warning, body: Some(b), .. } if b == "careful"))
    })
    .await;
    let notifies = h.events.lock().iter().filter(|e| matches!(e, IdeEvent::Notify { .. })).count();
    assert_eq!(notifies, 2, "showMessageRequest error + showMessage warning; info is not surfaced");

    // Dynamically registered capability is now usable.
    s.respond(
        "textDocument/documentHighlight",
        json!([{ "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":3}}, "kind": 3 }]),
    );
    let hl = h.mgr.document_highlights(_doc, Pos::new(0, 1)).await.unwrap();
    assert_eq!(hl[0].kind, HighlightKind::Write);
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_tasks_and_busy_status() {
    let h = harness(&[("mock", incremental_caps())]);
    h.open("a.mk", "x");
    h.wait_status("mock", ServerStatus::Ready).await;
    let peer = h.launcher.state("mock").peer();
    peer.notify(
        "$/progress",
        json!({ "token": 1, "value": { "kind": "begin", "title": "Indexing", "percentage": 0 } }),
    )
    .unwrap();
    peer.notify(
        "$/progress",
        json!({ "token": 1, "value": { "kind": "report", "message": "3/10", "percentage": 30 } }),
    )
    .unwrap();
    h.wait_status("mock", ServerStatus::Busy).await;
    peer.notify("$/progress", json!({ "token": 1, "value": { "kind": "end" } })).unwrap();
    h.wait_status("mock", ServerStatus::Ready).await;
    let tasks: Vec<(String, Option<String>, Option<f32>, bool)> = h
        .events
        .lock()
        .iter()
        .filter_map(|e| match e {
            IdeEvent::Task { title, message, fraction, done, .. } => {
                Some((title.clone(), message.clone(), *fraction, *done))
            }
            _ => None,
        })
        .collect();
    assert_eq!(tasks.len(), 3);
    assert_eq!(tasks[0], ("Indexing".into(), None, Some(0.0), false));
    assert_eq!(tasks[1], ("Indexing".into(), Some("3/10".into()), Some(0.3), false));
    assert!(tasks[2].3);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_a_cancellable_progress_task_asks_the_server_to_stop() {
    let h = harness(&[("mock", incremental_caps())]);
    h.open("a.mk", "x");
    h.wait_status("mock", ServerStatus::Ready).await;
    let s = h.launcher.state("mock");
    let peer = s.peer();
    let begin = |token: Value, cancellable: bool| json!({ "token": token, "value": { "kind": "begin", "title": "Building", "cancellable": cancellable } });
    peer.notify("$/progress", begin(json!(7), true)).unwrap();
    peer.notify("$/progress", begin(json!("plain"), false)).unwrap();
    let task_of = |want: bool| {
        h.events.lock().iter().find_map(|e| match e {
            IdeEvent::Task { id, cancellable, done: false, .. } if *cancellable == want => Some(*id),
            _ => None,
        })
    };
    eventually(|| task_of(true).is_some() && task_of(false).is_some()).await;
    let (cancellable, plain) = (task_of(true).unwrap(), task_of(false).unwrap());
    assert!(!ide_core::task::cancel(plain), "the server did not offer to cancel it");
    assert!(ide_core::task::cancel(cancellable));
    eventually(|| !s.notified("window/workDoneProgress/cancel").is_empty()).await;
    assert_eq!(s.notified("window/workDoneProgress/cancel"), [json!({ "token": 7 })]);
    // Once it ended there is nothing left to cancel.
    peer.notify("$/progress", json!({ "token": 7, "value": { "kind": "end" } })).unwrap();
    eventually(|| {
        h.events.lock().iter().any(|e| matches!(e, IdeEvent::Task { id, done: true, .. } if *id == cancellable))
    })
    .await;
    assert!(!ide_core::task::cancel(cancellable));
}

#[tokio::test(flavor = "multi_thread")]
async fn angular_project_loading_shows_as_progress() {
    let h = harness(&[("mock", incremental_caps())]);
    h.open("a.mk", "x");
    h.wait_status("mock", ServerStatus::Ready).await;
    let peer = h.launcher.state("mock").peer();
    peer.notify("angular/projectLoadingStart", Value::Null).unwrap();
    h.wait_status("mock", ServerStatus::Busy).await;
    peer.notify("angular/projectLoadingFinish", Value::Null).unwrap();
    h.wait_status("mock", ServerStatus::Ready).await;
    let tasks: Vec<(String, bool)> = h
        .events
        .lock()
        .iter()
        .filter_map(|e| match e {
            IdeEvent::Task { title, done, .. } => Some((title.clone(), *done)),
            _ => None,
        })
        .collect();
    assert_eq!(tasks, [("Loading Angular project".into(), false), ("Loading Angular project".into(), true)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn crash_restarts_and_reopens_documents() {
    let h = harness(&[("mock", incremental_caps())]);
    let (doc, path) = h.open("a.mk", "one");
    h.wait_status("mock", ServerStatus::Ready).await;
    let s = h.launcher.state("mock");
    let uri = uri_of(&path);
    eventually(|| s.docs.lock().contains_key(&uri)).await;
    s.peer()
        .notify(
            "textDocument/publishDiagnostics",
            json!({ "uri": uri, "diagnostics": [
        { "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":1}}, "message": "e" }] }),
        )
        .unwrap();
    eventually(|| {
        h.events.lock().iter().any(|e| matches!(e, IdeEvent::Diagnostics { items, .. } if !items.is_empty()))
    })
    .await;

    // Edit while running, then crash.
    h.mgr.did_change(doc, 2, &[change(rng(0, 3, 0, 3), " two")], &|| unreachable!());
    eventually(|| s.docs.lock().get(&uri).map(String::as_str) == Some("one two")).await;
    s.peer().kill();

    eventually(|| h.statuses("mock").contains(&ServerStatus::Crashed)).await;
    // Diagnostics of the dead instance are withdrawn.
    eventually(|| h.events.lock().iter().any(|e| matches!(e, IdeEvent::Diagnostics { items, .. } if items.is_empty())))
        .await;
    eventually(|| s.launches.load(Ordering::SeqCst) == 2).await;
    h.wait_status("mock", ServerStatus::Ready).await;
    eventually(|| s.docs.lock().get(&uri).map(String::as_str) == Some("one two")).await;
    let opens = s.notified("textDocument/didOpen");
    assert_eq!(opens.last().unwrap()["textDocument"]["version"], 2);

    // Features work again on the new instance.
    s.respond("textDocument/hover", json!({ "contents": { "kind": "markdown", "value": "hi" } }));
    let hover = h.mgr.hover(doc, Pos::new(0, 1), Default::default()).await.unwrap().unwrap();
    assert_eq!(hover.contents.value, "hi");
}

#[tokio::test(flavor = "multi_thread")]
async fn gives_up_after_repeated_crashes_and_manual_restart_works() {
    let h = harness(&[("mock", incremental_caps())]);
    h.open("a.mk", "x");
    let s = h.launcher.state("mock");
    let count = |status| h.statuses("mock").iter().filter(|s| **s == status).count();
    for n in 1..=4 {
        // Counted, not the last status: a restart may already have replaced it.
        eventually(|| count(ServerStatus::Ready) == n).await;
        assert_eq!(s.launches.load(Ordering::SeqCst), n);
        s.peer().kill();
        eventually(|| count(ServerStatus::Crashed) == n).await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(s.launches.load(Ordering::SeqCst), 4, "initial start + 3 restarts");
    let last = h.events.lock().iter().rev().find_map(|e| match e {
        IdeEvent::LanguageServer { message, .. } => message.clone(),
        _ => None,
    });
    assert!(last.unwrap().contains("restart it manually"));

    let id = h.mgr.servers()[0].id;
    h.mgr.restart(id).await.unwrap();
    assert_eq!(s.launches.load(Ordering::SeqCst), 5);
    assert_eq!(h.mgr.servers()[0].status, ServerStatus::Ready);
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_server_reports_once() {
    let h = harness(&[("ghost", json!({}))]);
    h.launcher.state("ghost").missing.store(true, Ordering::SeqCst);
    let (doc, _) = h.open("a.mk", "x");
    h.wait_status("ghost", ServerStatus::Missing).await;
    h.open("b.mk", "y");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let missing: Vec<Option<String>> = h
        .events
        .lock()
        .iter()
        .filter_map(|e| match e {
            IdeEvent::LanguageServer { status: ServerStatus::Missing, message, .. } => Some(message.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(missing, vec![Some("install ghost".to_owned())]);
    let err = h.mgr.hover(doc, Pos::new(0, 0), Default::default()).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable);
    assert_eq!(h.mgr.document_symbols(doc).await.unwrap(), None);
    assert!(h.mgr.semantic_tokens(doc).await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn launch_error_fails_without_starting_the_server() {
    let h = harness(&[("mock", incremental_caps())]);
    h.mgr.set_config_hook(Box::new(|cfg, _| cfg.launch_error = Some("needs JDK 21".into())));
    assert!(!h.mgr.serves_path(&h.root.join("a.mk")), "batch inspection skips it");
    h.open("a.mk", "x");
    // Not a crash: nothing ran, the configuration has to change.
    h.wait_status("mock", ServerStatus::Misconfigured).await;
    assert_eq!(h.launcher.state("mock").launches.load(Ordering::SeqCst), 0);
    let reason = h.events.lock().iter().find_map(|e| match e {
        IdeEvent::LanguageServer { status: ServerStatus::Misconfigured, message, .. } => message.clone(),
        _ => None,
    });
    assert_eq!(reason.as_deref(), Some("needs JDK 21"));
    assert!(!h.statuses("mock").contains(&ServerStatus::Crashed));
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_changes_reach_servers_without_restarts() {
    let h = harness(&[("mock", incremental_caps()), ("extra", incremental_caps())]);
    let settings: Arc<Mutex<Option<Value>>> = Default::default();
    let disabled: Arc<Mutex<Vec<String>>> = Default::default();
    {
        let settings = settings.clone();
        h.mgr.set_config_hook(Box::new(move |cfg, _| cfg.settings = settings.lock().clone()));
    }
    {
        let disabled = disabled.clone();
        h.mgr.set_servers_hook(Box::new(move |_, defined| {
            defined.iter().filter(|c| !disabled.lock().contains(&c.name)).cloned().collect()
        }));
    }
    h.open("a.mk", "x");
    h.wait_status("mock", ServerStatus::Ready).await;
    h.wait_status("extra", ServerStatus::Ready).await;

    // Only `settings` changed: pushed to the running server, which keeps running.
    let s = h.launcher.state("mock");
    *settings.lock() = Some(json!({ "nested": { "other": 2 } }));
    h.mgr.reconfigure().await;
    eventually(|| !s.notified("workspace/didChangeConfiguration").is_empty()).await;
    assert_eq!(
        s.notified("workspace/didChangeConfiguration")[0],
        json!({ "settings": { "flag": true, "nested": { "deep": 1, "other": 2 } } })
    );
    assert_eq!(s.launches.load(Ordering::SeqCst), 1);
    let cfg: Value = s
        .peer()
        .request("workspace/configuration", json!({ "items": [{ "section": "nested.other" }] }), None)
        .await
        .unwrap();
    assert_eq!(cfg, json!([2]));

    // Disabled: stopped and forgotten; enabled again: attached to the open document.
    disabled.lock().push("extra".into());
    h.mgr.reconfigure().await;
    assert_eq!(h.mgr.servers().iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["mock"]);
    assert_eq!(h.statuses("extra").last(), Some(&ServerStatus::Stopped));
    assert!(h.removed("extra"));
    assert!(!h.removed("mock"));
    disabled.lock().clear();
    h.mgr.reconfigure().await;
    h.wait_status("extra", ServerStatus::Ready).await;
    eventually(|| h.launcher.state("extra").notified("textDocument/didOpen").len() == 2).await;
    assert_eq!(s.launches.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn fallback_servers_only_run_when_the_preferred_one_is_missing() {
    // Preferred installed: the alternative is never started.
    let h = harness_with_fallbacks(&[("main", incremental_caps()), ("alt", incremental_caps())], &["alt"]);
    let (doc, _) = h.open("a.mk", "x");
    h.wait_status("main", ServerStatus::Ready).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(h.statuses("alt").is_empty());
    assert!(h.mgr.hover(doc, Pos::new(0, 0), Default::default()).await.is_ok());

    // Preferred missing: open documents move to the alternative.
    let h = harness_with_fallbacks(&[("ghost", json!({})), ("alt", incremental_caps())], &["alt"]);
    h.launcher.state("ghost").missing.store(true, Ordering::SeqCst);
    let (doc, path) = h.open("a.mk", "x");
    h.wait_status("ghost", ServerStatus::Missing).await;
    h.wait_status("alt", ServerStatus::Ready).await;
    let uri = uri_of(&path);
    eventually(|| h.launcher.state("alt").docs.lock().contains_key(&uri)).await;
    let (_, other) = h.open("b.mk", "y");
    let other = uri_of(&other);
    eventually(|| h.launcher.state("alt").docs.lock().contains_key(&other)).await;
    assert!(h.mgr.hover(doc, Pos::new(0, 0), Default::default()).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_requiring_a_root_marker_serves_only_files_below_one() {
    // `framework` next to `main` (one instance for the whole project), like the
    // Angular server next to vtsls.
    let servers = [("main", incremental_caps()), ("framework", incremental_caps())];
    let h = harness_configured("mock", "mk", &servers, |cfg| match cfg.name.as_str() {
        "framework" => cfg.require_root_marker = true,
        _ => cfg.root_markers.clear(),
    });
    for dir in ["plain", "app"] {
        std::fs::create_dir_all(h.root.join(dir)).unwrap();
    }
    std::fs::write(h.root.join("app/mock.toml"), "").unwrap();
    let (_, plain) = h.open("plain/a.mk", "x");
    h.wait_status("main", ServerStatus::Ready).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(h.statuses("framework").is_empty());

    let (_, app) = h.open("app/b.mk", "y");
    h.wait_status("framework", ServerStatus::Ready).await;
    let framework = h.launcher.state("framework");
    eventually(|| framework.docs.lock().contains_key(&uri_of(&app))).await;
    assert!(!framework.docs.lock().contains_key(&uri_of(&plain)));
    eventually(|| h.launcher.state("main").docs.lock().len() == 2).await;

    // It stands in for no other server: with `ghost` missing, its fallback serves too.
    let servers = [("ghost", json!({})), ("framework", incremental_caps()), ("alt", incremental_caps())];
    let h = harness_configured("mock", "mk", &servers, |cfg| match cfg.name.as_str() {
        "framework" => cfg.require_root_marker = true,
        "alt" => cfg.fallback = true,
        _ => {}
    });
    h.launcher.state("ghost").missing.store(true, Ordering::SeqCst);
    std::fs::write(h.root.join("mock.toml"), "").unwrap();
    h.open("a.mk", "x");
    h.wait_status("framework", ServerStatus::Ready).await;
    h.wait_status("alt", ServerStatus::Ready).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fallback_leaves_when_the_preferred_server_is_enabled_again() {
    let h = harness_with_fallbacks(&[("main", incremental_caps()), ("alt", incremental_caps())], &["alt"]);
    let disabled: Arc<Mutex<Vec<String>>> = Default::default();
    {
        let disabled = disabled.clone();
        h.mgr.set_servers_hook(Box::new(move |_, defined| {
            defined.iter().filter(|c| !disabled.lock().contains(&c.name)).cloned().collect()
        }));
    }
    let (doc, path) = h.open("a.mk", "x");
    let uri = uri_of(&path);
    h.wait_status("main", ServerStatus::Ready).await;
    assert!(h.statuses("alt").is_empty());

    // Preferred disabled: the fallback takes over the open document.
    disabled.lock().push("main".into());
    h.mgr.reconfigure().await;
    h.wait_status("alt", ServerStatus::Ready).await;
    eventually(|| h.launcher.state("alt").docs.lock().contains_key(&uri)).await;
    assert_eq!(h.mgr.servers().iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["alt"]);
    assert!(h.removed("main"));

    // Enabled again: the fallback closes the document and stops.
    disabled.lock().clear();
    h.mgr.reconfigure().await;
    h.wait_status("main", ServerStatus::Ready).await;
    eventually(|| h.launcher.state("main").docs.lock().contains_key(&uri)).await;
    assert!(!h.launcher.state("alt").notified("textDocument/didClose").is_empty());
    assert_eq!(h.statuses("alt").last(), Some(&ServerStatus::Stopped));
    assert!(h.removed("alt"));
    assert_eq!(h.mgr.servers().iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["main"]);
    assert!(h.mgr.hover(doc, Pos::new(0, 0), Default::default()).await.is_ok());
    assert_eq!(h.launcher.state("alt").requested("textDocument/hover").len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn implementations_per_position() {
    let caps = json!({ "textDocumentSync": 1, "implementationProvider": true });
    let h = harness(&[("mock", caps)]);
    let (doc, path) = h.open("a.mk", "iface A {}\nimpl B {}\nimpl C {}\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    let s = h.launcher.state("mock");
    let uri = uri_of(&path);
    *s.responder.lock() = Some(Arc::new(move |_, method, params| {
        if method != "textDocument/implementation" {
            return None;
        }
        // Line 0 is implemented on lines 1 and 2; nothing else is.
        Some(match params["position"]["line"].as_u64() {
            Some(0) => json!([
                { "uri": uri, "range": {"start":{"line":1,"character":5},"end":{"line":1,"character":6}} },
                { "uri": uri, "range": {"start":{"line":2,"character":5},"end":{"line":2,"character":6}} },
            ]),
            _ => json!([]),
        })
    }));
    let found = h.mgr.implementations(doc, &[Pos::new(0, 6), Pos::new(1, 5)], Default::default()).await.unwrap();
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].iter().map(|l| l.range.start.line).collect::<Vec<_>>(), vec![1, 2]);
    assert!(found[1].is_empty());
    assert!(h.mgr.implementations(doc, &[], Default::default()).await.unwrap().is_empty());

    let cancel = ide_core::CancellationToken::new();
    cancel.cancel();
    let err = h.mgr.implementations(doc, &[Pos::new(0, 6)], cancel).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);
}

#[tokio::test(flavor = "multi_thread")]
async fn navigation_rename_format_and_decorations() {
    let h = harness(&[("mock", incremental_caps())]);
    let (doc, path) = h.open("a.mk", "fn foo() {}\nfoo();\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    let s = h.launcher.state("mock");
    let uri = uri_of(&path);
    let r = |l0: u32, c0: u32, l1: u32, c1: u32| json!({"start":{"line":l0,"character":c0},"end":{"line":l1,"character":c1}});

    s.respond(
        "textDocument/definition",
        json!([{ "targetUri": uri, "targetRange": r(0,0,0,11), "targetSelectionRange": r(0,3,0,6) }]),
    );
    let defs = h.mgr.goto(doc, Pos::new(1, 1), GotoKind::Definition).await.unwrap();
    assert_eq!(defs, vec![ide_core::Location::file(path.clone(), rng(0, 3, 0, 6))]);
    let err = h.mgr.goto(doc, Pos::new(1, 1), GotoKind::TypeDefinition).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Unavailable);

    s.respond("textDocument/references", json!([{ "uri": uri, "range": r(0,3,0,6) }, { "uri": uri, "range": r(1,0,1,3) }, { "uri": uri, "range": r(1,0,1,3) }]));
    let refs = h.mgr.references(doc, Pos::new(1, 1), true, true, Default::default()).await.unwrap().locations;
    assert_eq!(refs.len(), 2);
    assert_eq!(s.requested("textDocument/references")[0]["context"]["includeDeclaration"], true);

    s.respond("textDocument/prepareRename", json!({ "range": r(1,0,1,3), "placeholder": "foo" }));
    assert_eq!(h.mgr.prepare_rename(doc, Pos::new(1, 1)).await.unwrap(), Some(rng(1, 0, 1, 3)));
    s.respond("textDocument/rename", json!({ "changes": { uri.clone(): [{ "range": r(0,3,0,6), "newText": "bar" }, { "range": r(1,0,1,3), "newText": "bar" }] } }));
    let edit = h.mgr.rename(doc, Pos::new(1, 1), "bar".into()).await.unwrap();
    assert!(matches!(&edit.files[0], FileEdit::Edit { edits, .. } if edits.len() == 2));
    assert_eq!(s.requested("textDocument/rename")[0]["newName"], "bar");

    s.respond("textDocument/formatting", json!([{ "range": r(0,10,0,11), "newText": "\n}" }]));
    let edits = h.mgr.format(doc, None, FormatOptions { tab_size: 2, insert_spaces: true }).await.unwrap();
    assert_eq!(edits[0].range, rng(0, 10, 0, 11));
    assert_eq!(s.requested("textDocument/formatting")[0]["options"], json!({ "tabSize": 2, "insertSpaces": true }));
    assert!(
        h.mgr.format(doc, Some(rng(0, 0, 1, 0)), FormatOptions { tab_size: 2, insert_spaces: true }).await.is_err()
    );

    s.respond("textDocument/semanticTokens/full", json!({ "data": [0, 3, 3, 0, 1, 1, 0, 3, 0, 0] }));
    let tokens = h.mgr.semantic_tokens(doc).await.unwrap().unwrap();
    assert_eq!(tokens.data, vec![0, 3, 3, 0, 1, 1, 0, 3, 0, 0]);
    assert_eq!(tokens.token_types, vec!["function", "variable"]);

    s.respond("textDocument/codeLens", json!([{ "range": r(0,0,0,2), "data": 1 }, { "range": r(1,0,1,2), "command": { "title": "Run", "command": "mock.run" } }]));
    s.respond(
        "codeLens/resolve",
        json!({ "range": r(0,0,0,2), "command": { "title": "1 reference", "command": "mock.refs" } }),
    );
    let lenses = h.mgr.code_lens(doc).await.unwrap();
    assert_eq!(lenses.len(), 2);
    assert_eq!(lenses[0].command.as_ref().unwrap().title, "1 reference");
    assert_eq!(s.requested("codeLens/resolve").len(), 1);

    s.respond(
        "textDocument/inlayHint",
        json!([{ "position": {"line":1,"character":5}, "label": [{"value": "x:"}], "kind": 2, "paddingRight": true }]),
    );
    let hints = h.mgr.inlay_hints(doc, rng(0, 0, 2, 0)).await.unwrap();
    assert_eq!(hints[0].label, "x:");
    assert_eq!(hints[0].kind, InlayKind::Parameter);

    // Nothing to prepare at the position: NotFound, so the UI can retry at the enclosing declaration.
    s.respond("textDocument/prepareCallHierarchy", json!(null));
    let err = h.mgr.call_hierarchy(doc, Pos::new(0, 1), HierarchyDirection::Incoming).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::NotFound);

    let item = json!({ "name": "foo", "kind": 12, "uri": uri, "range": r(0,0,0,11), "selectionRange": r(0,3,0,6), "data": "id" });
    s.respond("textDocument/prepareCallHierarchy", json!([item]));
    s.respond("callHierarchy/incomingCalls", json!([{ "from": { "name": "main", "kind": 12, "uri": uri, "range": r(1,0,1,6), "selectionRange": r(1,0,1,3) }, "fromRanges": [r(1,0,1,3)] }]));
    let calls = h.mgr.call_hierarchy(doc, Pos::new(0, 4), HierarchyDirection::Incoming).await.unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "main");
    assert_eq!(calls[0].from_ranges, vec![rng(1, 0, 1, 3)]);
    assert_eq!(s.requested("callHierarchy/incomingCalls")[0]["item"]["data"], "id");

    // No documentSymbolProvider → None so callers fall back to tree-sitter.
    assert_eq!(h.mgr.document_symbols(doc).await.unwrap(), None);
}

/// The edits of `edit` in `path`, by range.
fn edits_in(edit: &WorkspaceEdit, path: &Path) -> Vec<(Range, String)> {
    edit.files
        .iter()
        .filter_map(|f| match f {
            FileEdit::Edit { path: p, edits } if p.to_path_buf() == path => {
                Some(edits.iter().map(|e| (e.range, e.new_text.clone())))
            }
            _ => None,
        })
        .flatten()
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn rename_merges_the_servers_that_can_rename_there() {
    // `ts` can't rename inside a template string (its `prepareRename` is null), `ng` can.
    let h = harness(&[("ts", incremental_caps()), ("ng", incremental_caps())]);
    let (doc, path) = h.open("a.mk", "template: `{{ title }}`\ntitle = 1\n");
    h.wait_status("ts", ServerStatus::Ready).await;
    h.wait_status("ng", ServerStatus::Ready).await;
    let html = h.root.join("a.html");
    let (uri, html_uri) = (uri_of(&path), uri_of(&html));
    let r = |l: u32, c0: u32, c1: u32| json!({"start":{"line":l,"character":c0},"end":{"line":l,"character":c1}});
    let ng = h.launcher.state("ng");
    ng.respond("textDocument/prepareRename", json!({ "range": r(0, 14, 19), "placeholder": "title" }));
    ng.respond(
        "textDocument/rename",
        json!({ "changes": {
            uri.clone(): [{ "range": r(0, 14, 19), "newText": "heading" }, { "range": r(1, 0, 5), "newText": "heading" }],
            html_uri: [{ "range": r(0, 3, 8), "newText": "heading" }],
        } }),
    );

    assert_eq!(h.mgr.prepare_rename(doc, Pos::new(0, 15)).await.unwrap(), Some(rng(0, 14, 0, 19)));
    let edit = h.mgr.rename(doc, Pos::new(0, 15), "heading".into()).await.unwrap();
    assert_eq!(edits_in(&edit, &path).len(), 2);
    assert!(h.launcher.state("ts").requested("textDocument/rename").is_empty());

    // Both can rename the declaration: `ng` adds what `ts` doesn't see, and
    // `ts`'s own edits win where both change the same text.
    let ts = h.launcher.state("ts");
    ts.respond("textDocument/prepareRename", json!({ "range": r(1, 0, 5), "placeholder": "title" }));
    ts.respond(
        "textDocument/rename",
        json!({ "changes": { uri: [{ "range": r(1, 0, 5), "newText": "heading: x" }] } }),
    );
    let edit = h.mgr.rename(doc, Pos::new(1, 2), "heading".into()).await.unwrap();
    assert_eq!(edits_in(&edit, &path), [(rng(0, 14, 0, 19), "heading".into()), (rng(1, 0, 1, 5), "heading: x".into())]);
    assert_eq!(edits_in(&edit, &html), [(rng(0, 3, 0, 8), "heading".into())]);
}

#[tokio::test(flavor = "multi_thread")]
async fn angular_server_is_asked_about_typescript_only_in_component_templates() {
    let servers = [("vtsls", incremental_caps()), ("angular-language-server", incremental_caps())];
    let h = harness_for("typescript", "ts", &servers, &[]);
    let (doc, _) = h.open("a.ts", "@Component({ template: '<p>{{ title }}</p>' })\nclass A { title = 1; }\n");
    h.wait_status("vtsls", ServerStatus::Ready).await;
    h.wait_status("angular-language-server", ServerStatus::Ready).await;
    let ng = h.launcher.state("angular-language-server");
    let asked = |method: &str| ng.requested(method).len();
    let mgr = &h.mgr;
    let ask = |pos: Pos| async move {
        mgr.completion(doc, pos, None, Default::default()).await.unwrap();
        mgr.hover(doc, pos, Default::default()).await.unwrap();
        mgr.goto(doc, pos, GotoKind::Definition).await.unwrap();
    };

    // In the class: vtsls alone, though it has no answer.
    ask(Pos::new(1, 12)).await;
    assert_eq!(
        (asked("textDocument/completion"), asked("textDocument/hover"), asked("textDocument/definition")),
        (0, 0, 0)
    );
    // In the template: the Angular server too.
    ask(Pos::new(0, 31)).await;
    assert_eq!(
        (asked("textDocument/completion"), asked("textDocument/hover"), asked("textDocument/definition")),
        (1, 1, 1)
    );

    // Inlay hints only where Angular is imported.
    let lines = rng(0, 0, 2, 0);
    h.mgr.inlay_hints(doc, lines).await.unwrap();
    assert_eq!(asked("textDocument/inlayHint"), 0);
    let (doc, _) = h.open("b.ts", "import { Component } from '@angular/core';\n");
    h.mgr.inlay_hints(doc, lines).await.unwrap();
    assert_eq!(asked("textDocument/inlayHint"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn angular_references_leave_out_the_declaration_unless_asked() {
    let servers = [("vtsls", incremental_caps()), ("angular-language-server", incremental_caps())];
    let h = harness_for("typescript", "ts", &servers, &[]);
    let (doc, path) = h.open("a.ts", "class A { title = 1; }\n");
    h.wait_status("vtsls", ServerStatus::Ready).await;
    h.wait_status("angular-language-server", ServerStatus::Ready).await;
    let html = h.root.join("a.html");
    let declaration =
        json!({ "uri": uri_of(&path), "range": {"start":{"line":0,"character":10},"end":{"line":0,"character":15}} });
    let usage =
        json!({ "uri": uri_of(&html), "range": {"start":{"line":0,"character":3},"end":{"line":0,"character":8}} });
    // Like ngserver, it lists the declaration whatever `includeDeclaration` says;
    // vtsls knows where it is.
    let ng = h.launcher.state("angular-language-server");
    ng.respond("textDocument/references", json!([declaration, usage]));
    let vtsls = h.launcher.state("vtsls");
    vtsls.respond("textDocument/definition", json!([declaration]));

    let mgr = &h.mgr;
    let found = |include_declaration: bool| async move {
        let refs = mgr.references(doc, Pos::new(0, 11), include_declaration, false, Default::default()).await;
        let mut v: Vec<(PathBuf, Range)> =
            refs.unwrap().locations.iter().map(|l| (l.path.to_path_buf(), l.range)).collect();
        v.sort();
        v
    };
    assert_eq!(found(false).await, [(html.clone(), rng(0, 3, 0, 8))]);
    assert_eq!(found(true).await, [(html, rng(0, 3, 0, 8)), (path, rng(0, 10, 0, 15))]);
    assert_eq!(vtsls.requested("textDocument/definition").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn utf8_server_positions_are_converted() {
    let h = harness(&[(
        "u8",
        json!({ "positionEncoding": "utf-8", "textDocumentSync": 2, "hoverProvider": true, "definitionProvider": true }),
    )]);
    let (doc, path) = h.open("a.mk", "é😀x = é😀x\n");
    h.wait_status("u8", ServerStatus::Ready).await;
    let s = h.launcher.state("u8");
    let uri = uri_of(&path);
    s.respond(
        "textDocument/definition",
        json!([{ "uri": uri, "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":7}} }]),
    );
    // UTF-16 col 3 ("x" after "é😀") is byte 6.
    let defs = h.mgr.goto(doc, Pos::new(0, 3), GotoKind::Definition).await.unwrap();
    assert_eq!(s.requested("textDocument/definition")[0]["position"], json!({ "line": 0, "character": 6 }));
    assert_eq!(defs[0].range, rng(0, 0, 0, 4));
    // didChange ranges are converted too.
    h.mgr.did_change(doc, 2, &[change(rng(0, 4, 0, 4), "y")], &|| unreachable!());
    eventually(|| !s.notified("textDocument/didChange").is_empty()).await;
    assert_eq!(s.notified("textDocument/didChange")[0]["contentChanges"][0]["range"]["start"]["character"], 7);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_is_propagated() {
    let h = harness(&[("mock", incremental_caps())]);
    let (doc, _) = h.open("a.mk", "x");
    h.wait_status("mock", ServerStatus::Ready).await;
    let token = ide_core::CancellationToken::new();
    token.cancel();
    let err = h.mgr.hover(doc, Pos::new(0, 0), token).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);
}

#[tokio::test(flavor = "multi_thread")]
async fn code_action_query_reports_advertised_kinds_and_cancels() {
    let mut caps = incremental_caps();
    caps["codeActionProvider"] = json!({ "codeActionKinds": ["quickfix", "refactor.extract", "refactor.inline"] });
    let h = harness(&[("mock", caps)]);
    let (doc, _) = h.open("a.mk", "let x = 1;\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    let s = h.launcher.state("mock");
    s.respond(
        "textDocument/codeAction",
        json!([{ "title": "Extract into variable", "kind": "refactor.extract.variable" }]),
    );

    let q = h
        .mgr
        .code_action_query(doc, rng(0, 8, 0, 9), vec!["refactor".into()], ide_core::CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(q.actions.len(), 1);
    assert_eq!(q.actions[0].kind.as_deref(), Some("refactor.extract.variable"));
    assert_eq!(q.advertised_kinds, Some(vec!["quickfix".into(), "refactor.extract".into(), "refactor.inline".into()]));
    assert_eq!(s.requested("textDocument/codeAction")[0]["context"]["only"], json!(["refactor"]));

    let token = ide_core::CancellationToken::new();
    token.cancel();
    let err = h.mgr.code_action_query(doc, rng(0, 8, 0, 9), vec![], token).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);
}

#[tokio::test(flavor = "multi_thread")]
async fn code_action_query_without_listed_kinds() {
    let h = harness(&[("mock", incremental_caps())]);
    let (doc, _) = h.open("a.mk", "x");
    h.wait_status("mock", ServerStatus::Ready).await;
    let q = h.mgr.code_action_query(doc, rng(0, 0, 0, 0), vec![], ide_core::CancellationToken::new()).await.unwrap();
    assert!(q.actions.is_empty());
    assert_eq!(q.advertised_kinds, None, "`codeActionProvider` without `codeActionKinds` may return any kind");
}

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_all_stops_gracefully() {
    let h = harness(&[("mock", incremental_caps())]);
    h.open("a.mk", "x");
    h.wait_status("mock", ServerStatus::Ready).await;
    let s = h.launcher.state("mock");
    tokio::time::timeout(Duration::from_secs(5), h.mgr.shutdown_all()).await.unwrap();
    assert_eq!(s.requested("shutdown").len(), 1);
    assert_eq!(s.notified("exit").len(), 1);
    assert_eq!(h.statuses("mock").last(), Some(&ServerStatus::Stopped));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(s.launches.load(Ordering::SeqCst), 1, "no restart after shutdown");
    // Opening more documents after shutdown does not start servers.
    h.open("b.mk", "y");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(s.launches.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn noop_handler_is_usable_for_raw_peers() {
    // Sanity check that the public jsonrpc API composes with the launcher seam.
    let (a, b) = tokio::io::duplex(1024);
    let (ar, aw) = tokio::io::split(a);
    let (br, bw) = tokio::io::split(b);
    let _server = Peer::connect(br, bw, Arc::new(MockHandler(Arc::default())));
    let client = Peer::connect(ar, aw, Arc::new(NoopHandler));
    let v: Value = client.request("shutdown", (), None).await.unwrap();
    assert_eq!(v, Value::Null);
}

// ------------------------------------------------------------------ virtual documents

#[tokio::test(flavor = "multi_thread")]
async fn virtual_locations_and_text_document_content() {
    let mut caps = incremental_caps();
    caps["typeHierarchyProvider"] = json!(true);
    caps["workspace"] = json!({ "textDocumentContent": { "schemes": ["mocklib"] } });
    let h = harness(&[("mock", caps)]);
    let (doc, path) = h.open("a.mk", "use Thing;\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    let s = h.launcher.state("mock");
    let r = |l0: u32, c0: u32, l1: u32, c1: u32| json!({"start":{"line":l0,"character":c0},"end":{"line":l1,"character":c1}});
    let lib = "mocklib://deps/lib-1.0/Thing.mk";

    // Non-file targets are kept (as virtual locations) instead of dropped.
    s.respond("textDocument/definition", json!({ "uri": lib, "range": r(2, 4, 2, 9) }));
    let defs = h.mgr.goto(doc, Pos::new(0, 5), GotoKind::Definition).await.unwrap();
    assert_eq!(defs, vec![ide_core::Location { path: lib.into(), range: rng(2, 4, 2, 9), uri: Some(lib.to_owned()) }]);
    s.respond(
        "textDocument/references",
        json!([{ "uri": uri_of(&path), "range": r(0, 4, 0, 9) }, { "uri": lib, "range": r(2, 4, 2, 9) }]),
    );
    let refs = h.mgr.references(doc, Pos::new(0, 5), true, true, Default::default()).await.unwrap().locations;
    assert_eq!(refs.iter().map(|l| l.uri.is_some()).collect::<Vec<_>>(), vec![false, true]);
    s.respond(
        "textDocument/prepareTypeHierarchy",
        json!([{ "name": "Thing", "kind": 5, "uri": uri_of(&path), "range": r(0,0,0,1), "selectionRange": r(0,0,0,1) }]),
    );
    s.respond(
        "typeHierarchy/supertypes",
        json!([{ "name": "Base", "kind": 5, "uri": lib, "range": r(1,0,3,1), "selectionRange": r(1,6,1,10) }]),
    );
    let supers = h.mgr.type_hierarchy(doc, Pos::new(0, 5), HierarchyDirection::Incoming).await.unwrap();
    assert_eq!(supers[0].uri.as_deref(), Some(lib));
    assert_eq!(supers[0].selection_range, rng(1, 6, 1, 10));

    // Contents come from `workspace/textDocumentContent` and are cached.
    s.respond("workspace/textDocumentContent", json!({ "text": "// lib\npub struct Base;\npub struct Thing;\n" }));
    let vd = h.mgr.virtual_document(lib).await.unwrap();
    assert_eq!(vd.title, "Thing.mk");
    assert_eq!(vd.language_id.as_str(), "mock");
    assert!(!vd.decompiled);
    assert_eq!(h.mgr.virtual_document(lib).await.unwrap(), vd);
    let asked = s.requested("workspace/textDocumentContent");
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["uri"], lib);

    // Opened read-only on the owning server: didOpen with the URI, requests
    // inside it use it, closing sends didClose; never didChange.
    let vdoc = DocId::next();
    h.mgr.did_open_virtual(vdoc, lib, &vd.language_id, 0, &vd.text);
    eventually(|| s.docs.lock().contains_key(lib)).await;
    s.respond("textDocument/hover", json!({ "contents": { "kind": "markdown", "value": "struct Thing" } }));
    let hover = h.mgr.hover(vdoc, Pos::new(2, 12), Default::default()).await.unwrap().unwrap();
    assert_eq!(hover.contents.value, "struct Thing");
    assert_eq!(s.requested("textDocument/hover").last().unwrap()["textDocument"]["uri"], lib);
    h.mgr.did_close(vdoc);
    eventually(|| !s.docs.lock().contains_key(lib)).await;
    assert!(s.notified("textDocument/didChange").iter().all(|p| p["textDocument"]["uri"] != lib));

    // Unknown schemes nobody serves fail cleanly.
    assert!(h.mgr.virtual_document("other://x/y.mk").await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn jdt_class_file_contents() {
    let h = harness_for("java", "java", &[("jdtls", incremental_caps())], &[]);
    let (doc, _) = h.open("App.java", "import org.example.Lib;\n");
    h.wait_status("jdtls", ServerStatus::Ready).await;
    let s = h.launcher.state("jdtls");
    let jdt = "jdt://contents/lib-1.0.jar/org.example/Lib.class?=demo/%5C/m2%5C/lib-1.0.jar%3Corg.example%28Lib.class";
    s.respond(
        "textDocument/definition",
        json!([{ "uri": jdt, "range": { "start": { "line": 3, "character": 13 }, "end": { "line": 3, "character": 16 } } }]),
    );
    let defs = h.mgr.goto(doc, Pos::new(0, 20), GotoKind::Definition).await.unwrap();
    assert_eq!(defs[0].uri.as_deref(), Some(jdt));

    s.respond(
        "java/classFileContents",
        json!("// Source code is unavailable, and was generated by the Fernflower decompiler.\npackage org.example;\n\npublic class Lib {}\n"),
    );
    let vd = h.mgr.virtual_document(jdt).await.unwrap();
    assert_eq!(s.requested("java/classFileContents")[0], json!({ "uri": jdt }));
    assert!(vd.decompiled);
    assert_eq!(vd.title, "Lib.class");
    assert_eq!(vd.language_id.as_str(), "java");
    assert_eq!(vd.description.as_deref(), Some("/m2/lib-1.0.jar"));
}

#[tokio::test(flavor = "multi_thread")]
async fn will_and_did_rename_files_honour_filters() {
    let mut caps = incremental_caps();
    caps["workspace"] = json!({ "fileOperations": {
        "willRename": { "filters": [
            { "scheme": "file", "pattern": { "glob": "**/*.mk", "matches": "file" } },
            { "scheme": "file", "pattern": { "glob": "**", "matches": "folder" } }
        ] },
        "didRename": { "filters": [{ "pattern": { "glob": "**/*.mk" } }] }
    }});
    let h = harness(&[("mock", caps)]);
    std::fs::create_dir_all(h.root.join("pkg")).unwrap();
    let util = h.root.join("pkg/util.mk");
    let main = h.root.join("main.mk");
    std::fs::write(&util, "fn util() {}\n").unwrap();
    std::fs::write(&main, "use pkg/util;\n").unwrap();
    let s = h.launcher.state("mock");
    let r = |l0: u32, c0: u32, l1: u32, c1: u32| json!({"start":{"line":l0,"character":c0},"end":{"line":l1,"character":c1}});
    s.respond(
        "workspace/willRenameFiles",
        json!({ "changes": { uri_of(&main): [{ "range": r(0,4,0,7), "newText": "lib" }] } }),
    );

    // Nothing open yet: the server is started for the moved file's language,
    // and the file is opened just for the request (tsserver needs a project).
    let to = h.root.join("lib/util.mk");
    let result =
        h.mgr.will_rename_files(&[(util.clone(), to.clone())], ide_core::CancellationToken::new()).await.unwrap();
    assert_eq!(result.servers, vec!["mock".to_owned()]);
    assert!(result.errors.is_empty());
    match &result.edit.files[..] {
        [FileEdit::Edit { path, edits }] => {
            assert_eq!(path, &main);
            assert_eq!(edits[0].range, rng(0, 4, 0, 7));
            assert_eq!(edits[0].new_text, "lib");
        }
        other => panic!("unexpected edit {other:?}"),
    }
    let req = &s.requested("workspace/willRenameFiles")[0];
    assert_eq!(req["files"], json!([{ "oldUri": uri_of(&util), "newUri": uri_of(&to) }]));
    assert_eq!(s.notified("textDocument/didOpen")[0]["textDocument"]["uri"], uri_of(&util));
    eventually(|| !s.notified("textDocument/didClose").is_empty()).await;
    assert_eq!(s.notified("textDocument/didClose")[0]["textDocument"]["uri"], uri_of(&util));

    // Folders match the folder filter; files of other types match nothing.
    let dir_to = h.root.join("lib");
    h.mgr.will_rename_files(&[(h.root.join("pkg"), dir_to.clone())], ide_core::CancellationToken::new()).await.unwrap();
    assert_eq!(s.requested("workspace/willRenameFiles")[1]["files"][0]["newUri"], uri_of(&dir_to));
    let txt = h.root.join("notes.txt");
    std::fs::write(&txt, "x").unwrap();
    let none = h
        .mgr
        .will_rename_files(&[(txt.clone(), h.root.join("n.txt"))], ide_core::CancellationToken::new())
        .await
        .unwrap();
    assert!(none.servers.is_empty() && none.edit.files.is_empty());
    assert_eq!(s.requested("workspace/willRenameFiles").len(), 2);

    // didRenameFiles after the move, filtered the same way.
    std::fs::create_dir_all(h.root.join("lib")).unwrap();
    std::fs::rename(&util, &to).unwrap();
    std::fs::rename(&txt, h.root.join("n.txt")).unwrap();
    h.mgr.did_rename_files(&[(util.clone(), to.clone()), (txt, h.root.join("n.txt"))]);
    eventually(|| !s.notified("workspace/didRenameFiles").is_empty()).await;
    assert_eq!(
        s.notified("workspace/didRenameFiles")[0]["files"],
        json!([{ "oldUri": uri_of(&util), "newUri": uri_of(&to) }])
    );

    // Servers without fileOperations are never asked.
    let plain = harness(&[("plain", incremental_caps())]);
    let f = plain.root.join("a.mk");
    std::fs::write(&f, "x").unwrap();
    let r = plain
        .mgr
        .will_rename_files(&[(f.clone(), plain.root.join("b.mk"))], ide_core::CancellationToken::new())
        .await
        .unwrap();
    assert!(r.servers.is_empty());
    assert!(plain.launcher.state("plain").requested("workspace/willRenameFiles").is_empty());
    assert_eq!(
        s.requested("initialize")[0]["capabilities"]["workspace"]["fileOperations"],
        json!({ "dynamicRegistration": true, "willRename": true, "didRename": true })
    );
}

// ------------------------------------------------------------------ inspect code

struct InspectTestHost {
    mgr: Arc<LspManager>,
    lang: LanguageId,
}

impl ide_lsp::InspectHost for InspectTestHost {
    fn open(&self, path: &Path) -> ide_core::IdeResult<(DocId, bool)> {
        let text = std::fs::read_to_string(path).map_err(|e| ide_core::IdeError::internal(e.to_string()))?;
        let doc = DocId::next();
        self.mgr.did_open(doc, path, &self.lang, 1, &text);
        Ok((doc, false))
    }
    fn close(&self, doc: DocId) {
        self.mgr.did_close(doc);
    }
}

fn inspect_opts() -> ide_lsp::InspectOptions {
    ide_lsp::InspectOptions { concurrency: 2, timeout: Duration::from_secs(5), settle: Duration::from_millis(50) }
}

async fn inspect(h: &Harness, lang: &str, files: Vec<PathBuf>) -> Vec<(PathBuf, ide_lsp::FileInspection)> {
    let host = Arc::new(InspectTestHost { mgr: h.mgr.clone(), lang: LanguageId::new(lang) });
    let out = Mutex::new(Vec::new());
    h.mgr
        .inspect_files(host, files, inspect_opts(), ide_core::CancellationToken::new(), &|p, r| out.lock().push((p, r)))
        .await;
    let mut out = out.into_inner();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn inspect_waits_for_published_diagnostics_and_closes_files() {
    let h = harness(&[("mock", incremental_caps())]);
    let a = h.root.join("a.mk");
    let b = h.root.join("b.mk");
    std::fs::write(&a, "let unused = 1;\n").unwrap();
    std::fs::write(&b, "ok\n").unwrap();
    let s = h.launcher.state("mock");
    // The "server" publishes for every file it gets opened: one problem in a.mk, none in b.mk.
    let publisher = {
        let s = s.clone();
        let (a, b) = (a.clone(), b.clone());
        tokio::spawn(async move {
            let mut done = Vec::new();
            for _ in 0..500 {
                for open in s.notified("textDocument/didOpen") {
                    let uri = open["textDocument"]["uri"].as_str().unwrap().to_owned();
                    if done.contains(&uri) {
                        continue;
                    }
                    let diags = if uri == uri_of(&a) {
                        json!([{ "range": {"start":{"line":0,"character":4},"end":{"line":0,"character":10}},
                                 "severity": 2, "message": "unused variable" }])
                    } else {
                        assert_eq!(uri, uri_of(&b));
                        json!([])
                    };
                    s.peer()
                        .notify("textDocument/publishDiagnostics", json!({ "uri": uri, "diagnostics": diags }))
                        .unwrap();
                    done.push(uri);
                }
                if done.len() == 2 {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
    };
    let results = inspect(&h, "mock", vec![a.clone(), b.clone()]).await;
    publisher.await.unwrap();
    assert_eq!(results.len(), 2);
    match &results[0].1 {
        ide_lsp::FileInspection::Inspected(items) => {
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].message, "unused variable");
            assert_eq!(items[0].severity, Severity::Warning);
            assert_eq!(items[0].source.as_deref(), Some("mock"));
            assert_eq!(items[0].range, rng(0, 4, 0, 10));
        }
        other => panic!("unexpected {other:?}"),
    }
    assert!(matches!(&results[1].1, ide_lsp::FileInspection::Inspected(items) if items.is_empty()));
    // Transient documents are closed again.
    eventually(|| s.notified("textDocument/didClose").len() == 2).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn inspect_pulls_diagnostics_when_the_server_supports_it() {
    let mut caps = incremental_caps();
    caps["diagnosticProvider"] = json!({ "interFileDependencies": false, "workspaceDiagnostics": false });
    let h = harness(&[("mock", caps)]);
    let a = h.root.join("a.mk");
    std::fs::write(&a, "x\n").unwrap();
    let s = h.launcher.state("mock");
    s.respond(
        "textDocument/diagnostic",
        json!({ "kind": "full", "items": [{ "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":1}},
                                           "severity": 1, "message": "bad x", "source": "mockc" }] }),
    );
    let results = inspect(&h, "mock", vec![a.clone()]).await;
    match &results[0].1 {
        ide_lsp::FileInspection::Inspected(items) => {
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].severity, Severity::Error);
            assert_eq!(items[0].source.as_deref(), Some("mockc"));
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(s.requested("textDocument/diagnostic")[0]["textDocument"]["uri"], json!(uri_of(&a)));
}

#[tokio::test(flavor = "multi_thread")]
async fn inspect_reports_files_without_a_server() {
    let h = harness(&[("mock", incremental_caps())]);
    let txt = h.root.join("notes.txt");
    std::fs::write(&txt, "hello\n").unwrap();
    assert!(!h.mgr.serves_path(&txt));
    assert!(h.mgr.serves_path(&h.root.join("a.mk")));
    let results = inspect(&h, "plaintext", vec![txt]).await;
    assert!(matches!(results[0].1, ide_lsp::FileInspection::NoServer));
}

#[tokio::test(flavor = "multi_thread")]
async fn css_family_configuration_returns_default_objects() {
    for language in ["css", "scss", "less"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let registry = Arc::new(LanguageRegistry::load(None).unwrap());
        let launcher = Arc::new(MockLauncher::default());
        let state = launcher.state("vscode-css-language-server");
        *state.caps.lock() = incremental_caps();
        let mgr = LspManager::with_launcher(root.clone(), registry, Arc::new(|_| {}), launcher);
        let path = root.join(format!("a.{language}"));
        let text = ".qa { colr: red; }";
        std::fs::write(&path, text).unwrap();
        mgr.did_open(DocId::next(), &path, &LanguageId::new(language), 1, text);
        eventually(|| !state.notified("textDocument/didOpen").is_empty()).await;
        let reply: Value = state
            .peer()
            .request(
                "workspace/configuration",
                json!({ "items": [
            { "section": "css", "scopeUri": uri_of(&path) },
            { "section": "scss", "scopeUri": uri_of(&path) },
            { "section": "less", "scopeUri": uri_of(&path) },
            { "section": "unknown" }
        ] }),
                None,
            )
            .await
            .unwrap();
        assert_eq!(reply, json!([{}, {}, {}, null]), "{language}");
        assert_eq!(state.requested("initialize")[0]["initializationOptions"]["provideFormatter"], true);
    }
}

// ------------------------------------------------------------------ references beyond the analysis scope

const WORD: &str = "target";

/// Locations of [`WORD`] in `text` (ASCII, so UTF-16 columns are byte offsets).
fn occurrences(uri: &str, text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for (line, l) in text.lines().enumerate() {
        for (col, _) in l.match_indices(WORD) {
            let end = col + WORD.len();
            out.push(json!({ "uri": uri, "range": {
                "start": { "line": line, "character": col }, "end": { "line": line, "character": end } } }));
        }
    }
    out
}

/// A server that only analyses its open documents (minus `blind` URIs), like
/// Pyright for files outside its `include`.
fn open_files_only(blind: Vec<String>) -> Responder {
    Arc::new(move |s, method, _| {
        let docs: Vec<(String, String)> =
            s.docs.lock().iter().filter(|(u, _)| !blind.contains(u)).map(|(u, t)| (u.clone(), t.clone())).collect();
        let locs = || docs.iter().flat_map(|(u, t)| occurrences(u, t));
        match method {
            "textDocument/references" => Some(Value::Array(locs().collect())),
            "textDocument/rename" => {
                let mut changes = serde_json::Map::new();
                for loc in locs() {
                    let edits = changes.entry(loc["uri"].as_str().unwrap()).or_insert_with(|| json!([]));
                    edits.as_array_mut().unwrap().push(json!({ "range": loc["range"], "newText": "renamed" }));
                }
                Some(json!({ "changes": changes }))
            }
            _ => None,
        }
    })
}

/// Candidate files: those directly under the root that contain the word; records the queries.
fn grep_candidates(h: &Harness) -> Arc<Mutex<Vec<ide_lsp::CandidateQuery>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    h.mgr.set_candidates_hook(Box::new(move |q, _| {
        log.lock().push(q.clone());
        let mut files: Vec<PathBuf> = std::fs::read_dir(&q.root)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| std::fs::read_to_string(p).is_ok_and(|t| t.contains(&q.word)))
            .collect();
        files.sort();
        ide_lsp::CandidateFiles { files, limit_hit: false }
    }));
    seen
}

fn uris(params: &[Value]) -> Vec<String> {
    params.iter().map(|p| p["textDocument"]["uri"].as_str().unwrap().to_owned()).collect()
}

fn diagnostics_for(h: &Harness, path: &Path) -> usize {
    h.events.lock().iter().filter(|e| matches!(e, IdeEvent::Diagnostics { path: p, .. } if p == path)).count()
}

fn scope_harness() -> (Harness, Arc<MockState>) {
    let h = harness(&[("mock", incremental_caps())]);
    let s = h.launcher.state("mock");
    *s.responder.lock() = Some(open_files_only(vec![]));
    (h, s)
}

#[tokio::test(flavor = "multi_thread")]
async fn references_open_unopened_files_that_mention_the_name() {
    let (h, s) = scope_harness();
    let seen = grep_candidates(&h);
    let b = h.root.join("b.mk");
    let c = h.root.join("c.mk");
    std::fs::write(&b, "call target\n").unwrap();
    std::fs::write(&c, "nothing here\n").unwrap();
    let (doc, a) = h.open("a.mk", "def target\n");
    let (_, d) = h.open("d.mk", "use target\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    eventually(|| s.docs.lock().len() == 2).await;

    let refs = h.mgr.references(doc, Pos::new(0, 5), true, true, Default::default()).await.unwrap();
    let mut paths: Vec<PathBuf> = refs.locations.iter().map(|l| l.path.to_path_buf()).collect();
    paths.sort();
    assert_eq!(paths, vec![a.clone(), b.clone(), d.clone()]);
    assert_eq!(refs.incomplete, None);

    let q = seen.lock()[0].clone();
    assert_eq!((q.word.as_str(), q.root.as_path(), q.limit), (WORD, h.root.as_path(), ide_lsp::MAX_CANDIDATES));
    assert_eq!(q.languages, vec![h.lang.clone()]);

    // Only the unopened candidate was opened (from disk), then closed again.
    let opens = s.notified("textDocument/didOpen");
    let temp: Vec<&Value> = opens.iter().filter(|p| p["textDocument"]["uri"] == uri_of(&b)).collect();
    assert_eq!(temp.len(), 1);
    assert_eq!(temp[0]["textDocument"]["version"], 0);
    assert_eq!(temp[0]["textDocument"]["text"], "call target\n");
    assert!(!uris(&opens).contains(&uri_of(&c)));
    assert_eq!(uris(&opens).iter().filter(|u| **u == uri_of(&d)).count(), 1);
    eventually(|| uris(&s.notified("textDocument/didClose")) == vec![uri_of(&b)]).await;
    assert_eq!(s.requested("textDocument/references").len(), 2);
    assert_eq!(s.docs.lock().len(), 2);

    // When every candidate file is already in the answer, no second request is made.
    std::fs::remove_file(&b).unwrap();
    h.mgr.references(doc, Pos::new(0, 5), true, true, Default::default()).await.unwrap();
    assert_eq!(s.requested("textDocument/references").len(), 3);

    // Without project_wide only the server's scope counts: no project search.
    std::fs::write(&b, "call target\n").unwrap();
    let refs = h.mgr.references(doc, Pos::new(0, 5), true, false, Default::default()).await.unwrap();
    assert_eq!(refs.locations.len(), 2);
    assert_eq!(seen.lock().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn references_never_reopen_or_close_the_users_files() {
    let h = harness(&[("mock", incremental_caps())]);
    let s = h.launcher.state("mock");
    grep_candidates(&h);
    let (doc, _) = h.open("a.mk", "def target\n");
    // Open, mentions the name, but the server does not report it.
    let (_, d) = h.open("d.mk", "use target\n");
    *s.responder.lock() = Some(open_files_only(vec![uri_of(&d)]));
    h.wait_status("mock", ServerStatus::Ready).await;
    eventually(|| s.docs.lock().len() == 2).await;

    let refs = h.mgr.references(doc, Pos::new(0, 5), true, true, Default::default()).await.unwrap();
    assert_eq!(refs.locations.len(), 1);
    assert_eq!(uris(&s.notified("textDocument/didOpen")).iter().filter(|u| **u == uri_of(&d)).count(), 1);
    assert!(s.notified("textDocument/didClose").is_empty());
    assert_eq!(s.requested("textDocument/references").len(), 1);
    assert!(s.docs.lock().contains_key(&uri_of(&d)));
}

#[tokio::test(flavor = "multi_thread")]
async fn references_report_a_capped_candidate_search() {
    let (h, s) = scope_harness();
    h.mgr.set_candidates_hook(Box::new(|q, _| ide_lsp::CandidateFiles {
        files: vec![q.root.join("b.mk")],
        limit_hit: true,
    }));
    std::fs::write(h.root.join("b.mk"), "target\n").unwrap();
    let (doc, _) = h.open("a.mk", "def target\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    eventually(|| s.docs.lock().len() == 1).await;
    let refs = h.mgr.references(doc, Pos::new(0, 5), true, true, Default::default()).await.unwrap();
    assert_eq!(refs.locations.len(), 2);
    assert_eq!(refs.incomplete, Some(ReferencesIncomplete::TooManyFiles));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_a_references_search_stops_the_candidate_search_and_closes_files() {
    let (h, s) = scope_harness();
    h.mgr.set_candidates_hook(Box::new(|_, cancel| {
        while !cancel.is_cancelled() {
            std::thread::sleep(Duration::from_millis(5));
        }
        ide_lsp::CandidateFiles::default()
    }));
    let (doc, _) = h.open("a.mk", "def target\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    let cancel = ide_core::CancellationToken::new();
    let later = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        later.cancel();
    });
    let err = h.mgr.references(doc, Pos::new(0, 5), true, true, cancel).await.unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);

    // Cancelled while the server answers with a file opened for the search.
    let b = h.root.join("b.mk");
    std::fs::write(&b, "call target\n").unwrap();
    grep_candidates(&h);
    let slow = uri_of(&b);
    let inner = open_files_only(vec![]);
    let gate = Arc::new(Gate::default());
    let held = gate.clone();
    *s.responder.lock() = Some(Arc::new(move |s, method, params| {
        if s.docs.lock().contains_key(&slow) {
            held.hold();
        }
        inner(s, method, params)
    }));
    let cancel = ide_core::CancellationToken::new();
    let mgr = h.mgr.clone();
    let search = tokio::spawn({
        let cancel = cancel.clone();
        async move { mgr.references(doc, Pos::new(0, 5), true, true, cancel).await }
    });
    eventually(|| gate.entered()).await;
    cancel.cancel();
    // Returns while the server still holds the answer.
    let err = search.await.unwrap().unwrap_err();
    assert_eq!(err.kind, ide_core::error::ErrorKind::Cancelled);
    eventually(|| uris(&s.notified("textDocument/didClose")) == vec![uri_of(&b)]).await;
    gate.open();
}

#[tokio::test(flavor = "multi_thread")]
async fn diagnostics_of_files_opened_for_a_search_stay_out_of_problems() {
    let h = harness(&[("mock", incremental_caps())]);
    let s = h.launcher.state("mock");
    grep_candidates(&h);
    let b = h.root.join("b.mk");
    std::fs::write(&b, "call target\n").unwrap();
    let (doc, a) = h.open("a.mk", "def target\n");
    let diag = json!([{ "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":1}}, "message": "e" }]);
    let inner = open_files_only(vec![]);
    let (temp, user, d) = (uri_of(&b), uri_of(&a), diag.clone());
    *s.responder.lock() = Some(Arc::new(move |s, method, params| {
        if s.docs.lock().contains_key(&temp) {
            for uri in [&temp, &user] {
                s.peer().notify("textDocument/publishDiagnostics", json!({ "uri": uri, "diagnostics": d })).unwrap();
            }
        }
        inner(s, method, params)
    }));
    h.wait_status("mock", ServerStatus::Ready).await;
    eventually(|| s.docs.lock().len() == 1).await;

    let refs = h.mgr.references(doc, Pos::new(0, 5), true, true, Default::default()).await.unwrap();
    assert_eq!(refs.locations.len(), 2);
    // Published right after the didClose (analysis still running): dropped too.
    s.peer().notify("textDocument/publishDiagnostics", json!({ "uri": uri_of(&b), "diagnostics": diag })).unwrap();
    s.peer().notify("textDocument/publishDiagnostics", json!({ "uri": uri_of(&a), "diagnostics": [] })).unwrap();
    eventually(|| diagnostics_for(&h, &a) == 2).await;
    assert_eq!(diagnostics_for(&h, &b), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_a_file_during_a_search_takes_it_over() {
    let h = harness(&[("mock", incremental_caps())]);
    let s = h.launcher.state("mock");
    grep_candidates(&h);
    let b = h.root.join("b.mk");
    std::fs::write(&b, "call target\n").unwrap();
    let (doc, _) = h.open("a.mk", "def target\n");
    let slow = uri_of(&b);
    let inner = open_files_only(vec![]);
    let gate = Arc::new(Gate::default());
    let held = gate.clone();
    *s.responder.lock() = Some(Arc::new(move |s, method, params| {
        if s.docs.lock().get(&slow).is_some_and(|t| t.starts_with("call")) {
            held.hold();
        }
        inner(s, method, params)
    }));
    h.wait_status("mock", ServerStatus::Ready).await;
    eventually(|| s.docs.lock().len() == 1).await;

    let mgr = h.mgr.clone();
    let search = tokio::spawn(async move { mgr.references(doc, Pos::new(0, 5), true, true, Default::default()).await });
    // The server answers with the copy opened for the search.
    eventually(|| gate.entered()).await;
    let user_doc = DocId::next();
    h.mgr.did_open(user_doc, &b, &h.lang, 7, "edited target\n");
    eventually(|| s.docs.lock().get(&uri_of(&b)).map(String::as_str) == Some("edited target\n")).await;
    gate.open();
    search.await.unwrap().unwrap();

    // The temporary copy was closed before the user's didOpen, and the user's stays open.
    let events: Vec<(String, Value)> = s
        .notifications
        .lock()
        .iter()
        .filter(|(m, p)| m.starts_with("textDocument/did") && p["textDocument"]["uri"] == uri_of(&b))
        .map(|(m, p)| (m.clone(), p["textDocument"]["version"].clone()))
        .collect();
    assert_eq!(
        events,
        vec![
            ("textDocument/didOpen".to_owned(), json!(0)),
            ("textDocument/didClose".to_owned(), Value::Null),
            ("textDocument/didOpen".to_owned(), json!(7)),
        ]
    );
    assert_eq!(s.docs.lock().get(&uri_of(&b)).map(String::as_str), Some("edited target\n"));
    // Its diagnostics are the user's again.
    s.peer().notify("textDocument/publishDiagnostics", json!({ "uri": uri_of(&b), "diagnostics": [] })).unwrap();
    eventually(|| diagnostics_for(&h, &b) == 1).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_answer_while_indexing_is_retried_when_indexing_ends() {
    let h = harness(&[("mock", incremental_caps())]);
    let s = h.launcher.state("mock");
    let (doc, path) = h.open("a.mk", "def target\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    let peer = s.peer();
    peer.notify("$/progress", json!({ "token": "idx", "value": { "kind": "begin", "title": "Indexing" } })).unwrap();
    h.wait_status("mock", ServerStatus::Busy).await;
    // Nothing found while indexing; indexing ends once that answer is out.
    s.respond("textDocument/references", Value::Array(occurrences(&uri_of(&path), "def target\n")));
    let answered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let first = answered.clone();
    *s.responder.lock() = Some(Arc::new(move |_, method, _| {
        (method == "textDocument/references" && !first.swap(true, Ordering::SeqCst)).then(|| json!([]))
    }));
    tokio::spawn(async move {
        eventually(|| answered.load(Ordering::SeqCst)).await;
        peer.notify("$/progress", json!({ "token": "idx", "value": { "kind": "end" } })).unwrap();
    });
    let refs = h.mgr.references(doc, Pos::new(0, 5), true, true, Default::default()).await.unwrap();
    assert_eq!(refs.locations.len(), 1);
    assert_eq!(refs.incomplete, None);
    assert_eq!(s.requested("textDocument/references").len(), 2);

    // While the server works, results are taken as they are; finding nothing is flagged.
    s.peer()
        .notify("$/progress", json!({ "token": "again", "value": { "kind": "begin", "title": "Indexing" } }))
        .unwrap();
    h.wait_status("mock", ServerStatus::Busy).await;
    let refs = h.mgr.references(doc, Pos::new(0, 5), true, true, Default::default()).await.unwrap();
    assert_eq!((refs.locations.len(), refs.incomplete), (1, None));
    s.respond("textDocument/references", json!([]));
    let refs = h.mgr.references(doc, Pos::new(0, 5), true, false, Default::default()).await.unwrap();
    assert_eq!(refs.locations.len(), 0);
    assert_eq!(refs.incomplete, Some(ReferencesIncomplete::Indexing));
}

#[tokio::test(flavor = "multi_thread")]
async fn rename_edits_files_outside_the_analysis_scope() {
    let (h, s) = scope_harness();
    grep_candidates(&h);
    let b = h.root.join("b.mk");
    std::fs::write(&b, "call target\n").unwrap();
    let (doc, a) = h.open("a.mk", "def target\n");
    h.wait_status("mock", ServerStatus::Ready).await;
    eventually(|| s.docs.lock().len() == 1).await;
    let edit = h.mgr.rename(doc, Pos::new(0, 5), "renamed".into()).await.unwrap();
    let mut paths: Vec<PathBuf> = edit
        .files
        .iter()
        .map(|f| match f {
            FileEdit::Edit { path, .. } => path.to_path_buf(),
            _ => panic!("unexpected {f:?}"),
        })
        .collect();
    paths.sort();
    assert_eq!(paths, vec![a, b.clone()]);
    eventually(|| uris(&s.notified("textDocument/didClose")) == vec![uri_of(&b)]).await;
}
