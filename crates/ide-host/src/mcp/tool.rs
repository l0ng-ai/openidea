use crate::{Host, Project};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct Call {
    pub host: Arc<Host>,
    pub project: Arc<Project>,
    pub window: String,
    pub args: Value,
    pub cancel: CancellationToken,
}

impl Call {
    pub fn host(&self) -> Arc<Host> {
        self.host.clone()
    }
    pub fn project(&self) -> &Arc<Project> {
        &self.project
    }
    pub fn root(&self) -> &Path {
        &self.project.root
    }
    pub fn window(&self) -> &str {
        &self.window
    }
    pub fn str(&self, name: &str) -> IdeResult<String> {
        self.args
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| IdeError::invalid(format!("missing or invalid argument `{name}`")))
    }
    pub fn opt_i64(&self, name: &str) -> IdeResult<Option<i64>> {
        self.args
            .get(name)
            .map(|v| v.as_i64().ok_or_else(|| IdeError::invalid(format!("{name} must be an integer"))))
            .transpose()
    }
    pub fn flag(&self, name: &str, default: bool) -> IdeResult<bool> {
        self.args
            .get(name)
            .map(|v| v.as_bool().ok_or_else(|| IdeError::invalid(format!("{name} must be a boolean"))))
            .unwrap_or(Ok(default))
    }
    pub fn str_list(&self, name: &str) -> IdeResult<Vec<String>> {
        match self.args.get(name) {
            None => Ok(Vec::new()),
            Some(Value::Array(values)) => values
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| IdeError::invalid(format!("{name} must contain strings")))
                })
                .collect(),
            _ => Err(IdeError::invalid(format!("{name} must be an array"))),
        }
    }
    pub fn display(&self, path: &Path) -> String {
        path.strip_prefix(self.root()).unwrap_or(path).to_string_lossy().replace('\\', "/")
    }
    pub async fn resolve_readable(&self, path: &str) -> IdeResult<PathBuf> {
        let root = self.root().to_path_buf();
        let mut roots = self.project.content_roots();
        roots.extend(self.host.mcp_reports.libraries(&self.host.mcp_windows(self.root())));
        roots.extend(
            self.project
                .settings
                .effective()
                .project_structure
                .libraries
                .iter()
                .flat_map(|l| l.sources.iter().chain(&l.classes).chain(&l.javadocs))
                .map(|p| self.root().join(p)),
        );
        let path = path.to_owned();
        self.host
            .blocking(move || {
                let path = if path.starts_with("file://") {
                    ide_lsp::uri_to_path(&path).ok_or_else(|| IdeError::invalid("invalid file URL"))?
                } else {
                    PathBuf::from(path)
                };
                let path = if path.is_absolute() { path } else { root.join(path) };
                let (local, entry) =
                    ide_vfs::split_archive_path(&path).map_or((path.clone(), None), |(p, e)| (p, Some(e)));
                let real = if let Ok(real) = dunce::canonicalize(&local) {
                    real
                } else {
                    let parent =
                        local.ancestors().find(|p| p.exists()).ok_or_else(|| IdeError::not_found("path not found"))?;
                    normalize(
                        &dunce::canonicalize(parent)?
                            .join(local.strip_prefix(parent).map_err(|e| IdeError::invalid(e.to_string()))?),
                    )
                };
                if !std::iter::once(root).chain(roots).any(|r| {
                    let r = ide_vfs::split_archive_path(&r).map_or(r.clone(), |(archive, _)| archive);
                    dunce::canonicalize(r).is_ok_and(|r| real.starts_with(r))
                }) {
                    return Err(IdeError::invalid("path is outside the project's content roots"));
                }
                Ok(entry.map_or_else(|| real.clone(), |entry| PathBuf::from(format!("{}!/{entry}", real.display()))))
            })
            .await
    }
}

pub struct Output(pub String);
impl Output {
    pub fn text(text: impl Into<String>) -> Self {
        Self(text.into())
    }
    pub fn json(value: impl Serialize) -> IdeResult<Self> {
        serde_json::to_string(&value).map(Self).map_err(|e| IdeError::internal(e.to_string()))
    }
}

#[derive(Clone, Copy)]
pub enum ParamType {
    String,
    Integer,
    Boolean,
    StringList,
}
pub struct Param {
    name: &'static str,
    kind: ParamType,
    description: &'static str,
    required: bool,
}
impl Param {
    pub fn required(name: &'static str, kind: ParamType, description: &'static str) -> Self {
        Self { name, kind, description, required: true }
    }
    pub fn optional(name: &'static str, kind: ParamType, description: &'static str) -> Self {
        Self { name, kind, description, required: false }
    }
}

type Handler = Arc<dyn Fn(Call) -> futures::future::BoxFuture<'static, IdeResult<Output>> + Send + Sync>;
pub struct Tool {
    pub metadata: ide_mcp::Tool,
    pub handler: Handler,
}
impl Tool {
    pub fn new<F, Fut>(name: &str, description: &str, handler: F) -> Self
    where
        F: Fn(Call) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = IdeResult<Output>> + Send + 'static,
    {
        Self {
            metadata: ide_mcp::Tool {
                name: name.into(),
                description: description.into(),
                read_only: true,
                destructive: false,
                output_schema: None,
                input_schema: json!({ "type": "object", "properties": {
                    "projectPath": { "type": "string", "description": "Any directory inside an open project. Optional when only one project is open." }
                }, "required": [] }),
            },
            handler: Arc::new(move |call| Box::pin(handler(call))),
        }
    }
    pub fn param(mut self, param: Param) -> Self {
        let mut schema = match param.kind {
            ParamType::String => json!({"type":"string"}),
            ParamType::Integer => json!({"type":"integer"}),
            ParamType::Boolean => json!({"type":"boolean"}),
            ParamType::StringList => json!({"type":"array","items":{"type":"string"}}),
        };
        schema["description"] = param.description.into();
        self.metadata.input_schema["properties"][param.name] = schema;
        if param.required {
            self.metadata.input_schema["required"].as_array_mut().unwrap().push(param.name.into());
        }
        self
    }
    pub fn output(mut self, schema: Value) -> Self {
        self.metadata.output_schema = Some(schema);
        self
    }
}

pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            p => out.push(p.as_os_str()),
        }
    }
    out
}

pub fn request_id() -> ide_core::RequestId {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0x8000_0000);
    ide_core::RequestId(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}
