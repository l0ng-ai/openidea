//! The built-in MCP server's link to the windows: confirmations and editor state go
//! to a project window as `IdeEvent::McpRequest` and come back through `mcp_respond`.

use crate::events::TauriSink;
use crate::state::AppState;
use crate::windows::WindowsState;
use futures::future::BoxFuture;
use ide_core::mcp::{McpAnswer, McpStatus, McpUiRequest};
use ide_core::{EventSink, IdeError, IdeEvent, IdeResult};
use ide_host::Host;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

/// How long a confirmation waits for the user.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long the UI gets for requests it answers by itself.
const UI_TIMEOUT: Duration = Duration::from_secs(15);

/// Requests waiting for a window's answer, with the window they went to.
#[derive(Default)]
pub struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, (String, oneshot::Sender<McpAnswer>)>>,
}

impl Pending {
    /// Delivers `answer` to request `id`; false if it is no longer waiting.
    pub fn answer(&self, id: u64, answer: McpAnswer) -> bool {
        match self.waiting.lock().remove(&id) {
            Some((_, tx)) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    /// `window` closed: its requests fail rather than wait for their timeout.
    pub fn window_closed(&self, window: &str) {
        let closed: Vec<_> = {
            let mut waiting = self.waiting.lock();
            let ids: Vec<u64> = waiting.iter().filter(|(_, (w, _))| w == window).map(|(id, _)| *id).collect();
            ids.into_iter().filter_map(|id| waiting.remove(&id)).collect()
        };
        for (_, tx) in closed {
            let _ = tx.send(McpAnswer::Failed { message: "The OpenIDEA window closed.".into() });
        }
    }
}

pub struct TauriMcpHost {
    pub app: AppHandle,
    pub host: Arc<Host>,
    pub pending: Arc<Pending>,
}

impl ide_mcp::McpHost for TauriMcpHost {
    fn host(&self) -> Arc<Host> {
        self.host.clone()
    }

    fn focused_window(&self) -> Option<String> {
        let label = self.app.try_state::<WindowsState>()?.last_focused()?;
        Some(AppState::owner_window(&label).to_owned())
    }

    fn ask(&self, window: &str, request: McpUiRequest) -> BoxFuture<'static, IdeResult<Value>> {
        let id = self.pending.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.waiting.lock().insert(id, (window.to_owned(), tx));
        let confirm = matches!(request, McpUiRequest::Confirm { .. });
        let timeout = if confirm { CONFIRM_TIMEOUT } else { UI_TIMEOUT };
        let sink = TauriSink { app: self.app.clone(), window: Some(window.to_owned()) };
        if confirm {
            // A confirmation needs the user: bring the window forward.
            if let Some(w) = self.app.get_webview_window(window) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        sink.emit(IdeEvent::McpRequest { id, request });
        // Closes the dialog and forgets the request however the wait ends: answered,
        // timed out, or dropped because the call was cancelled.
        let done = Done { sink, id, pending: self.pending.clone() };
        Box::pin(async move {
            let outcome = tokio::time::timeout(timeout, rx).await;
            drop(done);
            let answer = match outcome {
                Ok(Ok(a)) => a,
                Ok(Err(_)) => return Err(IdeError::cancelled()),
                Err(_) if confirm => {
                    return Err(IdeError::unavailable("Nobody answered the confirmation in OpenIDEA in time."));
                }
                Err(_) => return Err(IdeError::unavailable("The OpenIDEA window did not answer.")),
            };
            match answer {
                McpAnswer::Confirm { allow, remember: false } => Ok(Value::Bool(allow)),
                McpAnswer::Confirm { allow, remember: true } => {
                    Ok(serde_json::json!({ "allow": allow, "remember": true }))
                }
                McpAnswer::Done => Ok(Value::Null),
                McpAnswer::OpenEditors { editors } => {
                    serde_json::to_value(editors).map_err(|e| IdeError::internal(e.to_string()))
                }
                McpAnswer::Failed { message } => Err(IdeError::unavailable(message)),
            }
        })
    }

    fn status_changed(&self, status: &McpStatus) {
        TauriSink { app: self.app.clone(), window: None }.emit(IdeEvent::McpStatusChanged { status: status.clone() });
    }

    fn log_file(&self) -> Option<std::path::PathBuf> {
        crate::logging::latest_log(crate::logging::log_dir()?)
    }
}

/// Ends request `id` when dropped: forgets it and tells the window to close its dialog.
struct Done {
    sink: TauriSink,
    id: u64,
    pending: Arc<Pending>,
}

impl Drop for Done {
    fn drop(&mut self) {
        self.pending.waiting.lock().remove(&self.id);
        self.sink.emit(IdeEvent::McpRequestDone { id: self.id });
    }
}

/// The token file in the app data directory.
pub fn token_file(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("mcp-token")
}

/// Starts or reconfigures the server for the current global settings (off the caller's thread).
pub fn apply_settings(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let server = state.mcp.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Read when the task runs: the last of several quick changes applies the latest settings.
        let Some(state) = app.try_state::<AppState>() else { return };
        let settings = state.global_settings.effective().mcp;
        server.apply(&settings).await;
    });
}

/// Gives the IDE's own agents the server (Settings › Tools › MCP Server › agents), while it runs.
pub fn offer_to_agents(app: &AppHandle) {
    let app = app.clone();
    ide_agent::set_mcp_servers(Some(Arc::new(move |cwd: &std::path::Path| {
        let Some(state) = app.try_state::<AppState>() else { return Vec::new() };
        if !state.global_settings.effective().mcp.agents {
            return Vec::new();
        }
        let Some((url, token)) = state.mcp.endpoint() else { return Vec::new() };
        vec![agent_server(&url, &token, cwd)]
    })));
}

/// The ACP `McpServer` entry of this server for an agent session in `cwd`: the session's
/// directory names its project, so its calls need no `projectPath`.
fn agent_server(url: &str, token: &str, cwd: &std::path::Path) -> serde_json::Value {
    serde_json::json!({
        "type": "http",
        "name": ide_mcp::clients::SERVER_NAME,
        "url": url,
        "headers": [
            { "name": "Authorization", "value": format!("Bearer {token}") },
            { "name": ide_mcp::project::PROJECT_PATH_HEADER, "value": cwd.to_string_lossy() },
        ],
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn agent_sessions_name_their_project() {
        let entry = super::agent_server("http://127.0.0.1:1/mcp", "t", std::path::Path::new("/work/app"));
        assert_eq!(
            entry["headers"],
            serde_json::json!([
                { "name": "Authorization", "value": "Bearer t" },
                { "name": "OPENIDEA_MCP_PROJECT_PATH", "value": "/work/app" },
            ])
        );
    }
}
