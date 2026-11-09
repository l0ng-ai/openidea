use super::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::{Diagnostic, IdeResult, Severity};
use serde_json::{Value, json};

pub fn tools() -> Vec<Tool> {
    vec![
        Tool::new(
            "get_all_open_file_paths",
            "Returns active editor's and other open editors' file paths relative to the project root.

Use this tool to explore current open editors.",
            open_editors,
        ),
        Tool::new(
            "get_current_file",
            "Returns the focused editor's file and selection reported by the IDE.
Selection lines and UTF-16 columns are 1-based, end exclusive.
Selected text is limited to 65536 UTF-16 units.",
            current_file,
        ),
        Tool::new(
            "get_file_problems",
            "Returns the problems for a file as reported by the IDE's Problems view, including language servers
and inspections after profile filtering. This reflects what the Problems view shows, rather than a fresh analysis.
Lines and UTF-16 columns are 1-based.",
            file_problems,
        )
        .param(Param::required("filePath", ParamType::String, "Path relative to the project root"))
        .param(Param::optional(
            "errorsOnly",
            ParamType::Boolean,
            "Whether to include only errors or include both errors and warnings",
        )),
        Tool::new(
            "get_project_problems",
            "Returns the project's problems as reported by the IDE's Problems view, including language servers
and inspections after profile filtering. This reflects what the Problems view shows, rather than a fresh analysis.
Lines and UTF-16 columns are 1-based.",
            project_problems,
        ),
    ]
}

async fn open_editors(call: Call) -> IdeResult<Output> {
    let windows = call.host.mcp_windows(call.root());
    let open = call.host.mcp_reports.editors(&windows);
    let active = call.host.mcp_reports.focused(call.window());
    Output::json(json!({
        "activeFilePath": active.map(|e| call.display(&e.path.0)),
        "openFiles": open.iter().map(|p| call.display(p)).collect::<Vec<_>>(),
    }))
}

async fn current_file(call: Call) -> IdeResult<Output> {
    let editor = call.host.mcp_reports.focused(call.window());
    Output::json(match editor {
        None => json!({}),
        Some(e) => json!({
            "filePath": call.display(&e.path.0), "selectedText": e.selected_text,
            "selection": {
                "startLine": e.selection.start.line + 1, "startColumn": e.selection.start.col + 1,
                "endLine": e.selection.end.line + 1, "endColumn": e.selection.end.col + 1,
            },
        }),
    })
}

fn problem(d: Diagnostic, text: &str) -> Value {
    json!({
        "severity": d.severity, "description": d.message,
        "lineContent": text.lines().nth(d.range.start.line as usize).unwrap_or_default(),
        "line": d.range.start.line + 1, "column": d.range.start.col + 1, "source": d.source, "code": d.code,
    })
}

async fn file_problems(call: Call) -> IdeResult<Output> {
    let path = call.resolve_readable(&call.str("filePath")?).await?;
    let errors_only = call.flag("errorsOnly", true)?;
    let files = call.host.mcp_reports.problems(&call.host.mcp_windows(call.root()));
    let (project, file) = (call.project.clone(), path.clone());
    let text = call.host.blocking(move || project.text_of(&file)).await.unwrap_or_default();
    let errors: Vec<_> = files
        .into_iter()
        .filter(|f| f.path.0 == path)
        .flat_map(|f| f.items)
        .filter(|d| !errors_only || d.severity == Severity::Error)
        .map(|d| problem(d, &text))
        .collect();
    Output::json(json!({"filePath": call.display(&path), "errors": errors}))
}

async fn project_problems(call: Call) -> IdeResult<Output> {
    let files = call.host.mcp_reports.problems(&call.host.mcp_windows(call.root()));
    let files: Vec<_> = files.into_iter().map(|f| json!({
        "filePath":call.display(&f.path.0), "problems": f.items.into_iter().map(|d| problem(d, "")).collect::<Vec<_>>()
    })).collect();
    Output::json(json!({"files":files}))
}
