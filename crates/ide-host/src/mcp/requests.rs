//! Window-bound requests; missing windows, cancellation and timeout all fail closed.
use super::tool::Call;
use ide_core::{IdeError, IdeEvent, IdeResult, event::McpUiRequest};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use tokio::sync::oneshot;

#[derive(Default)]
pub struct Requests(Mutex<State>);
#[derive(Default)]
struct State {
    ready: HashSet<String>,
    pending: HashMap<u32, Pending>,
}
struct Pending {
    window: String,
    answer: oneshot::Sender<Result<bool, String>>,
}
impl Requests {
    pub fn set_ready(&self, window: &str, ready: bool) {
        if ready {
            self.0.lock().ready.insert(window.into());
        } else {
            self.forget_window(window);
        }
    }
    pub fn forget_window(&self, window: &str) {
        let mut state = self.0.lock();
        state.ready.remove(window);
        state.pending.retain(|_, p| p.window != window);
    }
    pub fn answer(&self, window: &str, id: u32, allow: bool, error: Option<String>) -> IdeResult<()> {
        let mut state = self.0.lock();
        if !state.pending.get(&id).is_some_and(|p| p.window == window) {
            return Err(IdeError::invalid("MCP request expired or belongs to another window"));
        }
        let pending = state.pending.remove(&id).unwrap();
        let _ = pending.answer.send(error.map_or(Ok(allow), Err));
        Ok(())
    }
    pub(super) async fn ask(&self, call: &Call, request: McpUiRequest) -> IdeResult<()> {
        let id = super::tool::request_id().0;
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.0.lock();
            if !state.ready.contains(call.window()) {
                return Err(IdeError::unavailable("MCP request denied: no project window is available"));
            }
            state.pending.insert(id, Pending { window: call.window.clone(), answer: tx });
        }
        struct Close<'a>(&'a Requests, &'a Call, u32);
        impl Drop for Close<'_> {
            fn drop(&mut self) {
                self.0.0.lock().pending.remove(&self.2);
                self.1.project.sink.emit(IdeEvent::McpRequestClosed { id: self.2 });
            }
        }
        let _close = Close(self, call, id);
        call.project.sink.emit(IdeEvent::McpRequest { id, request });
        let result = tokio::select! {
            result = rx => result.map_err(|_| IdeError::unavailable("MCP request denied: project window closed"))?,
            _ = tokio::time::sleep(std::time::Duration::from_secs(180)) => return Err(IdeError::unavailable("MCP request denied: confirmation timed out")),
            _ = call.cancel.cancelled() => return Err(IdeError::cancelled()),
        };
        match result {
            Ok(true) => Ok(()),
            Ok(false) => Err(IdeError::invalid("MCP request denied by the user")),
            Err(message) => Err(IdeError::unavailable(message)),
        }
    }
}
