//! MCP over JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`
//! and notifications, for one POST body (a message or a batch). Blocking: the
//! server runs it on a blocking thread.

use crate::{CancellationToken, Tool, ToolCallError, ToolRegistry};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct Requests(Mutex<RequestState>);
#[derive(Default)]
struct RequestState {
    clients: HashMap<String, String>,
    running: HashMap<(String, String), CancellationToken>,
    early: HashMap<(String, String), std::time::Instant>,
}
struct InFlight<'a> {
    requests: &'a Requests,
    key: (String, String),
}
impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.requests.0.lock().unwrap().running.remove(&self.key);
    }
}

/// The protocol version answered when the client asks for one this server doesn't know.
pub(crate) const LATEST: &str = "2025-06-18";
pub(crate) const SUPPORTED: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
/// The requested folder isn't a project open in the IDE (or has no tools there).
pub(crate) const NOT_OPEN: i64 = -32001;

pub(crate) struct RpcError {
    code: i64,
    message: String,
}

impl RpcError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

pub(crate) fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Answers one POST body: `Ok(None)` when it held only notifications and
/// responses (HTTP 202), `Err` with the error response when it isn't JSON.
pub(crate) fn handle_body(
    registry: &dyn ToolRegistry,
    project: Option<&str>,
    body: &[u8],
    requests: &Requests,
    scope: &str,
    cancel: CancellationToken,
) -> Result<Option<Value>, Value> {
    let message: Value = serde_json::from_slice(body)
        .map_err(|e| error_response(Value::Null, PARSE_ERROR, &format!("not JSON: {e}")))?;
    let session = Session { registry, project, requests, scope, cancel };
    Ok(match message {
        Value::Array(batch) if batch.is_empty() => Some(error_response(Value::Null, INVALID_REQUEST, "an empty batch")),
        Value::Array(batch) => {
            let replies: Vec<Value> = batch.into_iter().filter_map(|m| session.handle(m)).collect();
            (!replies.is_empty()).then_some(Value::Array(replies))
        }
        message => session.handle(message),
    })
}

struct Session<'a> {
    registry: &'a dyn ToolRegistry,
    project: Option<&'a str>,
    requests: &'a Requests,
    scope: &'a str,
    cancel: CancellationToken,
}

impl Session<'_> {
    /// The response to one message (`None` for notifications and responses).
    fn handle(&self, message: Value) -> Option<Value> {
        let Value::Object(mut message) = message else {
            return Some(error_response(Value::Null, INVALID_REQUEST, "not a JSON-RPC message"));
        };
        let id = message.remove("id");
        if message.get("jsonrpc") != Some(&json!("2.0"))
            || id.as_ref().is_some_and(|id| !id.is_null() && !id.is_string() && !id.is_number())
        {
            return Some(error_response(Value::Null, INVALID_REQUEST, "invalid JSON-RPC envelope"));
        }
        let Some(method) = message.get("method").and_then(Value::as_str).map(str::to_owned) else {
            // A response to a request of ours (we send none), or garbage.
            return id.map(|id| error_response(id, INVALID_REQUEST, "not a JSON-RPC request"));
        };
        if method == "notifications/cancelled" {
            if let Some(id) = message.get("params").and_then(|p| p.get("requestId")) {
                let key = (self.scope.to_owned(), id.to_string());
                let mut state = self.requests.0.lock().unwrap();
                if let Some(cancel) = state.running.get(&key) {
                    cancel.cancel();
                } else if state.early.len() < 1024 {
                    state.early.insert(key, std::time::Instant::now());
                }
            }
            return None;
        }
        let id = id?;
        let key = (self.scope.to_owned(), id.to_string());
        let cancel = self.cancel.child_token();
        {
            let mut requests = self.requests.0.lock().unwrap();
            requests.early.retain(|_, at| at.elapsed() < std::time::Duration::from_secs(60));
            if requests.running.contains_key(&key) {
                return Some(error_response(id, INVALID_REQUEST, "request id already in flight"));
            }
            if requests.early.remove(&key).is_some() {
                cancel.cancel();
            }
            requests.running.insert(key.clone(), cancel.clone());
        }
        let _in_flight = InFlight { requests: self.requests, key };
        let params = message.remove("params").unwrap_or(Value::Null);
        let result = match self.request(&method, params, cancel) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(e) => error_response(id, e.code, &e.message),
        };
        Some(result)
    }

    fn request(&self, method: &str, params: Value, cancel: CancellationToken) -> Result<Value, RpcError> {
        match method {
            "initialize" => Ok(self.initialize(&params)),
            "ping" => Ok(json!({})),
            "tools/list" => {
                let project = self.project()?;
                let tools = self.registry.tools(&project).map_err(|e| RpcError::new(NOT_OPEN, e))?;
                Ok(json!({ "tools": tools.iter().map(tool_json).collect::<Vec<_>>() }))
            }
            "tools/call" => self.call(params, cancel),
            _ => Err(RpcError::new(METHOD_NOT_FOUND, format!("no method {method:?}"))),
        }
    }

    fn initialize(&self, params: &Value) -> Value {
        if let Some(name) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
            let mut requests = self.requests.0.lock().unwrap();
            if requests.clients.len() < 1024 {
                requests.clients.insert(self.scope.into(), name.chars().take(128).collect());
            }
        }
        let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(LATEST);
        let version = if SUPPORTED.contains(&asked) { asked } else { LATEST };
        let about = match self.project() {
            Ok(root) => format!("the project open in OpenIDEA at {}", root.display()),
            Err(_) => "a project open in OpenIDEA".to_owned(),
        };
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "OpenIDEA", "version": env!("CARGO_PKG_VERSION") },
            "instructions": format!(
                "Built-in OpenIDEA tools for {about}: they see the files and editors the IDE has open."
            ),
        })
    }

    fn call(&self, params: Value, cancel: CancellationToken) -> Result<Value, RpcError> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::new(INVALID_PARAMS, "tools/call needs a tool `name`"))?;
        let arguments = match params.get("arguments") {
            None | Some(Value::Null) => "{}".to_owned(),
            Some(args @ Value::Object(_)) => args.to_string(),
            Some(_) => return Err(RpcError::new(INVALID_PARAMS, "`arguments` must be an object")),
        };
        let requested = params.pointer("/arguments/projectPath");
        if requested.is_some_and(|v| !v.is_string()) {
            return Err(RpcError::new(INVALID_PARAMS, "projectPath must be a string"));
        }
        let project = self.resolve_project(requested.and_then(Value::as_str).or(self.project))?;
        let outcome = if cancel.is_cancelled() {
            Err(ToolCallError::Failed("cancelled".into()))
        } else {
            let client =
                self.requests.0.lock().unwrap().clients.get(self.scope).cloned().unwrap_or_else(|| "MCP client".into());
            self.registry.call_with_client(&project, name, &arguments, cancel, &client)
        };
        let (text, is_error) = match outcome {
            Ok(text) => (text, false),
            Err(ToolCallError::Failed(message)) => (message, true),
            Err(ToolCallError::UnknownTool(message)) => return Err(RpcError::new(INVALID_PARAMS, message)),
        };
        let mut result = json!({ "content": [{ "type": "text", "text": text }], "isError": is_error });
        if !is_error && let Ok(value @ Value::Object(_)) = serde_json::from_str::<Value>(&text) {
            result["structuredContent"] = value;
        }
        Ok(result)
    }

    /// The open project the request names.
    fn project(&self) -> Result<PathBuf, RpcError> {
        self.resolve_project(self.project)
    }

    fn resolve_project(&self, requested: Option<&str>) -> Result<PathBuf, RpcError> {
        let mut roots = self.registry.projects();
        roots.sort();
        roots.dedup();
        if let Some(requested) = requested.filter(|p| !p.trim().is_empty()) {
            return resolve(&roots, Path::new(requested)).ok_or_else(|| {
                RpcError::new(
                    NOT_OPEN,
                    format!(
                        "this folder isn't open in OpenIDEA: {requested}. Open projects: {}",
                        roots.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
                    ),
                )
            });
        }
        if roots.len() == 1 {
            return Ok(roots.remove(0));
        }
        Err(RpcError::new(
            INVALID_PARAMS,
            format!(
                "Specify projectPath, X-OpenIDEA-Project or ?project=. Open projects: {}",
                roots.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
            ),
        ))
    }
}

/// The project among `roots` containing `path` (the innermost one).
fn resolve(roots: &[PathBuf], path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let path = dunce::canonicalize(path).unwrap_or_else(|_| {
        let mut out = PathBuf::new();
        for part in path.components() {
            match part {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    out.pop();
                }
                part => out.push(part.as_os_str()),
            }
        }
        out
    });
    roots
        .iter()
        .filter_map(|root| {
            let canonical = dunce::canonicalize(root).unwrap_or_else(|_| root.clone());
            path.starts_with(&canonical).then(|| (canonical.components().count(), root))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, root)| root.clone())
}

fn tool_json(tool: &Tool) -> Value {
    let mut value = json!({
        "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema,
        "annotations": { "readOnlyHint": tool.read_only, "destructiveHint": tool.destructive },
    });
    if let Some(schema) = &tool.output_schema {
        value["outputSchema"] = schema.clone();
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_innermost_open_project_containing_the_path_answers() {
        let tmp = tempfile::tempdir().unwrap();
        let outer = dunce::canonicalize(tmp.path()).unwrap();
        let inner = outer.join("inner");
        std::fs::create_dir_all(inner.join("src")).unwrap();
        let roots = [outer.clone(), inner.clone()];
        assert_eq!(resolve(&roots, &inner.join("src")), Some(inner.clone()));
        assert_eq!(resolve(&roots, &outer.join("other")), Some(outer.clone()));
        assert_eq!(resolve(&roots[1..], &outer), None);
        assert_eq!(resolve(&roots, Path::new("relative/path")), None);
        // Siblings sharing a prefix are not inside.
        assert_eq!(resolve(&roots[1..], &outer.join("inner-two")), None);
    }
}
