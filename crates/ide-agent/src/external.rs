//! Sessions the user started outside OpenIDEA (a terminal, another editor, the CLI):
//! scanned so they can be listed and imported as tasks instead of re-explained (#312).
//!
//! Only the native providers keep transcripts on disk in a readable form: Claude Code
//! (`<config>/projects/*/<id>.jsonl`, see `native::claude::history`) and Codex
//! (`<home>/.codex/sessions/**`, rollout files with a `session_meta` line).

use super::native::claude::history;
use serde::Serialize;
use specta::Type;
use std::path::{Path, PathBuf};

/// A session on this machine that no task holds yet.
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    /// The [`crate::AgentProvider`] id that owns it (`claude`, `codex`).
    pub provider: String,
    /// The id resuming it names (`--resume`, `thread/resume`).
    pub session_id: String,
    pub title: String,
    /// Where it ran, when the transcript names one.
    pub cwd: Option<String>,
    /// File modification time, ms since the epoch.
    pub updated_ms: f64,
}

/// Modification time of `path` in ms, else 0.
fn mtime(path: &Path) -> f64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Short display text: collapsed whitespace, truncated to `MAX_TITLE` chars.
fn short(text: &str) -> String {
    const MAX_TITLE: usize = 80;
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_TITLE {
        flat
    } else {
        format!("{}…", flat.chars().take(MAX_TITLE - 1).collect::<String>())
    }
}

/// The text of a Claude Code transcript entry's message, when it carries prose.
fn message_text(e: &serde_json::Value) -> Option<String> {
    match e.pointer("/message/content") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Array(blocks)) => {
            let text: Vec<&str> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(serde_json::Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(serde_json::Value::as_str))
                .collect();
            (!text.is_empty()).then(|| text.join("\n"))
        }
        _ => None,
    }
}

/// Claude Code transcripts: `<config>/projects/*/<id>.jsonl`.
pub fn claude_sessions(config_dir: &Path) -> Vec<ExternalSession> {
    let mut out = Vec::new();
    let projects = config_dir.join("projects");
    let dirs: Vec<PathBuf> = std::fs::read_dir(&projects).into_iter().flatten().flatten().map(|d| d.path()).collect();
    for dir in dirs {
        let files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|d| d.path())
            .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
            .collect();
        for path in files {
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_owned();
            if id.is_empty() {
                continue;
            }
            let entries = history::read(&path).unwrap_or_default();
            if entries.is_empty() {
                continue;
            }
            let title = history::title(&entries)
                .or_else(|| entries.iter().filter(|e| history::is_turn_start(e)).filter_map(message_text).next())
                .map(|t| short(&t))
                .unwrap_or_else(|| format!("Claude Code session {}", &id[..id.len().min(8)]));
            let cwd = entries
                .iter()
                .filter_map(|e| e.get("cwd").and_then(serde_json::Value::as_str))
                .next()
                .map(str::to_owned);
            out.push(ExternalSession {
                provider: "claude".to_owned(),
                session_id: id,
                title,
                cwd,
                updated_ms: mtime(&path),
            });
        }
    }
    out
}

/// The `session_meta` line of a Codex rollout file: `(id, cwd)`, across shapes.
fn codex_meta(line: &serde_json::Value) -> Option<(String, Option<String>)> {
    let payload =
        line.get("payload").filter(|p| p.get("type").and_then(serde_json::Value::as_str) == Some("session_meta"));
    let inner = payload.and_then(|p| p.get("payload")).or_else(|| {
        line.get("type").and_then(serde_json::Value::as_str).filter(|t| *t == "session_meta").and(Some(line))
    })?;
    let id = inner.get("id").and_then(serde_json::Value::as_str)?.to_owned();
    let cwd = inner.get("cwd").and_then(serde_json::Value::as_str).map(str::to_owned);
    Some((id, cwd))
}

/// A prose line of a Codex rollout file (a user message), across shapes.
fn codex_user_text(line: &serde_json::Value) -> Option<String> {
    let payload = line.get("payload")?;
    let ty = payload.get("type").and_then(serde_json::Value::as_str)?;
    if !(ty == "user_message" || ty == "userMessage" || ty == "event_msg") {
        return None;
    }
    let inner = payload.get("payload").unwrap_or(&serde_json::Value::Null);
    for v in [payload, inner] {
        if let Some(s) = v.get("message").and_then(serde_json::Value::as_str) {
            return Some(s.to_owned());
        }
        if let Some(s) = v.get("text").and_then(serde_json::Value::as_str) {
            return Some(s.to_owned());
        }
    }
    None
}

/// One rollout file's session, or `None` when it names no `session_meta`.
fn codex_file(path: &Path) -> Option<ExternalSession> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut id: Option<(String, Option<String>)> = None;
    let mut title: Option<String> = None;
    // `session_meta` is first, but cap the scan: giant rollouts must not stall listing.
    for line in text.lines().take(400) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if id.is_none()
            && let Some(meta) = codex_meta(&v)
        {
            id = Some(meta);
        }
        if title.is_none()
            && let Some(t) = codex_user_text(&v)
        {
            title = Some(short(&t));
        }
        if id.is_some() && title.is_some() {
            break;
        }
    }
    let (session_id, cwd) = id?;
    Some(ExternalSession {
        provider: "codex".to_owned(),
        title: title.unwrap_or_else(|| format!("Codex session {}", &session_id[..session_id.len().min(8)])),
        session_id,
        cwd,
        updated_ms: mtime(path),
    })
}

/// Collects `*.jsonl` below `dir`, up to 4 levels (`sessions/YYYY/MM/DD/<rollout>`).
fn rollout_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            rollout_files(&path, depth - 1, out);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}

/// Codex sessions: `<home>/.codex/sessions/**`.
pub fn codex_sessions(codex_home: &Path) -> Vec<ExternalSession> {
    let mut files = Vec::new();
    rollout_files(&codex_home.join("sessions"), 4, &mut files);
    files.iter().filter_map(|p| codex_file(p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn write(path: &Path, lines: &[serde_json::Value]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(path).unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
    }

    fn claude_user(uuid: &str, text: &str) -> serde_json::Value {
        json!({"type": "user", "uuid": uuid, "parentUuid": null,
            "message": {"role": "user", "content": text}, "cwd": "/work/app"})
    }

    #[test]
    fn lists_claude_transcripts_with_titles() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &tmp.path().join("projects/-work-app/abc123.jsonl"),
            &[
                claude_user("u1", "fix the login bug"),
                json!({"type": "assistant", "uuid": "a1", "parentUuid": "u1",
                    "message": {"role": "assistant", "content": []}}),
                json!({"type": "ai-title", "aiTitle": "Login fix"}),
            ],
        );
        write(&tmp.path().join("projects/-work-app/empty.jsonl"), &[]);
        let sessions = claude_sessions(tmp.path());
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!((s.provider.as_str(), s.session_id.as_str()), ("claude", "abc123"));
        assert_eq!(s.title, "Login fix");
        assert_eq!(s.cwd.as_deref(), Some("/work/app"));
        assert!(s.updated_ms > 0.0);
    }

    #[test]
    fn claude_title_falls_back_to_the_first_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("projects/-x/def456.jsonl"), &[claude_user("u1", "hello there")]);
        let sessions = claude_sessions(tmp.path());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "hello there");
    }

    #[test]
    fn lists_codex_rollouts_with_meta() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &tmp.path().join("sessions/2026/01/02/rollout-01.jsonl"),
            &[
                json!({"timestamp": "t", "payload": {"type": "session_meta",
                    "payload": {"id": "thread-1", "cwd": "/work/app"}}}),
                json!({"timestamp": "t", "payload": {"type": "user_message",
                    "payload": {"message": "add tests"}}}),
            ],
        );
        write(&tmp.path().join("sessions/notes.jsonl"), &[json!({"nope": true})]);
        let sessions = codex_sessions(tmp.path());
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!((s.provider.as_str(), s.session_id.as_str()), ("codex", "thread-1"));
        assert_eq!(s.title, "add tests");
        assert_eq!(s.cwd.as_deref(), Some("/work/app"));
    }

    #[test]
    fn missing_directories_list_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(claude_sessions(&tmp.path().join("nope")).is_empty());
        assert!(codex_sessions(&tmp.path().join("nope")).is_empty());
    }
}
