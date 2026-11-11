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
use std::time::Duration;

/// Progress token standing for `angular/projectLoadingStart` … `Finish`.
const ANGULAR_LOADING: &str = "angular/projectLoading";

/// How often a running progress token's silence is checked.
const PROGRESS_SWEEP: Duration = Duration::from_secs(15);
/// A token that reports nothing this long is marked stuck: jdtls's `Importing Maven
/// project(s)` waits minutes on one repository that never answers (`DefaultMetadataResolver`
/// awaits its whole batch), and a task frozen at one percent is not progress. It stays
/// visible, but stops holding the server busy while the work behind it keeps running.
const PROGRESS_STALE: Duration = Duration::from_secs(180);

/// Task message after [`PROGRESS_STALE`] of silence: keep the server's last message and
/// say how long nothing happened.
fn stalled_message(message: Option<&str>) -> String {
    let secs = PROGRESS_STALE.as_secs();
    match message.filter(|m| !m.is_empty()) {
        Some(message) => format!("{message} — no progress for {secs} s"),
        None => format!("No progress for {secs} s"),
    }
}

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
        let kind = value.get("kind").and_then(Value::as_str);
        let message = value.get("message").and_then(Value::as_str).map(str::to_owned);
        let fraction = value.get("percentage").and_then(Value::as_f64).map(|p| (p / 100.0).clamp(0.0, 1.0) as f32);
        let cancellable = value.get("cancellable").and_then(Value::as_bool);
        let mut replaced = None;
        let event = {
            let mut progress = self.server.progress.lock();
            match kind {
                Some("begin") => {
                    let title = value
                        .get("title")
                        .and_then(Value::as_str)
                        .filter(|t| !t.is_empty())
                        .map(ide_core::task::display_title)
                        .unwrap_or_else(|| self.server.name.clone());
                    let task = TaskId::next();
                    let cancel = (cancellable == Some(true)).then(|| self.cancel_handle(task, &params["token"]));
                    let cancellable = cancel.is_some();
                    // A token carries one `begin`, yet servers reuse one for concurrent work
                    // (PHPantom: begin, begin, end, end). The task it replaces ends now, or no
                    // `end` would ever reach it.
                    replaced = progress
                        .insert(
                            token.clone(),
                            Progress {
                                task,
                                title: title.clone(),
                                message: message.clone(),
                                cancel,
                                last: tokio::time::Instant::now(),
                                stalled: false,
                                fraction,
                            },
                        )
                        .map(|p| IdeEvent::Task {
                            id: p.task,
                            title: p.title,
                            message: p.message,
                            fraction: None,
                            done: true,
                            cancellable: false,
                        });
                    IdeEvent::Task { id: task, title, message, fraction, done: false, cancellable }
                }
                Some("report") => {
                    let Some(p) = progress.get_mut(&token) else { return };
                    p.last = tokio::time::Instant::now();
                    p.stalled = false;
                    if message.is_some() {
                        p.message = message;
                    }
                    if fraction.is_some() {
                        p.fraction = fraction;
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
        let ended = replaced.is_some() || matches!(&event, IdeEvent::Task { done: true, .. });
        if let Some(replaced) = replaced {
            self.server.emit(mgr.sink(), replaced);
        }
        self.server.emit(mgr.sink(), event);
        self.server.refresh_busy_status(mgr.sink());
        if ended {
            self.server.progress_ended();
        } else if kind == Some("begin") {
            self.watch_progress(mgr, token);
        }
    }

    /// A task that reports nothing for [`PROGRESS_STALE`] is stuck: the work behind it is
    /// blocked on something that never answers, and a bar frozen at one percent is not
    /// progress. Keep its task visible but mark it, and stop counting it as busy: a slow
    /// import can resume and finish in the same task, while the IDE stays usable.
    fn watch_progress(&self, mgr: &LspManager, token: String) {
        let (weak, server, generation) = (self.mgr.clone(), self.server.clone(), self.generation);
        // The notification runs on a reader thread, not inside a runtime.
        mgr.runtime.spawn(async move {
            loop {
                tokio::time::sleep(PROGRESS_SWEEP).await;
                let Some(mgr) = weak.upgrade() else { return };
                if server.running_gen(generation).is_none() || !server.has_progress(&token) {
                    return; // the instance is gone, or the task ended normally
                }
                if server.progress_silent(&token, PROGRESS_STALE) {
                    let handler = ClientHandler::new(Arc::downgrade(&mgr), server.clone(), generation);
                    if handler.mark_progress_stalled(&mgr, &token) {
                        tracing::warn!(
                            "{}: progress '{token}' reported nothing for {} s; marking it stuck",
                            server.name,
                            PROGRESS_STALE.as_secs()
                        );
                    }
                }
            }
        });
    }

    /// Marks a silent task as possibly stuck without ending it. Returns whether it was
    /// newly marked; a later `report` clears the mark and makes the server busy again.
    fn mark_progress_stalled(&self, mgr: &LspManager, token: &str) -> bool {
        let event = {
            let mut progress = self.server.progress.lock();
            let Some(p) = progress.get_mut(token) else { return false };
            if p.stalled || !p.silent(PROGRESS_STALE) {
                return false;
            }
            p.stalled = true;
            IdeEvent::Task {
                id: p.task,
                title: p.title.clone(),
                message: Some(stalled_message(p.message.as_deref())),
                fraction: p.fraction,
                done: false,
                cancellable: p.cancel.is_some(),
            }
        };
        self.server.emit(mgr.sink(), event);
        self.server.refresh_busy_status(mgr.sink());
        self.server.progress_ended();
        true
    }

    fn publish_diagnostics(&self, mgr: &LspManager, params: Value) {
        // Problems come only from servers used for `diagnostics`.
        if self.server.running_gen(self.generation).is_some_and(|run| !run.caps.read().restriction.diagnostics()) {
            return;
        }
        let params: lsp::PublishDiagnosticsParams = match serde_json::from_value(params) {
            Ok(p) => p,
            Err(e) => {
                tracing::debug!("{}: bad publishDiagnostics: {e}", self.server.name);
                return;
            }
        };
        let Some(path) = uri_to_path(params.uri.as_str()) else { return };
        if self.server.name == "jdtls"
            && let Some(body) = crate::jdtls::build_plan_failure(&path, &self.server.root, &params.diagnostics)
            && mgr.first_message(&self.server.name, &body)
        {
            mgr.sink().emit(ide_core::IdeEvent::Notify {
                level: ide_core::event::NotifyLevel::Error,
                title: "Maven project could not be configured".into(),
                body: Some(body),
            });
        }
        if !mgr.accepts_injected_diagnostics(&path, params.version) {
            return;
        }
        // Files opened only for a request (references search) are not the user's problems.
        if (self.server.external_diagnostics.load(std::sync::atomic::Ordering::Acquire)
            && !mgr.docs.lock().values().any(|d| d.path == path))
            || self.server.suppresses_diagnostics(&path)
        {
            return;
        }
        let shown = self.server.set_diagnostics(path.clone(), params.diagnostics);
        mgr.emit_diagnostics(&self.server, path, shown, self.encoding());
    }

    fn show_message(&self, mgr: &LspManager, params: &Value) {
        let text = params.get("message").and_then(Value::as_str).unwrap_or_default().to_owned();
        // rust-analyzer built from source reports its own slow main-loop turns as errors, meant for
        // its developers (`poke_rust_analyzer_developer`); nothing for the user to act on.
        if text.starts_with("overly long loop turn") {
            tracing::warn!("[{}] {text}", self.server.name);
            return;
        }
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
            Some(hook) => hook(edit.clone()),
            None => false,
        };
        if applied {
            let _ = mgr.applied_edits.send((self.server.id, edit));
        }
        let mut reply = json!({ "applied": applied });
        if !applied {
            reply["failureReason"] = json!("edit could not be applied");
        }
        Ok(reply)
    }

    fn registration(&self, mgr: &LspManager, params: &Value, register: bool) {
        let Some(run) = self.server.initialized_gen(self.generation) else { return };
        let key = if register { "registrations" } else { "unregisterations" };
        let list = params.get(key).or_else(|| params.get("unregistrations")).and_then(Value::as_array);
        let mut caps = run.caps.write();
        let mut watchers_changed = false;
        for reg in list.into_iter().flatten() {
            let Some(method) = reg.get("method").and_then(Value::as_str) else { continue };
            if method == "workspace/didChangeWatchedFiles" {
                let id = reg.get("id").and_then(Value::as_str).unwrap_or_default();
                let mut watchers = run.watchers.write();
                if register {
                    watchers.register(id, reg.get("registerOptions"));
                } else {
                    watchers.unregister(id);
                }
                watchers_changed = true;
            } else if register {
                caps.register(method, reg.get("registerOptions"));
            } else {
                caps.unregister(method);
            }
        }
        drop(caps);
        if watchers_changed {
            mgr.file_watch_roots_changed();
        }
    }
}

impl Handler for ClientHandler {
    fn on_notification(&self, method: &str, params: Value) {
        let Some(mgr) = self.mgr.upgrade() else { return };
        match method {
            "$/progress" => self.progress(&mgr, params),
            "experimental/serverStatus" => {
                if let Some(quiescent) = params.get("quiescent").and_then(Value::as_bool) {
                    self.server.set_loading(mgr.sink(), !quiescent);
                }
            }
            "textDocument/publishDiagnostics" => self.publish_diagnostics(&mgr, params),
            "window/showMessage" => self.show_message(&mgr, &params),
            "window/logMessage" => {
                let text = params.get("message").and_then(Value::as_str).unwrap_or_default();
                if self.server.name == "jdtls"
                    && text.contains("Can't use Java ")
                    && text.contains(" to import Gradle project ")
                {
                    self.show_message(&mgr, &json!({ "type": 1, "message": text.lines().next().unwrap_or(text) }));
                }
                match params.get("type").and_then(Value::as_u64) {
                    Some(1) if self.server.name == "jdtls" && text.contains(crate::jdtls::reserved_names::IMPORT_FAILURE) => {
                        tracing::warn!("[{}] {text}", self.server.name);
                        mgr.report_import_failure(self.server.root.clone(), text.to_owned());
                    }
                    Some(1) => tracing::warn!("[{}] {text}", self.server.name),
                    Some(2 | 3) => tracing::info!("[{}] {text}", self.server.name),
                    _ => tracing::debug!("[{}] {text}", self.server.name),
                }
            }
            "tsserver/request" => mgr.forward_tsserver_requests(self.server.clone(), self.generation, params),
            "language/status" if self.server.name == "jdtls" && params["type"] == "ServiceReady" => {
                mgr.java_import_ready(self.server.clone(), self.generation);
            }
            "language/status" if self.server.name == "jdtls" && params["type"] == "ProjectStatus" => {
                mgr.java_projects_updated(self.server.clone(), self.generation);
            }
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
            "eslint/status" | "eslint/probeFailed" | "eslint/exitCalled" => {}
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
                self.registration(&mgr, &params, true);
                Ok(Value::Null)
            }
            "client/unregisterCapability" => {
                self.registration(&mgr, &params, false);
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
            "workspace/diagnostic/refresh" => {
                mgr.refresh_pulled_diagnostics(&self.server);
                Ok(Value::Null)
            }
            "workspace/inlineValue/refresh" => Ok(Value::Null),
            // vscode-eslint asks its client before using the project's eslint (approved: 4) and
            // reports a missing library or configuration; diagnostics already say what's wrong.
            "eslint/confirmESLintExecution" => Ok(json!(4)),
            "eslint/noLibrary" | "eslint/noConfig" | "eslint/openDoc" => Ok(json!({})),
            other => Err((codes::METHOD_NOT_FOUND, format!("unsupported method {other}"))),
        }
    }

    fn after_response(&self, method: &str) {
        if method == "workspace/configuration"
            && self.server.config.resync_on_configuration
            && let Some(mgr) = self.mgr.upgrade()
        {
            mgr.resync_documents(&self.server, self.generation);
        }
    }
}

/// What `workspace/configuration` sections are looked up in: the server's
/// `initializationOptions` with its `settings` merged over them.
pub(crate) fn all_settings(cfg: &ide_language::LanguageServerConfig) -> Value {
    let mut out = cfg.initialization_options.as_ref().and_then(|v| serde_json::to_value(v).ok()).unwrap_or(Value::Null);
    if cfg.name == "jdtls" {
        out = out.get("settings").cloned().unwrap_or_else(|| json!({}));
        if let Some(settings) = &cfg.settings {
            // Accept the initialization-options wrapper as well as LSP settings.
            if let Some(nested) = settings.get("settings") {
                merge(&mut out, nested.clone());
            }
            let mut direct = settings.clone();
            if let Some(direct) = direct.as_object_mut() {
                direct.remove("settings");
            }
            merge(&mut out, direct);
        }
        return out;
    }
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
