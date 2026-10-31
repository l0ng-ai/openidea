// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/FormattingToolset.kt), Apache-2.0.
//! `reformat_file` and `optimize_imports` with the language servers: document
//! formatting and the `source.organizeImports` code action. Both answer with a
//! unified diff of what changed, or `ok`.
//!
//! JetBrains always has a formatter and an import optimizer; here a file whose
//! language server offers none is reported after the diff (the whole call fails
//! only when no file could be processed).

use super::diff::{ChangedFileText, MAX_DIFF_LINES, build_unified_diff};
use super::{edits_for, open_document, requested_files, whole_range};
use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::mcp::McpToolKind;
use ide_core::{DocId, IdeError, IdeResult};
use std::path::Path;

const ORGANIZE_IMPORTS: &str = "source.organizeImports";

pub(super) fn reformat_file() -> Tool {
    Tool::new(
        "reformat_file",
        McpToolKind::Edit,
        "Reformats the specified files in the IDE.
Use this tool to apply code formatting rules to files identified by their project-relative paths.
Returns a unified diff of the changes that the formatter applied, or \"ok\" when the files already match the code \
style.
The diff shows the formatter changes only. It never repeats the edit that you applied yourself.
The diff stops at 200 lines. A footer names the file(s) that it leaves out.
To remove unused imports without reformatting, use optimize_imports.",
        |call| async move {
            let organize = call.flag("optimizeImports", false)?;
            run(&call, Job { organize, format: true }).await
        },
    )
    .param(Param::required(
        "files",
        ParamType::StringList,
        "List of project-relative files to reformat. Duplicate paths are ignored after normalization.",
    ))
    .param(Param::optional(
        "optimizeImports",
        ParamType::Boolean,
        "If true, also remove unused imports and order the remaining ones before reformatting.",
    ))
}

pub(super) fn optimize_imports() -> Tool {
    Tool::new(
        "optimize_imports",
        McpToolKind::Edit,
        "Optimizes imports in the specified files in the IDE: removes unused imports and orders the remaining ones by \
the code style.
It never adds missing imports.
Returns a unified diff of the changes, or \"ok\" when nothing changed.
The diff stops at 200 lines. A footer names the file(s) that it leaves out.",
        |call| async move { run(&call, Job { organize: true, format: false }).await },
    )
    .param(Param::required(
        "files",
        ParamType::StringList,
        "List of project-relative files to optimize imports in. Duplicate paths are ignored after normalization.",
    ))
}

#[derive(Clone, Copy)]
struct Job {
    organize: bool,
    format: bool,
}

async fn run(call: &Call, job: Job) -> IdeResult<Output> {
    let files = requested_files(call)?;
    let mut changed = Vec::new();
    let mut problems = Vec::new();
    for (raw, path) in &files {
        match process(call, path, job).await {
            Ok(outcome) => {
                changed.push(ChangedFileText {
                    path: raw.clone(),
                    before: Some(outcome.before),
                    after: Some(outcome.after),
                });
                problems.extend(outcome.notes.into_iter().map(|n| format!("{raw}: {n}")));
            }
            Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => return Err(e),
            Err(e) => {
                let what = if job.format { "not formatted" } else { "imports not optimized" };
                problems.push(format!("{raw}: {what}: {}", e.message));
            }
        }
    }
    if changed.is_empty() {
        return Err(IdeError::unavailable(problems.join("\n")));
    }
    let mut out = build_unified_diff(&changed, MAX_DIFF_LINES).unwrap_or_else(|| "ok".into());
    if !problems.is_empty() {
        out.push_str("\n\n");
        out.push_str(&problems.join("\n"));
    }
    Ok(Output::text(out))
}

struct Outcome {
    before: String,
    after: String,
    /// What went wrong without failing the file (imports not optimized before a reformat).
    notes: Vec<String>,
}

/// Runs the job on one file's document (opened transiently when it is not open) and saves it.
async fn process(call: &Call, path: &Path, job: Job) -> IdeResult<Outcome> {
    let host = call.host();
    let project = call.project().clone();
    let (p, target) = (project.clone(), path.to_path_buf());
    let (doc, transient) = host.blocking(move || open_document(&p, &target)).await?;
    let result = async {
        let info = project.documents.snapshot(doc)?;
        if info.read_only {
            return Err(IdeError::invalid("the file is read-only"));
        }
        let before = project.documents.text_snapshot(doc)?.text;
        let mut notes = Vec::new();
        if job.organize {
            match organize_imports(call, doc, path).await {
                Ok(()) => {}
                Err(e) if job.format && e.kind != ide_core::error::ErrorKind::Cancelled => {
                    notes.push(format!("imports not optimized: {}", e.message));
                }
                Err(e) => return Err(e),
            }
        }
        if job.format {
            format(call, doc, &info).await?;
        }
        let p = project.clone();
        let after = host
            .blocking(move || {
                if p.documents.is_dirty(doc)? {
                    p.documents.save(doc)?;
                }
                Ok(p.documents.text_snapshot(doc)?.text)
            })
            .await?;
        Ok(Outcome { before, after, notes })
    }
    .await;
    if transient {
        project.documents.close(doc);
    }
    result
}

/// Formats the whole document with its language server; indentation from EditorConfig, else the settings.
async fn format(call: &Call, doc: DocId, info: &ide_workspace::DocumentInfo) -> IdeResult<()> {
    let host = call.host();
    let project = call.project().clone();
    let editor = project.settings.effective().editor;
    let ec = info.editorconfig.as_ref();
    let insert_spaces = match ec.and_then(|e| e.indent_style) {
        Some(style) => style != ide_workspace::editorconfig::IndentStyle::Tab,
        None => editor.insert_spaces,
    };
    let tab_size = ec.and_then(|e| e.indent_size.or(e.tab_width)).unwrap_or(editor.tab_size);
    let options = ide_lsp::types::FormatOptions { tab_size, insert_spaces };
    let version = project.documents.text_snapshot(doc)?.version;
    let edits = tokio::select! {
        r = ide_host::ops::lsp::lsp_format(&host, call.window(), doc, None, options) => r?,
        _ = call.cancel.cancelled() => return Err(IdeError::cancelled()),
    };
    host.blocking(move || {
        if project.documents.text_snapshot(doc)?.version != version {
            return Err(IdeError::unavailable("the file changed while it was being formatted; try again"));
        }
        project.documents.apply_edits(doc, &edits).map(|_| ())
    })
    .await
}

/// Runs the `source.organizeImports` code action of the document's language server.
/// Nothing offered: nothing to do, unless the server says it has no such action at all.
pub(super) async fn organize_imports(call: &Call, doc: DocId, path: &Path) -> IdeResult<()> {
    let host = call.host();
    let window = call.window();
    let text = call.project().documents.text_snapshot(doc)?.text;
    let request = crate::tool::request_id();
    let only = vec![ORGANIZE_IMPORTS.to_owned()];
    let query = tokio::select! {
        r = ide_host::ops::lsp::lsp_code_action_query(&host, window, request, doc, whole_range(&text), only) => r?,
        _ = call.cancel.cancelled() => {
            host.cancel_request(request);
            return Err(IdeError::cancelled());
        }
    };
    let organizes = |kind: &str| kind == ORGANIZE_IMPORTS || kind.starts_with("source.organizeImports.");
    let action = query
        .actions
        .into_iter()
        .filter(|a| a.disabled_reason.is_none() && a.kind.as_deref().is_some_and(organizes))
        .max_by_key(|a| a.is_preferred);
    let Some(action) = action else {
        let offered = query.advertised_kinds.is_none_or(|kinds| kinds.iter().any(|k| k == "source" || organizes(k)));
        return if offered {
            Ok(())
        } else {
            Err(IdeError::unavailable("the language server of this file offers no organize imports action"))
        };
    };
    let action = ide_host::ops::lsp::lsp_resolve_code_action(&host, window, doc, action).await?;
    match &action.edit {
        Some(edit) => {
            let edits = edits_for(edit, path);
            let project = call.project().clone();
            host.blocking(move || project.documents.apply_edits(doc, &edits).map(|_| ())).await
        }
        // The server applies the change itself (`workspace/applyEdit` during the command).
        None => ide_host::ops::lsp::lsp_apply_code_action(&host, window, doc, action).await,
    }
}
