//! Pure translations between `codex app-server` (v2) messages and ACP.

use serde_json::{Map, Value, json};

/// Tool output sent per update; longer output keeps its tail (the timeline keeps no more).
pub(super) const MAX_OUTPUT: usize = 64 * 1024;

/// Approval and sandbox presets, offered as the session's mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    ReadOnly,
    Ask,
    Auto,
    FullAccess,
}

impl Mode {
    pub const ALL: [Mode; 4] = [Mode::ReadOnly, Mode::Ask, Mode::Auto, Mode::FullAccess];

    pub fn id(self) -> &'static str {
        match self {
            Mode::ReadOnly => "read-only",
            Mode::Ask => "ask",
            Mode::Auto => "auto",
            Mode::FullAccess => "full-access",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Mode::ReadOnly => "Read Only",
            Mode::Ask => "Ask",
            Mode::Auto => "Auto",
            Mode::FullAccess => "Full Access",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Mode::ReadOnly => "Reads files; asks before editing or running anything that writes",
            Mode::Ask => "Edits in the workspace; asks before running commands it doesn't trust",
            Mode::Auto => "Edits and runs commands in the workspace; asks to go beyond it",
            Mode::FullAccess => "Edits and runs anything, with network access, without asking",
        }
    }

    pub fn parse(id: &str) -> Option<Mode> {
        Mode::ALL.into_iter().find(|m| m.id() == id)
    }

    /// `approvalPolicy` (`AskForApproval`).
    pub fn approval_policy(self) -> &'static str {
        match self {
            Mode::ReadOnly | Mode::Auto => "on-request",
            Mode::Ask => "untrusted",
            Mode::FullAccess => "never",
        }
    }

    /// `sandbox` of `thread/start`, `thread/resume` and `thread/fork` (`SandboxMode`).
    pub fn sandbox_mode(self) -> &'static str {
        match self {
            Mode::ReadOnly => "read-only",
            Mode::Ask | Mode::Auto => "workspace-write",
            Mode::FullAccess => "danger-full-access",
        }
    }

    /// `sandboxPolicy` of `turn/start` (`SandboxPolicy`).
    pub fn sandbox_policy(self) -> Value {
        match self {
            Mode::ReadOnly => json!({ "type": "readOnly" }),
            Mode::Ask | Mode::Auto => json!({ "type": "workspaceWrite" }),
            Mode::FullAccess => json!({ "type": "dangerFullAccess" }),
        }
    }

    /// The preset closest to what a thread runs with (`approvalPolicy`, `sandbox` policy).
    pub fn of(approval: &Value, sandbox: &Value) -> Mode {
        match sandbox.get("type").and_then(Value::as_str) {
            Some("readOnly") => Mode::ReadOnly,
            Some("dangerFullAccess" | "externalSandbox") => Mode::FullAccess,
            _ if approval.as_str() == Some("untrusted") => Mode::Ask,
            _ => Mode::Auto,
        }
    }
}

/// A model `model/list` offers.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct ModelInfo {
    pub id: String,
    /// The slug sent as `model`.
    pub model: String,
    pub name: String,
    pub description: Option<String>,
    /// `(effort, description)`.
    pub efforts: Vec<(String, String)>,
    pub default_effort: Option<String>,
    pub is_default: bool,
    pub hidden: bool,
}

pub(super) fn models_of(list: &Value) -> Vec<ModelInfo> {
    let data = list.get("data").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    data.iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_owned();
            Some(ModelInfo {
                model: str_of(m, "model").unwrap_or_else(|| id.clone()),
                name: str_of(m, "displayName").filter(|n| !n.is_empty()).unwrap_or_else(|| id.clone()),
                description: str_of(m, "description").filter(|d| !d.is_empty()),
                efforts: m
                    .get("supportedReasoningEfforts")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|e| {
                        Some((
                            e.get("reasoningEffort")?.as_str()?.to_owned(),
                            str_of(e, "description").unwrap_or_default(),
                        ))
                    })
                    .collect(),
                default_effort: str_of(m, "defaultReasoningEffort"),
                is_default: m.get("isDefault").and_then(Value::as_bool) == Some(true),
                hidden: m.get("hidden").and_then(Value::as_bool) == Some(true),
                id,
            })
        })
        .collect()
}

/// What a session runs with; sent with every turn.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Settings {
    /// A model id from `model/list`, or the one the thread reported.
    pub model: String,
    pub effort: Option<String>,
    pub mode: Mode,
}

impl Settings {
    /// From a `thread/start`, `thread/resume` or `thread/fork` result.
    pub fn of(result: &Value, models: &[ModelInfo]) -> Settings {
        let reported = str_of(result, "model").unwrap_or_default();
        let model = models
            .iter()
            .find(|m| m.model == reported || m.id == reported)
            .or_else(|| reported.is_empty().then(|| models.iter().find(|m| m.is_default)).flatten())
            .map_or(reported, |m| m.id.clone());
        let mut s = Settings {
            model,
            effort: str_of(result, "reasoningEffort"),
            mode: Mode::of(
                result.get("approvalPolicy").unwrap_or(&Value::Null),
                result.get("sandbox").unwrap_or(&Value::Null),
            ),
        };
        s.fit_effort(models);
        s
    }

    /// The effort, made one the model supports (its default when it isn't).
    pub fn fit_effort(&mut self, models: &[ModelInfo]) {
        let Some(m) = models.iter().find(|m| m.id == self.model) else { return };
        if m.efforts.is_empty() {
            self.effort = None;
        } else if !self.effort.as_ref().is_some_and(|e| m.efforts.iter().any(|(x, _)| x == e)) {
            self.effort = m.default_effort.clone().or_else(|| m.efforts.first().map(|(e, _)| e.clone()));
        }
    }

    /// The slug to send as `model`.
    pub fn model_slug(&self, models: &[ModelInfo]) -> String {
        models.iter().find(|m| m.id == self.model).map_or_else(|| self.model.clone(), |m| m.model.clone())
    }

    /// Applies `session/set_config_option`; `Err` names what is wrong.
    pub fn set(&mut self, models: &[ModelInfo], option: &str, value: &str) -> Result<(), String> {
        match option {
            MODEL => {
                if !models.iter().any(|m| m.id == value) && value != self.model {
                    return Err(format!("unknown model {value}"));
                }
                self.model = value.to_owned();
                self.fit_effort(models);
            }
            EFFORT => {
                let m = models.iter().find(|m| m.id == self.model);
                if !m.is_some_and(|m| m.efforts.iter().any(|(e, _)| e == value)) {
                    return Err(format!("{} has no reasoning effort {value}", self.model));
                }
                self.effort = Some(value.to_owned());
            }
            MODE => self.mode = Mode::parse(value).ok_or_else(|| format!("unknown mode {value}"))?,
            _ => return Err(format!("unknown setting {option}")),
        }
        Ok(())
    }
}

pub(super) const MODEL: &str = "model";
pub(super) const EFFORT: &str = "reasoning_effort";
pub(super) const MODE: &str = "mode";

/// ACP `configOptions`: model, reasoning effort (for models that have it) and mode.
pub(super) fn config_options(models: &[ModelInfo], s: &Settings) -> Value {
    let mut model_values: Vec<Value> = models
        .iter()
        .filter(|m| !m.hidden || m.id == s.model)
        .map(|m| select_value(&m.id, &m.name, m.description.as_deref()))
        .collect();
    if !s.model.is_empty() && !models.iter().any(|m| m.id == s.model) {
        model_values.push(select_value(&s.model, &s.model, None));
    }
    let mut out = vec![json!({
        "id": MODEL, "name": "Model", "category": "model", "type": "select",
        "currentValue": s.model, "options": model_values,
    })];
    if let (Some(m), Some(effort)) = (models.iter().find(|m| m.id == s.model), &s.effort)
        && !m.efforts.is_empty()
    {
        let values: Vec<Value> = m
            .efforts
            .iter()
            .map(|(e, d)| select_value(e, &effort_name(e), Some(d).filter(|d| !d.is_empty()).map(String::as_str)))
            .collect();
        out.push(json!({
            "id": EFFORT, "name": "Reasoning", "category": "thought_level", "type": "select",
            "currentValue": effort, "options": values,
        }));
    }
    out.push(json!({
        "id": MODE, "name": "Mode", "category": "mode", "type": "select", "currentValue": s.mode.id(),
        "options": Mode::ALL.iter().map(|m| select_value(m.id(), m.name(), Some(m.description()))).collect::<Vec<_>>(),
    }));
    Value::Array(out)
}

fn select_value(value: &str, name: &str, description: Option<&str>) -> Value {
    let mut v = json!({ "value": value, "name": name });
    if let Some(d) = description {
        v["description"] = json!(d);
    }
    v
}

fn effort_name(effort: &str) -> String {
    match effort {
        "xhigh" => "Extra high".into(),
        e => {
            let mut c = e.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
        }
    }
}

/// ACP prompt content blocks as codex `UserInput`s. Embedded files become text.
pub(super) fn user_input(prompt: &Value) -> Vec<Value> {
    let blocks = prompt.as_array().map(Vec::as_slice).unwrap_or_default();
    blocks
        .iter()
        .filter_map(|b| match b.get("type").and_then(Value::as_str)? {
            "text" => Some(json!({ "type": "text", "text": b.get("text")?.as_str()? })),
            "image" => {
                let url = match (b.get("data").and_then(Value::as_str), b.get("uri").and_then(Value::as_str)) {
                    (Some(data), _) => {
                        format!(
                            "data:{};base64,{data}",
                            b.get("mimeType").and_then(Value::as_str).unwrap_or("image/png")
                        )
                    }
                    (None, Some(uri)) => uri.to_owned(),
                    _ => return None,
                };
                Some(json!({ "type": "image", "url": url }))
            }
            "resource" => {
                let r = b.get("resource")?;
                let path = uri_path(r.get("uri").and_then(Value::as_str).unwrap_or_default());
                let text = r.get("text").and_then(Value::as_str)?;
                Some(json!({ "type": "text", "text": format!("<file path=\"{path}\">\n{text}\n</file>") }))
            }
            "resource_link" => Some(json!({ "type": "text", "text": uri_path(b.get("uri")?.as_str()?) })),
            _ => None,
        })
        .collect()
}

/// The path of a `file://` URI (percent-decoded); other URIs as they are.
fn uri_path(uri: &str) -> String {
    let Some(rest) = uri.strip_prefix("file://") else { return uri.to_owned() };
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(b) = rest.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A `session/update` notification's `update` for content.
pub(super) fn chunk(kind: &str, text: &str) -> Value {
    json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } })
}

/// ACP tool status of a codex item `status`; items without one are running until they complete.
fn tool_status(item: &Value, done: bool) -> &'static str {
    match item.get("status").and_then(Value::as_str) {
        Some("completed") => "completed",
        Some("failed" | "declined") => "failed",
        Some(_) => "in_progress",
        None if done => "completed",
        None => "in_progress",
    }
}

/// The `tool_call` (or with `done`, the `tool_call_update`) for a tool-like item; `None`
/// for messages, reasoning and subagent bookkeeping. `output` is the command output
/// streamed so far, used when the item carries none.
pub(super) fn tool_call(item: &Value, done: bool, cwd: Option<&str>, output: Option<&str>) -> Option<Value> {
    let id = item.get("id")?.as_str()?;
    let ty = item.get("type")?.as_str()?;
    let mut call = Map::new();
    let (title, kind) = match ty {
        "commandExecution" => {
            let (title, kind, locations) = command_title(item, cwd);
            call.insert("rawInput".into(), json!({ "command": item.get("command"), "cwd": item.get("cwd") }));
            if !locations.is_empty() {
                call.insert("locations".into(), Value::Array(locations));
            }
            let text = item.get("aggregatedOutput").and_then(Value::as_str).or(output);
            if let Some(text) = text.filter(|t| !t.is_empty()) {
                call.insert("content".into(), json!([text_content(&tail(text))]));
            }
            if done && let Some(code) = item.get("exitCode").filter(|c| !c.is_null()) {
                call.insert("rawOutput".into(), json!({ "exitCode": code }));
            }
            (title, kind)
        }
        "fileChange" => {
            let changes = item.get("changes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            let diffs: Vec<Value> = changes.iter().filter_map(file_diff).collect();
            let locations: Vec<Value> =
                diffs.iter().filter_map(|d| d.get("path")).map(|p| json!({ "path": p })).collect();
            call.insert("locations".into(), Value::Array(locations));
            if !diffs.is_empty() {
                call.insert("content".into(), Value::Array(diffs));
            }
            file_change_title(changes, cwd)
        }
        "mcpToolCall" => {
            call.insert("rawInput".into(), item.get("arguments").cloned().unwrap_or(Value::Null));
            let mut content: Vec<Value> = item
                .pointer("/result/content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|c| c.get("type").is_some())
                .map(|c| json!({ "type": "content", "content": c }))
                .collect();
            if let Some(message) = item.pointer("/error/message").and_then(Value::as_str) {
                content.push(text_content(message));
            }
            if !content.is_empty() {
                call.insert("content".into(), Value::Array(content));
            }
            let server = item.get("server").and_then(Value::as_str).unwrap_or_default();
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or_default();
            (format!("{server}: {tool}"), "other")
        }
        "dynamicToolCall" => {
            call.insert("rawInput".into(), item.get("arguments").cloned().unwrap_or(Value::Null));
            let content: Vec<Value> = item
                .get("contentItems")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|c| c.get("text").and_then(Value::as_str))
                .map(text_content)
                .collect();
            if !content.is_empty() {
                call.insert("content".into(), Value::Array(content));
            }
            (str_of(item, "tool").unwrap_or_default(), "other")
        }
        "webSearch" => (web_search_title(item), "fetch"),
        "imageView" => {
            let path = item.get("path").and_then(Value::as_str).unwrap_or_default();
            call.insert("locations".into(), json!([{ "path": path }]));
            (format!("View {}", display_path(path, cwd)), "read")
        }
        "collabAgentToolCall" => {
            let title = match item.get("tool").and_then(Value::as_str) {
                Some("spawnAgent") => return None,
                Some("sendInput") => "Message an agent",
                Some("resumeAgent") => "Resume an agent",
                Some("wait") => "Wait for agents",
                Some("closeAgent") => "Close an agent",
                _ => "Coordinate agents",
            };
            (title.to_owned(), "other")
        }
        "contextCompaction" => ("Compact the conversation".to_owned(), "other"),
        "sleep" => ("Wait".to_owned(), "other"),
        "imageGeneration" => ("Generate an image".to_owned(), "other"),
        _ => return None,
    };
    call.insert("sessionUpdate".into(), json!(if done { "tool_call_update" } else { "tool_call" }));
    call.insert("toolCallId".into(), json!(id));
    call.insert("title".into(), json!(title));
    call.insert("kind".into(), json!(kind));
    call.insert("status".into(), json!(tool_status(item, done)));
    Some(Value::Object(call))
}

/// The output of a running command, as a `tool_call_update`.
pub(super) fn command_output(id: &str, output: &str) -> Value {
    json!({ "sessionUpdate": "tool_call_update", "toolCallId": id, "content": [text_content(&tail(output))] })
}

fn text_content(text: &str) -> Value {
    json!({ "type": "content", "content": { "type": "text", "text": text } })
}

/// Title, ACP kind and locations of a command: what it does when codex recognised it
/// (reading, listing, searching), else the command itself.
fn command_title(item: &Value, cwd: Option<&str>) -> (String, &'static str, Vec<Value>) {
    let actions = item.get("commandActions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let ty = |a: &Value| a.get("type").and_then(Value::as_str).unwrap_or("unknown").to_owned();
    let all = |t: &str| !actions.is_empty() && actions.iter().all(|a| ty(a) == t);
    if all("read") {
        let names: Vec<String> = actions.iter().filter_map(|a| str_of(a, "name")).collect();
        let locations = actions.iter().filter_map(|a| a.get("path")).map(|p| json!({ "path": p })).collect();
        return (format!("Read {}", names.join(", ")), "read", locations);
    }
    if all("listFiles") {
        let path =
            actions[0].get("path").and_then(Value::as_str).map_or_else(|| ".".to_owned(), |p| display_path(p, cwd));
        return (format!("List {path}"), "search", Vec::new());
    }
    if all("search") && actions.len() == 1 {
        let a = &actions[0];
        let query = a.get("query").and_then(Value::as_str);
        let path = a.get("path").and_then(Value::as_str).map(|p| display_path(p, cwd));
        let title = match (query, path) {
            (Some(q), Some(p)) => format!("Search {q} in {p}"),
            (Some(q), None) => format!("Search {q}"),
            (None, Some(p)) => format!("Search in {p}"),
            (None, None) => "Search".to_owned(),
        };
        return (title, "search", Vec::new());
    }
    // The command as the model wrote it, without the shell wrapper codex adds.
    let command = match actions {
        [one] => one.get("command").and_then(Value::as_str),
        _ => None,
    };
    let command = command.or_else(|| item.get("command").and_then(Value::as_str)).unwrap_or_default();
    (command.to_owned(), "execute", Vec::new())
}

fn file_change_title(changes: &[Value], cwd: Option<&str>) -> (String, &'static str) {
    let kind_of = |c: &Value| c.pointer("/kind/type").and_then(Value::as_str).unwrap_or("update").to_owned();
    let moved = |c: &Value| c.pointer("/kind/move_path").and_then(Value::as_str).map(str::to_owned);
    match changes {
        [one] => {
            let path = display_path(one.get("path").and_then(Value::as_str).unwrap_or_default(), cwd);
            match (kind_of(one).as_str(), moved(one)) {
                ("add", _) => (format!("Create {path}"), "edit"),
                ("delete", _) => (format!("Delete {path}"), "delete"),
                (_, Some(to)) => (format!("Move {path} to {}", display_path(&to, cwd)), "move"),
                _ => (format!("Edit {path}"), "edit"),
            }
        }
        _ if !changes.is_empty() && changes.iter().all(|c| kind_of(c) == "delete") => {
            (format!("Delete {} files", changes.len()), "delete")
        }
        _ => (format!("Edit {} files", changes.len()), "edit"),
    }
}

/// An ACP `diff` content item for a `FileUpdateChange`: a new file's `diff` is its
/// content, a deleted one's its old content, an update's a unified diff.
fn file_diff(change: &Value) -> Option<Value> {
    let path = change.get("path")?.as_str()?;
    let diff = change.get("diff").and_then(Value::as_str).unwrap_or_default();
    let (path, old, new) = match change.pointer("/kind/type").and_then(Value::as_str) {
        Some("add") => (path, String::new(), diff.to_owned()),
        Some("delete") => (path, diff.to_owned(), String::new()),
        _ => {
            let (old, new) = diff_sides(diff);
            (change.pointer("/kind/move_path").and_then(Value::as_str).unwrap_or(path), old, new)
        }
    };
    Some(json!({ "type": "diff", "path": path, "oldText": old, "newText": new }))
}

/// The old and new text a unified diff's hunks cover (context included).
pub(super) fn diff_sides(diff: &str) -> (String, String) {
    let (mut old, mut new) = (String::new(), String::new());
    let mut in_hunk = false;
    for line in diff.split_inclusive('\n') {
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        match line.as_bytes().first() {
            Some(b' ') => {
                old.push_str(&line[1..]);
                new.push_str(&line[1..]);
            }
            Some(b'-') => old.push_str(&line[1..]),
            Some(b'+') => new.push_str(&line[1..]),
            // `\ No newline at end of file`, or the next file's header.
            Some(b'\\') => {}
            Some(b'\n') => {
                old.push('\n');
                new.push('\n');
            }
            _ => in_hunk = false,
        }
    }
    (old, new)
}

fn web_search_title(item: &Value) -> String {
    let action = item.get("action");
    let field = |k: &str| action.and_then(|a| a.get(k)).and_then(Value::as_str).filter(|s| !s.is_empty());
    let query = item.get("query").and_then(Value::as_str).filter(|q| !q.is_empty());
    match action.and_then(|a| a.get("type")).and_then(Value::as_str) {
        Some("openPage") => field("url").map_or_else(|| "Open a page".to_owned(), |u| format!("Open {u}")),
        Some("findInPage") => match field("pattern") {
            Some(p) => format!("Find {p}"),
            None => "Find in page".to_owned(),
        },
        _ => field("query").or(query).map_or_else(|| "Search the web".to_owned(), |q| format!("Search the web: {q}")),
    }
}

/// `path` relative to `cwd` when it is inside it.
fn display_path(path: &str, cwd: Option<&str>) -> String {
    cwd.and_then(|c| path.strip_prefix(c.trim_end_matches('/')))
        .and_then(|rest| rest.strip_prefix('/'))
        .filter(|r| !r.is_empty())
        .unwrap_or(path)
        .to_owned()
}

/// `turn/plan/updated` as an ACP `plan`.
pub(super) fn plan(params: &Value) -> Value {
    let entries: Vec<Value> = params
        .get("plan")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|s| {
            let status = match s.get("status").and_then(Value::as_str) {
                Some("completed") => "completed",
                Some("inProgress") => "in_progress",
                _ => "pending",
            };
            json!({ "content": s.get("step").and_then(Value::as_str).unwrap_or_default(), "priority": "medium", "status": status })
        })
        .collect();
    json!({ "sessionUpdate": "plan", "entries": entries })
}

/// `thread/tokenUsage/updated` as an ACP `usage_update`: what the last request put in
/// the context window, out of its size.
pub(super) fn usage(params: &Value) -> Option<Value> {
    let usage = params.get("tokenUsage")?;
    let used = usage.pointer("/last/totalTokens")?.as_u64()?;
    let size = usage.get("modelContextWindow")?.as_u64().filter(|s| *s > 0)?;
    Some(json!({ "sessionUpdate": "usage_update", "used": used, "size": size }))
}

/// How a failed turn is reported.
#[derive(Debug, PartialEq)]
pub(super) enum Failure {
    /// The account's usage limit; when it resets (ms since the epoch), when known.
    UsageLimit(Option<f64>),
    /// Signed out or refused.
    Auth,
    /// The model declined.
    Refusal,
    Other,
}

/// What kind of failure a `TurnError` is; `rate_limits` is the last
/// `account/rateLimits/updated` snapshot.
pub(super) fn classify(error: &Value, rate_limits: Option<&Value>) -> Failure {
    let info = error.get("codexErrorInfo").unwrap_or(&Value::Null);
    let http_status =
        info.as_object().and_then(|o| o.values().next()).and_then(|v| v.get("httpStatusCode")).and_then(Value::as_u64);
    let message = error.get("message").and_then(Value::as_str).unwrap_or_default().to_lowercase();
    match info.as_str() {
        Some("usageLimitExceeded") => return Failure::UsageLimit(resets_at(rate_limits)),
        Some("unauthorized") => return Failure::Auth,
        Some("cyberPolicy") => return Failure::Refusal,
        _ => {}
    }
    if http_status == Some(429) && info.get("responseTooManyFailedAttempts").is_some() {
        return Failure::UsageLimit(resets_at(rate_limits));
    }
    if http_status == Some(401) || message.contains("401 unauthorized") {
        return Failure::Auth;
    }
    Failure::Other
}

/// When the exhausted rate-limit window resets, in ms.
fn resets_at(rate_limits: Option<&Value>) -> Option<f64> {
    let limits = rate_limits?;
    let windows = ["primary", "secondary"].map(|w| limits.get(w).filter(|w| !w.is_null()));
    let exhausted = windows
        .iter()
        .flatten()
        .filter(|w| w.get("usedPercent").and_then(Value::as_f64).is_some_and(|p| p >= 100.0))
        .filter_map(|w| w.get("resetsAt").and_then(Value::as_f64))
        .fold(None, |acc: Option<f64>, t| Some(acc.map_or(t, |a| a.max(t))));
    exhausted.map(|s| s * 1000.0)
}

/// The text a failed turn reports: codex's message, with its details.
pub(super) fn error_message(error: &Value) -> String {
    let message = error.get("message").and_then(Value::as_str).unwrap_or("Codex failed").trim();
    match error.get("additionalDetails").and_then(Value::as_str).map(str::trim).filter(|d| !d.is_empty()) {
        Some(details) if !message.contains(details) => format!("{message}\n{details}"),
        _ => message.to_owned(),
    }
}

/// One choice of an approval: what ACP shows and what codex gets back.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Choice {
    pub option: Value,
    pub answer: Value,
}

/// The choices of a command or file-change approval: what codex offers
/// (`availableDecisions`), else the usual four; a way to decline is always there.
pub(super) fn decisions(params: &Value, command: bool) -> Vec<Choice> {
    let offered: Vec<Value> = match params.get("availableDecisions").and_then(Value::as_array) {
        Some(list) if !list.is_empty() => list.clone(),
        _ => ["accept", "acceptForSession", "decline", "cancel"].map(|d| json!(d)).to_vec(),
    };
    let mut list = offered;
    if !list.iter().any(|d| d == "decline") {
        let at = list.iter().position(|d| d == "cancel").unwrap_or(list.len());
        list.insert(at, json!("decline"));
    }
    let mut out: Vec<Choice> = Vec::new();
    for decision in list {
        let (id, name, kind) = match &decision {
            Value::String(s) => match s.as_str() {
                "accept" => {
                    ("accept".to_owned(), if command { "Allow once" } else { "Allow" }.to_owned(), "allow_once")
                }
                "acceptForSession" => {
                    ("acceptForSession".to_owned(), "Allow for this session".to_owned(), "allow_always")
                }
                "decline" => ("decline".to_owned(), "Decline".to_owned(), "reject_once"),
                "cancel" => ("cancel".to_owned(), "Decline and stop".to_owned(), "reject_once"),
                other => (other.to_owned(), other.to_owned(), "allow_once"),
            },
            Value::Object(o) => {
                let Some((key, v)) = o.iter().next() else { continue };
                match key.as_str() {
                    "acceptWithExecpolicyAmendment" => {
                        let prefix: Vec<&str> = v
                            .get("execpolicy_amendment")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .collect();
                        let shown = shell_unwrapped(&prefix);
                        (key.clone(), format!("Always allow `{shown}`"), "allow_always")
                    }
                    "applyNetworkPolicyAmendment" => {
                        let a = v.get("network_policy_amendment").unwrap_or(&Value::Null);
                        let host = a.get("host").and_then(Value::as_str).unwrap_or("this host");
                        match a.get("action").and_then(Value::as_str) {
                            Some("deny") => {
                                (format!("{key}:deny:{host}"), format!("Always block {host}"), "reject_always")
                            }
                            _ => (format!("{key}:allow:{host}"), format!("Always allow {host}"), "allow_always"),
                        }
                    }
                    other => (other.to_owned(), other.to_owned(), "allow_once"),
                }
            }
            _ => continue,
        };
        if out.iter().any(|c| c.option["optionId"] == json!(id)) {
            continue;
        }
        out.push(Choice {
            option: json!({ "optionId": id, "name": name, "kind": kind }),
            answer: json!({ "decision": decision }),
        });
    }
    out
}

/// A command prefix as typed: the script of a `<shell> -lc <script>` wrapper, else the words.
fn shell_unwrapped(argv: &[&str]) -> String {
    match argv {
        [_, flag, script] if flag.starts_with('-') && flag.ends_with('c') => (*script).to_owned(),
        _ => argv.join(" "),
    }
}

/// The codex answer for an ACP `session/request_permission` result; a cancelled or
/// unknown outcome declines.
/// The `content` of an accepted elicitation for `schema` (its `requestedSchema`): every
/// property's default, else the allowing option of a choice (`allow`, `accept`, ...; else
/// the first option), else `true` for a boolean. An empty form would read as no decision,
/// so the approval would count as declined (OpenIDEA's own server asks for `decision: allow`).
pub(super) fn accept_content(schema: Option<&Value>) -> Value {
    const ALLOWING: [&str; 6] = ["allow", "accept", "approve", "yes", "ok", "true"];
    let mut content = serde_json::Map::new();
    let properties = schema.and_then(|s| s.get("properties")).and_then(Value::as_object);
    for (name, property) in properties.into_iter().flatten() {
        if let Some(default) = property.get("default") {
            content.insert(name.clone(), default.clone());
            continue;
        }
        let options: Vec<&Value> = match (property.get("enum"), property.get("oneOf").or_else(|| property.get("anyOf")))
        {
            (Some(Value::Array(values)), _) => values.iter().collect(),
            (_, Some(Value::Array(variants))) => variants.iter().filter_map(|v| v.get("const")).collect(),
            _ => Vec::new(),
        };
        let allowing = |v: &&&Value| v.as_str().is_some_and(|s| ALLOWING.contains(&s.to_ascii_lowercase().as_str()));
        if let Some(choice) = options.iter().find(allowing).or(options.first()) {
            content.insert(name.clone(), (*choice).clone());
        } else if property.get("type").and_then(Value::as_str) == Some("boolean") {
            content.insert(name.clone(), Value::Bool(true));
        }
    }
    Value::Object(content)
}

pub(super) fn answer_of(choices: &[Choice], outcome: &Value, decline: Value) -> Value {
    let chosen = outcome.pointer("/outcome/optionId").and_then(Value::as_str);
    let selected = outcome.pointer("/outcome/outcome").and_then(Value::as_str) == Some("selected");
    choices.iter().find(|c| selected && c.option["optionId"].as_str() == chosen).map_or(decline, |c| c.answer.clone())
}

/// The ACP title of a command approval.
pub(super) fn command_approval_title(params: &Value, item: Option<&Value>, cwd: Option<&str>) -> String {
    if let Some(host) = params.pointer("/networkApprovalContext/host").and_then(Value::as_str) {
        return format!("Allow network access to {host}");
    }
    let from_item = item.and_then(|i| tool_call(i, false, cwd, None)).and_then(|c| str_of(&c, "title"));
    let title = from_item.or_else(|| {
        let synthetic = json!({ "id": "", "type": "commandExecution", "command": params.get("command"),
            "commandActions": params.get("commandActions").cloned().unwrap_or(json!([])) });
        tool_call(&synthetic, false, cwd, None).and_then(|c| str_of(&c, "title"))
    });
    match title.filter(|t| !t.is_empty()) {
        Some(t) => format!("Run {t}"),
        None => "Run a command".to_owned(),
    }
}

/// The ACP title of a file-change approval, from the item it is about.
pub(super) fn file_approval_title(item: Option<&Value>, cwd: Option<&str>) -> String {
    let changes = item.and_then(|i| i.get("changes")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    if changes.is_empty() {
        return "Edit files".to_owned();
    }
    file_change_title(changes, cwd).0
}

/// A thread's history (`Thread.turns`) as the `session/update`s an ACP agent replays on `session/load`.
pub(super) fn history(thread: &Value, cwd: Option<&str>) -> Vec<Value> {
    let mut out = Vec::new();
    for turn in thread.get("turns").and_then(Value::as_array).into_iter().flatten() {
        for item in turn.get("items").and_then(Value::as_array).into_iter().flatten() {
            match item.get("type").and_then(Value::as_str) {
                Some("userMessage") => {
                    for c in item.get("content").and_then(Value::as_array).into_iter().flatten() {
                        match c.get("type").and_then(Value::as_str) {
                            Some("text") => out.push(chunk(
                                "user_message_chunk",
                                c.get("text").and_then(Value::as_str).unwrap_or_default(),
                            )),
                            Some("image") => out.push(json!({ "sessionUpdate": "user_message_chunk",
                                "content": { "type": "resource_link", "uri": c.get("url"), "name": "image" } })),
                            Some("localImage" | "mention" | "skill") => {
                                let path = c.get("path").and_then(Value::as_str).unwrap_or_default();
                                out.push(chunk("user_message_chunk", path));
                            }
                            _ => {}
                        }
                    }
                }
                Some("agentMessage" | "plan") => {
                    let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                    if !text.is_empty() {
                        out.push(chunk("agent_message_chunk", text));
                    }
                }
                Some("reasoning") => {
                    let text = reasoning_text(item);
                    if !text.is_empty() {
                        out.push(chunk("agent_thought_chunk", &text));
                    }
                }
                _ => {
                    if let Some(call) = tool_call(item, false, cwd, None) {
                        out.push(call);
                        out.extend(tool_call(item, true, cwd, None));
                    }
                }
            }
        }
    }
    out
}

/// A reasoning item's summary (or, without one, its raw text).
pub(super) fn reasoning_text(item: &Value) -> String {
    let parts = |k: &str| -> Vec<String> {
        item.get(k)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    let summary = parts("summary");
    if summary.is_empty() { parts("content").join("\n\n") } else { summary.join("\n\n") }
}

/// The last characters of `text`, at most [`MAX_OUTPUT`] bytes.
pub(super) fn tail(text: &str) -> String {
    if text.len() <= MAX_OUTPUT {
        return text.to_owned();
    }
    let mut cut = text.len() - MAX_OUTPUT;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    format!("…{}", &text[cut..])
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}
