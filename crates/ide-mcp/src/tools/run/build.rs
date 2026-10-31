// Ported from JetBrains intellij-community plugins/mcp-server
// (mcpserver.toolsets/src/general/AnalysisToolset.kt, build_project), Apache-2.0.
//! `build_project`.

use super::output::{MAX_TEXT_LENGTH, TRUNCATED_MARKER, TruncateMode, truncate_text};
use crate::tool::{Call, Output, Param, ParamType, Tool};
use crate::tools::run::timeout;
use ide_build::compile::{BuildEvent, BuildKind, BuildMessage, BuildResult};
use ide_core::Severity;
use ide_core::mcp::McpToolKind;
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

const DEFAULT_TIMEOUT_MS: usize = 60_000;
const MAX_TIMEOUT_MS: usize = 3_600_000;
const MAX_PROBLEMS: usize = 300;
/// Console lines attached to a failure whose messages were not parsed.
const CONSOLE_LINES: usize = 200;

/// A JetBrains `ProjectProblem`: `kind` ERROR or WARNING, the compiler's code as `group`,
/// 1-based `line` / `column` (JetBrains reports them 0-based).
fn problem(call: &Call, m: &BuildMessage) -> Value {
    let mut v = json!({
        "message": m.text,
        "kind": if m.severity == Severity::Error { "ERROR" } else { "WARNING" },
    });
    if let Some(code) = &m.code {
        v["group"] = code.clone().into();
    }
    if let Some(path) = &m.path {
        v["file"] = call.display(path).into();
    }
    if let Some(range) = m.range {
        v["line"] = (range.start.line + 1).into();
        v["column"] = (range.start.col + 1).into();
    }
    v
}

/// Runs the build of `target` (the whole project when `None`), its console into `console`.
/// Returns `None` when `deadline` passed first (the build is then stopped).
pub async fn build_once(
    call: &Call,
    kind: BuildKind,
    target: Option<PathBuf>,
    deadline: Instant,
    console: &Arc<Mutex<String>>,
) -> IdeResult<Option<BuildResult>> {
    let host = call.host();
    let request = crate::tool::request_id();
    let sink = console.clone();
    let channel = ide_host::ops::Channel::new(move |e: BuildEvent| match e {
        BuildEvent::Output { text, .. } => sink.lock().push_str(&text),
        BuildEvent::Step { command, .. } => sink.lock().push_str(&format!("$ {command}\n")),
        _ => {}
    });
    let build = ide_host::ops::build::build_run(&host, call.window(), kind, target, request, Vec::new(), channel);
    tokio::pin!(build);
    let remaining = deadline.saturating_duration_since(Instant::now());
    tokio::select! {
        r = &mut build => r.map(Some),
        _ = tokio::time::sleep(remaining) => {
            host.cancel_request(request);
            let _ = build.await;
            Ok(None)
        }
        _ = call.cancel.cancelled() => {
            host.cancel_request(request);
            let _ = build.await;
            Err(IdeError::cancelled())
        }
    }
}

pub fn build_project() -> Tool {
    Tool::new(
        "build_project",
        McpToolKind::Execute,
        "Triggers building of the project or specified files, waits for completion, and returns build errors.
Use this tool to build the project or compile files and get detailed information about compilation errors and warnings.
You have to use this tool after performing edits to validate if the edits are valid.
In OpenIDEA the project's build system builds it (Maven, Gradle, Cargo, Go or TypeScript); with `filesToRebuild`, the \
modules containing those files. Asks the user first unless brave mode is on. Problems have the project-relative \
`file` and 1-based `line` / `column`. On timeout the build is stopped.",
        |call| async move {
            let files: Vec<String> =
                call.str_list("filesToRebuild")?.into_iter().filter(|f| !f.trim().is_empty()).collect();
            let rebuild = call.flag("rebuild", false)? && files.is_empty();
            let kind = if rebuild { BuildKind::Rebuild } else { BuildKind::Build };
            let limit = timeout(&call, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)?;
            let mut targets: Vec<Option<PathBuf>> = Vec::new();
            let mut dirs: Vec<PathBuf> = Vec::new();
            for f in &files {
                let path = call.resolve_inside(f)?;
                if !path.exists() {
                    return Err(IdeError::not_found(format!("File not found: {f}")));
                }
                let dir = if path.is_dir() { path.clone() } else { path.parent().unwrap_or(&path).to_path_buf() };
                if !dirs.contains(&dir) {
                    dirs.push(dir);
                    targets.push(Some(path));
                }
            }
            if targets.is_empty() {
                targets.push(None);
            }
            let subject = if rebuild { "Rebuild project" } else { "Build project" };
            let detail = targets.iter().flatten().map(|p| call.display(p)).collect::<Vec<_>>().join(", ");
            call.confirm(subject, (!detail.is_empty()).then(|| format!("modules of {detail}"))).await?;

            let console = Arc::new(Mutex::new(String::new()));
            let deadline = Instant::now() + limit;
            let mut results: Vec<BuildResult> = Vec::new();
            let mut timed_out = false;
            for target in targets {
                match build_once(&call, kind, target, deadline, &console).await? {
                    Some(r) => {
                        let failed = !r.success;
                        results.push(r);
                        if failed {
                            break;
                        }
                    }
                    None => {
                        timed_out = true;
                        break;
                    }
                }
            }
            let messages: Vec<&BuildMessage> = results
                .iter()
                .flat_map(|r| r.messages.iter())
                .filter(|m| matches!(m.severity, Severity::Error | Severity::Warning))
                .collect();
            let mut problems: Vec<Value> = messages.iter().take(MAX_PROBLEMS).map(|m| problem(&call, m)).collect();
            let failed = results.iter().any(|r| !r.success);
            if failed && !messages.iter().any(|m| m.severity == Severity::Error) {
                let tail = truncate_text(
                    console.lock().trim_end(),
                    CONSOLE_LINES,
                    MAX_TEXT_LENGTH,
                    TruncateMode::End,
                    TRUNCATED_MARKER,
                );
                problems.push(json!({
                    "message": "Build reported errors, but detailed error messages were not captured through build events.",
                    "kind": "ERROR",
                    "description": tail,
                }));
            }
            let mut result = Map::new();
            result.insert("isSuccess".into(), (!timed_out && !failed).into());
            result.insert("problems".into(), problems.into());
            if timed_out {
                result.insert("timedOut".into(), true.into());
            }
            Output::json(Value::Object(result))
        },
    )
    .param(Param::optional(
        "rebuild",
        ParamType::Boolean,
        "Whether to perform full rebuild the project. Defaults to false. Effective only when `filesToRebuild` is not \
specified.",
    ))
    .param(Param::optional(
        "filesToRebuild",
        ParamType::StringList,
        "If specified, only compile files with the specified paths. Paths are relative to the project root.",
    ))
    .param(Param::optional("timeout", ParamType::Integer, "Timeout in milliseconds"))
}
