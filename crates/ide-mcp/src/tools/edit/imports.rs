// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/ImportsToolset.kt, src/com/intellij/mcpserver/imports/McpMissingImportProvider.kt), Apache-2.0.
//! `add_missing_imports` with the language servers. JetBrains asks a per-language
//! provider (Java, Kotlin) for the unresolved names and their candidates; here the
//! names are the error diagnostics of the file's language server, and the
//! candidates are the import quick fixes it offers for them. All fixes are
//! computed against one text and merged, so `diff` mode writes nothing.

use super::diff::{ChangedFileText, MAX_DIFF_LINES, build_unified_diff};
use super::format::organize_imports;
use super::{apply_text_edits, edits_for, open_document, requested_files};
use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::error::ErrorKind;
use ide_core::mcp::McpToolKind;
use ide_core::{DocId, IdeError, IdeResult, Severity, TextEdit};
use ide_lsp::types::CodeAction;
use serde::Serialize;
use std::path::Path;
use std::time::Duration;
use tokio::time::Instant;

const MODE_DIFF: &str = "diff";
const MODE_APPLY: &str = "apply";
const AMBIGUITY_REPORT: &str = "report";
const AMBIGUITY_BEST: &str = "best";
const REASON_SYMBOL_NOT_FOUND: &str = "symbol_not_found";
const REASON_FIX_NOT_APPLIED: &str = "fix_not_applied";
const DEFAULT_TIMEOUT_MS: usize = 60_000;
const MAX_TIMEOUT_MS: usize = 600_000;
/// Quiet period after a publish before a file's diagnostics count as complete.
const SETTLE: Duration = Duration::from_millis(400);

pub(super) fn add_missing_imports() -> Tool {
    Tool::new(
        "add_missing_imports",
        McpToolKind::Edit,
        "Adds the imports that the specified files are missing, with the import quick fixes of their language servers.
Write the code first and leave the imports out, then call this tool. It takes the names that the language server \
reports as unresolved, and imports each one with the fix the editor would offer for it.
`mode` defaults to `apply`: the tool writes the files and saves them, so read such a file again before you edit it. \
`mode: diff` only previews the change and writes nothing.
`ambiguity` defaults to `report`: a name with several candidates goes to `ambiguous` and gets no import, so pick a \
candidate by the context of your task. `ambiguity: best` takes the preferred (else the first) candidate of the \
language server.
`optimize` defaults to false, so every name gets its own import. `optimize: true` then runs the organize imports \
action of the language server, which also removes the unused imports and sorts the rest. Ask for it only when you \
want the file to match the style of the project.
`diff` shows every import that the file gained. A name that the file already resolves is in no list.
`unresolved` holds a name that the tool did not import. `symbol_not_found` means that the language server offers no \
import for the name, so check that you did not invent it, or that the module has the dependency. `fix_not_applied` \
means the import fix could not be applied, so add that one import yourself.
A file entry with a `notAnalyzedReason` was skipped. Lines are 1-based: in `diff` mode they point at the file on the \
disk, in `apply` mode at the file after the write.
The diff stops after 200 lines and says how much it left out. `timedOut: true` means that the remaining files are \
missing from `items`.",
        |call| async move { run(&call).await },
    )
    .param(Param::required(
        "files",
        ParamType::StringList,
        "Path relative to the project root. Duplicate paths are ignored after normalization.",
    ))
    .param(Param::optional(
        "mode",
        ParamType::Enum(&[MODE_APPLY, MODE_DIFF]),
        "`apply` (default) writes the files and saves them. `diff` returns the change and writes nothing.",
    ))
    .param(Param::optional(
        "ambiguity",
        ParamType::Enum(&[AMBIGUITY_REPORT, AMBIGUITY_BEST]),
        "`report` (default) reports a name with several candidates and imports nothing for it. `best` imports the \
preferred (else the first) candidate of the language server.",
    ))
    .param(Param::optional(
        "optimize",
        ParamType::Boolean,
        "Whether to run organize imports of the language server after the imports are added (default: false). It \
removes the unused imports and sorts the rest.",
    ))
    .param(Param::optional("timeout", ParamType::Integer, "Timeout in milliseconds (default: 60000)"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportsResult {
    items: Vec<FileResult>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    partial_result_reason: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct FileResult {
    file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    not_analyzed_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diff: Option<String>,
    applied: bool,
    ambiguous: Vec<Ambiguous>,
    unresolved: Vec<Unresolved>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ambiguous {
    short_name: String,
    line: u32,
    line_text: String,
    candidates: Vec<Candidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    fq_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Unresolved {
    short_name: String,
    line: u32,
    reason: &'static str,
}

#[derive(Clone, Copy)]
struct Options {
    apply: bool,
    take_best: bool,
    optimize: bool,
}

async fn run(call: &Call) -> IdeResult<Output> {
    let mode = call.opt_str("mode")?.unwrap_or_else(|| MODE_APPLY.into());
    let apply = match mode.as_str() {
        MODE_DIFF => false,
        MODE_APPLY => true,
        _ => return Err(IdeError::invalid(format!("mode must be `{MODE_DIFF}` or `{MODE_APPLY}`, got `{mode}`"))),
    };
    let ambiguity = call.opt_str("ambiguity")?.unwrap_or_else(|| AMBIGUITY_REPORT.into());
    let take_best = match ambiguity.as_str() {
        AMBIGUITY_REPORT => false,
        AMBIGUITY_BEST => true,
        _ => {
            return Err(IdeError::invalid(format!(
                "ambiguity must be `{AMBIGUITY_REPORT}` or `{AMBIGUITY_BEST}`, got `{ambiguity}`"
            )));
        }
    };
    let opts = Options { apply, take_best, optimize: call.flag("optimize", false)? };
    let timeout = call.count("timeout", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)?;
    let deadline = Instant::now() + Duration::from_millis(timeout as u64);
    let files = requested_files(call).await?;
    let mut result = ImportsResult { items: Vec::new(), timed_out: false, partial_result_reason: None };
    for (raw, path) in files {
        // Only the analysis runs under the timeout: once the new text goes into the
        // document, the write runs to its save, so a timeout never leaves a half-done file.
        let analysis = match tokio::time::timeout_at(deadline, analyze(call, &raw, &path, opts, deadline)).await {
            Ok(Ok(Analysis::Skipped(item))) => {
                result.items.push(item);
                continue;
            }
            Ok(Ok(Analysis::Found(found))) => found,
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                result.timed_out = true;
                break;
            }
        };
        let (item, note) = write(call, &raw, &path, opts, *analysis).await?;
        result.items.push(item);
        if let Some(note) = note {
            result.partial_result_reason.get_or_insert(note);
        }
    }
    Output::json(result)
}

/// Closes a transient document on every path out, a timeout included.
struct Close(std::sync::Arc<ide_host::Project>, Option<DocId>);

impl Drop for Close {
    fn drop(&mut self) {
        if let Some(doc) = self.1 {
            self.0.documents.close(doc);
        }
    }
}

enum Analysis {
    /// The file was not analyzed.
    Skipped(FileResult),
    Found(Box<Found>),
}

/// What the analysis of one file found: the merged import edits and what it could not import.
struct Found {
    doc: DocId,
    transient: bool,
    _close: Close,
    read_only: bool,
    text: String,
    version: u32,
    accepted: Vec<TextEdit>,
    ambiguous: Vec<Ambiguous>,
    unresolved: Vec<Unresolved>,
}

/// One file's unresolved names and the import fixes for them; changes nothing.
async fn analyze(call: &Call, raw: &str, path: &Path, opts: Options, deadline: Instant) -> IdeResult<Analysis> {
    let host = call.host();
    let project = call.project().clone();
    let was_open = project.documents.by_path(path).is_some();
    let since = std::time::Instant::now();
    let (p, target) = (project.clone(), path.to_path_buf());
    let (doc, transient) = host.blocking(move || open_document(&p, &target)).await?;
    let close = Close(project.clone(), transient.then_some(doc));
    let skipped = |reason: String| FileResult {
        file_path: raw.into(),
        not_analyzed_reason: Some(reason),
        ..FileResult::default()
    };

    let remaining = deadline.saturating_duration_since(Instant::now());
    let inspect = ide_lsp::InspectOptions { concurrency: 1, timeout: remaining, settle: SETTLE };
    let diagnostics =
        match project.lsp.document_diagnostics(doc, (!was_open).then_some(since), inspect, &call.cancel).await {
            Ok(Some(d)) => d,
            Ok(None) => {
                let reason = "No language server for this file became ready, so the tool cannot find the missing \
imports.";
                return Ok(Analysis::Skipped(skipped(reason.into())));
            }
            Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
            Err(e) => return Ok(Analysis::Skipped(skipped(format!("The language server failed: {}", e.message)))),
        };
    let read_only = project.documents.snapshot(doc)?.read_only;
    let snap = project.documents.text_snapshot(doc)?;
    let text = snap.text;
    let lines: Vec<&str> = text.split('\n').collect();

    let names = unresolved_names(diagnostics, &lines);

    let mut ambiguous = Vec::new();
    let mut unresolved = Vec::new();
    let mut accepted: Vec<TextEdit> = Vec::new();
    for (name, range, message) in names {
        let line = range.start.line + 1;
        let actions = ide_host::ops::lsp::lsp_code_actions(&host, call.window(), doc, range, vec!["quickfix".into()])
            .await
            .unwrap_or_default();
        let mut fixes: Vec<CodeAction> = Vec::new();
        for a in actions {
            if a.disabled_reason.is_none() && is_import_fix(&a.title) && !fixes.iter().any(|f| f.title == a.title) {
                fixes.push(a);
            }
        }
        let fix = match fixes.len() {
            0 => {
                if looks_unresolved(&message) {
                    unresolved.push(Unresolved { short_name: name, line, reason: REASON_SYMBOL_NOT_FOUND });
                }
                continue;
            }
            1 => fixes.remove(0),
            _ if opts.take_best => {
                let best = fixes.iter().position(|f| f.is_preferred).unwrap_or(0);
                fixes.remove(best)
            }
            _ => {
                let line_text = lines.get(range.start.line as usize).map_or("", |l| l.trim()).to_owned();
                let candidates = fixes.iter().map(|f| Candidate { fq_name: candidate_name(&f.title) }).collect();
                ambiguous.push(Ambiguous { short_name: name, line, line_text, candidates });
                continue;
            }
        };
        let edits = match ide_host::ops::lsp::lsp_resolve_code_action(&host, call.window(), doc, fix).await {
            Ok(a) => a.edit.map(|e| edits_for(&e, path)).unwrap_or_default(),
            Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
            Err(_) => Vec::new(),
        };
        if !merge_fix(&text, &mut accepted, edits) {
            unresolved.push(Unresolved { short_name: name, line, reason: REASON_FIX_NOT_APPLIED });
        }
    }
    let found = Found {
        doc,
        transient,
        _close: close,
        read_only,
        text,
        version: snap.version,
        accepted,
        ambiguous,
        unresolved,
    };
    Ok(Analysis::Found(Box::new(found)))
}

/// The unresolved names of `diagnostics` (single-line errors over a name), each with its
/// first reference in the document and that diagnostic's message, in document order.
fn unresolved_names(
    mut diagnostics: Vec<ide_core::Diagnostic>,
    lines: &[&str],
) -> Vec<(String, ide_core::Range, String)> {
    // Servers publish in any order: the first reference is the earliest range.
    diagnostics.sort_by_key(|d| d.range.start);
    let mut names: Vec<(String, ide_core::Range, String)> = Vec::new();
    for d in diagnostics {
        if d.severity != Severity::Error || d.range.start.line != d.range.end.line {
            continue;
        }
        let Some(name) = range_text(lines, d.range).filter(|n| is_name(n)) else { continue };
        if !names.iter().any(|(n, ..)| *n == name) {
            names.push((name, d.range, d.message));
        }
    }
    names
}

/// Adds a fix's `edits` to the `accepted` ones when they apply together to `text`;
/// `false` when the fix brings no edit at all or conflicts with the accepted ones.
fn merge_fix(text: &str, accepted: &mut Vec<TextEdit>, edits: Vec<TextEdit>) -> bool {
    if edits.is_empty() {
        return false;
    }
    // Two names from one module can bring the same edit.
    let new: Vec<TextEdit> = edits.into_iter().filter(|e| !accepted.contains(e)).collect();
    let merged: Vec<TextEdit> = accepted.iter().chain(&new).cloned().collect();
    if apply_text_edits(text, &merged).is_none() {
        return false;
    }
    *accepted = merged;
    true
}

/// Writes (or, in `diff` mode, previews) what [`analyze`] found: the result and a note
/// when a part of the job was skipped. Not cancelled halfway: once the text is in the
/// document it is saved.
async fn write(
    call: &Call,
    raw: &str,
    path: &Path,
    opts: Options,
    found: Found,
) -> IdeResult<(FileResult, Option<String>)> {
    let host = call.host();
    let project = call.project().clone();
    let Found { doc, transient, _close, read_only, text, version, accepted, ambiguous, unresolved } = found;
    let lines: Vec<&str> = text.split('\n').collect();
    let mut after = apply_text_edits(&text, &accepted).unwrap_or_else(|| text.clone());

    let mut note = None;
    let mut applied = false;
    let writable = opts.apply && !read_only;
    if writable || (opts.optimize && transient) {
        // The new text goes into the document: to be written, or (a transient one) to be optimized.
        let (p, new_text) = (project.clone(), after.clone());
        let current = host
            .blocking(move || {
                // A file the user changed meanwhile is left alone.
                if p.documents.text_snapshot(doc)?.version != version {
                    return Ok(false);
                }
                p.documents.replace_all(doc, &new_text).map(|_| true)
            })
            .await?;
        if current {
            let mut cancelled = None;
            if opts.optimize {
                match organize_imports(call, doc, path).await {
                    Err(e) if e.kind == ErrorKind::Cancelled => cancelled = Some(e),
                    Err(e) => note = Some(format!("{raw}: imports not optimized: {}", e.message)),
                    Ok(()) => {}
                }
            }
            after = project.documents.text_snapshot(doc)?.text;
            if writable {
                // Saved even when the call was cancelled meanwhile: the imports are in the buffer.
                let p = project.clone();
                host.blocking(move || p.documents.save(doc)).await?;
                applied = after != text;
                if applied {
                    call.record_change(path);
                }
            }
            if let Some(e) = cancelled {
                return Err(e);
            }
        }
    } else if opts.optimize {
        note = Some(format!("{raw}: optimize is skipped in diff mode for a file open in the editor"));
    }
    if opts.apply && read_only {
        note = Some(format!("{raw}: the file is read-only, so nothing was written"));
    }
    // Every reference sits under the import block, so one shift moves every line of the written file.
    let shift = if applied { after.split('\n').count() as i64 - lines.len() as i64 } else { 0 };
    let shifted = |line: u32| (line as i64 + shift).max(1) as u32;
    let item = FileResult {
        file_path: raw.into(),
        not_analyzed_reason: None,
        diff: build_unified_diff(
            &[ChangedFileText { path: raw.into(), before: Some(text.clone()), after: Some(after) }],
            MAX_DIFF_LINES,
        ),
        applied,
        ambiguous: ambiguous.into_iter().map(|a| Ambiguous { line: shifted(a.line), ..a }).collect(),
        unresolved: unresolved.into_iter().map(|u| Unresolved { line: shifted(u.line), ..u }).collect(),
    };
    Ok((item, note))
}

/// The text a single-line range covers.
fn range_text(lines: &[&str], range: ide_core::Range) -> Option<String> {
    let line = lines.get(range.start.line as usize)?;
    let units: Vec<u16> = line.encode_utf16().collect();
    let (from, to) = (range.start.col as usize, range.end.col as usize);
    (from < to && to <= units.len()).then(|| String::from_utf16_lossy(&units[from..to]))
}

fn is_name(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with(|c: char| c.is_ascii_digit())
        && s.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// A quick fix that adds an import (`Import 'List' (java.util)`, ``Import `std::fmt` ``,
/// `Add import from "./x"`), not one that removes or reorders imports.
fn is_import_fix(title: &str) -> bool {
    let t = title.to_lowercase();
    t.contains("import") && !["remove", "unused", "organize", "delete", "sort"].iter().any(|w| t.contains(w))
}

/// Diagnostic messages of a name that does not resolve.
fn looks_unresolved(message: &str) -> bool {
    let m = message.to_lowercase();
    [
        "cannot find",
        "cannot be resolved",
        "cannot resolve",
        "could not be resolved",
        "unresolved",
        "not defined",
        "undefined",
        "undeclared",
        "not found",
        "unknown",
    ]
    .iter()
    .any(|p| m.contains(p))
}

/// The import a fix's title names: the quoted part (``Import `std::fmt` ``), with a
/// trailing `(package)` in front of it (`Import 'List' (java.util)`); else the title.
fn candidate_name(title: &str) -> String {
    let quoted = ['`', '\'', '"'].iter().find_map(|&q| {
        let start = title.find(q)? + 1;
        let len = title[start..].find(q)?;
        Some((&title[start..start + len], start + len + 1))
    });
    match quoted {
        Some((name, end)) => {
            let rest = title[end..].trim();
            match rest.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
                Some(package) if !package.contains(' ') => format!("{package}.{name}"),
                _ => name.to_owned(),
            }
        }
        None => title.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_import_fixes() {
        assert!(is_import_fix("Import `std::collections::HashMap`"));
        assert!(is_import_fix("Add import from \"./util\""));
        assert!(!is_import_fix("Remove unused import"));
        assert!(!is_import_fix("Organize imports"));
        assert!(!is_import_fix("Change spelling to 'Lists'"));
        assert_eq!(candidate_name("Import `std::collections::HashMap`"), "std::collections::HashMap");
        assert_eq!(candidate_name("Import 'List' (java.util)"), "java.util.List");
        assert_eq!(candidate_name("Add import from \"./util\""), "./util");
        assert_eq!(candidate_name("Import HashMap"), "Import HashMap");
        assert!(looks_unresolved("cannot find type `HashMap` in this scope"));
        assert!(looks_unresolved("List cannot be resolved to a type"));
        assert!(!looks_unresolved("mismatched types"));
        assert!(is_name("HashMap") && is_name("$x") && !is_name("a.b") && !is_name("1a"));
    }

    fn range(line: u32, from: u32, to: u32) -> ide_core::Range {
        ide_core::Range::new(ide_core::Pos::new(line, from), ide_core::Pos::new(line, to))
    }

    #[test]
    fn a_name_is_reported_at_its_first_reference() {
        let lines = ["fn f() {", "  let a: HashMap = x;", "  let b: HashMap = y;", "}"];
        let diagnostic = |line| ide_core::Diagnostic {
            range: range(line, 9, 16),
            severity: Severity::Error,
            message: format!("cannot find type `HashMap` (line {line})"),
            source: None,
            code: None,
            unnecessary: false,
            deprecated: false,
            server: None,
        };
        // Published last reference first.
        let names = unresolved_names(vec![diagnostic(2), diagnostic(1)], &lines);
        assert_eq!(names.len(), 1);
        assert_eq!((names[0].0.as_str(), names[0].1.start.line), ("HashMap", 1));
    }

    #[test]
    fn a_fix_without_edits_is_not_applied() {
        let text = "use a;\nfn f() {}\n";
        let import = TextEdit { range: range(0, 0, 0), new_text: "use b;\n".into() };
        let mut accepted = Vec::new();
        assert!(merge_fix(text, &mut accepted, vec![import.clone()]));
        // A second name whose fix resolved to nothing: not silently counted as imported.
        assert!(!merge_fix(text, &mut accepted, Vec::new()));
        // One that brings the same import as an earlier name: fine.
        assert!(merge_fix(text, &mut accepted, vec![import.clone()]));
        assert_eq!(accepted, vec![import]);
        let overlapping = TextEdit { range: range(0, 0, 5), new_text: "x".into() };
        let inside = TextEdit { range: range(0, 2, 3), new_text: "y".into() };
        let mut accepted = vec![overlapping];
        assert!(!merge_fix(text, &mut accepted, vec![inside]));
    }
}
