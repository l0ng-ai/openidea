//! How Claude Code's tools look as ACP tool calls: title, kind, locations and content.

use serde_json::{Value, json};
use std::path::Path;

/// Tools reported some other way than as a tool call.
pub(super) fn is_agent(name: &str) -> bool {
    matches!(name, "Agent" | "Task")
}

/// Tools whose calls become the session's plan instead of tool calls.
pub(super) fn is_plan(name: &str) -> bool {
    matches!(name, "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet")
}

/// The fields of a `tool_call` for a use of tool `name` with `input`.
pub(super) fn call_fields(name: &str, input: &Value, cwd: &Path) -> Value {
    let s = |k: &str| input.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
    let path = s("file_path").or_else(|| s("notebook_path")).or_else(|| s("path"));
    let shown = path.map(|p| display_path(p, cwd));
    let (title, kind) = match name {
        "Bash" | "PowerShell" => (s("command").map(first_line).unwrap_or_else(|| "Terminal".into()), "execute"),
        "Read" => {
            let range = match (input.get("offset").and_then(Value::as_u64), input.get("limit").and_then(Value::as_u64))
            {
                (o, Some(l)) if l > 0 => {
                    let from = o.unwrap_or(1);
                    format!(" ({from} - {})", from + l - 1)
                }
                (Some(o), _) => format!(" (from line {o})"),
                _ => String::new(),
            };
            (format!("Read {}{range}", shown.as_deref().unwrap_or("file")), "read")
        }
        "Write" => (shown.map_or_else(|| "Write".into(), |p| format!("Write {p}")), "edit"),
        "Edit" | "MultiEdit" => (shown.map_or_else(|| "Edit".into(), |p| format!("Edit {p}")), "edit"),
        "NotebookEdit" => (shown.map_or_else(|| "Edit notebook".into(), |p| format!("Edit {p}")), "edit"),
        "Glob" => (format!("Find {}", s("pattern").unwrap_or_default()).trim_end().to_owned(), "search"),
        "Grep" => {
            let mut t = format!("grep \"{}\"", s("pattern").unwrap_or_default());
            if let Some(p) = path {
                t.push(' ');
                t.push_str(&display_path(p, cwd));
            }
            (t, "search")
        }
        "WebFetch" => (s("url").map_or_else(|| "Fetch".into(), |u| format!("Fetch {u}")), "fetch"),
        "WebSearch" => (s("query").map_or_else(|| "Web search".into(), |q| format!("Search \"{q}\"")), "fetch"),
        "Agent" | "Task" => (s("description").unwrap_or("Subagent").to_owned(), "think"),
        "ExitPlanMode" => ("Ready to code?".into(), "switch_mode"),
        "EnterPlanMode" => ("Enter plan mode".into(), "switch_mode"),
        "Skill" => (s("skill").map_or_else(|| "Load skill".into(), |k| format!("Load skill: {k}")), "other"),
        _ => (mcp_title(name), "other"),
    };
    let mut out = json!({ "title": title, "kind": kind, "rawInput": input });
    if let Some(p) = path
        && matches!(kind, "read" | "edit" | "search")
    {
        let mut loc = json!({ "path": p });
        if name == "Read" {
            loc["line"] = json!(input.get("offset").and_then(Value::as_u64).unwrap_or(1));
        }
        out["locations"] = json!([loc]);
    }
    let content = input_content(name, input);
    if !content.is_empty() {
        out["content"] = Value::Array(content);
    }
    out
}

/// What the input itself shows: an edit's change, a command's purpose, a plan.
fn input_content(name: &str, input: &Value) -> Vec<Value> {
    let s = |k: &str| input.get(k).and_then(Value::as_str);
    match name {
        "Edit" => match s("file_path") {
            Some(p) => vec![diff(p, s("old_string"), s("new_string").unwrap_or_default())],
            None => Vec::new(),
        },
        "MultiEdit" => {
            let Some(p) = s("file_path") else { return Vec::new() };
            let edits = input.get("edits").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            edits
                .iter()
                .map(|e| {
                    let field = |k: &str| e.get(k).and_then(Value::as_str);
                    diff(p, field("old_string"), field("new_string").unwrap_or_default())
                })
                .collect()
        }
        "Write" => match (s("file_path"), s("content")) {
            (Some(p), Some(c)) => vec![diff(p, None, c)],
            _ => Vec::new(),
        },
        "ExitPlanMode" => s("plan").map(|p| vec![text(p)]).unwrap_or_default(),
        "Bash" | "WebFetch" => s("description").or_else(|| s("prompt")).map(|d| vec![text(d)]).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The `tool_call_update` fields that finish a call: status and what it produced.
/// `structured` is the message's `tool_use_result`.
pub(super) fn result_fields(name: &str, input: &Value, block: &Value, structured: Option<&Value>) -> Value {
    let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
    let mut content = Vec::new();
    match name {
        "Edit" | "MultiEdit" | "Write" if !failed => {
            // The final change: a write that replaced a file shows what it replaced.
            content = input_content(name, input);
            if name == "Write"
                && let (Some(old), Some(c)) =
                    (structured.and_then(|s| s.get("originalFile")).and_then(Value::as_str), content.first_mut())
            {
                c["oldText"] = json!(old);
            }
        }
        "Bash" | "PowerShell" => {
            let out = structured
                .filter(|s| s.get("stdout").is_some())
                .map(|s| {
                    let part = |k: &str| s.get(k).and_then(Value::as_str).unwrap_or_default();
                    [part("stdout"), part("stderr")]
                        .iter()
                        .filter(|p| !p.is_empty())
                        .copied()
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_else(|| result_text(block));
            if !out.is_empty() {
                content.push(text(&out));
            }
        }
        _ => {
            let t = result_text(block);
            if !t.is_empty() {
                content.push(text(&t));
            }
        }
    }
    if failed && content.is_empty() {
        let t = result_text(block);
        if !t.is_empty() {
            content.push(text(&t));
        }
    }
    if let Some(blocks) = block.get("content").and_then(Value::as_array) {
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("image") {
                continue;
            }
            let Some(source) = block.get("source") else { continue };
            if source.get("type").and_then(Value::as_str) != Some("base64") {
                continue;
            }
            let data = source.get("data").and_then(Value::as_str).unwrap_or_default();
            let mime = source.get("media_type").and_then(Value::as_str).unwrap_or_default();
            if !data.is_empty() && mime.starts_with("image/") {
                content.push(json!({"type": "content", "content": {"type": "image", "mimeType": mime, "data": data}}));
            }
        }
    }
    let mut out = json!({ "status": if failed { "failed" } else { "completed" } });
    if !content.is_empty() {
        out["content"] = Value::Array(content);
    }
    out
}

/// The text of a `tool_result` block's content (a string or text blocks).
pub(super) fn result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => {
            items.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")
        }
        _ => String::new(),
    }
}

/// `TodoWrite` input as ACP plan entries.
pub(super) fn todo_entries(input: &Value) -> Option<Vec<Value>> {
    let todos = input.get("todos")?.as_array()?;
    Some(
        todos
            .iter()
            .map(|t| {
                let s = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or_default();
                let status = s("status");
                let content =
                    if status == "in_progress" && !s("activeForm").is_empty() { s("activeForm") } else { s("content") };
                json!({ "content": content, "status": status, "priority": "medium" })
            })
            .collect(),
    )
}

pub(super) fn text(t: &str) -> Value {
    json!({ "type": "content", "content": { "type": "text", "text": t } })
}

fn diff(path: &str, old: Option<&str>, new: &str) -> Value {
    json!({ "type": "diff", "path": path, "oldText": old, "newText": new })
}

fn first_line(s: &str) -> String {
    let line = s.lines().next().unwrap_or_default();
    if s.contains('\n') { format!("{line} …") } else { line.to_owned() }
}

/// `mcp__server__tool` as `server: tool`.
fn mcp_title(name: &str) -> String {
    match name.strip_prefix("mcp__").and_then(|r| r.split_once("__")) {
        Some((server, tool)) => format!("{server}: {tool}"),
        None => name.to_owned(),
    }
}

fn display_path(path: &str, cwd: &Path) -> String {
    Path::new(path)
        .strip_prefix(cwd)
        .ok()
        .filter(|r| !r.as_os_str().is_empty())
        .map_or_else(|| path.to_owned(), |r| r.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_kinds_and_changes() {
        let cwd = Path::new("/w");
        let edit = call_fields("Edit", &json!({"file_path": "/w/src/a.rs", "old_string": "a", "new_string": "b"}), cwd);
        assert_eq!(edit["title"], "Edit src/a.rs");
        assert_eq!(edit["kind"], "edit");
        assert_eq!(edit["locations"], json!([{"path": "/w/src/a.rs"}]));
        assert_eq!(edit["content"], json!([{"type": "diff", "path": "/w/src/a.rs", "oldText": "a", "newText": "b"}]));
        let read = call_fields("Read", &json!({"file_path": "/x/b.rs", "offset": 10, "limit": 5}), cwd);
        assert_eq!((read["title"].as_str(), read["kind"].as_str()), (Some("Read /x/b.rs (10 - 14)"), Some("read")));
        assert_eq!(read["locations"], json!([{"path": "/x/b.rs", "line": 10}]));
        let bash = call_fields("Bash", &json!({"command": "ls\npwd", "description": "List"}), cwd);
        assert_eq!((bash["title"].as_str(), bash["kind"].as_str()), (Some("ls …"), Some("execute")));
        assert_eq!(call_fields("Grep", &json!({"pattern": "fn", "path": "/w/src"}), cwd)["title"], "grep \"fn\" src");
        assert_eq!(call_fields("mcp__docs__read", &json!({}), cwd)["title"], "docs: read");
        assert_eq!(call_fields("WebSearch", &json!({"query": "q"}), cwd)["kind"], "fetch");
    }

    #[test]
    fn image_tool_results_keep_text_and_inline_images() {
        let result = result_fields(
            "Read",
            &json!({"file_path": "/w/preview.png"}),
            &json!({"content": [
                {"type": "text", "text": "Preview ready"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aW1hZ2U="}}
            ]}),
            None,
        );
        assert_eq!(result["status"], "completed");
        assert_eq!(
            result["content"],
            json!([
                text("Preview ready"),
                {"type": "content", "content": {"type": "image", "mimeType": "image/png", "data": "aW1hZ2U="}}
            ])
        );
    }

    #[test]
    fn failed_shell_tool_images_keep_fallback_error_text() {
        let result = result_fields(
            "Bash",
            &json!({}),
            &json!({"is_error": true, "content": [
                {"type": "text", "text": "Preview command failed"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aW1hZ2U="}}
            ]}),
            Some(&json!({"stdout": "", "stderr": ""})),
        );
        assert_eq!(result["status"], "failed");
        assert_eq!(result["content"][0], text("Preview command failed"));
        assert_eq!(result["content"][1]["content"]["type"], "image");
    }

    #[test]
    fn results() {
        let input = json!({"file_path": "/w/n.txt", "content": "two"});
        let r = result_fields(
            "Write",
            &input,
            &json!({"type": "tool_result", "content": "File created"}),
            Some(&json!({"type": "update", "originalFile": "one"})),
        );
        assert_eq!(
            r,
            json!({"status": "completed", "content": [{"type": "diff", "path": "/w/n.txt", "oldText": "one", "newText": "two"}]})
        );
        let denied = result_fields("Edit", &json!({}), &json!({"content": "User denied", "is_error": true}), None);
        assert_eq!(denied, json!({"status": "failed", "content": [text("User denied")]}));
        let bash = result_fields(
            "Bash",
            &json!({}),
            &json!({"content": "x"}),
            Some(&json!({"stdout": "out", "stderr": "err"})),
        );
        assert_eq!(bash["content"], json!([text("out\nerr")]));
        let todos =
            todo_entries(&json!({"todos": [{"content": "A", "activeForm": "Doing A", "status": "in_progress"}]}));
        assert_eq!(todos.unwrap()[0]["content"], "Doing A");
    }
}
