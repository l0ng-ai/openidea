// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/toolwindow/McpDiagnosticService.kt), Apache-2.0.
//! The recent tool calls (client, tool, arguments without secrets, project, start, duration,
//! outcome, changed files) for the settings page (`mcp_call_history`) and `get_ide_diagnostics`.

use ide_core::error::ErrorKind;
use ide_core::mcp::{McpCallOutcome, McpCallRecord};
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Calls kept; older ones are dropped.
pub const MAX_CALLS: usize = 200;
/// Characters of a call's arguments kept.
const MAX_ARGUMENTS_CHARS: usize = 500;
/// Characters of one string argument kept.
const MAX_VALUE_CHARS: usize = 120;

#[derive(Default)]
pub struct CallHistory {
    next_id: AtomicU32,
    calls: Mutex<VecDeque<McpCallRecord>>,
}

/// A started call, to pass to [`CallHistory::finish`].
pub struct Started {
    id: u32,
    at: Instant,
}

/// How a call ended, for [`CallHistory::finish`].
pub struct Ended {
    pub outcome: McpCallOutcome,
    /// Why it did not succeed.
    pub error: Option<String>,
    /// Files it created, changed, moved or deleted, as shown to the user.
    pub changed_files: Vec<String>,
}

impl Ended {
    pub fn success() -> Self {
        Self { outcome: McpCallOutcome::Success, error: None, changed_files: Vec::new() }
    }

    /// The handler returned `e` (a cancellation or an error).
    pub fn error(e: &IdeError) -> Self {
        let outcome = if e.kind == ErrorKind::Cancelled { McpCallOutcome::Cancelled } else { McpCallOutcome::Error };
        Self { outcome, error: Some(e.message.clone()), changed_files: Vec::new() }
    }

    /// From the result of the call's handler.
    pub fn of<T>(result: &IdeResult<T>) -> Self {
        result.as_ref().map_or_else(Self::error, |_| Self::success())
    }

    /// The handler panicked.
    pub fn failed(message: String) -> Self {
        Self { outcome: McpCallOutcome::Failed, error: Some(message), changed_files: Vec::new() }
    }
}

impl CallHistory {
    /// Records a call that starts now; `project` is its project's root once known.
    pub fn begin(
        &self,
        client: &str,
        tool: &str,
        args: &Map<String, Value>,
        via_router: bool,
        project: Option<&Path>,
    ) -> Started {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let started_at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        let mut calls = self.calls.lock();
        if calls.len() >= MAX_CALLS {
            calls.pop_front();
        }
        calls.push_back(McpCallRecord {
            id,
            client: client.into(),
            tool: tool.into(),
            arguments: summarize_arguments(args),
            started_at_ms,
            duration_ms: None,
            outcome: McpCallOutcome::InProgress,
            error: None,
            via_router,
            project: project.map(|p| p.display().to_string()),
            changed_files: Vec::new(),
        });
        Started { id, at: Instant::now() }
    }

    /// The call's project became known.
    pub fn set_project(&self, started: &Started, root: &Path) {
        self.update(started.id, |call| call.project = Some(root.display().to_string()));
    }

    /// Records how the call ended.
    pub fn finish(&self, started: Started, ended: Ended) {
        let duration = started.at.elapsed().as_millis().min(u32::MAX as u128) as u32;
        self.update(started.id, |call| {
            call.duration_ms = Some(duration);
            call.outcome = ended.outcome;
            call.error = ended.error;
            call.changed_files = ended.changed_files;
        });
    }

    fn update(&self, id: u32, f: impl FnOnce(&mut McpCallRecord)) {
        if let Some(call) = self.calls.lock().iter_mut().rev().find(|c| c.id == id) {
            f(call);
        }
    }

    /// The recorded calls, most recent first.
    pub fn snapshot(&self) -> Vec<McpCallRecord> {
        self.calls.lock().iter().rev().cloned().collect()
    }
}

/// Whether an argument's name says its value is a secret.
fn is_secret(name: &str) -> bool {
    let n = name.to_ascii_lowercase().replace(['_', '-'], "");
    ["token", "secret", "password", "passwd", "apikey", "authorization", "credential", "privatekey", "cookie"]
        .iter()
        .any(|s| n.contains(s))
        || n == "auth"
}

/// `args` as compact JSON with secret-looking values replaced by `***` and long strings cut.
pub fn summarize_arguments(args: &Map<String, Value>) -> String {
    fn redact(value: &Value, key: Option<&str>) -> Value {
        if key.is_some_and(is_secret) && !value.is_null() {
            return Value::String("***".into());
        }
        match value {
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), redact(v, Some(k)))).collect()),
            Value::Array(items) => Value::Array(items.iter().map(|v| redact(v, None)).collect()),
            Value::String(s) => {
                let s = redact_assignments(s);
                if s.chars().count() > MAX_VALUE_CHARS {
                    Value::String(format!("{}…", s.chars().take(MAX_VALUE_CHARS).collect::<String>()))
                } else {
                    Value::String(s)
                }
            }
            v => v.clone(),
        }
    }
    let text = redact(&Value::Object(args.clone()), None).to_string();
    if text.chars().count() > MAX_ARGUMENTS_CHARS {
        format!("{}…", text.chars().take(MAX_ARGUMENTS_CHARS).collect::<String>())
    } else {
        text
    }
}

/// `API_TOKEN=abc` and `Bearer abc` inside a string (a command line) with the value replaced by `***`.
fn redact_assignments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut bearer = false;
    for (i, word) in s.split(' ').enumerate() {
        if i > 0 {
            out.push(' ');
        }
        match word.split_once('=') {
            _ if bearer && !word.is_empty() => out.push_str("***"),
            Some((key, value)) if !value.is_empty() && is_secret(key.trim_start_matches('-')) => {
                out.push_str(key);
                out.push_str("=***");
            }
            _ => out.push_str(word),
        }
        bearer = word.eq_ignore_ascii_case("bearer");
    }
    out
}
