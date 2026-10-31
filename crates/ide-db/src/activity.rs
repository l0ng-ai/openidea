//! Statements run on each connection target, running and recent: the query sessions
//! external tools see (`list_recent_sql_queries`) and cancel (`cancel_sql_query`).
//!
//! A session is a connection target (a data source id, or `<id>:<database>`) with a
//! numeric id stable for the life of the project; its work is the statements run there
//! through [`crate::DbManager::execute`] (consoles) and the MCP tools. The IDE's own
//! metadata queries (introspection, completion, table pages) are not listed, like the
//! internal requests.

use ide_core::CancellationToken;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Instant;

/// The session of the consoles' statements.
pub const CONSOLE: &str = "console";
/// The session of statements run by external tools (the MCP server's database tools).
pub const TOOLS: &str = "tools";

/// Finished statements kept per session.
const KEPT_PER_SESSION: usize = 50;

/// Where a statement is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename = "DbWorkState")]
pub enum WorkState {
    Submitted,
    Running,
    Cancelling,
    Finished,
}

/// How a statement ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename = "DbWorkStatus")]
pub enum WorkStatus {
    Success,
    Warning,
    Error,
    Cancelled,
    Unknown,
}

/// One statement of a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[serde(rename = "DbQueryWork")]
pub struct QueryWork {
    pub session_id: u64,
    pub time_spent_ms: u64,
    pub state: WorkState,
    pub status: WorkStatus,
    pub query_text: String,
}

struct Work {
    id: u64,
    text: String,
    started: Instant,
    /// Set when finished.
    spent_ms: Option<u64>,
    state: WorkState,
    status: WorkStatus,
    cancel: CancellationToken,
}

struct Session {
    id: u64,
    target: String,
    /// Who runs statements in it: consoles ([`CONSOLE`]) or external tools ([`TOOLS`]).
    owner: &'static str,
    work: Vec<Work>,
}

#[derive(Default)]
pub struct Activity {
    next_session: u64,
    next_work: u64,
    sessions: Vec<Session>,
}

/// A running statement's entry: finish it with [`Activity::finish`].
pub struct WorkTicket {
    session: u64,
    work: u64,
    /// Cancelled by the caller's token or by [`Activity::cancel_session`].
    pub cancel: CancellationToken,
}

impl Activity {
    fn session_mut(&mut self, target: &str, owner: &'static str) -> &mut Session {
        if let Some(i) = self.sessions.iter().position(|s| s.target == target && s.owner == owner) {
            return &mut self.sessions[i];
        }
        self.next_session += 1;
        self.sessions.push(Session { id: self.next_session, target: target.to_owned(), owner, work: Vec::new() });
        self.sessions.last_mut().expect("pushed")
    }

    /// Records that `text` starts running on `target` in `owner`'s session; `cancel` is the caller's token.
    pub fn start(&mut self, target: &str, owner: &'static str, text: &str, cancel: &CancellationToken) -> WorkTicket {
        self.next_work += 1;
        let work = self.next_work;
        let token = cancel.child_token();
        let session = self.session_mut(target, owner);
        session.work.push(Work {
            id: work,
            text: text.to_owned(),
            started: Instant::now(),
            spent_ms: None,
            state: WorkState::Running,
            status: WorkStatus::Unknown,
            cancel: token.clone(),
        });
        let finished = session.work.iter().filter(|w| w.state == WorkState::Finished).count();
        if finished > KEPT_PER_SESSION {
            let mut drop = finished - KEPT_PER_SESSION;
            session.work.retain(|w| {
                let old = drop > 0 && w.state == WorkState::Finished;
                if old {
                    drop -= 1;
                }
                !old
            });
        }
        WorkTicket { session: session.id, work, cancel: token }
    }

    pub fn finish(&mut self, ticket: &WorkTicket, status: WorkStatus) {
        let Some(s) = self.sessions.iter_mut().find(|s| s.id == ticket.session) else { return };
        if let Some(w) = s.work.iter_mut().find(|w| w.id == ticket.work) {
            w.spent_ms = Some(w.started.elapsed().as_millis() as u64);
            w.state = WorkState::Finished;
            w.status = status;
        }
    }

    /// The statements of the sessions of data source `source` (all its targets), oldest first.
    pub fn list(&self, source: &str) -> Vec<QueryWork> {
        self.sessions
            .iter()
            .filter(|s| crate::split_target(&s.target).0 == source)
            .flat_map(|s| {
                s.work.iter().map(|w| QueryWork {
                    session_id: s.id,
                    time_spent_ms: w.spent_ms.unwrap_or_else(|| w.started.elapsed().as_millis() as u64),
                    state: w.state,
                    status: w.status,
                    query_text: w.text.clone(),
                })
            })
            .collect()
    }

    /// Whether session `id` exists.
    pub fn has_session(&self, id: u64) -> bool {
        self.sessions.iter().any(|s| s.id == id)
    }

    /// Cancels what session `id` is running; false when there is no such session.
    pub fn cancel_session(&mut self, id: u64) -> bool {
        let Some(s) = self.sessions.iter_mut().find(|s| s.id == id) else { return false };
        for w in s.work.iter_mut().filter(|w| w.state != WorkState::Finished) {
            w.state = WorkState::Cancelling;
            w.cancel.cancel();
        }
        true
    }

    /// The target of session `id`.
    pub fn target(&self, id: u64) -> Option<String> {
        self.sessions.iter().find(|s| s.id == id).map(|s| s.target.clone())
    }
}

/// Shared [`Activity`] of one project's connections.
pub type SharedActivity = Mutex<Activity>;

/// Session ids by target, for tests.
#[cfg(test)]
fn ids(a: &Activity) -> std::collections::HashMap<(String, &'static str), u64> {
    a.sessions.iter().map(|s| ((s.target.clone(), s.owner), s.id)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_are_per_target_and_listed_per_source() {
        let mut a = Activity::default();
        let c = CancellationToken::new();
        let t1 = a.start("ds", CONSOLE, "select 1", &c);
        a.finish(&t1, WorkStatus::Success);
        let t2 = a.start("ds:other", CONSOLE, "select 2", &c);
        let _t3 = a.start("ds2", CONSOLE, "select 3", &c);
        a.finish(&t2, WorkStatus::Error);
        let ids = ids(&a);
        assert_eq!(ids.len(), 3);
        let tools = a.start("ds", TOOLS, "select 4", &c);
        a.finish(&tools, WorkStatus::Success);
        assert_eq!(a.list("ds").len(), 3);
        assert_ne!(a.list("ds")[0].session_id, a.list("ds")[2].session_id, "tools have their own session");
        let listed: Vec<_> = a.list("ds").into_iter().take(2).collect();
        assert_eq!(listed[0].query_text, "select 1");
        assert_eq!(listed[0].state, WorkState::Finished);
        assert_eq!(listed[0].status, WorkStatus::Success);
        assert_eq!(listed[1].status, WorkStatus::Error);
        assert_eq!(a.list("ds2")[0].state, WorkState::Running);
    }

    #[test]
    fn cancelling_a_session_cancels_its_running_statements() {
        let mut a = Activity::default();
        let c = CancellationToken::new();
        let t = a.start("ds", TOOLS, "select pg_sleep(10)", &c);
        let id = a.list("ds")[0].session_id;
        assert!(a.cancel_session(id));
        assert!(t.cancel.is_cancelled());
        assert!(!c.is_cancelled(), "the caller's token stays");
        assert_eq!(a.list("ds")[0].state, WorkState::Cancelling);
        assert!(!a.cancel_session(id + 100));
    }

    #[test]
    fn keeps_the_latest_finished_statements() {
        let mut a = Activity::default();
        let c = CancellationToken::new();
        for i in 0..(KEPT_PER_SESSION + 10) {
            let t = a.start("ds", CONSOLE, &format!("select {i}"), &c);
            a.finish(&t, WorkStatus::Success);
        }
        let listed = a.list("ds");
        assert!(listed.len() <= KEPT_PER_SESSION + 1);
        assert_eq!(listed.last().unwrap().query_text, format!("select {}", KEPT_PER_SESSION + 9));
    }
}
