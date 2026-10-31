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

/// Requests waiting for a window's answer.
#[derive(Default)]
pub struct Pending {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, oneshot::Sender<McpAnswer>>>,
}

impl Pending {
    /// Delivers `answer` to request `id`; false if it is no longer waiting.
    pub fn answer(&self, id: u64, answer: McpAnswer) -> bool {
        match self.waiting.lock().remove(&id) {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
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
        self.pending.waiting.lock().insert(id, tx);
        let timeout = if matches!(request, McpUiRequest::Confirm { .. }) { CONFIRM_TIMEOUT } else { UI_TIMEOUT };
        let confirm = matches!(request, McpUiRequest::Confirm { .. });
        let sink = TauriSink { app: self.app.clone(), window: Some(window.to_owned()) };
        if confirm {
            // A confirmation needs the user: bring the window forward.
            if let Some(w) = self.app.get_webview_window(window) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        sink.emit(IdeEvent::McpRequest { id, request });
        let pending = self.pending.clone();
        Box::pin(async move {
            let outcome = tokio::time::timeout(timeout, rx).await;
            pending.waiting.lock().remove(&id);
            // Closes the dialog when it timed out or the call was cancelled.
            let done = Guard(Some(sink), id);
            let answer = match outcome {
                Ok(Ok(a)) => a,
                Ok(Err(_)) => return Err(IdeError::cancelled()),
                Err(_) if confirm => {
                    return Err(IdeError::unavailable("Nobody answered the confirmation in OpenIDEA in time."));
                }
                Err(_) => return Err(IdeError::unavailable("The OpenIDEA window did not answer.")),
            };
            drop(done);
            match answer {
                McpAnswer::Confirm { allow } => Ok(Value::Bool(allow)),
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
}

/// Tells the window that request `.1` is over when dropped (answered, timed out, cancelled).
struct Guard(Option<TauriSink>, u64);

impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(sink) = self.0.take() {
            sink.emit(IdeEvent::McpRequestDone { id: self.1 });
        }
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
    let settings = state.global_settings.effective().mcp;
    tauri::async_runtime::spawn(async move {
        server.apply(&settings).await;
    });
}
