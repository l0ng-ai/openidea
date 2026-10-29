//! Claude Code's conversation messages (`assistant`, `user`, `stream_event`, task events)
//! as ACP `session/update`s, for live sessions and for replayed history alike.
//!
//! Subagents (the Agent tool) become ACP subagent sessions whose id is the id of the
//! Agent tool use that launched them: their messages carry it as `parent_tool_use_id`.

use super::tools;
use crate::RETRY_UPDATE;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;

/// One `session/update`: the session it belongs to and the update object.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Update {
    pub session: String,
    pub update: Value,
}

struct ToolUse {
    name: String,
    input: Value,
    /// The session the call belongs to.
    session: String,
    /// A `tool_call` went out for it.
    emitted: bool,
}

struct Child {
    /// The session that launched it.
    parent: String,
    /// What it said last: its answer when it finishes in the background.
    last_text: String,
    /// Runs in the background (`task_started`): it reports in a task notification, else
    /// in its tool result.
    background: Option<bool>,
    done: bool,
}

pub(super) struct Translator {
    root: String,
    cwd: PathBuf,
    /// The client shows subagents as sessions of their own.
    subagents: bool,
    /// Text and thinking blocks that streamed, by API message id: (thought, text).
    streamed: HashMap<String, VecDeque<(bool, String)>>,
    /// The message streaming now, per session.
    streaming: HashMap<String, String>,
    tools: HashMap<String, ToolUse>,
    /// Subagents by the id of their Agent tool use (their session id).
    children: HashMap<String, Child>,
    /// Agent ids (`agent_id`, `task_id`) to the subagent's session id.
    agent_ids: HashMap<String, String>,
    /// `TaskCreate` lists: (task id, content, status).
    tasks: Vec<(String, String, String)>,
    /// Context use of the main conversation: tokens in its last request, the model, the
    /// window of each model seen in a `result`.
    pub used: Option<u64>,
    pub model: Option<String>,
    windows: HashMap<String, u64>,
}

impl Translator {
    pub fn new(root: &str, cwd: PathBuf, subagents: bool) -> Self {
        Self {
            root: root.to_owned(),
            cwd,
            subagents,
            streamed: HashMap::new(),
            streaming: HashMap::new(),
            tools: HashMap::new(),
            children: HashMap::new(),
            agent_ids: HashMap::new(),
            tasks: Vec::new(),
            used: None,
            model: None,
            windows: HashMap::new(),
        }
    }

    /// The session a message with `parent_tool_use_id` belongs to; `None` when it is a
    /// subagent's the client doesn't show.
    fn owner(&self, parent: Option<&str>) -> Option<String> {
        match parent {
            None => Some(self.root.clone()),
            Some(p) if self.children.contains_key(p) => Some(p.to_owned()),
            Some(_) => None,
        }
    }

    /// The session of subagent `agent_id` (a permission request's), else the main one.
    pub fn session_of_agent(&self, agent_id: Option<&str>) -> String {
        agent_id.and_then(|a| self.agent_ids.get(a)).cloned().unwrap_or_else(|| self.root.clone())
    }

    /// The subagent session `session`'s agent id, to stop it.
    pub fn agent_of(&self, session: &str) -> Option<String> {
        self.agent_ids.iter().find(|(_, s)| *s == session).map(|(a, _)| a.clone())
    }

    /// The call `tool_use_id` as a `toolCall` for a permission request.
    pub fn tool_call(&self, tool_use_id: &str, name: &str, input: &Value) -> Value {
        let mut call = tools::call_fields(name, input, &self.cwd);
        call["toolCallId"] = json!(tool_use_id);
        call
    }

    /// Whether a `tool_call` went out for `id`.
    pub fn emitted(&self, id: &str) -> bool {
        self.tools.get(id).is_some_and(|t| t.emitted)
    }

    /// Ensures the call `id` is shown before something refers to it (a permission request).
    pub fn ensure_call(&mut self, id: &str, name: &str, input: &Value, session: &str) -> Vec<Update> {
        if self.emitted(id) || tools::is_agent(name) && self.subagents {
            return Vec::new();
        }
        let mut call = self.tool_call(id, name, input);
        call["sessionUpdate"] = json!("tool_call");
        call["status"] = json!("pending");
        self.tools.insert(
            id.to_owned(),
            ToolUse { name: name.to_owned(), input: input.clone(), session: session.to_owned(), emitted: true },
        );
        vec![Update { session: session.to_owned(), update: call }]
    }

    pub fn on_message(&mut self, msg: &Value) -> Vec<Update> {
        match msg.get("type").and_then(Value::as_str) {
            Some("stream_event") => self.on_stream(msg),
            Some("assistant") => self.on_assistant(msg),
            Some("user") => self.on_user(msg, false),
            Some("system") => self.on_system(msg),
            _ => Vec::new(),
        }
    }

    /// A user message of replayed history: the prompts too.
    pub fn on_history_user(&mut self, msg: &Value) -> Vec<Update> {
        self.on_user(msg, true)
    }

    fn on_stream(&mut self, msg: &Value) -> Vec<Update> {
        let parent = msg.get("parent_tool_use_id").and_then(Value::as_str);
        let Some(session) = self.owner(parent) else { return Vec::new() };
        let Some(event) = msg.get("event") else { return Vec::new() };
        let mut out = Vec::new();
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(id) = event.pointer("/message/id").and_then(Value::as_str) {
                    self.streaming.insert(session.clone(), id.to_owned());
                }
                if parent.is_none() {
                    self.note_usage(event.pointer("/message/usage"), event.pointer("/message/model"));
                }
            }
            Some("message_delta") if parent.is_none() => {
                self.note_usage(event.get("usage"), None);
                out.extend(self.usage_update());
            }
            Some("content_block_start") => {
                let block = event.get("content_block").cloned().unwrap_or_default();
                match block.get("type").and_then(Value::as_str) {
                    Some(kind @ ("text" | "thinking")) => {
                        if let Some(id) = self.streaming.get(&session) {
                            self.streamed.entry(id.clone()).or_default().push_back((kind == "thinking", String::new()));
                        }
                    }
                    Some("tool_use") => {
                        // The input streams after this: shown by name until the message has it.
                        let (id, name) = (str_of(&block, "id"), str_of(&block, "name"));
                        if !id.is_empty() && !tools::is_plan(&name) && !(tools::is_agent(&name) && self.subagents) {
                            out.extend(self.ensure_call(&id, &name, &json!({}), &session));
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_delta") => {
                let delta = event.get("delta").cloned().unwrap_or_default();
                let (thought, piece) = match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => (false, str_of(&delta, "text")),
                    Some("thinking_delta") => (true, str_of(&delta, "thinking")),
                    _ => return out,
                };
                if piece.is_empty() {
                    return out;
                }
                if let Some(id) = self.streaming.get(&session)
                    && let Some(last) = self.streamed.get_mut(id).and_then(|q| q.back_mut())
                    && last.0 == thought
                {
                    last.1.push_str(&piece);
                }
                out.push(chunk(&session, thought, &piece));
            }
            _ => {}
        }
        out
    }

    fn on_assistant(&mut self, msg: &Value) -> Vec<Update> {
        let parent = msg.get("parent_tool_use_id").and_then(Value::as_str);
        let Some(session) = self.owner(parent) else { return Vec::new() };
        let message = msg.get("message").cloned().unwrap_or_default();
        let msg_id = str_of(&message, "id");
        if parent.is_none() && message.get("model").and_then(Value::as_str) != Some("<synthetic>") {
            self.note_usage(message.get("usage"), message.get("model"));
        }
        let mut out = Vec::new();
        for block in message.get("content").and_then(Value::as_array).into_iter().flatten() {
            match block.get("type").and_then(Value::as_str) {
                Some(kind @ ("text" | "thinking")) => {
                    let thought = kind == "thinking";
                    let full = str_of(block, if thought { "thinking" } else { "text" });
                    if !thought && let Some(child) = self.children.get_mut(&session) {
                        child.last_text = full.clone();
                    }
                    // What streamed already is not sent again.
                    let streamed = self.streamed.get_mut(&msg_id).and_then(|q| {
                        let i = q.iter().position(|(t, _)| *t == thought)?;
                        q.remove(i)
                    });
                    let rest = match &streamed {
                        Some((_, s)) => full.strip_prefix(s.as_str()).unwrap_or_default(),
                        None => full.as_str(),
                    };
                    if !rest.is_empty() {
                        out.push(chunk(&session, thought, rest));
                    }
                }
                Some("tool_use" | "server_tool_use" | "mcp_tool_use") => out.extend(self.on_tool_use(block, &session)),
                _ => {}
            }
        }
        if parent.is_none() {
            out.extend(self.usage_update());
        }
        out
    }

    fn on_tool_use(&mut self, block: &Value, session: &str) -> Vec<Update> {
        let (id, name) = (str_of(block, "id"), str_of(block, "name"));
        let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
        if name == "TodoWrite" {
            self.tools.insert(id, ToolUse { name, input: input.clone(), session: session.to_owned(), emitted: false });
            return tools::todo_entries(&input)
                .map(|entries| vec![Update { session: session.to_owned(), update: plan(entries) }])
                .unwrap_or_default();
        }
        if tools::is_agent(&name) && self.subagents {
            let fresh = !self.children.contains_key(&id);
            self.tools.insert(
                id.clone(),
                ToolUse { name, input: input.clone(), session: session.to_owned(), emitted: false },
            );
            if !fresh {
                return Vec::new();
            }
            self.children.insert(
                id.clone(),
                Child { parent: session.to_owned(), last_text: String::new(), background: None, done: false },
            );
            let s = |k: &str| input.get(k).and_then(Value::as_str);
            let mut announce = json!({
                "sessionUpdate": "subagent_update", "sessionId": id,
                "title": s("subagent_type").unwrap_or("Agent"),
                "capabilities": { "cancel": {} }, "state": { "state": "running" },
            });
            if let Some(d) = s("description") {
                announce["description"] = json!(d);
            }
            let mut out = vec![Update { session: session.to_owned(), update: announce }];
            if let Some(prompt) = s("prompt") {
                let message = json!({
                    "sessionUpdate": "session_message", "messageId": id,
                    "senderSessionId": session, "recipientSessionId": id,
                    "content": [{ "type": "text", "text": prompt }],
                });
                out.push(Update { session: session.to_owned(), update: message.clone() });
                out.push(Update { session: id, update: message });
            }
            return out;
        }
        if tools::is_plan(&name) {
            self.tools.insert(id, ToolUse { name, input, session: session.to_owned(), emitted: false });
            return Vec::new();
        }
        let was_emitted = self.emitted(&id);
        let mut fields = self.tool_call(&id, &name, &input);
        self.tools.insert(id, ToolUse { name, input, session: session.to_owned(), emitted: true });
        fields["sessionUpdate"] = json!(if was_emitted { "tool_call_update" } else { "tool_call" });
        if !was_emitted {
            fields["status"] = json!("pending");
        }
        vec![Update { session: session.to_owned(), update: fields }]
    }

    fn on_user(&mut self, msg: &Value, history: bool) -> Vec<Update> {
        let parent = msg.get("parent_tool_use_id").and_then(Value::as_str);
        let Some(session) = self.owner(parent) else { return Vec::new() };
        let structured = msg.get("tool_use_result").or_else(|| msg.get("toolUseResult"));
        let content = msg.pointer("/message/content");
        let mut out = Vec::new();
        if let Some(text) = content.and_then(Value::as_str) {
            if history && parent.is_none() {
                out.push(Update {
                    session,
                    update: json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": text } }),
                });
            }
            return out;
        }
        let blocks = content.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let results = blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")).count();
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("tool_result") => {
                    // `tool_use_result` describes the message's only result.
                    let structured = structured.filter(|_| results == 1);
                    out.extend(self.on_tool_result(block, structured));
                }
                Some("text") if history && parent.is_none() => out.push(Update {
                    session: session.clone(),
                    update: json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": str_of(block, "text") } }),
                }),
                Some("image") if history && parent.is_none() => {
                    let source = block.get("source").cloned().unwrap_or_default();
                    out.push(Update {
                        session: session.clone(),
                        update: json!({ "sessionUpdate": "user_message_chunk", "content": {
                            "type": "image", "data": str_of(&source, "data"), "mimeType": str_of(&source, "media_type") } }),
                    });
                }
                _ => {}
            }
        }
        out
    }

    fn on_tool_result(&mut self, block: &Value, structured: Option<&Value>) -> Vec<Update> {
        let id = str_of(block, "tool_use_id");
        let Some(tool) = self.tools.get(&id) else { return Vec::new() };
        let (name, input, session, emitted) =
            (tool.name.clone(), tool.input.clone(), tool.session.clone(), tool.emitted);
        let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
        if tools::is_agent(&name) && self.children.contains_key(&id) {
            // A background launch reports its result later, in a task notification.
            let launched = structured.and_then(|s| s.get("status")).and_then(Value::as_str) == Some("async_launched")
                || structured.and_then(|s| s.get("isAsync")).and_then(Value::as_bool) == Some(true);
            if launched && !failed {
                return Vec::new();
            }
            // Its report, without what the harness adds for the model.
            let report = structured
                .filter(|s| s.get("status").and_then(Value::as_str) == Some("completed"))
                .and_then(|s| s.get("content")?.as_array().cloned())
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .filter(|t| !t.trim_start().starts_with("<tools-used"))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_else(|| tools::result_text(block));
            let state = if failed { "error" } else { "end_turn" };
            return self.finish_child(&id, state, Some(report));
        }
        if tools::is_plan(&name) {
            if !failed && let Some(entries) = self.task_plan(&name, &input, block, structured) {
                return vec![Update { session, update: plan(entries) }];
            }
            return Vec::new();
        }
        if !emitted {
            return Vec::new();
        }
        let mut update = tools::result_fields(&name, &input, block, structured);
        update["sessionUpdate"] = json!("tool_call_update");
        update["toolCallId"] = json!(id);
        vec![Update { session, update }]
    }

    /// Ends subagent `id` (`stop` an ACP stop reason, or `error`) with its answer.
    fn finish_child(&mut self, id: &str, stop: &str, reply: Option<String>) -> Vec<Update> {
        let Some(child) = self.children.get_mut(id) else { return Vec::new() };
        if child.done {
            return Vec::new();
        }
        child.done = true;
        let parent = child.parent.clone();
        let reply = reply.filter(|r| !r.trim().is_empty()).unwrap_or_else(|| child.last_text.clone());
        let mut state = json!({ "state": "idle", "stopReason": stop });
        if stop == "error" {
            state["error"] = json!({ "code": -32603, "message": if reply.is_empty() { "The subagent failed." } else { reply.as_str() } });
        }
        let mut out = vec![Update {
            session: parent.clone(),
            update: json!({ "sessionUpdate": "subagent_update", "sessionId": id, "state": state }),
        }];
        if !reply.is_empty() && stop != "error" {
            out.push(Update {
                session: parent.clone(),
                update: json!({
                    "sessionUpdate": "session_message", "messageId": format!("{id}:reply"),
                    "senderSessionId": id, "recipientSessionId": parent,
                    "content": [{ "type": "text", "text": reply }],
                }),
            });
        }
        out
    }

    fn on_system(&mut self, msg: &Value) -> Vec<Update> {
        let tool_use = str_of(msg, "tool_use_id");
        match msg.get("subtype").and_then(Value::as_str) {
            Some("task_started") => {
                if let Some(task) = msg.get("task_id").and_then(Value::as_str)
                    && let Some(child) = self.children.get_mut(&tool_use)
                {
                    child.background = msg.get("is_backgrounded").and_then(Value::as_bool);
                    self.agent_ids.insert(task.to_owned(), tool_use);
                } else if let Some(t) = self.tools.get(&tool_use).filter(|t| t.emitted) {
                    let update =
                        json!({ "sessionUpdate": "tool_call_update", "toolCallId": tool_use, "status": "in_progress" });
                    return vec![Update { session: t.session.clone(), update }];
                }
                Vec::new()
            }
            // Claude Code retries a failed API request on its own; without this the turn looks stuck.
            Some("api_retry") => {
                let n = |k: &str| msg.get(k).and_then(Value::as_u64);
                let error = msg.get("error").and_then(|e| {
                    e.as_str().map(str::to_owned).or_else(|| e.get("message")?.as_str().map(str::to_owned))
                });
                vec![Update {
                    session: self.root.clone(),
                    update: json!({
                        "sessionUpdate": RETRY_UPDATE,
                        "attempt": n("attempt").unwrap_or(1),
                        "maxRetries": n("max_retries"),
                        "retryDelayMs": n("retry_delay_ms").unwrap_or(0),
                        "error": error,
                    }),
                }]
            }
            Some("task_notification") if self.children.get(&tool_use).is_some_and(|c| c.background != Some(false)) => {
                let stop = match msg.get("status").and_then(Value::as_str) {
                    Some("failed") => "error",
                    Some("killed" | "stopped" | "cancelled") => "cancelled",
                    _ => "end_turn",
                };
                let summary = msg.get("summary").and_then(Value::as_str).map(str::to_owned);
                let last = self.children.get(&tool_use).map(|c| c.last_text.clone()).filter(|t| !t.is_empty());
                self.finish_child(&tool_use, stop, last.or(summary))
            }
            _ => Vec::new(),
        }
    }

    /// Marks subagent `session` waiting for (or no longer waiting for) the user.
    pub fn child_state(&self, session: &str, waiting: bool) -> Option<Update> {
        let child = self.children.get(session).filter(|c| !c.done)?;
        let state = if waiting { "requires_action" } else { "running" };
        Some(Update {
            session: child.parent.clone(),
            update: json!({ "sessionUpdate": "subagent_update", "sessionId": session, "state": { "state": state } }),
        })
    }

    /// Subagents still working when their agent is gone.
    pub fn stop_children(&mut self) -> Vec<Update> {
        let ids: Vec<String> = self.children.iter().filter(|(_, c)| !c.done).map(|(id, _)| id.clone()).collect();
        ids.iter().flat_map(|id| self.finish_child(id, "cancelled", None)).collect()
    }

    fn task_plan(
        &mut self,
        name: &str,
        input: &Value,
        block: &Value,
        structured: Option<&Value>,
    ) -> Option<Vec<Value>> {
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        match name {
            "TaskCreate" => {
                let id =
                    structured.and_then(|r| r.pointer("/task/id")).and_then(Value::as_str).map(str::to_owned).or_else(
                        || {
                            let text = tools::result_text(block);
                            let rest = text.trim().strip_prefix("Task #")?;
                            Some(rest.split_whitespace().next()?.to_owned())
                        },
                    )?;
                self.tasks.push((id, s(input, "subject").unwrap_or_default(), "pending".into()));
            }
            "TaskUpdate" => {
                let id = s(input, "taskId")?;
                if s(input, "status").as_deref() == Some("deleted") {
                    self.tasks.retain(|t| t.0 != id);
                } else {
                    let t = self.tasks.iter_mut().find(|t| t.0 == id)?;
                    if let Some(st) = s(input, "status") {
                        t.2 = st;
                    }
                    if let Some(sub) = s(input, "subject") {
                        t.1 = sub;
                    }
                }
            }
            "TaskList" => {
                let list = structured?.get("tasks")?.as_array()?;
                self.tasks = list
                    .iter()
                    .filter_map(|t| {
                        Some((s(t, "id")?, s(t, "subject")?, s(t, "status").unwrap_or_else(|| "pending".into())))
                    })
                    .collect();
            }
            _ => return None,
        }
        Some(self.tasks.iter().map(|(_, c, st)| json!({ "content": c, "status": st, "priority": "medium" })).collect())
    }

    fn note_usage(&mut self, usage: Option<&Value>, model: Option<&Value>) {
        if let Some(m) = model.and_then(Value::as_str).filter(|m| *m != "<synthetic>") {
            self.model = Some(m.to_owned());
        }
        let Some(u) = usage else { return };
        let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        let total =
            n("input_tokens") + n("output_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        if total > 0 {
            self.used = Some(total);
        }
    }

    /// Learns the context window of the models a `result` reports; returns the usage then.
    pub fn on_result(&mut self, result: &Value) -> Vec<Update> {
        for (model, u) in result.get("modelUsage").and_then(Value::as_object).into_iter().flatten() {
            if let Some(w) = u.get("contextWindow").and_then(Value::as_u64).filter(|w| *w > 0) {
                self.windows.insert(model.clone(), w);
            }
        }
        self.usage_update().into_iter().collect()
    }

    fn usage_update(&self) -> Option<Update> {
        let used = self.used?;
        let size = self
            .model
            .as_ref()
            .and_then(|m| {
                self.windows
                    .get(m)
                    .or_else(|| self.windows.iter().find(|(k, _)| k.starts_with(m.as_str())).map(|(_, v)| v))
            })
            .or_else(|| (self.windows.len() == 1).then(|| self.windows.values().next()).flatten())?;
        Some(Update {
            session: self.root.clone(),
            update: json!({ "sessionUpdate": "usage_update", "used": used, "size": size }),
        })
    }
}

fn chunk(session: &str, thought: bool, text: &str) -> Update {
    let kind = if thought { "agent_thought_chunk" } else { "agent_message_chunk" };
    Update {
        session: session.to_owned(),
        update: json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } }),
    }
}

fn plan(entries: Vec<Value>) -> Value {
    json!({ "sessionUpdate": "plan", "entries": entries })
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}
