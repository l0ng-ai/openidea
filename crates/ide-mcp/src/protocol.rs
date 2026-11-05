//! MCP over JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`
//! and notifications, for one POST body (a message or a batch). Blocking: the
//! server runs it on a blocking thread.

use crate::{Tool, ToolCallError, ToolRegistry};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

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
) -> Result<Option<Value>, Value> {
    let message: Value = serde_json::from_slice(body)
        .map_err(|e| error_response(Value::Null, PARSE_ERROR, &format!("not JSON: {e}")))?;
    let session = Session { registry, project };
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
}

impl Session<'_> {
    /// The response to one message (`None` for notifications and responses).
    fn handle(&self, message: Value) -> Option<Value> {
        let Value::Object(mut message) = message else {
            return Some(error_response(Value::Null, INVALID_REQUEST, "not a JSON-RPC message"));
        };
        let id = message.remove("id");
        let Some(method) = message.get("method").and_then(Value::as_str).map(str::to_owned) else {
            // A response to a request of ours (we send none), or garbage.
            return id.map(|id| error_response(id, INVALID_REQUEST, "not a JSON-RPC request"));
        };
        let id = id?; // A notification (`notifications/initialized`, `…/cancelled`): nothing to answer.
        let params = message.remove("params").unwrap_or(Value::Null);
        Some(match self.request(&method, params) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(e) => error_response(id, e.code, &e.message),
        })
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            "initialize" => Ok(self.initialize(&params)),
            "ping" => Ok(json!({})),
            "tools/list" => {
                let project = self.project()?;
                let tools = self.registry.tools(&project).map_err(|e| RpcError::new(NOT_OPEN, e))?;
                Ok(json!({ "tools": tools.iter().map(tool_json).collect::<Vec<_>>() }))
            }
            "tools/call" => self.call(params),
            _ => Err(RpcError::new(METHOD_NOT_FOUND, format!("no method {method:?}"))),
        }
    }

    fn initialize(&self, params: &Value) -> Value {
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
                "Tools of OpenIDEA's plugins for {about}: they see the files and editors the IDE has open."
            ),
        })
    }

    fn call(&self, params: Value) -> Result<Value, RpcError> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::new(INVALID_PARAMS, "tools/call needs a tool `name`"))?;
        let arguments = match params.get("arguments") {
            None | Some(Value::Null) => "{}".to_owned(),
            Some(args @ Value::Object(_)) => args.to_string(),
            Some(_) => return Err(RpcError::new(INVALID_PARAMS, "`arguments` must be an object")),
        };
        let project = self.project()?;
        let (text, is_error) = match self.registry.call(&project, name, &arguments) {
            Ok(text) => (text, false),
            Err(ToolCallError::Failed(message)) => (message, true),
            Err(ToolCallError::UnknownTool(message)) => return Err(RpcError::new(INVALID_PARAMS, message)),
        };
        Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
    }

    /// The open project the request names.
    fn project(&self) -> Result<PathBuf, RpcError> {
        let requested = self.project.filter(|p| !p.trim().is_empty()).ok_or_else(|| {
            RpcError::new(
                INVALID_PARAMS,
                "no project: name its folder with the X-OpenIDEA-Project header or the ?project= query",
            )
        })?;
        resolve(&self.registry.projects(), Path::new(requested)).ok_or_else(|| {
            RpcError::new(
                NOT_OPEN,
                format!("this folder isn't open in OpenIDEA: {requested}. Open it in OpenIDEA first"),
            )
        })
    }
}

/// The project among `roots` containing `path` (the innermost one).
fn resolve(roots: &[PathBuf], path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let path = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
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
    json!({
        "name": tool.name,
        "description": tool.description,
        "inputSchema": tool.input_schema,
        "annotations": { "readOnlyHint": tool.read_only, "destructiveHint": tool.destructive },
    })
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
