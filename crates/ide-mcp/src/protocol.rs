// Ported from JetBrains intellij-community plugins/mcp-server (src/com/intellij/mcpserver/impl/McpSessionHandler.kt, McpServerService.kt), Apache-2.0.
//! MCP over JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`, the
//! `notifications/*` a client sends and its answers to the server's own requests
//! (`roots/list`, `elicitation/create`). Transport-independent (see [`crate::http`]).

use crate::Shared;
use crate::history::Ended;
use crate::progress::Forwarder;
use crate::project::{self, PROJECT_PATH_HEADER, Sources};
use crate::session::{ClientInfo, Outbound, ROOTS_TIMEOUT, Session};
use crate::tool::{Call, PROJECT_PATH};
use ide_core::error::ErrorKind;
use ide_core::mcp::McpClient;
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::time::Duration;

/// Protocol revisions this server speaks, newest first.
pub const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

/// The name in `serverInfo` (JetBrains: "<product> MCP Server").
pub const SERVER_NAME: &str = "OpenIDEA MCP Server";

const INSTRUCTIONS: &str = "Tools of the OpenIDEA IDE for the project open in it. Paths are relative to the project \
root unless absolute; lines and columns are 1-based (columns count UTF-16 code units, i.e. characters except that emoji and \
other astral characters count two). Prefer these tools over shell commands for reading, searching and navigating code: \
they see unsaved editor changes and use the IDE's index and language servers.";
/// Added unless the session's project is known up front (then the schemas have no `projectPath`).
const INSTRUCTIONS_PROJECT_PATH: &str = " Pass `projectPath` (your working directory) with every call.";

/// How long a call waits for the client's roots before it resolves its project without them.
const CALL_ROOTS_TIMEOUT: Duration = Duration::from_secs(10);

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

/// Where a message came from and where what it causes goes.
#[derive(Default)]
pub(crate) struct Ctx {
    pub session: Option<Arc<Session>>,
    /// The SSE stream the POST is answered with, if it is.
    pub outbound: Option<Outbound>,
    /// The project path header of the HTTP request.
    pub project_header: Option<String>,
}

/// Handles one message or a batch; a session that `initialize` creates is returned in `new_session`.
pub(crate) async fn handle(shared: &Arc<Shared>, ctx: &Ctx, body: Value, new_session: &mut Option<String>) -> Handled {
    match body {
        Value::Array(messages) if messages.is_empty() => {
            Handled::Reply(error(Value::Null, INVALID_REQUEST, "empty batch"))
        }
        Value::Array(messages) => {
            let mut replies = Vec::new();
            for message in messages {
                if let Some(r) = handle_one(shared, ctx, message, new_session).await {
                    replies.push(r);
                }
            }
            if replies.is_empty() { Handled::Accepted } else { Handled::Reply(Value::Array(replies)) }
        }
        message => match handle_one(shared, ctx, message, new_session).await {
            Some(r) => Handled::Reply(r),
            None => Handled::Accepted,
        },
    }
}

/// Whether a POST of `message` is better answered with an SSE stream (when the client
/// accepts one): a tool call that may report progress, ask for confirmation or need the
/// client's roots, all of which the server sends while the call runs.
pub(crate) fn wants_stream(session: &Session, message: &Value) -> bool {
    if message.get("method").and_then(Value::as_str) != Some("tools/call") || message.get("id").is_none() {
        return false;
    }
    message.pointer("/params/_meta/progressToken").is_some_and(|t| !t.is_null())
        || session.client.read().elicitation
        || session.roots_wanted()
}

async fn handle_one(
    shared: &Arc<Shared>,
    ctx: &Ctx,
    message: Value,
    new_session: &mut Option<String>,
) -> Option<Value> {
    let Value::Object(mut message) = message else {
        return Some(error(Value::Null, INVALID_REQUEST, "a JSON-RPC message must be an object"));
    };
    let id = message.remove("id");
    let Some(method) = message.get("method").and_then(Value::as_str).map(str::to_owned) else {
        // The client's answer to a request of ours.
        return match id {
            Some(id) if message.contains_key("result") || message.contains_key("error") => {
                if let Some(session) = &ctx.session {
                    let outcome = match message.remove("error") {
                        Some(e) => Err(e),
                        None => Ok(message.remove("result").unwrap_or(Value::Null)),
                    };
                    session.answer(&id, outcome);
                }
                None
            }
            id => Some(error(id.unwrap_or(Value::Null), INVALID_REQUEST, "missing `method`")),
        };
    };
    let params = match message.remove("params") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(p)) => p,
        Some(_) => return id.map(|id| error(id, INVALID_PARAMS, "`params` must be an object")),
    };
    let Some(id) = id else {
        notification(shared, ctx, &method, &params);
        return None;
    };
    Some(match method.as_str() {
        "initialize" => {
            let (session, reply) = initialize(shared, ctx, id, &params);
            *new_session = session;
            reply
        }
        "ping" => result(id, json!({})),
        "tools/list" => result(id, json!({ "tools": list_tools(shared, ctx.session.as_deref()) })),
        "tools/call" => call_tool(shared, ctx, id, params).await,
        "resources/list" => result(id, json!({ "resources": [] })),
        "resources/templates/list" => result(id, json!({ "resourceTemplates": [] })),
        "prompts/list" => result(id, json!({ "prompts": [] })),
        "logging/setLevel" => result(id, json!({})),
        other => error(id, METHOD_NOT_FOUND, format!("unknown method `{other}`")),
    })
}

fn notification(shared: &Arc<Shared>, ctx: &Ctx, method: &str, params: &Map<String, Value>) {
    let session = ctx.session.as_ref();
    match method {
        "notifications/cancelled" => {
            if let Some(request) = params.get("requestId")
                && let Some(token) = shared.inflight.lock().get(&inflight_key(session.map(|s| s.id.as_str()), request))
            {
                token.cancel();
            }
        }
        "notifications/initialized" => {
            if let Some(s) = session {
                refresh_roots(shared, s);
            }
        }
        "notifications/roots/list_changed" => {
            if let Some(s) = session {
                s.roots_changed();
                refresh_roots(shared, s);
            }
        }
        _ => {}
    }
}

fn inflight_key(session: Option<&str>, request: &Value) -> String {
    format!("{}\u{0}{request}", session.unwrap_or(""))
}

/// Asks the client for its roots in the background when it has some, they are not
/// known and a stream reaches it (else the next stream or call asks).
pub(crate) fn refresh_roots(shared: &Arc<Shared>, session: &Arc<Session>) {
    if !session.roots_wanted() || !session.has_stream() || !session.begin_fetch() {
        return;
    }
    let (shared, session) = (shared.clone(), session.clone());
    tokio::spawn(async move {
        let fetched = session.fetch_roots(None, ROOTS_TIMEOUT).await;
        session.end_fetch();
        if fetched {
            announce_schema_change(&shared, &session);
        }
    });
}

/// The session's project is known without `projectPath` (header or roots).
fn known_upfront(shared: &Shared, session: &Session) -> bool {
    let roots = session.roots();
    let sources = Sources { session_header: session.project_header.as_deref(), roots: &roots, ..Default::default() };
    project::session_target(&shared.ui.host(), &sources).is_some()
}

/// The schemas lose or regain `projectPath` when the project becomes known or unknown:
/// a client that listed them is told to list again.
fn announce_schema_change(shared: &Shared, session: &Session) {
    let advertised = *session.advertised_stripped.lock();
    if advertised.is_some_and(|a| a != known_upfront(shared, session)) {
        session.notify(None, "notifications/tools/list_changed", json!({}));
    }
}

fn list_tools(shared: &Arc<Shared>, session: Option<&Session>) -> Vec<Value> {
    let strip = session.is_some_and(|s| known_upfront(shared, s));
    if let Some(s) = session {
        *s.advertised_stripped.lock() = Some(strip);
    }
    shared
        .enabled_tools()
        .iter()
        .map(|t| {
            let mut d = t.descriptor();
            if strip {
                strip_project_path(&mut d["inputSchema"]);
            }
            d
        })
        .collect()
}

fn strip_project_path(schema: &mut Value) {
    if let Some(p) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        p.remove(PROJECT_PATH);
    }
    if let Some(r) = schema.get_mut("required").and_then(Value::as_array_mut) {
        r.retain(|n| n != PROJECT_PATH);
    }
}

fn initialize(shared: &Arc<Shared>, ctx: &Ctx, id: Value, params: &Map<String, Value>) -> (Option<String>, Value) {
    let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let version = PROTOCOL_VERSIONS.iter().find(|v| **v == requested).copied().unwrap_or(PROTOCOL_VERSIONS[0]);
    let info = params.get("clientInfo");
    let text = |key: &str| info.and_then(|i| i.get(key)).and_then(Value::as_str).map(str::to_owned);
    let capability = |key: &str| params.get("capabilities").and_then(|c| c.get(key)).is_some_and(Value::is_object);
    let client = ClientInfo {
        name: text("name").unwrap_or_else(|| "unknown client".into()),
        version: text("version").unwrap_or_default(),
        protocol: version.into(),
        roots: capability("roots"),
        elicitation: capability("elicitation"),
    };
    // A legacy SSE session exists before its `initialize`; a streamable HTTP one starts with it.
    let (session, created) = match &ctx.session {
        Some(s) if s.legacy => (s.clone(), None),
        _ => {
            let s =
                Arc::new(Session::new(uuid::Uuid::new_v4().simple().to_string(), false, ctx.project_header.clone()));
            shared.add_session(s.clone());
            (s.clone(), Some(s.id.clone()))
        }
    };
    shared.client_seen(McpClient { name: client.name.clone(), version: client.version.clone(), calls: 0 });
    *session.client.write() = client;
    let mut instructions = INSTRUCTIONS.to_owned();
    if !known_upfront(shared, &session) {
        instructions.push_str(INSTRUCTIONS_PROJECT_PATH);
    }
    let reply = result(
        id,
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": true } },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            "instructions": instructions,
        }),
    );
    (created, reply)
}

fn given(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

async fn call_tool(shared: &Arc<Shared>, ctx: &Ctx, id: Value, mut params: Map<String, Value>) -> Value {
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
    let session = ctx.session.clone();
    let client =
        session.as_ref().map(|s| s.client_name()).filter(|n| !n.is_empty()).unwrap_or_else(|| "MCP client".into());
    shared.count_call(&client);
    // Recorded once, here; `execute_tool` records the call it routes as well.
    let started = shared.history.begin(&client, tool.name, &args, false, None);

    let meta = params.get("_meta").and_then(Value::as_object);
    let call_header = given(ctx.project_header.as_deref())
        .or_else(|| given(meta.and_then(|m| m.get(PROJECT_PATH_HEADER)).and_then(Value::as_str)));
    let argument = given(args.get(PROJECT_PATH).and_then(Value::as_str));
    if let Some(s) = &session
        && argument.is_none()
        && call_header.is_none()
        && s.roots_wanted()
        && (ctx.outbound.is_some() || s.has_stream())
        && s.fetch_roots(ctx.outbound.as_ref(), CALL_ROOTS_TIMEOUT).await
    {
        announce_schema_change(shared, s);
    }
    let roots = session.as_ref().map(|s| s.roots()).unwrap_or_default();
    let sources = Sources {
        argument,
        call_header,
        session_header: session.as_ref().and_then(|s| s.project_header.as_deref()),
        roots: &roots,
    };
    let host = shared.ui.host();
    let target = match project::target(&host, &sources, shared.ui.focused_window().as_deref()) {
        Ok(t) => t,
        Err(e) => {
            shared.history.finish(started, Ended::error(&e));
            return result(id, tool_error(&e.message));
        }
    };
    let root = target.project.root.clone();
    shared.history.set_project(&started, &root);

    let cancel = shared.stop.lock().child_token();
    let key = inflight_key(session.as_ref().map(|s| s.id.as_str()), &id);
    shared.inflight.lock().insert(key.clone(), cancel.clone());
    let token = meta.and_then(|m| m.get("progressToken")).filter(|t| t.is_string() || t.is_number()).cloned();
    let (forwarder, progress) = match (&session, token) {
        (Some(s), Some(token)) => {
            let interval = shared.timing.read().progress;
            let (f, sink) = Forwarder::start(s.clone(), ctx.outbound.clone(), token, interval);
            (Some(f), Some(sink))
        }
        _ => (None, None),
    };
    let changes = Arc::<parking_lot::Mutex<Vec<std::path::PathBuf>>>::default();
    let call = Call {
        shared: shared.clone(),
        target,
        args,
        client,
        tool: tool.name,
        cancel: cancel.clone(),
        progress,
        session,
        outbound: ctx.outbound.clone(),
        changes: changes.clone(),
    };
    let handler = tool.handler.clone();
    // Its own task: a panicking tool fails the call, not the connection.
    let outcome = tokio::spawn(async move { handler(call).await }).await;
    shared.inflight.lock().remove(&key);
    if let Some(f) = forwarder {
        f.finish().await;
    }
    let (reply, mut ended) = match outcome {
        Ok(Ok(output)) => {
            let mut r = json!({ "content": [{ "type": "text", "text": output.text }], "isError": false });
            if let Some(s) = output.structured {
                r["structuredContent"] = s;
            }
            (r, Ended::success())
        }
        Ok(Err(e)) if e.kind == ErrorKind::Cancelled => {
            let reply =
                tool_error(&format!("MCP tool call has been cancelled likely by a user interaction: {}", e.message));
            (reply, Ended::error(&e))
        }
        Ok(Err(e)) => (tool_error(&e.message), Ended::error(&e)),
        Err(e) => {
            let why = match e.try_into_panic() {
                Ok(p) => p
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_owned())
                    .or_else(|| p.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "the tool panicked".into()),
                Err(e) => e.to_string(),
            };
            tracing::error!("MCP tool {name} panicked: {why}");
            let message = format!("MCP tool call has been failed: {why}");
            (tool_error(&message), Ended::failed(message))
        }
    };
    ended.changed_files = changes.lock().iter().map(|p| project::display(&root, p)).collect();
    shared.history.finish(started, ended);
    if cancel.is_cancelled() && shared.stop.lock().is_cancelled() {
        return error(id, INTERNAL_ERROR, "the server is stopping");
    }
    result(id, reply)
}

fn tool_error(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_project_path_from_schemas() {
        let mut schema = json!({ "properties": { "projectPath": {}, "a": {} }, "required": ["a", "projectPath"] });
        strip_project_path(&mut schema);
        assert_eq!(schema, json!({ "properties": { "a": {} }, "required": ["a"] }));
    }
}
