// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/AnalysisToolset.kt, LintFilesAnalysisSupport.kt, LintFilesRequestSupport.kt), Apache-2.0.
//! `get_file_problems` and `lint_files`: the problems the editor shows.
//!
//! IntelliJ runs its highlighting passes and inspections; here the file's language
//! servers publish diagnostics (the file is opened and its first publish waited for),
//! and files no server serves, or whose server does not report in time, get tree-sitter
//! syntax errors. Severities map onto IntelliJ's names: LSP Error → `ERROR`,
//! Warning → `WARNING`, Information → `WEAK WARNING`, Hint → `INFORMATION`.

use super::{
    Docs, FileText, TIMED_OUT_DESCRIPTION, TIMEOUT_DESCRIPTION, Unloadable, blocking, load_text, resolve_existing_file,
    timeout_ms, truncate,
};
use crate::tool::{Call, Output, Param, ParamType, Tool};
use futures::StreamExt;
use ide_core::mcp::McpToolKind;
use ide_core::{CancellationToken, Diagnostic, IdeError, IdeResult, Severity};
use ide_host::Project;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

/// JetBrains' `Constants.MEDIUM_TIMEOUT_MILLISECONDS_VALUE`.
const GET_FILE_PROBLEMS_DEFAULT_TIMEOUT_MS: u64 = 10_000;
const LINT_FILES_DEFAULT_TIMEOUT_MS: u64 = 120_000;
const LINT_FILES_PER_FILE_TIMEOUT_MS: u64 = 20_000;
const LINT_FILES_TIMEOUT_HEADROOM_DIVISOR: u64 = 20;
const LINT_FILES_MIN_TIMEOUT_HEADROOM_MS: u64 = 50;
const LINT_FILES_MAX_TIMEOUT_HEADROOM_MS: u64 = 5_000;
/// Files whose language servers are waited for at the same time.
const LINT_CONCURRENCY: usize = 4;
/// Quiet period after a publish before a file's diagnostics count as complete.
const SETTLE: Duration = Duration::from_millis(400);
/// A minified file's line would flood the answer.
const LINE_TEXT_CHARS: usize = 1000;

const NOT_ANALYZED_EXCLUDED: &str = "File is outside project content roots or in an excluded directory";
const NOT_ANALYZED_UNSUPPORTED: &str = "File type is not recognized or not supported for analysis";
const NOT_ANALYZED_INVALID: &str = "File is not valid or has been deleted";
const NOT_ANALYZED_TOO_LARGE: &str = "File is too large to be analyzed";

/// `min_severity` (JetBrains' `LintMinSeverity`), as a rank of [`severity`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MinSeverity {
    /// Weak warnings and up.
    Warning,
    StrongWarning,
    Error,
}

impl MinSeverity {
    const VALUES: [(&'static str, Self); 3] =
        [("warning", Self::Warning), ("strong_warning", Self::StrongWarning), ("error", Self::Error)];

    fn parse(value: &str) -> IdeResult<Self> {
        let normalized = value.trim().to_lowercase();
        Self::VALUES.iter().find(|(v, _)| *v == normalized).map(|(_, s)| *s).ok_or_else(|| {
            let all: Vec<&str> = Self::VALUES.iter().map(|(v, _)| *v).collect();
            IdeError::invalid(format!("min_severity must be one of: {}", all.join(", ")))
        })
    }

    fn rank(self) -> u8 {
        match self {
            Self::Warning => 2,
            Self::StrongWarning => 3,
            Self::Error => 4,
        }
    }
}

/// IntelliJ's `HighlightSeverity` name and rank for an LSP severity.
fn severity(s: Severity) -> (&'static str, u8) {
    match s {
        Severity::Error => ("ERROR", 4),
        Severity::Warning => ("WARNING", 3),
        Severity::Info => ("WEAK WARNING", 2),
        Severity::Hint => ("INFORMATION", 1),
    }
}

/// JetBrains' `LintProblem`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LintProblem {
    severity: &'static str,
    /// The diagnostic's code (`E0308`, `no-unused-vars`), IntelliJ's inspection id.
    #[serde(skip_serializing_if = "Option::is_none")]
    inspection_id: Option<String>,
    description: String,
    line_text: String,
    line: u32,
    column: u32,
}

fn lint_problem(file: &FileText, d: Diagnostic) -> LintProblem {
    let line_text = file.line(d.range.start.line);
    LintProblem {
        severity: severity(d.severity).0,
        inspection_id: d.code.filter(|c| !c.is_empty()),
        description: d.message,
        line_text: truncate(line_text, LINE_TEXT_CHARS),
        line: d.range.start.line + 1,
        column: d.range.start.col + 1,
    }
}

/// What analysing one file gave.
enum FileOutcome {
    Analyzed { problems: Vec<LintProblem>, timed_out: bool, note: Option<String> },
    NotAnalyzed(&'static str),
}

/// Problems of `path` at `min` severity and up: language server diagnostics (waiting for
/// the first publish after opening it, until `deadline`), else tree-sitter syntax errors.
/// A server that misses `deadline` gives a timed-out outcome that still has the syntax errors.
async fn analyze(
    project: &Arc<Project>,
    path: &Path,
    min: MinSeverity,
    deadline: Instant,
    cancel: &CancellationToken,
) -> IdeResult<FileOutcome> {
    if Instant::now() >= deadline {
        return Ok(FileOutcome::Analyzed { problems: Vec::new(), timed_out: true, note: None });
    }
    let file = {
        let (project, path) = (project.clone(), path.to_path_buf());
        let loaded = blocking(move || {
            let rel = path.strip_prefix(&project.root).ok().map(|r| r.to_string_lossy().replace('\\', "/"));
            let excluded = rel.is_some_and(|rel| {
                project.roots().root_for(&rel).is_some_and(|r| r.kind == ide_workspace::RootKind::Excluded)
            });
            Ok((!excluded).then(|| load_text(&project, &path)))
        })
        .await?;
        match loaded {
            None => return Ok(FileOutcome::NotAnalyzed(NOT_ANALYZED_EXCLUDED)),
            Some(Err(Unloadable::Binary)) => return Ok(FileOutcome::NotAnalyzed(NOT_ANALYZED_UNSUPPORTED)),
            Some(Err(Unloadable::TooLarge)) => return Ok(FileOutcome::NotAnalyzed(NOT_ANALYZED_TOO_LARGE)),
            Some(Err(Unloadable::Unreadable)) => return Ok(FileOutcome::NotAnalyzed(NOT_ANALYZED_INVALID)),
            Some(Ok(file)) => file,
        }
    };
    let mut timed_out = false;
    let mut note = None;
    let mut items = None;
    if file.served {
        let docs = Docs::new(project.clone());
        let was_open = project.documents.by_path(path).is_some();
        let since = std::time::Instant::now();
        let remaining = deadline.saturating_duration_since(Instant::now());
        let opts = ide_lsp::InspectOptions { concurrency: 1, timeout: remaining, settle: SETTLE };
        let work = async {
            let doc = docs.open(path).await?;
            project.lsp.document_diagnostics(doc, (!was_open).then_some(since), opts, cancel).await
        };
        match tokio::time::timeout_at(deadline, work).await {
            Ok(Ok(Some(found))) => items = Some(found),
            Ok(Ok(None)) => {
                note = Some("No language server for this file became ready; only syntax errors are reported.".into())
            }
            Ok(Err(e)) if e.kind == ide_core::error::ErrorKind::Cancelled => return Err(e),
            Ok(Err(e)) => {
                note = Some(format!("The language server failed ({}); only syntax errors are reported.", e.message))
            }
            Err(_) => {
                timed_out = true;
                note = Some(
                    "The language server did not report in time (it may still be starting or indexing); only syntax \
errors are reported. Retry with a larger timeout."
                        .into(),
                );
            }
        }
    }
    let items = match items {
        Some(items) => items,
        None => {
            let (project, cancel) = (project.clone(), cancel.clone());
            let (language, text, large) = (file.language.clone(), file.text.clone(), file.large);
            let errors = blocking(move || {
                if large {
                    return Ok(None);
                }
                let snap = ide_syntax::Snapshot::text(&language, &text);
                match project.structure.syntax_errors(&snap, &cancel) {
                    Ok(e) => Ok(Some(e.errors)),
                    Err(ide_syntax::StructureError::Cancelled) => Err(IdeError::cancelled()),
                    Err(_) => Ok(None),
                }
            })
            .await?;
            match errors {
                Some(errors) => {
                    if note.is_none() && !file.served {
                        note = Some("No language server serves this file; only syntax errors are reported.".into());
                    }
                    errors
                        .into_iter()
                        .map(|e| Diagnostic {
                            range: e.range,
                            severity: Severity::Error,
                            message: e.message,
                            source: Some("syntax".into()),
                            code: None,
                            unnecessary: false,
                            deprecated: false,
                            server: None,
                        })
                        .collect()
                }
                None => {
                    if note.is_none() && !file.served {
                        note = Some(if file.large {
                            "The file is too large for syntax checks.".into()
                        } else {
                            "No language server or syntax checker supports this file type; it was not checked.".into()
                        });
                    }
                    Vec::new()
                }
            }
        }
    };
    let mut ranked: Vec<(u8, LintProblem)> = items
        .into_iter()
        .filter(|d| severity(d.severity).1 >= min.rank())
        .map(|d| (severity(d.severity).1, lint_problem(&file, d)))
        .collect();
    ranked.sort_by_key(|(rank, p)| (p.line, p.column, std::cmp::Reverse(*rank)));
    let problems = ranked.into_iter().map(|(_, p)| p).collect();
    Ok(FileOutcome::Analyzed { problems, timed_out, note })
}

pub(super) fn get_file_problems() -> Tool {
    Tool::new(
        "get_file_problems",
        McpToolKind::Read,
        "Analyzes the specified file for errors and warnings using its language servers' diagnostics (the problems \
the editor shows).
Use this tool to identify coding issues, syntax errors, and other problems in a specific file.
Returns a list of problems found in the file, including severity, description, and location information.
Without a language server for the file (or when it does not report in time) only tree-sitter syntax errors are \
reported, and `note` says so.
Note: Only analyzes files within the project directory.
Note: Lines and Columns are 1-based.",
        |call| async move {
            let requested = call.str("filePath")?;
            let path = resolve_existing_file(&call, requested.trim())?;
            let min = if call.flag("errorsOnly", true)? { MinSeverity::Error } else { MinSeverity::Warning };
            let deadline =
                Instant::now() + Duration::from_millis(timeout_ms(&call, GET_FILE_PROBLEMS_DEFAULT_TIMEOUT_MS)?);
            let project = call.project().clone();
            let (problems, timed_out, note) = match analyze(&project, &path, min, deadline, &call.cancel).await? {
                FileOutcome::NotAnalyzed(reason) => {
                    return Err(IdeError::invalid(format!("File cannot be analyzed: {reason}")));
                }
                FileOutcome::Analyzed { problems, timed_out, note } => (problems, timed_out, note),
            };
            let errors: Vec<Value> = problems
                .into_iter()
                .map(|p| {
                    json!({
                        "severity": p.severity,
                        "description": p.description,
                        "lineContent": p.line_text,
                        "line": p.line,
                        "column": p.column,
                    })
                })
                .collect();
            let mut out = json!({ "filePath": call.display(&path), "errors": errors });
            if timed_out {
                out["timedOut"] = true.into();
            }
            if let Some(note) = note {
                out["note"] = note.into();
            }
            Output::json(out)
        },
    )
    .param(Param::required("filePath", ParamType::String, super::RELATIVE_PATH_DESCRIPTION))
    .param(Param::optional(
        "errorsOnly",
        ParamType::Boolean,
        "Whether to include only errors or include both errors and warnings",
    ))
    .param(Param::optional("timeout", ParamType::Integer, TIMEOUT_DESCRIPTION))
    .output(json!({
        "type": "object",
        "properties": {
            "filePath": { "type": "string" },
            "errors": { "type": "array", "items": {
                "type": "object",
                "properties": {
                    "severity": { "type": "string" },
                    "description": { "type": "string" },
                    "lineContent": { "type": "string" },
                    "line": { "type": "integer" },
                    "column": { "type": "integer" },
                },
                "required": ["severity", "description", "lineContent", "line", "column"],
            } },
            "timedOut": { "type": "boolean", "description": TIMED_OUT_DESCRIPTION },
            "note": { "type": "string", "description": "Why only syntax errors (or nothing) could be checked" },
        },
        "required": ["filePath", "errors"],
    }))
}

/// JetBrains' `createLintFilesBatchTimeouts`: at `deadline` unfinished files are reported
/// as timed out; `analysis` (half a headroom later) cancels the run, the other half is
/// for the response.
struct BatchTimeouts {
    deadline: Instant,
    analysis: Instant,
}

fn batch_timeouts(timeout_ms: u64, now: Instant) -> BatchTimeouts {
    let headroom = (timeout_ms / LINT_FILES_TIMEOUT_HEADROOM_DIVISOR)
        .clamp(LINT_FILES_MIN_TIMEOUT_HEADROOM_MS, LINT_FILES_MAX_TIMEOUT_HEADROOM_MS);
    BatchTimeouts {
        deadline: now + Duration::from_millis(timeout_ms.saturating_sub(headroom)),
        analysis: now + Duration::from_millis(timeout_ms.saturating_sub(headroom / 2)),
    }
}

/// A file to lint: its normalized project-relative path and where it is.
struct RequestedFile {
    rel: String,
    path: PathBuf,
}

/// JetBrains' `prepareRequestedLintFiles`: every path must be an existing project file;
/// duplicates (after normalization) are dropped, the first one's place kept.
fn prepare_requested(call: &Call, files: &[String]) -> IdeResult<Vec<RequestedFile>> {
    if files.is_empty() {
        return Err(IdeError::invalid("files must contain at least one path"));
    }
    let mut out: Vec<RequestedFile> = Vec::new();
    for raw in files {
        let requested = raw.trim();
        if requested.is_empty() {
            return Err(IdeError::invalid("files must not contain blank paths"));
        }
        let path = resolve_existing_file(call, requested)?;
        let rel = call.display(&path);
        if !out.iter().any(|f| f.rel == rel) {
            out.push(RequestedFile { rel, path });
        }
    }
    Ok(out)
}

/// JetBrains' `LintFileResult`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LintFileResult {
    file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    not_analyzed_reason: Option<&'static str>,
    problems: Vec<LintProblem>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    timed_out: bool,
}

pub(super) fn lint_files() -> Tool {
    Tool::new(
        "lint_files",
        McpToolKind::Read,
        "Analyzes the specified files for errors and warnings using their language servers' diagnostics (the \
problems the editor shows; files without a language server get tree-sitter syntax errors).
Use this tool to lint several files after editing them.
Returns per-file problems with severity, description, and location information.
Only files with problems, timed-out files and files that could not be analyzed are listed, in request order.
Batch responses may include file entries with `timedOut: true` when individual files exceed the available budget; their \
`problems` then hold only syntax errors, if any.
File entries with a `notAnalyzedReason` indicate files that could not be analyzed (e.g., outside project content roots, \
excluded, or unsupported file type).
Top-level `more: true` means the batch is incomplete.
`min_severity` must be `warning`, `strong_warning`, or `error`; defaults to `warning`.
Note: Only analyzes files within the project directory.
Note: Lines and Columns are 1-based.",
        |call| async move {
            let files = call.str_list("files")?;
            let min = MinSeverity::parse(call.opt_str("min_severity")?.as_deref().unwrap_or("warning"))?;
            let timeout = timeout_ms(&call, LINT_FILES_DEFAULT_TIMEOUT_MS)?;
            let requested = prepare_requested(&call, &files)?;
            let timeouts = batch_timeouts(timeout, Instant::now());
            let project = call.project().clone();
            // Filled as files finish: what is in when the run is cut off still goes out.
            let results: Mutex<Vec<Option<LintFileResult>>> =
                Mutex::new(requested.iter().map(|_| None).collect());
            let (results_ref, project_ref, cancel) = (&results, &project, &call.cancel);
            let jobs: Vec<(usize, String, PathBuf)> =
                requested.iter().enumerate().map(|(i, f)| (i, f.rel.clone(), f.path.clone())).collect();
            let run = futures::stream::iter(jobs)
                .map(|(i, rel, path)| async move {
                    let file_deadline = timeouts
                        .deadline
                        .min(Instant::now() + Duration::from_millis(LINT_FILES_PER_FILE_TIMEOUT_MS));
                    let outcome = analyze(project_ref, &path, min, file_deadline, cancel).await?;
                    let result = match outcome {
                        FileOutcome::NotAnalyzed(reason) => LintFileResult {
                            file_path: rel,
                            not_analyzed_reason: Some(reason),
                            problems: Vec::new(),
                            timed_out: false,
                        },
                        FileOutcome::Analyzed { problems, timed_out, .. } => LintFileResult {
                            file_path: rel,
                            not_analyzed_reason: None,
                            problems,
                            timed_out,
                        },
                    };
                    results_ref.lock()[i] = Some(result);
                    Ok::<_, IdeError>(())
                })
                .buffer_unordered(LINT_CONCURRENCY)
                .collect::<Vec<_>>();
            // `timeout_at` polls once even when the time is already up; JetBrains' `withTimeoutOrNull` does not.
            let completed_in_time = if Instant::now() < timeouts.analysis {
                match tokio::time::timeout_at(timeouts.analysis, run).await {
                    Ok(done) => {
                        for r in done {
                            r?;
                        }
                        true
                    }
                    Err(_) => false,
                }
            } else {
                drop(run);
                false
            };
            if call.cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let results = results.into_inner();
            let completed = results.iter().filter(|r| r.is_some()).count();
            let items: Vec<LintFileResult> = results
                .into_iter()
                .flatten()
                .filter(|r| !r.problems.is_empty() || r.timed_out || r.not_analyzed_reason.is_some())
                .collect();
            let mut out = json!({ "items": items });
            if !completed_in_time || completed < requested.len() {
                out["more"] = true.into();
            }
            Output::json(out)
        },
    )
    .param(Param::required(
        "files",
        ParamType::StringList,
        "List of project-relative files to analyze. Duplicate paths are ignored after normalization.",
    ))
    .param(Param::optional(
        "min_severity",
        ParamType::String,
        "Minimum severity to include: `warning` (includes weak warnings), `strong_warning`, or `error`. Defaults to \
`warning`.",
    ))
    .param(Param::optional("timeout", ParamType::Integer, TIMEOUT_DESCRIPTION))
    .output(json!({
        "type": "object",
        "properties": {
            "items": { "type": "array", "items": {
                "type": "object",
                "properties": {
                    "filePath": { "type": "string" },
                    "notAnalyzedReason": { "type": "string" },
                    "problems": { "type": "array", "items": {
                        "type": "object",
                        "properties": {
                            "severity": { "type": "string" },
                            "inspectionId": { "type": "string" },
                            "description": { "type": "string" },
                            "lineText": { "type": "string" },
                            "line": { "type": "integer" },
                            "column": { "type": "integer" },
                        },
                        "required": ["severity", "description", "lineText", "line", "column"],
                    } },
                    "timedOut": { "type": "boolean", "description": TIMED_OUT_DESCRIPTION },
                },
                "required": ["filePath", "problems"],
            } },
            "more": { "type": "boolean" },
        },
        "required": ["items"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_clamped_headroom() {
        let now = Instant::now();
        // JetBrains' `createLintFilesBatchTimeouts_reserves_clamped_headroom`.
        let short = batch_timeouts(100, now);
        assert_eq!(short.analysis - now, Duration::from_millis(75));
        assert_eq!(short.deadline - now, Duration::from_millis(50));
        let long = batch_timeouts(200_000, now);
        assert_eq!(long.analysis - now, Duration::from_millis(197_500));
        assert_eq!(long.deadline - now, Duration::from_millis(195_000));
        let zero = batch_timeouts(0, now);
        assert_eq!((zero.analysis, zero.deadline), (now, now));
    }

    #[test]
    fn parses_min_severity() {
        assert_eq!(MinSeverity::parse(" Strong_Warning ").unwrap(), MinSeverity::StrongWarning);
        assert_eq!(MinSeverity::parse("error").unwrap(), MinSeverity::Error);
        let e = MinSeverity::parse("hint").unwrap_err();
        assert_eq!(e.message, "min_severity must be one of: warning, strong_warning, error");
        // `warning` includes weak warnings (LSP information), not hints.
        assert!(severity(Severity::Info).1 >= MinSeverity::Warning.rank());
        assert!(severity(Severity::Hint).1 < MinSeverity::Warning.rank());
        assert!(severity(Severity::Info).1 < MinSeverity::StrongWarning.rank());
    }
}
