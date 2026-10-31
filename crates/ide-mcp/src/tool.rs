//! Tool definitions: a name, a description, typed parameters (which give the JSON
//! schema), a [`McpToolKind`] and an async handler that gets a [`Call`].

use crate::project::Target;
use crate::session::{Outbound, RequestError, Session};
use crate::{McpHost, Shared};
use futures::future::BoxFuture;
use ide_core::mcp::{McpToolKind, McpUiRequest};
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_host::{Host, Project};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A host request id for a tool's cancellable work. The UI's ids count up from 1, so
/// every tool takes its ids from this one counter in the upper half.
pub fn request_id() -> ide_core::RequestId {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    ide_core::RequestId(0x8000_0000 | (NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) & 0x7fff_ffff))
}

pub type Handler = Arc<dyn Fn(Call) -> BoxFuture<'static, IdeResult<Output>> + Send + Sync>;

/// The type of one parameter, for the input schema.
#[derive(Clone, Debug)]
pub enum ParamType {
    String,
    Integer,
    Boolean,
    StringList,
    /// String → string map (environment variables).
    StringMap,
    /// One of these strings.
    Enum(&'static [&'static str]),
}

#[derive(Clone, Debug)]
pub struct Param {
    pub name: &'static str,
    pub ty: ParamType,
    pub description: &'static str,
    pub required: bool,
}

impl Param {
    pub fn required(name: &'static str, ty: ParamType, description: &'static str) -> Self {
        Self { name, ty, description, required: true }
    }
    pub fn optional(name: &'static str, ty: ParamType, description: &'static str) -> Self {
        Self { name, ty, description, required: false }
    }
}

/// Described on every tool: which open project the call is for.
pub const PROJECT_PATH: &str = "projectPath";
const PROJECT_PATH_DESCRIPTION: &str = "Absolute path of the project (or of any directory inside it) the call is \
for. Always pass it when you know it, for example your working directory; without it the call goes to the focused \
OpenIDEA window, or to the only open project.";

#[derive(Clone)]
pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    pub kind: McpToolKind,
    pub params: Vec<Param>,
    /// JSON schema of `structuredContent` (MCP `outputSchema`), when the tool declares one.
    pub output_schema: Option<Value>,
    /// The toolset it belongs to, named like the JetBrains toolset class (`general.SearchToolset`);
    /// filters and the settings page group by it.
    pub group: &'static str,
    /// Hidden unless experimental tools are on.
    pub experimental: bool,
    pub handler: Handler,
}

impl Tool {
    pub fn new<F, Fut>(name: &'static str, kind: McpToolKind, description: &'static str, handler: F) -> Self
    where
        F: Fn(Call) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = IdeResult<Output>> + Send + 'static,
    {
        Self {
            name,
            description,
            kind,
            params: Vec::new(),
            output_schema: None,
            group: crate::filter::DEFAULT_GROUP,
            experimental: false,
            handler: Arc::new(move |call| Box::pin(handler(call))),
        }
    }

    pub fn param(mut self, param: Param) -> Self {
        self.params.push(param);
        self
    }

    /// Declares the JSON schema of the tool's structured result.
    pub fn output(mut self, schema: Value) -> Self {
        self.output_schema = Some(schema);
        self
    }

    /// Puts the tool into a toolset (see [`Tool::group`]).
    pub fn group(mut self, group: &'static str) -> Self {
        self.group = group;
        self
    }

    /// Marks the tool experimental: hidden unless the settings turn experimental tools on.
    pub fn experimental(mut self) -> Self {
        self.experimental = true;
        self
    }

    /// `<group>.<name>`, what masks and tool states match.
    pub fn fully_qualified_name(&self) -> String {
        format!("{}.{}", self.group, self.name)
    }

    /// The JSON schema of the arguments (`projectPath` included).
    pub fn input_schema(&self) -> Value {
        let mut properties = Map::new();
        let mut required = Vec::new();
        for p in &self.params {
            let mut schema = match &p.ty {
                ParamType::String => json!({ "type": "string" }),
                ParamType::Integer => json!({ "type": "integer" }),
                ParamType::Boolean => json!({ "type": "boolean" }),
                ParamType::StringList => json!({ "type": "array", "items": { "type": "string" } }),
                ParamType::StringMap => json!({ "type": "object", "additionalProperties": { "type": "string" } }),
                ParamType::Enum(values) => json!({ "type": "string", "enum": values }),
            };
            schema["description"] = p.description.into();
            properties.insert(p.name.into(), schema);
            if p.required {
                required.push(Value::from(p.name));
            }
        }
        properties.insert(PROJECT_PATH.into(), json!({ "type": "string", "description": PROJECT_PATH_DESCRIPTION }));
        json!({ "type": "object", "properties": properties, "required": required })
    }

    /// The `tools/list` entry.
    pub fn descriptor(&self) -> Value {
        let mut d = json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema(),
            "annotations": {
                "readOnlyHint": self.kind == McpToolKind::Read,
                "destructiveHint": self.kind != McpToolKind::Read,
                "openWorldHint": false,
            },
        });
        if let Some(schema) = &self.output_schema {
            d["outputSchema"] = schema.clone();
        }
        d
    }
}

/// What a tool returns: text for the model and, for JSON results, the same value
/// as `structuredContent`.
#[derive(Debug)]
pub struct Output {
    pub text: String,
    pub structured: Option<Value>,
}

impl Output {
    pub fn text(text: impl Into<String>) -> Self {
        Self { text: text.into(), structured: None }
    }

    /// A serializable result; objects also go out as `structuredContent`.
    pub fn json(value: impl Serialize) -> IdeResult<Self> {
        let value = serde_json::to_value(value).map_err(|e| IdeError::internal(e.to_string()))?;
        let text = serde_json::to_string(&value).map_err(|e| IdeError::internal(e.to_string()))?;
        Ok(Self { text, structured: value.is_object().then_some(value) })
    }
}

/// One `tools/call`: its arguments, the project it resolved to, and access to the IDE.
pub struct Call {
    pub(crate) shared: Arc<Shared>,
    pub target: Target,
    pub args: Map<String, Value>,
    /// The client's name from `initialize` (`claude-code`).
    pub client: String,
    pub tool: &'static str,
    /// Cancelled when the client sends `notifications/cancelled` or the server stops.
    pub cancel: CancellationToken,
    /// Where `notifications/progress` go when the client asked for them (`_meta.progressToken`).
    pub progress: Option<ProgressSink>,
    pub(crate) session: Option<Arc<Session>>,
    /// The SSE stream of the POST this call came in, when it is answered with one.
    pub(crate) outbound: Option<Outbound>,
    /// What [`Call::record_change`] noted.
    pub(crate) changes: Arc<parking_lot::Mutex<Vec<PathBuf>>>,
}

/// Receives `(progress, total, message)` for `notifications/progress`.
pub type ProgressSink = Arc<dyn Fn(f64, Option<f64>, Option<String>) + Send + Sync>;

impl Call {
    pub fn host(&self) -> Arc<Host> {
        self.shared.ui.host()
    }

    pub fn ui(&self) -> &Arc<dyn McpHost> {
        &self.shared.ui
    }

    /// The window label the call runs in.
    pub fn window(&self) -> &str {
        &self.target.window
    }

    pub fn project(&self) -> &Arc<Project> {
        &self.target.project
    }

    pub fn root(&self) -> &Path {
        &self.target.project.root
    }

    /// Reports progress of a long call; a no-op when the client did not ask for progress.
    pub fn report_progress(&self, progress: f64, total: Option<f64>, message: Option<&str>) {
        if let Some(sink) = &self.progress {
            sink(progress, total, message.map(str::to_owned));
        }
    }

    /// Notes a file the call created, changed, moved or deleted: the UI lists them per call.
    pub fn record_change(&self, path: &Path) {
        let mut changes = self.changes.lock();
        if !changes.iter().any(|p| p == path) {
            changes.push(path.to_path_buf());
        }
    }

    // --- arguments -------------------------------------------------------------

    fn arg(&self, name: &str) -> Option<&Value> {
        self.args.get(name).filter(|v| !v.is_null())
    }

    pub fn str(&self, name: &str) -> IdeResult<String> {
        self.opt_str(name)?.ok_or_else(|| IdeError::invalid(format!("missing required argument `{name}`")))
    }

    pub fn opt_str(&self, name: &str) -> IdeResult<Option<String>> {
        match self.arg(name) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(v) => Err(IdeError::invalid(format!("`{name}` must be a string, not {v}"))),
        }
    }

    /// An integer argument; numbers sent as strings (`"20"`) are accepted too.
    pub fn opt_i64(&self, name: &str) -> IdeResult<Option<i64>> {
        match self.arg(name) {
            None => Ok(None),
            Some(Value::Number(n)) => n
                .as_i64()
                .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
                .map(Some)
                .ok_or_else(|| IdeError::invalid(format!("`{name}` must be an integer"))),
            Some(Value::String(s)) => {
                s.trim().parse().map(Some).map_err(|_| IdeError::invalid(format!("`{name}` must be an integer")))
            }
            Some(v) => Err(IdeError::invalid(format!("`{name}` must be an integer, not {v}"))),
        }
    }

    /// A positive integer, at most `max`; `default` when absent.
    pub fn count(&self, name: &str, default: usize, max: usize) -> IdeResult<usize> {
        match self.opt_i64(name)? {
            None => Ok(default),
            Some(n) if n < 1 => Err(IdeError::invalid(format!("`{name}` must be at least 1"))),
            Some(n) => Ok((n as usize).min(max)),
        }
    }

    /// A required 1-based position component (line / column).
    pub fn one_based(&self, name: &str) -> IdeResult<u32> {
        match self.opt_i64(name)? {
            None => Err(IdeError::invalid(format!("missing required argument `{name}`"))),
            Some(n) if n < 1 => Err(IdeError::invalid(format!("`{name}` is 1-based and must be at least 1"))),
            Some(n) => Ok(n as u32),
        }
    }

    pub fn opt_bool(&self, name: &str) -> IdeResult<Option<bool>> {
        match self.arg(name) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(Value::String(s)) if s == "true" || s == "false" => Ok(Some(s == "true")),
            Some(v) => Err(IdeError::invalid(format!("`{name}` must be a boolean, not {v}"))),
        }
    }

    pub fn flag(&self, name: &str, default: bool) -> IdeResult<bool> {
        Ok(self.opt_bool(name)?.unwrap_or(default))
    }

    /// A list of strings; a single string counts as a list of one.
    pub fn str_list(&self, name: &str) -> IdeResult<Vec<String>> {
        match self.arg(name) {
            None => Ok(Vec::new()),
            Some(Value::String(s)) => Ok(vec![s.clone()]),
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| match v {
                    Value::String(s) => Ok(s.clone()),
                    v => Err(IdeError::invalid(format!("`{name}` must hold strings, not {v}"))),
                })
                .collect(),
            Some(v) => Err(IdeError::invalid(format!("`{name}` must be a list of strings, not {v}"))),
        }
    }

    pub fn str_map(&self, name: &str) -> IdeResult<Vec<(String, String)>> {
        match self.arg(name) {
            None => Ok(Vec::new()),
            Some(Value::Object(map)) => map
                .iter()
                .map(|(k, v)| match v {
                    Value::String(s) => Ok((k.clone(), s.clone())),
                    Value::Number(_) | Value::Bool(_) => Ok((k.clone(), v.to_string())),
                    v => Err(IdeError::invalid(format!("`{name}.{k}` must be a string, not {v}"))),
                })
                .collect(),
            Some(v) => Err(IdeError::invalid(format!("`{name}` must be an object of strings, not {v}"))),
        }
    }

    // --- paths -----------------------------------------------------------------

    /// Resolves a project-relative or absolute path (`file://` URLs too) without
    /// requiring it to be inside the project.
    pub fn resolve(&self, path: &str) -> IdeResult<PathBuf> {
        crate::project::resolve(self.root(), path)
    }

    /// Resolves `path` and requires it to be inside the project (for changes).
    pub fn resolve_inside(&self, path: &str) -> IdeResult<PathBuf> {
        let resolved = self.resolve(path)?;
        crate::project::ensure_inside(self.root(), &resolved)?;
        Ok(resolved)
    }

    /// Resolves a path to read. Outside the project (and its content roots) the user is
    /// asked first unless brave mode is on: a client could otherwise read `~/.ssh` or
    /// credentials of other tools.
    pub async fn resolve_readable(&self, path: &str) -> IdeResult<PathBuf> {
        let resolved = self.resolve(path)?;
        let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let real = canon(&resolved);
        let inside = std::iter::once(self.root().to_path_buf())
            .chain(self.project().content_roots())
            .any(|root| real.starts_with(canon(&root)));
        if !inside {
            self.confirm(&format!("Read {}", resolved.display()), Some("This path is outside the project.".into()))
                .await?;
        }
        Ok(resolved)
    }

    /// How a path is shown to the client: project-relative inside the project, else absolute.
    pub fn display(&self, path: &Path) -> String {
        crate::project::display(self.root(), path)
    }

    // --- the UI ----------------------------------------------------------------

    /// Asks the user before running `subject` unless brave mode is on; errors when declined.
    /// A client that supports elicitation asks its user; otherwise (or when it cannot be
    /// reached) the IDE asks.
    pub async fn confirm(&self, subject: &str, detail: Option<String>) -> IdeResult<()> {
        if self.shared.config.read().brave_mode {
            return Ok(());
        }
        if let Some(allowed) = self.elicit_confirmation(subject, detail.as_deref()).await? {
            return if allowed {
                Ok(())
            } else {
                Err(IdeError::new(
                    ide_core::error::ErrorKind::PermissionDenied,
                    "The user declined this. Do not retry it; ask the user what to do instead.",
                ))
            };
        }
        let request = McpUiRequest::Confirm {
            client: self.client.clone(),
            tool: self.tool.into(),
            subject: subject.into(),
            detail,
        };
        let answer = tokio::select! {
            a = self.shared.ui.ask(self.window(), request) => a?,
            _ = self.cancel.cancelled() => return Err(IdeError::cancelled()),
        };
        if answer.as_bool() == Some(true) {
            Ok(())
        } else {
            Err(IdeError::new(
                ide_core::error::ErrorKind::PermissionDenied,
                "The user declined this in OpenIDEA. Do not retry it; ask the user what to do instead.",
            ))
        }
    }

    /// The client's answer to a confirmation, or `None` when it has no elicitation
    /// support or no stream reaches it.
    async fn elicit_confirmation(&self, subject: &str, detail: Option<&str>) -> IdeResult<Option<bool>> {
        let Some(session) = &self.session else { return Ok(None) };
        let protocol = {
            let client = session.client.read();
            if !client.elicitation {
                return Ok(None);
            }
            client.protocol.clone()
        };
        let message = crate::elicitation::confirm_message(&self.client, self.tool, subject, detail);
        let params = crate::elicitation::confirm_params(&protocol, message);
        let timeout = self.shared.timing.read().elicitation;
        match session.request(self.outbound.as_ref(), "elicitation/create", params, timeout, &self.cancel).await {
            Ok(result) => Ok(Some(crate::elicitation::allowed(&result))),
            Err(RequestError::NoChannel) => Ok(None),
            Err(RequestError::Rejected(e)) => {
                tracing::debug!("MCP elicitation rejected by {}: {e}", self.client);
                Ok(None)
            }
            Err(RequestError::Timeout) => {
                Err(IdeError::unavailable("Nobody answered the confirmation in time. Do not retry it; ask the user."))
            }
            Err(RequestError::Cancelled | RequestError::Closed) => Err(IdeError::cancelled()),
        }
    }

    /// Sends a request to this window's UI and waits for its answer.
    pub async fn ask(&self, request: McpUiRequest) -> IdeResult<Value> {
        tokio::select! {
            a = self.shared.ui.ask(self.window(), request) => a,
            _ = self.cancel.cancelled() => Err(IdeError::cancelled()),
        }
    }
}
