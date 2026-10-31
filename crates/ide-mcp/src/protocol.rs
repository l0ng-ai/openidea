//! MCP over JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call` and the
//! `notifications/*` a client sends. Transport-independent (see [`crate::http`]).

use crate::tool::{Call, PROJECT_PATH};
use crate::{Session, Shared};
use ide_core::IdeError;
use ide_core::mcp::McpClient;
use serde_json::{Map, Value, json};
use std::sync::Arc;

/// Protocol revisions this server speaks, newest first.
pub const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

const INSTRUCTIONS: &str = "Tools of the OpenIDEA IDE for the project open in it. Paths are relative to the project \
root unless absolute; lines and columns are 1-based (columns count UTF-16 code units, i.e. characters except that emoji and \
other astral characters count two). Pass `projectPath` (your working directory) with every call. \
Prefer these tools over shell commands for reading, searching and navigating code: they see unsaved editor changes \
and use the IDE's index and language servers.";

pub fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

fn result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// What one HTTP POST body produced.
pub enum Handled {
    /// A response (or a batch of them) to send back.
    Reply(Value),
    /// Only notifications / responses: `202 Accepted`, no body.
    Accepted,
}

/// Handles one message or a batch. `session` is the `Mcp-Session-Id` the request
/// carried; a new session from `initialize` is returned in `new_session`.
pub(crate) async fn handle(
    shared: &Arc<Shared>,
    session: Option<String>,
    body: Value,
    new_session: &mut Option<String>,
) -> Handled {
    match body {
        Value::Array(messages) if messages.is_empty() => {
            Handled::Reply(error(Value::Null, INVALID_REQUEST, "empty batch"))
        }
        Value::Array(messages) => {
            let mut replies = Vec::new();
            for message in messages {
                if let Some(r) = handle_one(shared, session.as_deref(), message, new_session).await {
                    replies.push(r);
                }
            }
            if replies.is_empty() { Handled::Accepted } else { Handled::Reply(Value::Array(replies)) }
        }
        message => match handle_one(shared, session.as_deref(), message, new_session).await {
            Some(r) => Handled::Reply(r),
            None => Handled::Accepted,
        },
    }
}

async fn handle_one(
    shared: &Arc<Shared>,
    session: Option<&str>,
    message: Value,
    new_session: &mut Option<String>,
) -> Option<Value> {
    let Value::Object(mut message) = message else {
        return Some(error(Value::Null, INVALID_REQUEST, "a JSON-RPC message must be an object"));
    };
    let id = message.remove("id");
    let Some(method) = message.get("method").and_then(Value::as_str).map(str::to_owned) else {
        // A response to a request of ours (we send none) or garbage.
        return match id {
            Some(_) if message.contains_key("result") || message.contains_key("error") => None,
            id => Some(error(id.unwrap_or(Value::Null), INVALID_REQUEST, "missing `method`")),
        };
    };
    let params = match message.remove("params") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(p)) => p,
        Some(_) => return id.map(|id| error(id, INVALID_PARAMS, "`params` must be an object")),
    };
    let Some(id) = id else {
        notification(shared, session, &method, &params);
        return None;
    };
    Some(match method.as_str() {
        "initialize" => {
            let (id_out, reply) = initialize(shared, id, &params);
            *new_session = Some(id_out);
            reply
        }
        "ping" => result(id, json!({})),
        "tools/list" => {
            result(id, json!({ "tools": shared.enabled_tools().iter().map(|t| t.descriptor()).collect::<Vec<_>>() }))
        }
        "tools/call" => call_tool(shared, session, id, params).await,
        "resources/list" => result(id, json!({ "resources": [] })),
        "resources/templates/list" => result(id, json!({ "resourceTemplates": [] })),
        "prompts/list" => result(id, json!({ "prompts": [] })),
        "logging/setLevel" => result(id, json!({})),
        other => error(id, METHOD_NOT_FOUND, format!("unknown method `{other}`")),
    })
}

fn notification(shared: &Arc<Shared>, session: Option<&str>, method: &str, params: &Map<String, Value>) {
    if method == "notifications/cancelled"
        && let Some(request) = params.get("requestId")
        && let Some(token) = shared.inflight.lock().get(&inflight_key(session, request))
    {
        token.cancel();
    }
}

fn inflight_key(session: Option<&str>, request: &Value) -> String {
    format!("{}\u{0}{request}", session.unwrap_or(""))
}

fn initialize(shared: &Arc<Shared>, id: Value, params: &Map<String, Value>) -> (String, Value) {
    let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let version = PROTOCOL_VERSIONS.iter().find(|v| **v == requested).copied().unwrap_or(PROTOCOL_VERSIONS[0]);
    let info = params.get("clientInfo");
    let name = info.and_then(|i| i.get("name")).and_then(Value::as_str).unwrap_or("unknown client").to_owned();
    let client_version = info.and_then(|i| i.get("version")).and_then(Value::as_str).unwrap_or("").to_owned();
    let session_id = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut sessions = shared.sessions.lock();
        while sessions.len() >= crate::MAX_SESSIONS {
            let Some(oldest) = sessions.iter().min_by_key(|(_, s)| s.created).map(|(k, _)| k.clone()) else { break };
            sessions.remove(&oldest);
        }
        sessions.insert(session_id.clone(), Session { client: name.clone(), created: std::time::Instant::now() });
    }
    shared.client_seen(McpClient { name, version: client_version, calls: 0 });
    let reply = result(
        id,
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "openidea", "title": "OpenIDEA", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        }),
    );
    (session_id, reply)
}

async fn call_tool(shared: &Arc<Shared>, session: Option<&str>, id: Value, mut params: Map<String, Value>) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str).map(str::to_owned) else {
        return error(id, INVALID_PARAMS, "missing tool `name`");
    };
    let Some(tool) = shared.enabled_tools().into_iter().find(|t| t.name == name) else {
        return error(id, INVALID_PARAMS, format!("unknown tool `{name}`"));
    };
    let args = match params.remove("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(a)) => a,
        Some(_) => return error(id, INVALID_PARAMS, "`arguments` must be an object"),
    };
    let client = session
        .and_then(|s| shared.sessions.lock().get(s).map(|s| s.client.clone()))
        .unwrap_or_else(|| "MCP client".into());
    shared.count_call(&client);

    let host = shared.ui.host();
    let focused = shared.ui.focused_window();
    let project_path = args.get(PROJECT_PATH).and_then(Value::as_str);
    let target = match crate::project::target(&host, project_path, focused.as_deref()) {
        Ok(t) => t,
        Err(e) => return result(id, tool_error(&e)),
    };
    let cancel = shared.stop.lock().child_token();
    let key = inflight_key(session, &id);
    shared.inflight.lock().insert(key.clone(), cancel.clone());
    let call =
        Call { shared: shared.clone(), target, args, client, tool: tool.name, cancel: cancel.clone(), progress: None };
    let handler = tool.handler.clone();
    let started = shared.history.begin(&call.client, tool.name, &call.args, false);
    // Its own task: a panicking tool fails the call, not the connection.
    let outcome = tokio::spawn(async move { handler(call).await }).await;
    shared.history.finish(started, &outcome);
    shared.inflight.lock().remove(&key);
    let reply = match outcome {
        Ok(Ok(output)) => {
            let mut r = json!({ "content": [{ "type": "text", "text": output.text }], "isError": false });
            if let Some(s) = output.structured {
                r["structuredContent"] = s;
            }
            r
        }
        Ok(Err(e)) => tool_error(&e),
        Err(e) => {
            tracing::error!("MCP tool {name} panicked: {e}");
            tool_error(&IdeError::internal(format!("the tool `{name}` failed unexpectedly")))
        }
    };
    if cancel.is_cancelled() && shared.stop.lock().is_cancelled() {
        return error(id, INTERNAL_ERROR, "the server is stopping");
    }
    result(id, reply)
}

fn tool_error(e: &IdeError) -> Value {
    json!({ "content": [{ "type": "text", "text": e.message }], "isError": true })
}
