// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/toolwindow/McpDiagnosticService.kt), Apache-2.0.
//! The recent tool calls (client, tool, arguments without secrets, start, duration, outcome)
//! for the settings page (`mcp_call_history`) and `get_ide_diagnostics`.

use crate::tool::Output;
use ide_core::IdeResult;
use ide_core::error::ErrorKind;
use ide_core::mcp::{McpCallOutcome, McpCallRecord};
use parking_lot::Mutex;
use serde_json::{Map, Value};
use std::collections::VecDeque;
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

impl CallHistory {
    pub fn begin(&self, client: &str, tool: &str, args: &Map<String, Value>, via_router: bool) -> Started {
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
        });
        Started { id, at: Instant::now() }
    }

    /// Records how the call ended: its result, or `Err` when its task panicked.
    pub fn finish<E>(&self, started: Started, result: &Result<IdeResult<Output>, E>) {
        let (outcome, error) = match result {
            Ok(Ok(_)) => (McpCallOutcome::Success, None),
            Ok(Err(e)) if e.kind == ErrorKind::Cancelled => (McpCallOutcome::Cancelled, None),
            Ok(Err(e)) => (McpCallOutcome::Error, Some(e.message.clone())),
            Err(_) => (McpCallOutcome::Error, Some("the tool failed unexpectedly".to_owned())),
        };
        if let Some(call) = self.calls.lock().iter_mut().rev().find(|c| c.id == started.id) {
            call.duration_ms = Some(started.at.elapsed().as_millis().min(u32::MAX as u128) as u32);
            call.outcome = outcome;
            call.error = error;
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
