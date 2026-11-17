//! Pure translations between Copilot headless JSON-RPC payloads (`session.event`,
//! permissions, slash commands, MCP servers) and ACP v1.

use crate::LIMITS_UPDATE;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;

const MAX_OUTPUT: usize = 64 * 1024;

#[derive(Default)]
pub(super) struct EventTranslator {
    /// Assistant message IDs that already streamed deltas, so final `assistant.message` won't duplicate them.
    streamed_messages: HashSet<String>,
    /// Tool call metadata captured on `tool.execution_start`, keyed by `toolCallId`.
    tools: HashMap<String, ToolInfo>,
    /// Subagents started in this session (`toolCallId` → subagent session id).
    subagents: HashMap<String, String>,
    /// Last reported prompt token count, used when updating context size.
    pub last_used_tokens: Option<u32>,
}

#[derive(Clone, Debug)]
struct ToolInfo {
    kind: &'static str,
    title: String,
    locations: Vec<Value>,
    output: String,
    diffs: Vec<Value>,
}

/// An ACP notification `(session_id, update)` produced from a Copilot `session.event`.
pub(super) struct Translated {
    pub updates: Vec<(String, Value)>,
    pub terminal: Option<TurnTerminal>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum TurnTerminal {
    Idle { aborted: bool },
    Error { message: String, data: Option<Value> },
}

impl EventTranslator {
    pub fn reset_turn(&mut self) {
        self.streamed_messages.clear();
    }

    pub fn translate(&mut self, main_session: &str, event: &Value, fallback_limit: Option<u32>) -> Translated {
        let mut out = Translated { updates: Vec::new(), terminal: None };
        let event_type = str_of(event, "type").unwrap_or_default();
        let data = event.get("data").unwrap_or(&Value::Null);
        let agent_id = str_of(event, "agentId").filter(|s| !s.is_empty());
        let target_session =
            agent_id.map(|id| format!("{main_session}:sub:{id}")).unwrap_or_else(|| main_session.to_owned());

        match event_type {
            "assistant.reasoning_delta" => {
                let delta = str_of(data, "deltaContent").or_else(|| str_of(data, "content")).unwrap_or_default();
                if !delta.is_empty() {
                    out.updates.push((
                        target_session,
                        json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": delta } }),
                    ));
                }
            }
            "assistant.message_delta" => {
                if data.get("parentToolCallId").and_then(Value::as_str).is_some() && agent_id.is_none() {
                    return out;
                }
                if let Some(mid) = str_of(data, "messageId") {
                    self.streamed_messages.insert(mid.to_owned());
                }
                let delta = str_of(data, "deltaContent").unwrap_or_default();
                if !delta.is_empty() {
                    out.updates.push((
                        target_session,
                        json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": delta } }),
                    ));
                }
            }
            "assistant.message" => {
                if data.get("parentToolCallId").and_then(Value::as_str).is_some() && agent_id.is_none() {
                    return out;
                }
                let already = str_of(data, "messageId").is_some_and(|mid| self.streamed_messages.contains(mid));
                if !already && let Some(content) = str_of(data, "content").filter(|c| !c.is_empty()) {
                    out.updates.push((
                        target_session,
                        json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": content } }),
                    ));
                }
            }
            "tool.execution_start" => {
                let tool_name = str_of(data, "toolName").unwrap_or_default();
                if matches!(tool_name, "report_intent" | "tool_search_tool" | "tool_search_tool_regex") {
                    return out;
                }
                let Some(call_id) = str_of(data, "toolCallId").filter(|s| !s.is_empty()) else { return out };
                let args = data.get("arguments").unwrap_or(&Value::Null);
                if tool_name == "task" && agent_id.is_none() {
                    let sub_id = format!("{main_session}:task:{call_id}");
                    self.subagents.insert(call_id.to_owned(), sub_id.clone());
                    let title = str_of(args, "name").or_else(|| str_of(args, "agent_type")).unwrap_or("Subagent");
                    let desc = str_of(args, "description");
                    let prompt = str_of(args, "prompt");
                    out.updates.push((
                        main_session.to_owned(),
                        json!({
                            "sessionUpdate": "subagent_update",
                            "subagentId": sub_id,
                            "title": title,
                            "description": desc,
                            "prompt": prompt,
                            "status": "running",
                            "cancellable": false,
                        }),
                    ));
                    return out;
                }
                let info = describe_tool(tool_name, args);
                let mut update = json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": call_id,
                    "title": info.title,
                    "kind": info.kind,
                    "status": "in_progress",
                });
                if !info.locations.is_empty() {
                    update["locations"] = Value::Array(info.locations.clone());
                }
                if !info.diffs.is_empty() {
                    update["content"] = Value::Array(info.diffs.clone());
                }
                self.tools.insert(call_id.to_owned(), info);
                out.updates.push((target_session, update));
            }
            "tool.execution_partial_result" | "tool.shell_output" => {
                let Some(call_id) = str_of(data, "toolCallId") else { return out };
                let chunk = str_of(data, "partialOutput")
                    .or_else(|| str_of(data, "output"))
                    .or_else(|| str_of(data, "chunk"))
                    .unwrap_or_default();
                if chunk.is_empty() {
                    return out;
                }
                if let Some(info) = self.tools.get_mut(call_id) {
                    info.output.push_str(chunk);
                    trim_tail(&mut info.output);
                    let content = tool_content(&info.output, &info.diffs);
                    out.updates.push((
                        target_session,
                        json!({
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": call_id,
                            "content": content,
                        }),
                    ));
                }
            }
            "tool.execution_complete" => {
                let Some(call_id) = str_of(data, "toolCallId") else { return out };
                let success = data.get("success").and_then(Value::as_bool).unwrap_or(true);
                let result_text = extract_tool_result_text(data);
                if let Some(sub_id) = self.subagents.remove(call_id) {
                    out.updates.push((
                        main_session.to_owned(),
                        json!({
                            "sessionUpdate": "subagent_update",
                            "subagentId": sub_id,
                            "status": if success { "done" } else { "failed" },
                            "reply": result_text,
                            "error": (!success).then(|| result_text.clone()).flatten(),
                        }),
                    ));
                    return out;
                }
                let Some(mut info) = self.tools.remove(call_id) else { return out };
                if info.output.is_empty()
                    && let Some(t) = result_text
                    && info.kind != "edit"
                {
                    info.output = t;
                    trim_tail(&mut info.output);
                }
                let mut update = json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": call_id,
                    "status": if success { "completed" } else { "failed" },
                });
                let content = tool_content(&info.output, &info.diffs);
                if !content.is_empty() {
                    update["content"] = Value::Array(content);
                }
                out.updates.push((target_session, update));
            }
            "subagent.started" => {
                if let Some(call_id) = str_of(data, "toolCallId") {
                    let sub_id = self
                        .subagents
                        .entry(call_id.to_owned())
                        .or_insert_with(|| format!("{main_session}:task:{call_id}"))
                        .clone();
                    let title = str_of(data, "agentDisplayName").or_else(|| str_of(data, "agentName"));
                    let desc = str_of(data, "agentDescription");
                    out.updates.push((
                        main_session.to_owned(),
                        json!({
                            "sessionUpdate": "subagent_update",
                            "subagentId": sub_id,
                            "title": title,
                            "description": desc,
                            "status": "running",
                        }),
                    ));
                }
            }
            "subagent.failed" => {
                if let Some(call_id) = str_of(data, "toolCallId")
                    && let Some(sub_id) = self.subagents.get(call_id).cloned()
                {
                    out.updates.push((
                        main_session.to_owned(),
                        json!({
                            "sessionUpdate": "subagent_update",
                            "subagentId": sub_id,
                            "status": "failed",
                            "error": str_of(data, "error").or_else(|| str_of(data, "message")),
                        }),
                    ));
                }
            }
            "session.title_changed" => {
                if let Some(title) = str_of(data, "title").map(str::trim).filter(|t| !t.is_empty()) {
                    out.updates.push((
                        main_session.to_owned(),
                        json!({ "sessionUpdate": "session_info_update", "title": title }),
                    ));
                }
            }
            "session.usage_info" => {
                let used = data.get("currentTokens").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
                let limit = data
                    .get("tokenLimit")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok())
                    .filter(|&n| n > 0)
                    .or(fallback_limit);
                if let (Some(used), Some(size)) = (used, limit) {
                    self.last_used_tokens = Some(used);
                    out.updates.push((
                        main_session.to_owned(),
                        json!({ "sessionUpdate": "usage_update", "used": used, "size": size }),
                    ));
                }
            }
            "assistant.usage" => {
                if agent_id.is_none() {
                    let used = data.get("inputTokens").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
                    if let (Some(used), Some(size)) = (used, fallback_limit.filter(|&s| s > 0)) {
                        self.last_used_tokens = Some(used);
                        out.updates.push((
                            main_session.to_owned(),
                            json!({ "sessionUpdate": "usage_update", "used": used, "size": size }),
                        ));
                    }
                }
                if let Some(limits) = quota_limits(data.get("quotaSnapshots")) {
                    out.updates.push((main_session.to_owned(), limits));
                }
            }
            "session.idle" if agent_id.is_none() => {
                let mode = str_of(data, "mode").unwrap_or_default();
                if mode != "autopilot" {
                    let aborted = data.get("aborted").and_then(Value::as_bool).unwrap_or(false);
                    out.terminal = Some(TurnTerminal::Idle { aborted });
                }
            }
            "session.autopilot_stopped" if agent_id.is_none() => {
                let reason = str_of(data, "reason").unwrap_or_default();
                if reason == "error" {
                    out.terminal = Some(TurnTerminal::Error { message: "Autopilot request failed".into(), data: None });
                } else {
                    out.terminal = Some(TurnTerminal::Idle { aborted: reason == "aborted" });
                }
            }
            "session.error" if agent_id.is_none() => {
                let message = str_of(data, "message").unwrap_or("Copilot reported an error.").to_owned();
                out.terminal = Some(TurnTerminal::Error { message, data: Some(data.clone()) });
            }
            _ => {}
        }
        out
    }
}

fn describe_tool(name: &str, args: &Value) -> ToolInfo {
    let mut locations = Vec::new();
    let mut diffs = Vec::new();
    if let Some(p) = str_of(args, "path").or_else(|| str_of(args, "filePath")).filter(|p| !p.is_empty()) {
        locations.push(json!({ "path": p }));
    }
    let (kind, title) = match name {
        "bash" | "powershell" | "shell" => {
            let cmd = str_of(args, "command").or_else(|| str_of(args, "description")).unwrap_or("Run command");
            ("execute", cmd.to_owned())
        }
        "view" | "read_file" => {
            let label = str_of(args, "path")
                .and_then(|p| Path::new(p).file_name().and_then(|n| n.to_str()))
                .unwrap_or("Read file");
            ("read", format!("Read {label}"))
        }
        "grep" | "glob" | "semantic_search" => {
            let pat = str_of(args, "pattern").or_else(|| str_of(args, "query")).unwrap_or(name);
            ("search", format!("Search {pat}"))
        }
        "edit" => {
            let path = str_of(args, "path").unwrap_or_default();
            let old = str_of(args, "old_str").unwrap_or_default();
            let new = str_of(args, "new_str").unwrap_or_default();
            if !path.is_empty() {
                diffs.push(json!({ "type": "diff", "path": path, "oldText": old, "newText": new }));
            }
            let label = Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("file");
            ("edit", format!("Edit {label}"))
        }
        "create" => {
            let path = str_of(args, "path").unwrap_or_default();
            let new = str_of(args, "file_text").unwrap_or_default();
            if !path.is_empty() {
                diffs.push(json!({ "type": "diff", "path": path, "oldText": "", "newText": new }));
            }
            let label = Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("file");
            ("edit", format!("Create {label}"))
        }
        "web_fetch" => {
            let url = str_of(args, "url").unwrap_or("URL");
            ("fetch", format!("Fetch {url}"))
        }
        _ => ("other", str_of(args, "description").unwrap_or(name).to_owned()),
    };
    ToolInfo { kind, title, locations, output: String::new(), diffs }
}

fn extract_tool_result_text(data: &Value) -> Option<String> {
    if let Some(err) = data.pointer("/error/message").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return Some(err.to_owned());
    }
    let result = data.get("result")?;
    if let Some(s) = result.as_str() {
        return (!s.is_empty()).then(|| s.to_owned());
    }
    str_of(result, "content")
        .or_else(|| str_of(result, "detailedContent"))
        .or_else(|| str_of(result, "textResultForLlm"))
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn tool_content(output: &str, diffs: &[Value]) -> Vec<Value> {
    let mut out = diffs.to_vec();
    if !output.is_empty() {
        out.push(json!({ "type": "content", "content": { "type": "text", "text": output } }));
    }
    out
}

fn quota_limits(snapshots: Option<&Value>) -> Option<Value> {
    let map = snapshots?.as_object()?;
    let mut limits = Vec::new();
    for (window, snap) in map {
        let used_pct = snap
            .get("percentageUsed")
            .and_then(Value::as_f64)
            .or_else(|| snap.get("remainingPercentage").and_then(Value::as_f64).map(|rem| 100.0 - rem));
        let Some(used_pct) = used_pct.filter(|p| p.is_finite()) else { continue };
        let resets_ms = snap.get("resetsAt").and_then(Value::as_f64);
        let mut entry = json!({
            "window": window,
            "usedPercent": used_pct.clamp(0.0, 100.0),
        });
        if let Some(ms) = resets_ms {
            entry["resetsMs"] = json!(ms);
        }
        limits.push(entry);
    }
    (!limits.is_empty()).then(|| json!({ "sessionUpdate": LIMITS_UPDATE, "limits": limits }))
}

/// Builds an ACP `session/request_permission` payload from Copilot's `permission.requested` data.
pub(super) fn permission_request(session_id: &str, perm: &Value) -> Value {
    let kind = str_of(perm, "kind").unwrap_or("other");
    let tool_call_id = str_of(perm, "toolCallId").unwrap_or("permission");
    let (acp_kind, title, raw_input) = match kind {
        "shell" => {
            let cmd = str_of(perm, "fullCommandText").or_else(|| str_of(perm, "command")).unwrap_or_default();
            let title = str_of(perm, "intention")
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| if cmd.is_empty() { "Run shell command".into() } else { format!("Run {cmd}") });
            ("execute", title, json!({ "command": cmd }))
        }
        "write" => {
            let path = str_of(perm, "fileName").or_else(|| str_of(perm, "path")).unwrap_or("file");
            ("edit", format!("Edit {path}"), json!({ "path": path }))
        }
        "read" => {
            let path = str_of(perm, "path").unwrap_or("file");
            ("read", format!("Read {path}"), json!({ "path": path }))
        }
        "url" => {
            let url = str_of(perm, "url").unwrap_or("URL");
            ("fetch", format!("Allow network access to {url}"), json!({ "url": url }))
        }
        "mcp" => {
            let server = str_of(perm, "serverName").unwrap_or("MCP");
            let tool = str_of(perm, "toolName").unwrap_or("tool");
            ("other", format!("Run {server}: {tool}"), perm.clone())
        }
        _ => {
            let t = str_of(perm, "intention").or_else(|| str_of(perm, "message")).unwrap_or("Allow action");
            ("other", t.to_owned(), perm.clone())
        }
    };
    json!({
        "sessionId": session_id,
        "toolCall": {
            "toolCallId": tool_call_id,
            "kind": acp_kind,
            "title": title,
            "rawInput": raw_input,
        },
        "options": [
            { "optionId": "approve-once", "name": "Allow once", "kind": "allow_once" },
            { "optionId": "approved", "name": "Always allow", "kind": "allow_always" },
            { "optionId": "denied", "name": "Reject", "kind": "reject_once" },
        ],
    })
}

/// Builds an ACP `session/request_permission` question card for Copilot's `userInput.request`.
pub(super) fn user_input_permission_request(session_id: &str, req: &Value) -> Value {
    let question = str_of(req, "question").unwrap_or("Provide input");
    let choices: Vec<Value> = req
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| c.as_str().map(|label| json!({ "label": label, "description": "" })))
        .collect();
    json!({
        "sessionId": session_id,
        "toolCall": {
            "toolCallId": str_of(req, "toolCallId").unwrap_or("ask_user"),
            "kind": "other",
            "title": question,
            "_meta": {
                "questions": [{
                    "header": "Question",
                    "question": question,
                    "multiSelect": false,
                    "options": choices,
                }]
            }
        },
        "options": [
            { "optionId": "submit", "name": "Submit", "kind": "allow_once" },
            { "optionId": "cancel", "name": "Cancel", "kind": "reject_once" },
        ],
    })
}

/// Converts ACP `mcpServers` array into Copilot's `mcpServers` object map.
pub(super) fn wire_mcp_servers(acp_servers: Option<&Value>) -> Option<Value> {
    let list = acp_servers?.as_array()?;
    let mut out = Map::new();
    for item in list {
        let Some(name) = str_of(item, "name").filter(|n| !n.is_empty()) else { continue };
        let transport = str_of(item, "type").unwrap_or("stdio");
        match transport {
            "http" | "sse" => {
                let Some(url) = str_of(item, "url").filter(|u| !u.is_empty()) else { continue };
                let mut headers = Map::new();
                for kv in item.get("headers").and_then(Value::as_array).into_iter().flatten() {
                    if let (Some(k), Some(v)) = (str_of(kv, "name"), str_of(kv, "value")) {
                        headers.insert(k.to_owned(), json!(v));
                    }
                }
                out.insert(
                    name.to_owned(),
                    json!({
                        "type": transport,
                        "url": url,
                        "headers": headers,
                        "tools": ["*"],
                    }),
                );
            }
            _ => {
                let Some(cmd) = str_of(item, "command").filter(|c| !c.is_empty()) else { continue };
                let args: Vec<Value> = item.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
                let mut env = Map::new();
                for kv in item.get("env").and_then(Value::as_array).into_iter().flatten() {
                    if let (Some(k), Some(v)) = (str_of(kv, "name"), str_of(kv, "value")) {
                        env.insert(k.to_owned(), json!(v));
                    }
                }
                out.insert(
                    name.to_owned(),
                    json!({
                        "type": "local",
                        "command": cmd,
                        "args": args,
                        "env": env,
                        "tools": ["*"],
                    }),
                );
            }
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// Converts `commands.list` + `skills.discover` results into ACP `availableCommands`.
pub(super) fn available_commands(commands_res: Option<&Value>, skills_res: Option<&Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for cmd in commands_res.and_then(|v| v.get("commands")).and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = str_of(cmd, "name").map(|n| n.trim_start_matches('/')).filter(|n| !n.is_empty()) else {
            continue;
        };
        if !seen.insert(name.to_owned()) {
            continue;
        }
        let hint = cmd.pointer("/input/hint").and_then(Value::as_str).filter(|h| !h.is_empty());
        out.push(json!({
            "name": name,
            "description": str_of(cmd, "description").unwrap_or_default(),
            "source": "command",
            "input": hint.map(|h| json!({ "hint": h })),
        }));
    }
    for skill in skills_res.and_then(|v| v.get("skills")).and_then(Value::as_array).into_iter().flatten() {
        if skill.get("enabled").and_then(Value::as_bool) == Some(false)
            || skill.get("userInvocable").and_then(Value::as_bool) == Some(false)
        {
            continue;
        }
        let Some(name) = str_of(skill, "commandName")
            .or_else(|| str_of(skill, "name"))
            .map(|n| n.trim_start_matches('/'))
            .filter(|n| !n.is_empty())
        else {
            continue;
        };
        if !seen.insert(name.to_owned()) {
            continue;
        }
        let hint = str_of(skill, "argumentHint").filter(|h| !h.is_empty());
        out.push(json!({
            "name": name,
            "description": str_of(skill, "description").unwrap_or_default(),
            "source": "skill",
            "input": hint.map(|h| json!({ "hint": h })),
        }));
    }
    out
}

fn trim_tail(text: &mut String) {
    if text.len() > MAX_OUTPUT {
        let mut cut = text.len() - MAX_OUTPUT;
        while !text.is_char_boundary(cut) {
            cut += 1;
        }
        text.replace_range(..cut, "");
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}
