// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/impl/McpProgressForwarder.kt), Apache-2.0.
//! `notifications/progress` for a call that carries `_meta.progressToken`: the first
//! one at once, then at most one per interval, repeating the latest while nothing
//! changes (a keep-alive: clients reset their request timeout on progress), and the
//! latest one before the result if it has not gone out yet.

use crate::session::{Outbound, Session};
use crate::tool::ProgressSink;
use ide_core::CancellationToken;
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq)]
struct Event {
    progress: f64,
    total: Option<f64>,
    message: Option<String>,
}

struct State {
    latest: Event,
    sent: Event,
}

pub(crate) struct Forwarder {
    session: Arc<Session>,
    via: Option<Outbound>,
    token: Value,
    state: Arc<Mutex<State>>,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl Forwarder {
    /// Starts forwarding; the returned sink is what [`crate::tool::Call::report_progress`] feeds.
    pub fn start(
        session: Arc<Session>,
        via: Option<Outbound>,
        token: Value,
        interval: Duration,
    ) -> (Self, ProgressSink) {
        // The first one goes out before the tool runs, so it is the empty one.
        let first = Event { progress: 0.0, total: None, message: None };
        send(&session, via.as_ref(), &token, &first);
        let state = Arc::new(Mutex::new(State { latest: first.clone(), sent: first }));
        let stop = CancellationToken::new();
        let task = {
            let (session, via, token, state, stop) =
                (session.clone(), via.clone(), token.clone(), state.clone(), stop.clone());
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep(interval) => {}
                        _ = stop.cancelled() => return,
                    }
                    let event = state.lock().latest.clone();
                    send(&session, via.as_ref(), &token, &event);
                    state.lock().sent = event;
                }
            })
        };
        let sink: ProgressSink = {
            let state = state.clone();
            Arc::new(move |progress, total, message| {
                state.lock().latest = Event { progress, total, message };
            })
        };
        (Self { session, via, token, state, stop, task }, sink)
    }

    /// Stops the keep-alive and sends the latest progress if it has not gone out.
    pub async fn finish(self) {
        self.stop.cancel();
        let _ = self.task.await;
        let state = self.state.lock();
        if state.sent != state.latest {
            send(&self.session, self.via.as_ref(), &self.token, &state.latest);
        }
    }
}

fn send(session: &Session, via: Option<&Outbound>, token: &Value, event: &Event) {
    let mut params = json!({ "progressToken": token, "progress": event.progress });
    if let Some(total) = event.total {
        params["total"] = total.into();
    }
    if let Some(message) = &event.message {
        params["message"] = message.clone().into();
    }
    session.notify(via, "notifications/progress", params);
}
