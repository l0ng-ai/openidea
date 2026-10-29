//! Server → client notifications and requests.

use crate::LspManager;
use crate::convert;
use crate::server::{Progress, Server};
use crate::text::Encoding;
use crate::uri::uri_to_path;
use ide_core::event::{LspRefreshKind, NotifyLevel};
use ide_core::{IdeEvent, TaskId};
use ide_jsonrpc::{Handler, codes};
use lsp_types as lsp;
use serde_json::{Value, json};
use std::sync::{Arc, Weak};

/// Progress token standing for `angular/projectLoadingStart` … `Finish`.
const ANGULAR_LOADING: &str = "angular/projectLoading";

pub struct ClientHandler {
    mgr: Weak<LspManager>,
    server: Arc<Server>,
    generation: u64,
}

impl ClientHandler {
    pub fn new(mgr: Weak<LspManager>, server: Arc<Server>, generation: u64) -> Self {
        Self { mgr, server, generation }
    }

    fn encoding(&self) -> Encoding {
        self.server.running_gen(self.generation).map(|r| r.caps.read().encoding).unwrap_or_default()
    }

    /// Cancelling task `task` asks this server instance to stop the work of progress `token`.
    fn cancel_handle(&self, task: TaskId, token: &Value) -> ide_core::task::CancelHandle {
        let (server, generation, token) = (self.server.clone(), self.generation, token.clone());
        ide_core::task::on_cancel(task, move || {
            if let Some(run) = server.running_gen(generation)
                && let Err(e) = run.peer.notify("window/workDoneProgress/cancel", json!({ "token": token }))
            {
                tracing::debug!("{}: cannot cancel progress: {e}", server.name);
            }
        })
    }

    fn progress(&self, mgr: &LspManager, params: Value) {
        let token = match &params["token"] {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let value = &params["value"];
        let message = value.get("message").and_then(Value::as_str).map(str::to_owned);
        let fraction = value.get("percentage").and_then(Value::as_f64).map(|p| (p / 100.0).clamp(0.0, 1.0) as f32);
        let cancellable = value.get("cancellable").and_then(Value::as_bool);
        let event = {
            let mut progress = self.server.progress.lock();
            match value.get("kind").and_then(Value::as_str) {
                Some("begin") => {
                    let title = value
                        .get("title")
                        .and_then(Value::as_str)
                        .filter(|t| !t.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| self.server.name.clone());
                    let task = TaskId::next();
                    let cancel = (cancellable == Some(true)).then(|| self.cancel_handle(task, &params["token"]));
                    let cancellable = cancel.is_some();
                    progress.insert(token, Progress { task, title: title.clone(), message: message.clone(), cancel });
                    IdeEvent::Task { id: task, title, message, fraction, done: false, cancellable }
                }
                Some("report") => {
                    let Some(p) = progress.get_mut(&token) else { return };
                    if message.is_some() {
                        p.message = message;
                    }
                    match cancellable {
                        Some(true) if p.cancel.is_none() => {
                            p.cancel = Some(self.cancel_handle(p.task, &params["token"]))
                        }
                        Some(false) => p.cancel = None,
                        _ => {}
                    }
                    IdeEvent::Task {
                        id: p.task,
                        title: p.title.clone(),
                        message: p.message.clone(),
                        fraction,
                        done: false,
                        cancellable: p.cancel.is_some(),
                    }
                }
                Some("end") => {
                    let Some(p) = progress.remove(&token) else { return };
                    IdeEvent::Task {
                        id: p.task,
                        title: p.title,
                        message: message.or(p.message),
                        fraction: Some(1.0),
                        done: true,
                        cancellable: false,
                    }
                }
                _ => return,
            }
        };
        let ended = matches!(&event, IdeEvent::Task { done: true, .. });
        mgr.sink().emit(event);
        self.server.refresh_busy_status(mgr.sink());
        if ended {
            self.server.progress_ended();
        }
    }

    fn publish_diagnostics(&self, mgr: &LspManager, params: Value) {
        let params: lsp::PublishDiagnosticsParams = match serde_json::from_value(params) {
            Ok(p) => p,
            Err(e) => {
                tracing::debug!("{}: bad publishDiagnostics: {e}", self.server.name);
                return;
            }
        };
        let Some(path) = uri_to_path(params.uri.as_str()) else { return };
        // Files opened only for a request (references search) are not the user's problems.
        if self.server.suppresses_diagnostics(&path) {
            return;
        }
        let conv = mgr.conv(self.encoding());
        let items = params
            .diagnostics
            .iter()
            .cloned()
            .map(|d| convert::diagnostic(&conv, &path, d, &self.server.name))
            .collect();
        self.server.set_diagnostics(path.clone(), params.diagnostics);
        mgr.sink().emit(IdeEvent::Diagnostics { path: path.into(), source: self.server.name.clone(), items });
    }

    fn show_message(&self, mgr: &LspManager, params: &Value) {
        let text = params.get("message").and_then(Value::as_str).unwrap_or_default().to_owned();
        let level = match params.get("type").and_then(Value::as_u64) {
            Some(1) => NotifyLevel::Error,
            Some(2) => NotifyLevel::Warning,
            _ => {
                tracing::info!("[{}] {text}", self.server.name);
                return;
            }
        };
        if !mgr.first_message(&self.server.name, &text) {
            tracing::debug!("[{}] repeated: {text}", self.server.name);
            return;
        }
        mgr.sink().emit(IdeEvent::Notify { level, title: self.server.name.clone(), body: Some(text) });
    }

    fn configuration(&self, params: &Value) -> Value {
        let options = all_settings(&self.server.effective_config());
        let items = params.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        Value::Array(
            items
                .iter()
                // vtsls asks for the whole configuration as section `""`.
                .map(|item| match item.get("section").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    // The server's own section: its block under `settings` (basedpyright asks
                    // `basedpyright` and `basedpyright.analysis`), else the options themselves.
                    Some(section) if section == self.server.name => {
                        options.get("settings").and_then(|s| s.get(section)).unwrap_or(&options).clone()
                    }
                    // Servers that take settings under `initializationOptions.settings`
                    // (jdtls) ask for the same sections later.
                    Some(section) => [&options, options.get("settings").unwrap_or(&Value::Null)]
                        .into_iter()
                        .find_map(|base| section.split('.').try_fold(base, |v, key| v.get(key)))
                        .cloned()
                        .unwrap_or(Value::Null),
                    None => options.clone(),
                })
                .collect(),
        )
    }

    fn apply_edit(&self, mgr: &LspManager, params: Value) -> Result<Value, (i64, String)> {
        let edit: lsp::WorkspaceEdit = params
            .get("edit")
            .cloned()
            .ok_or_else(|| (codes::INVALID_PARAMS, "missing edit".to_owned()))
            .and_then(|e| serde_json::from_value(e).map_err(|e| (codes::INVALID_PARAMS, e.to_string())))?;
        // Convert before calling the hook: it re-enters document sync.
        let edit = convert::workspace_edit(&mgr.conv(self.encoding()), edit);
        let applied = match mgr.apply_edit_hook() {
            Some(hook) => hook(edit),
            None => false,
        };
        let mut reply = json!({ "applied": applied });
        if !applied {
            reply["failureReason"] = json!("edit could not be applied");
        }
        Ok(reply)
    }

    fn registration(&self, params: &Value, register: bool) {
        let Some(run) = self.server.running_gen(self.generation) else { return };
        let key = if register { "registrations" } else { "unregisterations" };
        let list = params.get(key).or_else(|| params.get("unregistrations")).and_then(Value::as_array);
        let mut caps = run.caps.write();
        for reg in list.into_iter().flatten() {
            let Some(method) = reg.get("method").and_then(Value::as_str) else { continue };
            if register {
                caps.register(method, reg.get("registerOptions"));
            } else {
                caps.unregister(method);
            }
        }
    }
}

impl Handler for ClientHandler {
    fn on_notification(&self, method: &str, params: Value) {
        let Some(mgr) = self.mgr.upgrade() else { return };
        match method {
            "$/progress" => self.progress(&mgr, params),
            "textDocument/publishDiagnostics" => self.publish_diagnostics(&mgr, params),
            "window/showMessage" => self.show_message(&mgr, &params),
            "window/logMessage" => {
                let text = params.get("message").and_then(Value::as_str).unwrap_or_default();
                match params.get("type").and_then(Value::as_u64) {
                    Some(1) => tracing::warn!("[{}] {text}", self.server.name),
                    Some(2 | 3) => tracing::info!("[{}] {text}", self.server.name),
                    _ => tracing::debug!("[{}] {text}", self.server.name),
                }
            }
            "tsserver/request" => mgr.forward_tsserver_requests(self.server.clone(), self.generation, params),
            // The Angular server's project loading, shown like `$/progress`; one
            // task while several projects load.
            "angular/projectLoadingStart" if !self.server.progress.lock().contains_key(ANGULAR_LOADING) => self
                .progress(
                    &mgr,
                    json!({ "token": ANGULAR_LOADING, "value": { "kind": "begin", "title": "Loading Angular project" } }),
                ),
            "angular/projectLoadingStart" => {}
            "angular/projectLoadingFinish" => {
                self.progress(&mgr, json!({ "token": ANGULAR_LOADING, "value": { "kind": "end" } }))
            }
            "telemetry/event" | "$/logTrace" | "$/cancelRequest" => {}
            other => tracing::trace!("[{}] unhandled notification {other}", self.server.name),
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        let Some(mgr) = self.mgr.upgrade() else {
            return Err((codes::INTERNAL_ERROR, "client is shutting down".into()));
        };
        match method {
            "window/workDoneProgress/create" => Ok(Value::Null),
            "window/showMessageRequest" => {
                self.show_message(&mgr, &params);
                Ok(Value::Null)
            }
            "window/showDocument" => Ok(json!({ "success": false })),
            "workspace/configuration" => Ok(self.configuration(&params)),
            "workspace/workspaceFolders" => Ok(mgr.workspace_folders(&self.server)),
            "client/registerCapability" => {
                self.registration(&params, true);
                Ok(Value::Null)
            }
            "client/unregisterCapability" => {
                self.registration(&params, false);
                Ok(Value::Null)
            }
            "workspace/applyEdit" => self.apply_edit(&mgr, params),
            "workspace/semanticTokens/refresh" | "workspace/inlayHint/refresh" | "workspace/codeLens/refresh" => {
                let kind = match method {
                    "workspace/semanticTokens/refresh" => LspRefreshKind::SemanticTokens,
                    "workspace/inlayHint/refresh" => LspRefreshKind::InlayHints,
                    _ => LspRefreshKind::CodeLens,
                };
                mgr.sink().emit(IdeEvent::LspRefresh { server: self.server.id, kind });
                Ok(Value::Null)
            }
            "workspace/diagnostic/refresh" | "workspace/inlineValue/refresh" => Ok(Value::Null),
            other => Err((codes::METHOD_NOT_FOUND, format!("unsupported method {other}"))),
        }
    }
}

/// What `workspace/configuration` sections are looked up in: the server's
/// `initializationOptions` with its `settings` merged over them.
pub(crate) fn all_settings(cfg: &ide_language::LanguageServerConfig) -> Value {
    let mut out = cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok()).unwrap_or(Value::Null);
    if let Some(settings) = &cfg.settings {
        merge(&mut out, settings.clone());
    }
    out
}

fn merge(base: &mut Value, layer: Value) {
    match (base, layer) {
        (Value::Object(base), Value::Object(layer)) => {
            for (k, v) in layer {
                match base.get_mut(&k) {
                    Some(existing) => merge(existing, v),
                    None => {
                        base.insert(k, v);
                    }
                }
            }
        }
        (base, layer) => *base = layer,
    }
}
