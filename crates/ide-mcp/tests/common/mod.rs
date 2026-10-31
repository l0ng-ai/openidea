//! A temporary project, a [`Host`] with it open in window `main`, and an
//! [`McpServer`] driven through its HTTP handler (no socket).
#![allow(dead_code)]

use futures::future::BoxFuture;
use ide_core::mcp::{McpStatus, McpUiRequest};
use ide_core::{IdeResult, NullSink};
use ide_host::{Host, HostConfig};
use ide_mcp::{McpHost, McpServer};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const TOKEN: &str = "0123456789abcdef0123456789abcdef";
pub const PORT: u16 = 64999;

/// Answers the server's UI requests; records them.
pub struct FakeUi {
    pub host: Arc<Host>,
    pub focused: Mutex<Option<String>>,
    pub asked: Mutex<Vec<McpUiRequest>>,
    /// The answer to every request (`true` allows confirmations).
    pub answer: Mutex<Value>,
}

impl McpHost for FakeUi {
    fn host(&self) -> Arc<Host> {
        self.host.clone()
    }
    fn focused_window(&self) -> Option<String> {
        self.focused.lock().clone()
    }
    fn ask(&self, _window: &str, request: McpUiRequest) -> BoxFuture<'static, IdeResult<Value>> {
        self.asked.lock().push(request);
        let answer = self.answer.lock().clone();
        Box::pin(async move { Ok(answer) })
    }
    fn status_changed(&self, _status: &McpStatus) {}
}

pub struct Harness {
    pub dir: tempfile::TempDir,
    pub root: PathBuf,
    pub ui: Arc<FakeUi>,
    pub server: McpServer,
    session: Mutex<Option<String>>,
}

impl Harness {
    /// A project at `<tmp>/project` holding `files` (relative path, contents), open in window `main`.
    pub async fn new(files: &[(&str, &str)]) -> Self {
        Self::with_trust(files, true).await
    }

    /// A project the user has not trusted (Restricted Mode).
    pub async fn restricted(files: &[(&str, &str)]) -> Self {
        Self::with_trust(files, false).await
    }

    async fn with_trust(files: &[(&str, &str)], trusted: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        for (path, text) in files {
            let file = root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        let host = Arc::new(Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        host.trust.decide(&root, trusted, false).unwrap();
        let project = host.open_project("main", &root).unwrap();
        project.index.wait_idle(std::time::Duration::from_secs(10));
        let ui = Arc::new(FakeUi {
            host,
            focused: Mutex::new(Some("main".into())),
            asked: Mutex::default(),
            answer: Mutex::new(Value::Bool(true)),
        });
        let server = McpServer::new(ui.clone(), TOKEN.into());
        Self { dir, root, ui, server, session: Mutex::default() }
    }

    pub fn host(&self) -> &Arc<Host> {
        &self.ui.host
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    /// One POST with the right Host and token; returns (status, headers, body).
    pub async fn post(&self, body: Value) -> (u16, Vec<(String, String)>, String) {
        let host = format!("127.0.0.1:{PORT}");
        let auth = format!("Bearer {TOKEN}");
        let session = self.session.lock().clone();
        let mut headers =
            vec![("Host", host.as_str()), ("Authorization", auth.as_str()), ("Content-Type", "application/json")];
        if let Some(s) = &session {
            headers.push(("Mcp-Session-Id", s.as_str()));
        }
        self.server.handle_for_test(PORT, "POST", &headers, &body.to_string()).await
    }

    /// `initialize` as `client`, keeping the session id.
    pub async fn initialize(&self, client: &str) -> Value {
        let (status, headers, body) = self
            .post(json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": client, "version": "1.0" } } }))
            .await;
        assert_eq!(status, 200, "{body}");
        let session = headers.into_iter().find(|(k, _)| k.eq_ignore_ascii_case("mcp-session-id")).map(|(_, v)| v);
        *self.session.lock() = session;
        serde_json::from_str(&body).unwrap()
    }

    /// `tools/call`; returns the `result` object (with `content`, `isError`, maybe `structuredContent`).
    pub async fn call_raw(&self, tool: &str, args: Value) -> Value {
        if self.session.lock().is_none() {
            self.initialize("test-client").await;
        }
        let (status, _, body) =
            self.post(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } })).await;
        assert_eq!(status, 200, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert!(v.get("error").is_none(), "JSON-RPC error: {v}");
        v["result"].clone()
    }

    /// A successful call's text; panics if the tool returned an error.
    pub async fn call(&self, tool: &str, args: Value) -> String {
        let r = self.call_raw(tool, args).await;
        assert_eq!(r["isError"], false, "{tool} failed: {}", r["content"][0]["text"]);
        r["content"][0]["text"].as_str().unwrap().to_owned()
    }

    /// A failing call's message; panics if the tool succeeded.
    pub async fn call_err(&self, tool: &str, args: Value) -> String {
        let r = self.call_raw(tool, args).await;
        assert_eq!(r["isError"], true, "{tool} unexpectedly succeeded: {}", r["content"][0]["text"]);
        r["content"][0]["text"].as_str().unwrap().to_owned()
    }

    /// A call's structured result (JSON tools), parsed from the text when there is no `structuredContent`.
    pub async fn call_json(&self, tool: &str, args: Value) -> Value {
        let r = self.call_raw(tool, args).await;
        assert_eq!(r["isError"], false, "{tool} failed: {}", r["content"][0]["text"]);
        match r.get("structuredContent") {
            Some(s) => s.clone(),
            None => serde_json::from_str(r["content"][0]["text"].as_str().unwrap()).unwrap(),
        }
    }
}

pub fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")
}
