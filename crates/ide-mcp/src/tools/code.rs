//! Code insight and analysis: symbol info, problems, call hierarchy, modules, dependencies.
//!
//! Language server features need the file as an open document. A call takes
//! its own reference ([`Docs`]) and gives it back when it ends (also on timeout
//! or cancellation), so a buffer the user has open stays open and nothing
//! opened here outlives the call. Files no installed language server serves are
//! never opened (that would start one, or offer to install it): they get
//! tree-sitter syntax errors and symbol-index answers instead.
//!
//! Columns are 1-based UTF-16 code units, like the backend's (0-based) and the
//! search tools'.

use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::mcp::McpToolKind;
use ide_core::{
    CancellationToken, Diagnostic, DocId, IdeError, IdeResult, LanguageId, Pos, Range, Severity, SymbolKind,
};
use ide_host::Project;
use ide_lsp::types::{GotoKind, HierarchyDirection, HierarchyItem};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

pub fn tools() -> Vec<Tool> {
    vec![
        get_symbol_info(),
        get_file_problems(),
        lint_files(),
        analyze_calls(),
        get_project_modules(),
        get_project_dependencies(),
    ]
}

const MAX_TIMEOUT_MS: usize = 300_000;
/// Quiet period after a publish before a file's diagnostics count as complete.
const SETTLE: Duration = Duration::from_millis(400);
const LINT_MAX_FILES: usize = 200;
const LINT_CONCURRENCY: usize = 4;
const MAX_DECLARATIONS: usize = 5;
const SNIPPET_LINES: u32 = 12;
const LINE_CONTENT_CHARS: usize = 200;

fn deadline(call: &Call, default_ms: usize) -> IdeResult<Instant> {
    let ms = call.count("timeout", default_ms, MAX_TIMEOUT_MS)?;
    Ok(Instant::now() + Duration::from_millis(ms as u64))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

// --- documents -------------------------------------------------------------------

#[derive(Default)]
struct DocsState {
    open: HashMap<PathBuf, DocId>,
    released: bool,
}

/// The document references one call holds; dropping it closes them.
struct Docs {
    project: Arc<Project>,
    state: Arc<Mutex<DocsState>>,
}

impl Docs {
    fn new(project: Arc<Project>) -> Self {
        Self { project, state: Arc::default() }
    }

    /// Opens `path` (another reference when the user has it open already).
    async fn open(&self, path: &Path) -> IdeResult<DocId> {
        if let Some(id) = self.state.lock().open.get(path) {
            return Ok(*id);
        }
        let (project, state, path) = (self.project.clone(), self.state.clone(), path.to_path_buf());
        // Registered from the blocking task itself: if the awaiting future is dropped
        // (timeout) the reference is still released.
        blocking(move || {
            let id = project.documents.open(&path)?.id;
            let mut st = state.lock();
            if st.released {
                drop(st);
                project.documents.close(id);
                return Err(IdeError::cancelled());
            }
            if let Some(extra) = st.open.insert(path, id) {
                project.documents.close(extra);
            }
            Ok(id)
        })
        .await
    }
}

impl Drop for Docs {
    fn drop(&mut self) {
        let open = {
            let mut st = self.state.lock();
            st.released = true;
            std::mem::take(&mut st.open)
        };
        for id in open.into_values() {
            self.project.documents.close(id);
        }
    }
}

// --- file text and positions -----------------------------------------------------

struct FileText {
    language: LanguageId,
    /// `\n` line endings; the open buffer's text when the file is open.
    text: String,
    large: bool,
    /// A language server can work on it (already open, or an installed server serves it).
    served: bool,
}

impl FileText {
    fn line(&self, line0: u32) -> &str {
        self.text.split('\n').nth(line0 as usize).unwrap_or("")
    }
}

/// Why a file cannot be analysed (`notAnalyzedReason`).
fn unreadable(project: &Project, path: &Path) -> Option<&'static str> {
    if !inside_project(project, path) {
        Some("outside the project")
    } else if path.is_dir() {
        Some("directory")
    } else if !path.exists() {
        Some("not found")
    } else {
        None
    }
}

fn load_text(project: &Project, path: &Path) -> Result<FileText, String> {
    if let Some(doc) = project.documents.by_path(path)
        && let Ok(snap) = project.documents.text_snapshot(doc)
    {
        return Ok(FileText { language: snap.language, text: snap.text, large: snap.large, served: !snap.large });
    }
    let loaded = project.documents.load_file(path).map_err(|e| e.message)?;
    if loaded.binary {
        return Err("binary file".into());
    }
    if loaded.too_large {
        return Err("too large".into());
    }
    let text = loaded.text.replace("\r\n", "\n").replace('\r', "\n");
    let language = project.languages.detect(path, text.lines().next());
    let served = !loaded.large && project.lsp.serves_path(path);
    Ok(FileText { language, text, large: loaded.large, served })
}

async fn read_file(call: &Call, path: &Path) -> IdeResult<FileText> {
    let project = call.project().clone();
    let shown = call.display(path);
    if let Some(reason) = unreadable(&project, path) {
        let message = format!("{shown}: {reason}");
        return Err(if reason == "not found" { IdeError::not_found(message) } else { IdeError::invalid(message) });
    }
    let path = path.to_path_buf();
    blocking(move || load_text(&project, &path).map_err(|r| IdeError::invalid(format!("{shown}: {r}")))).await
}

fn inside_project(project: &Project, path: &Path) -> bool {
    let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let path = canon(path);
    std::iter::once(project.root.clone()).chain(project.content_roots()).any(|root| path.starts_with(canon(&root)))
}

/// 1-based line / column → backend position.
fn to_pos(file: &FileText, line: u32, column: u32) -> IdeResult<Pos> {
    let lines = file.text.split('\n').count() as u32;
    if line > lines {
        return Err(IdeError::invalid(format!("line {line} is past the end of the file ({lines} lines)")));
    }
    let len = file.line(line - 1).encode_utf16().count() as u32;
    if column > len + 1 {
        return Err(IdeError::invalid(format!("column {column} is past the end of line {line} ({len} columns)")));
    }
    Ok(Pos::new(line - 1, column - 1))
}

/// The 1-based character index of 1-based UTF-16 `column` in `line`.
fn char_column(line: &str, column: u32) -> u32 {
    let mut units = 0u32;
    let mut chars = 0u32;
    for c in line.chars() {
        if units + 1 >= column {
            break;
        }
        units += c.len_utf16() as u32;
        chars += 1;
    }
    chars + 1
}

/// Backend position → 1-based line and column.
fn from_pos(_line_text: &str, pos: Pos) -> (u32, u32) {
    (pos.line + 1, pos.col + 1)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// The identifier at (or just before) `column` of `line`.
fn word_at(line: &str, column: u32) -> Option<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut at = (column as usize).saturating_sub(1).min(chars.len());
    if !chars.get(at).is_some_and(|c| is_word(*c)) {
        if at > 0 && is_word(chars[at - 1]) {
            at -= 1;
        } else {
            return None;
        }
    }
    let start = (0..=at).rev().take_while(|i| is_word(chars[*i])).last()?;
    let end = (at..chars.len()).take_while(|i| is_word(chars[*i])).last()? + 1;
    Some(chars[start..end].iter().collect())
}

fn numbered_lines(text: &str, from0: u32, to0: u32) -> String {
    let mut out = String::new();
    for (i, line) in text.split('\n').enumerate().skip(from0 as usize).take((to0 - from0 + 1) as usize) {
        let _ = writeln!(out, "{}\t{}", i + 1, truncate(line, 300));
    }
    out
}

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", &s[..cut]),
        None => s.to_owned(),
    }
}

/// Current text of `path` (open buffer, else disk), for snippets.
fn text_of(project: &Project, path: &Path) -> Option<String> {
    project.text_of(path).ok()
}

// --- problems --------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Problem {
    severity: &'static str,
    description: String,
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    line_content: String,
    #[serde(skip)]
    rank: u8,
}

fn severity_name(s: Severity) -> (&'static str, u8) {
    match s {
        Severity::Error => ("ERROR", 0),
        Severity::Warning => ("WARNING", 1),
        Severity::Info => ("INFO", 2),
        Severity::Hint => ("HINT", 3),
    }
}

fn problem(file: &FileText, d: Diagnostic) -> Problem {
    let (severity, rank) = severity_name(d.severity);
    let start_line = file.line(d.range.start.line);
    let (line, column) = from_pos(start_line, d.range.start);
    let (end_line, end_column) = from_pos(file.line(d.range.end.line), d.range.end);
    Problem {
        severity,
        description: d.message,
        line,
        column,
        end_line,
        end_column,
        source: d.source.or(d.server),
        code: d.code,
        line_content: truncate(start_line.trim(), LINE_CONTENT_CHARS),
        rank,
    }
}

/// Problems of one file.
struct Analysis {
    problems: Vec<Problem>,
    /// `languageServer`, `syntax` or `none`.
    analysis: &'static str,
    timed_out: bool,
    note: Option<String>,
}

/// Language server diagnostics of `path` (waiting for the first publish after
/// opening it, until `deadline`), else tree-sitter syntax errors.
async fn analyze(
    project: &Arc<Project>,
    path: &Path,
    deadline: Instant,
    cancel: &CancellationToken,
) -> Result<IdeResult<Analysis>, String> {
    if let Some(reason) = unreadable(project, path) {
        return Err(reason.into());
    }
    let file = {
        let (project, path) = (project.clone(), path.to_path_buf());
        match blocking(move || Ok(load_text(&project, &path))).await {
            Ok(r) => r?,
            Err(e) => return Ok(Err(e)),
        }
    };
    let mut timed_out = false;
    let mut note = None;
    let mut lsp_items = None;
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
            Ok(Ok(Some(items))) => lsp_items = Some(items),
            Ok(Ok(None)) => {
                note = Some("No language server for this file became ready; only syntax errors are reported.".into())
            }
            Ok(Err(e)) if e.kind == ide_core::error::ErrorKind::Cancelled => return Ok(Err(e)),
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
    let (analysis, items) = match lsp_items {
        Some(items) => ("languageServer", items),
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
            .await;
            match errors {
                Ok(Some(errors)) => {
                    if note.is_none() && !file.served {
                        note = Some("No language server serves this file; only syntax errors are reported.".into());
                    }
                    let items = errors
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
                        .collect();
                    ("syntax", items)
                }
                Ok(None) => {
                    if note.is_none() {
                        note = Some(if file.large {
                            "The file is too large to analyse.".into()
                        } else {
                            "No language server or syntax checker supports this file type.".into()
                        });
                    }
                    ("none", Vec::new())
                }
                Err(e) => return Ok(Err(e)),
            }
        }
    };
    let mut problems: Vec<Problem> = items.into_iter().map(|d| problem(&file, d)).collect();
    problems.sort_by_key(|p| (p.line, p.column, p.rank));
    Ok(Ok(Analysis { problems, analysis, timed_out, note }))
}

fn get_file_problems() -> Tool {
    Tool::new(
        "get_file_problems",
        McpToolKind::Read,
        "Errors and warnings of one project file, as the editor shows them: the diagnostics of its language server \
(opened and waited for when needed) or, when no server serves the file, tree-sitter syntax errors. Each problem has \
severity, description, 1-based line/column and end, source and the line's text. Use it after editing \
a file to check it still compiles.",
        |call| async move {
            let path = call.resolve(&call.str("filePath")?)?;
            let errors_only = call.flag("errorsOnly", true)?;
            let deadline = deadline(&call, 15_000)?;
            let project = call.project().clone();
            let shown = call.display(&path);
            let analysis = match analyze(&project, &path, deadline, &call.cancel).await {
                Ok(r) => r?,
                Err(reason) if reason == "not found" => {
                    return Err(IdeError::not_found(format!("{shown}: not found")));
                }
                Err(reason) => return Err(IdeError::invalid(format!("{shown}: {reason}"))),
            };
            let problems: Vec<_> =
                analysis.problems.into_iter().filter(|p| !errors_only || p.severity == "ERROR").collect();
            let mut out = json!({ "filePath": shown, "analysis": analysis.analysis, "problems": problems });
            if analysis.timed_out {
                out["timedOut"] = true.into();
            }
            if let Some(note) = analysis.note {
                out["note"] = note.into();
            }
            Output::json(out)
        },
    )
    .param(Param::required("filePath", ParamType::String, "Path of the file, project-relative or absolute"))
    .param(Param::optional(
        "errorsOnly",
        ParamType::Boolean,
        "Only errors (default true); false also returns warnings, infos and hints",
    ))
    .param(Param::optional(
        "timeout",
        ParamType::Integer,
        "Milliseconds to wait for the language server (default 15000); a server that is still starting may need more",
    ))
}

fn lint_files() -> Tool {
    Tool::new(
        "lint_files",
        McpToolKind::Read,
        "Problems of several files at once (language server diagnostics, else tree-sitter syntax errors), one entry \
per file in the given order. An entry has `timedOut: true` when its server did not report in time (syntax errors are \
still listed) and `notAnalyzedReason` when the file could not be analysed (outside the project, directory, not \
found, binary). When the total `timeout` runs out, the remaining files are listed in `remaining` and `more` is true: \
call again with them.",
        |call| async move {
            let files = call.str_list("files")?;
            if files.iter().all(|f| f.trim().is_empty()) {
                return Err(IdeError::invalid("`files` must name at least one file"));
            }
            let errors_only = match call.opt_str("min_severity")?.as_deref().map(str::to_ascii_lowercase).as_deref() {
                None | Some("warning") => false,
                Some("error") => true,
                Some(other) => {
                    return Err(IdeError::invalid(format!("`min_severity` must be warning or error, not {other}")));
                }
            };
            let deadline = deadline(&call, 30_000)?;
            let project = call.project().clone();
            let mut paths = Vec::new();
            for f in files.iter().filter(|f| !f.trim().is_empty()) {
                let path = call.resolve(f)?;
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
            let mut remaining: Vec<String> = paths.iter().skip(LINT_MAX_FILES).map(|p| call.display(p)).collect();
            paths.truncate(LINT_MAX_FILES);
            let call = &call;
            let project = &project;
            let tasks = paths.into_iter().map(|path| async move {
                let shown = call.display(&path);
                if Instant::now() >= deadline || call.cancel.is_cancelled() {
                    return (shown, None);
                }
                (shown, Some(analyze(project, &path, deadline, &call.cancel).await))
            });
            use futures::StreamExt;
            let results: Vec<_> = futures::stream::iter(tasks).buffered(LINT_CONCURRENCY).collect().await;
            if call.cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let mut entries = Vec::new();
            for (shown, result) in results {
                match result {
                    None => remaining.push(shown),
                    Some(Err(reason)) => entries.push(json!({ "filePath": shown, "notAnalyzedReason": reason })),
                    Some(Ok(Err(e))) => entries.push(json!({ "filePath": shown, "notAnalyzedReason": e.message })),
                    Some(Ok(Ok(a))) => {
                        let problems: Vec<_> =
                            a.problems.into_iter().filter(|p| p.rank == 0 || (!errors_only && p.rank == 1)).collect();
                        let mut entry = json!({ "filePath": shown, "analysis": a.analysis, "problems": problems });
                        if a.timed_out {
                            entry["timedOut"] = true.into();
                        }
                        entries.push(entry);
                    }
                }
            }
            let mut out = json!({ "files": entries });
            if !remaining.is_empty() {
                out["more"] = true.into();
                out["remaining"] = remaining.into();
            }
            Output::json(out)
        },
    )
    .param(Param::required(
        "files",
        ParamType::StringList,
        "Files to check, project-relative or absolute (at most 200)",
    ))
    .param(Param::optional(
        "min_severity",
        ParamType::Enum(&["warning", "error"]),
        "Lowest severity to report (default warning)",
    ))
    .param(Param::optional(
        "timeout",
        ParamType::Integer,
        "Total milliseconds for the whole call (default 30000); files are checked 4 at a time",
    ))
}

// --- symbol info -----------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Declaration {
    file_path: String,
    line: u32,
    column: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<SymbolKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    container: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snippet: Option<String>,
}

fn declaration(
    call: &Call,
    path: &Path,
    uri: Option<&str>,
    range: Range,
    kind: Option<SymbolKind>,
    container: Option<String>,
) -> Declaration {
    let text = if uri.is_some() { None } else { text_of(call.project(), path) };
    let (line, column) = match &text {
        Some(t) => from_pos(t.split('\n').nth(range.start.line as usize).unwrap_or(""), range.start),
        None => (range.start.line + 1, range.start.col + 1),
    };
    let snippet = text.as_deref().map(|t| {
        let last = t.split('\n').count().saturating_sub(1) as u32;
        let end = range.end.line.max(range.start.line + 4).min(range.start.line + SNIPPET_LINES - 1).min(last);
        numbered_lines(t, range.start.line, end.max(range.start.line))
    });
    let file_path = uri.map(str::to_owned).unwrap_or_else(|| call.display(path));
    Declaration { file_path, line, column, kind, container, snippet }
}

fn get_symbol_info() -> Tool {
    Tool::new(
        "get_symbol_info",
        McpToolKind::Read,
        "Quick Documentation for the symbol at a position: the language server's hover text (signature, type, docs) \
and where the symbol is declared, with a short snippet of the declaration. Without a language server for the file, \
declarations come from the project's symbol index. Line and column are 1-based.",
        |call| async move {
            let path = call.resolve(&call.str("filePath")?)?;
            let (line, column) = (call.one_based("line")?, call.one_based("column")?);
            let deadline = deadline(&call, 15_000)?;
            let file = read_file(&call, &path).await?;
            let pos = to_pos(&file, line, column)?;
            let word = word_at(file.line(pos.line), char_column(file.line(pos.line), column));
            let project = call.project().clone();
            let mut out = json!({ "filePath": call.display(&path), "line": line, "column": column });
            if let Some(w) = &word {
                out["symbol"] = w.clone().into();
            }
            let mut notes = Vec::new();
            let mut declarations = Vec::new();
            let mut source = "none";
            if file.served {
                let docs = Docs::new(project.clone());
                let work = async {
                    let doc = docs.open(&path).await?;
                    let lsp = &project.lsp;
                    let hover = async {
                        let first = lsp.hover(doc, pos, call.cancel.clone()).await;
                        // A server that just received the file may answer before it analysed it.
                        if matches!(first, Ok(None)) && word.is_some() {
                            tokio::time::sleep(Duration::from_millis(800)).await;
                            return lsp.hover(doc, pos, call.cancel.clone()).await;
                        }
                        first
                    };
                    let goto = lsp.goto(doc, pos, GotoKind::Definition);
                    Ok::<_, IdeError>(futures::join!(hover, goto))
                };
                match tokio::time::timeout_at(deadline, work).await {
                    Ok(Ok((hover, goto))) => {
                        match hover {
                            Ok(Some(h)) => {
                                out["documentation"] = h.contents.value.trim().into();
                                source = "languageServer";
                            }
                            Ok(None) => {}
                            Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => return Err(e),
                            Err(e) => notes.push(format!("hover: {}", e.message)),
                        }
                        match goto {
                            Ok(locations) => {
                                for l in locations.into_iter().take(MAX_DECLARATIONS) {
                                    declarations.push(declaration(
                                        &call,
                                        &l.path,
                                        l.uri.as_deref(),
                                        l.range,
                                        None,
                                        None,
                                    ));
                                }
                                if !declarations.is_empty() {
                                    source = "languageServer";
                                }
                            }
                            Err(e) => notes.push(format!("definition: {}", e.message)),
                        }
                    }
                    Ok(Err(e)) => return Err(e),
                    Err(_) => notes.push(
                        "The language server did not answer in time (it may still be starting or indexing); retry \
with a larger timeout."
                            .into(),
                    ),
                }
            } else {
                notes.push("No language server serves this file; declarations come from the symbol index.".into());
            }
            if declarations.is_empty()
                && let Some(w) = &word
            {
                let mut found = project.index.symbols_named(w, None, 50);
                // Declarations in this file first.
                found.sort_by_key(|m| *m.path != *path);
                for m in found.into_iter().take(MAX_DECLARATIONS) {
                    declarations.push(declaration(&call, &m.path, None, m.range, Some(m.kind), m.container));
                }
                if !declarations.is_empty() && source == "none" {
                    source = "index";
                }
            }
            if word.is_none() && out.get("documentation").is_none() {
                let at = file.line(pos.line).chars().nth(char_column(file.line(pos.line), column) as usize - 1);
                notes.push(match at {
                    Some(c) => format!("No symbol at {line}:{column} (the character there is {c:?})."),
                    None => format!("No symbol at {line}:{column} (end of line)."),
                });
            }
            out["declarations"] = serde_json::to_value(declarations).unwrap_or_default();
            out["source"] = source.into();
            if !notes.is_empty() {
                out["note"] = notes.join(" ").into();
            }
            Output::json(out)
        },
    )
    .param(Param::required("filePath", ParamType::String, "Path of the file, project-relative or absolute"))
    .param(Param::required("line", ParamType::Integer, "1-based line"))
    .param(Param::required("column", ParamType::Integer, "1-based column"))
    .param(Param::optional(
        "timeout",
        ParamType::Integer,
        "Milliseconds to wait for the language server (default 15000)",
    ))
}

// --- call hierarchy --------------------------------------------------------------

/// A symbol `symbolFqn` may mean.
#[derive(Clone)]
struct Candidate {
    name: String,
    kind: SymbolKind,
    container: Option<String>,
    path: PathBuf,
    rel: String,
    range: Range,
}

impl Candidate {
    fn segments(&self) -> Vec<String> {
        let rel = self.rel.rsplit_once('.').map_or(self.rel.as_str(), |(stem, _)| stem);
        let mut out = split_fqn(rel);
        out.extend(self.container.as_deref().map(split_fqn).unwrap_or_default());
        out
    }

    fn callable(&self) -> bool {
        matches!(self.kind, SymbolKind::Function | SymbolKind::Method | SymbolKind::Constructor)
    }

    /// A `symbolFqn` that picks this candidate.
    fn suggestion(&self) -> String {
        let rel = self.rel.rsplit_once('.').map_or(self.rel.as_str(), |(stem, _)| stem);
        match &self.container {
            Some(c) => format!("{rel}.{}.{}", split_fqn(c).join("."), self.name),
            None => format!("{rel}.{}", self.name),
        }
    }
}

/// `a::b.C#m(int)` → `[a, b, C, m]`.
fn split_fqn(fqn: &str) -> Vec<String> {
    let s = fqn.trim();
    let s = s.find('(').map_or(s, |i| &s[..i]);
    s.split(['.', '#', '/', '\\', ':']).map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned).collect()
}

/// Whether `qualifiers` appear in `segments` in order.
fn subsequence(qualifiers: &[String], segments: &[String]) -> bool {
    let mut it = segments.iter();
    qualifiers.iter().all(|q| it.any(|s| s == q))
}

/// Narrows `found` (symbols named like the last segment) to those `qualifiers` describe.
fn narrow(mut found: Vec<Candidate>, qualifiers: &[String]) -> Vec<Candidate> {
    found.retain(|c| subsequence(qualifiers, &c.segments()));
    if let Some(last) = qualifiers.last()
        && found.iter().any(|c| c.container.as_deref().and_then(|k| split_fqn(k).pop()).as_ref() == Some(last))
    {
        found.retain(|c| c.container.as_deref().and_then(|k| split_fqn(k).pop()).as_ref() == Some(last));
    }
    if found.iter().any(Candidate::callable) {
        found.retain(Candidate::callable);
    }
    let mut seen = Vec::new();
    found.retain(|c| {
        let key = (c.path.clone(), c.range);
        let new = !seen.contains(&key);
        seen.push(key);
        new
    });
    found
}

async fn locate(call: &Call, fqn: &str, deadline: Instant) -> IdeResult<Vec<Candidate>> {
    let segments = split_fqn(fqn);
    let Some((name, qualifiers)) = segments.split_last() else {
        return Err(IdeError::invalid("`symbolFqn` is empty"));
    };
    let project = call.project();
    let from_index: Vec<Candidate> = project
        .index
        .symbols_named(name, None, 500)
        .into_iter()
        .map(|m| Candidate {
            name: m.name,
            kind: m.kind,
            container: m.container,
            path: m.path.to_path_buf(),
            rel: m.rel_path,
            range: m.range,
        })
        .collect();
    let found = narrow(from_index, qualifiers);
    if !found.is_empty() {
        return Ok(found);
    }
    // Symbols the tree-sitter index does not know (macros, generated code): ask the running servers.
    if project.lsp.servers().is_empty() {
        return Ok(Vec::new());
    }
    let symbols = tokio::time::timeout_at(deadline, project.lsp.workspace_symbols(name, call.cancel.clone()))
        .await
        .unwrap_or(Ok(Vec::new()));
    let from_lsp = symbols
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.name == *name && s.location.uri.is_none())
        .map(|s| Candidate {
            rel: call.display(&s.location.path),
            name: s.name,
            kind: s.kind,
            container: s.container,
            path: s.location.path.to_path_buf(),
            range: s.location.range,
        })
        .collect();
    Ok(narrow(from_lsp, qualifiers))
}

/// Where the symbol's name starts inside its (possibly whole-declaration) range.
fn name_position(text: &str, c: &Candidate) -> Pos {
    let lines: Vec<&str> = text.split('\n').collect();
    let last = (c.range.end.line.max(c.range.start.line + 3) as usize).min(lines.len().saturating_sub(1));
    for l in c.range.start.line as usize..=last {
        let Some(line) = lines.get(l) else { break };
        let from = if l == c.range.start.line as usize { utf16_to_byte(line, c.range.start.col) } else { 0 };
        let mut search = from;
        while let Some(i) = line[search..].find(&c.name) {
            let at = search + i;
            let before = line[..at].chars().next_back();
            let after = line[at + c.name.len()..].chars().next();
            if !before.is_some_and(is_word) && !after.is_some_and(is_word) {
                return Pos::new(l as u32, line[..at].encode_utf16().count() as u32);
            }
            search = at + c.name.len();
        }
    }
    c.range.start
}

fn utf16_to_byte(line: &str, col: u32) -> usize {
    let mut units = 0u32;
    for (i, ch) in line.char_indices() {
        if units >= col {
            return i;
        }
        units += ch.len_utf16() as u32;
    }
    line.len()
}

struct Node {
    name: String,
    detail: Option<String>,
    path: PathBuf,
    uri: Option<String>,
    /// Where call hierarchy is asked for this node's own calls.
    pos: Pos,
    line: u32,
    call_lines: Vec<u32>,
    key: String,
    parent: Option<usize>,
    children: Vec<usize>,
    /// Children the server returned (before paging).
    total: usize,
    offset: usize,
    expanded: bool,
    recursive: bool,
    error: Option<String>,
}

fn node(call: &Call, item: HierarchyItem, parent: Option<usize>) -> Node {
    let line = item.selection_range.start.line + 1;
    let shown = item.uri.clone().unwrap_or_else(|| call.display(&item.path));
    let mut call_lines: Vec<u32> = item.from_ranges.iter().map(|r| r.start.line + 1).collect();
    call_lines.dedup();
    Node {
        key: format!("{}@{shown}:{line}", item.name),
        name: item.name,
        detail: item.detail.filter(|d| !d.trim().is_empty()),
        path: item.path.to_path_buf(),
        uri: item.uri,
        pos: item.selection_range.start,
        line,
        call_lines,
        parent,
        children: Vec::new(),
        total: 0,
        offset: 0,
        expanded: false,
        recursive: false,
        error: None,
    }
}

struct Hierarchy<'a> {
    call: &'a Call,
    docs: Docs,
    direction: HierarchyDirection,
    deadline: Instant,
}

impl Hierarchy<'_> {
    /// One level of calls of the symbol at `pos` in `path`.
    async fn calls(&self, path: &Path, pos: Pos, retry: bool) -> IdeResult<Vec<HierarchyItem>> {
        let project = self.call.project();
        let mut attempt = 0;
        loop {
            let work = async {
                let doc = self.docs.open(path).await?;
                project.lsp.call_hierarchy(doc, pos, self.direction, self.call.cancel.clone()).await
            };
            let result = match tokio::time::timeout_at(self.deadline, work).await {
                Ok(r) => r,
                Err(_) => return Err(IdeError::new(ide_core::error::ErrorKind::Unavailable, "timed out")),
            };
            match result {
                Ok(h) => return Ok(h.items),
                // A server still loading the project fails the first requests.
                Err(e)
                    if retry
                        && attempt < 3
                        && matches!(e.kind, ide_core::error::ErrorKind::Protocol | ide_core::error::ErrorKind::Io)
                        && Instant::now() + Duration::from_secs(1) < self.deadline =>
                {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }
}

struct Limits {
    depth: usize,
    max_children: usize,
    max_nodes: usize,
    child_offset: usize,
}

fn analyze_calls() -> Tool {
    Tool::new(
        "analyze_calls",
        McpToolKind::Read,
        "Call hierarchy of a function or method from its language server, as a text tree: INCOMING_CALLS lists its \
callers (and theirs, up to `depth`), OUTGOING_CALLS what it calls. `symbolFqn` is the name, qualified as far as \
needed (`Parser.parse`, `crate::net::connect`, `src/util.ts.format`); when several symbols match, the candidates are \
returned to pick from. Every node shows name, detail, file:line, call-site lines and its `treePath`: pass that \
`treePath` to expand the node further, and `childOffset` to page through its children.",
        |call| async move {
            let fqn = call.str("symbolFqn")?;
            let direction = match call.str("analysisKind")?.to_ascii_uppercase().as_str() {
                "INCOMING_CALLS" | "INCOMING" | "CALLERS" => HierarchyDirection::Incoming,
                "OUTGOING_CALLS" | "OUTGOING" | "CALLEES" => HierarchyDirection::Outgoing,
                other => {
                    return Err(IdeError::invalid(format!(
                        "`analysisKind` must be INCOMING_CALLS or OUTGOING_CALLS, not {other}"
                    )));
                }
            };
            let tree_path: Vec<String> = call.str_list("treePath")?.into_iter().filter(|s| !s.is_empty()).collect();
            let limits = Limits {
                depth: call.count("depth", 5, 50)?,
                max_children: call.count("maxChildren", 50, 1000)?,
                max_nodes: call.count("maxNodes", 1000, 10_000)?,
                child_offset: call.opt_i64("childOffset")?.unwrap_or(0).max(0) as usize,
            };
            let deadline = deadline(&call, 30_000)?;
            let mut found = locate(&call, &fqn, deadline).await?;
            if found.is_empty() {
                return Err(IdeError::not_found(format!(
                    "No symbol matches `{fqn}`. Check the spelling, or find it with search_symbol first."
                )));
            }
            let same_place = found.iter().all(|c| c.path == found[0].path && c.container == found[0].container);
            if found.len() > 1 && !same_place {
                let mut out =
                    format!("`{fqn}` matches {} symbols; call again with one of these as symbolFqn:\n", found.len());
                for c in found.iter().take(30) {
                    let line = c.range.start.line + 1;
                    let _ = writeln!(
                        out,
                        "- {}  ({:?}{}) — {}:{line}",
                        c.suggestion(),
                        c.kind,
                        c.container.as_deref().map(|k| format!(" in {k}")).unwrap_or_default(),
                        c.rel
                    );
                }
                return Ok(Output::text(out));
            }
            let target = found.swap_remove(0);
            let project = call.project().clone();
            let served = {
                let (p, path) = (project.clone(), target.path.clone());
                blocking(move || Ok(p.documents.by_path(&path).is_some() || p.lsp.serves_path(&path))).await?
            };
            if !served {
                return Err(IdeError::unavailable(format!(
                    "No installed language server serves {}; call hierarchy needs one.",
                    target.rel
                )));
            }
            let text = text_of(&project, &target.path).unwrap_or_default();
            let pos = name_position(&text, &target);
            let h = Hierarchy { call: &call, docs: Docs::new(project.clone()), direction, deadline };
            render_calls(&h, &target, pos, &tree_path, &limits, &fqn).await
        },
    )
    .param(Param::required(
        "symbolFqn",
        ParamType::String,
        "The function or method: its name, qualified by class / module / file as far as needed to be unique \
(`Parser.parse`, `net::connect`)",
    ))
    .param(Param::required(
        "analysisKind",
        ParamType::Enum(&["INCOMING_CALLS", "OUTGOING_CALLS"]),
        "INCOMING_CALLS: who calls it; OUTGOING_CALLS: what it calls",
    ))
    .param(Param::optional(
        "treePath",
        ParamType::StringList,
        "A node's treePath from an earlier result: show the tree below that node",
    ))
    .param(Param::optional("depth", ParamType::Integer, "Levels to expand (default 5)"))
    .param(Param::optional("maxChildren", ParamType::Integer, "Children shown per node (default 50)"))
    .param(Param::optional("maxNodes", ParamType::Integer, "Nodes shown in total (default 1000)"))
    .param(Param::optional(
        "childOffset",
        ParamType::Integer,
        "Skip this many children of the top node (paging; default 0)",
    ))
    .param(Param::optional("timeout", ParamType::Integer, "Total milliseconds (default 30000)"))
}

async fn render_calls(
    h: &Hierarchy<'_>,
    target: &Candidate,
    pos: Pos,
    tree_path: &[String],
    limits: &Limits,
    fqn: &str,
) -> IdeResult<Output> {
    let call = h.call;
    let kind = match h.direction {
        HierarchyDirection::Incoming => "INCOMING_CALLS",
        HierarchyDirection::Outgoing => "OUTGOING_CALLS",
    };
    let (none, more_word) = match h.direction {
        HierarchyDirection::Incoming => ("(no callers found)", "callers"),
        HierarchyDirection::Outgoing => ("(no calls found)", "callees"),
    };
    let mut nodes: Vec<Node> = vec![Node {
        name: target.name.clone(),
        detail: target.container.as_ref().map(|c| format!("in {c}")),
        path: target.path.clone(),
        uri: None,
        pos,
        line: pos.line + 1,
        call_lines: Vec::new(),
        key: String::new(),
        parent: None,
        children: Vec::new(),
        total: 0,
        offset: 0,
        expanded: false,
        recursive: false,
        error: None,
    }];
    // Walk down `treePath` to the node to show.
    let mut walked: Vec<String> = Vec::new();
    for step in tree_path {
        let current = nodes.last().expect("a node");
        if current.uri.is_some() {
            return Err(IdeError::invalid(format!("{} is library code and cannot be expanded", current.name)));
        }
        let items = h.calls(&current.path.clone(), current.pos, walked.is_empty()).await?;
        let children: Vec<Node> = items.into_iter().map(|i| node(call, i, None)).collect();
        let pick = children.iter().position(|n| n.key == *step).or_else(|| {
            let named: Vec<usize> =
                children.iter().enumerate().filter(|(_, n)| n.name == *step).map(|(i, _)| i).collect();
            (named.len() == 1).then(|| named[0])
        });
        let Some(i) = pick else {
            let keys: Vec<&str> = children.iter().take(20).map(|n| n.key.as_str()).collect();
            return Err(IdeError::not_found(format!(
                "treePath step `{step}` is not among the {} {more_word} of {}: {}",
                children.len(),
                if walked.is_empty() { target.name.clone() } else { walked.last().cloned().unwrap_or_default() },
                if keys.is_empty() { "(none)".to_owned() } else { keys.join(", ") }
            )));
        };
        let child = children.into_iter().nth(i).expect("picked");
        walked.push(child.key.clone());
        nodes = vec![child];
    }
    let base_path = walked.clone();

    // Breadth first, so a timeout or `maxNodes` cuts the deepest levels.
    let mut queue = std::collections::VecDeque::from([(0usize, 0usize)]);
    let mut timed_out = false;
    let mut capped = false;
    while let Some((idx, depth)) = queue.pop_front() {
        if depth >= limits.depth || nodes[idx].recursive || nodes[idx].uri.is_some() {
            continue;
        }
        if capped {
            continue;
        }
        if Instant::now() >= h.deadline || call.cancel.is_cancelled() {
            timed_out = true;
            break;
        }
        let (path, pos) = (nodes[idx].path.clone(), nodes[idx].pos);
        let items = match h.calls(&path, pos, idx == 0).await {
            Ok(items) => items,
            Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => return Err(e),
            Err(e) if idx == 0 => {
                return Err(IdeError::new(e.kind, format!("call hierarchy of {}: {}", nodes[0].name, e.message)));
            }
            Err(e) => {
                nodes[idx].error = Some(e.message);
                continue;
            }
        };
        nodes[idx].expanded = true;
        nodes[idx].total = items.len();
        let offset = if idx == 0 { limits.child_offset.min(items.len()) } else { 0 };
        nodes[idx].offset = offset;
        for item in items.into_iter().skip(offset).take(limits.max_children) {
            if nodes.len() > limits.max_nodes {
                capped = true;
                break;
            }
            let mut child = node(call, item, Some(idx));
            let mut up = Some(idx);
            while let Some(a) = up {
                if !nodes[a].key.is_empty() && nodes[a].key == child.key
                    || (a == 0 && child.path == target.path && child.pos == pos && walked.is_empty())
                {
                    child.recursive = true;
                    break;
                }
                up = nodes[a].parent;
            }
            let id = nodes.len();
            nodes.push(child);
            nodes[idx].children.push(id);
            queue.push_back((id, depth + 1));
        }
    }

    let top = &nodes[0];
    let mut out = format!("{kind} of {fqn}");
    if !walked.is_empty() {
        let _ = write!(out, " › {}", walked.join(" › "));
    }
    let _ = writeln!(
        out,
        " — {}{}:{}",
        top.detail.as_deref().map(|d| format!("{} ({d}) ", top.name)).unwrap_or_else(|| format!("{} ", top.name)),
        call.display(&top.path),
        top.line
    );
    if top.expanded && top.children.is_empty() && top.total == 0 {
        let _ = writeln!(out, "{none}");
    }
    let mut stack_path = base_path.clone();
    render(&nodes, 0, "", &mut stack_path, more_word, &mut out);
    if timed_out {
        let _ = writeln!(
            out,
            "… stopped at the timeout; expand the nodes without children via their treePath, or retry with a larger timeout."
        );
    }
    if capped {
        let _ = writeln!(out, "… stopped after maxNodes={} nodes.", limits.max_nodes);
    }
    let leaves_at_depth = nodes.iter().any(|n| !n.expanded && !n.recursive && n.uri.is_none() && n.error.is_none());
    if leaves_at_depth && !timed_out && !capped {
        let _ =
            writeln!(out, "(nodes at depth {} are not expanded; pass a node's treePath to go deeper)", limits.depth);
    }
    Ok(Output::text(out))
}

fn render(nodes: &[Node], idx: usize, prefix: &str, path: &mut Vec<String>, more_word: &str, out: &mut String) {
    let n = &nodes[idx];
    let count = n.children.len();
    for (i, &c) in n.children.iter().enumerate() {
        let child = &nodes[c];
        let last = i + 1 == count && n.total <= n.offset + count;
        path.push(child.key.clone());
        let mut line = format!("{prefix}{}{}", if last { "└── " } else { "├── " }, child.name);
        if let Some(d) = &child.detail {
            let _ = write!(line, "  {}", truncate(d.lines().next().unwrap_or(""), 120));
        }
        match &child.uri {
            Some(uri) => {
                let _ = write!(line, "  {uri} (library)");
            }
            None => {
                let file = child.key.rsplit_once('@').map_or("", |(_, f)| f);
                let _ = write!(line, "  {file}");
            }
        }
        if !child.call_lines.is_empty() {
            let lines: Vec<String> = child.call_lines.iter().take(10).map(u32::to_string).collect();
            let _ = write!(line, "  call sites: {}", lines.join(", "));
        }
        if child.recursive {
            line.push_str("  (recursive)");
        }
        if let Some(e) = &child.error {
            let _ = write!(line, "  (cannot expand: {})", truncate(e, 160));
        }
        let _ = writeln!(line, "  treePath={}", serde_json::to_string(path).unwrap_or_default());
        out.push_str(&line);
        let child_prefix = format!("{prefix}{}", if last { "    " } else { "│   " });
        render(nodes, c, &child_prefix, path, more_word, out);
        path.pop();
    }
    let rest = n.total.saturating_sub(n.offset + count);
    if rest > 0 {
        let _ = writeln!(
            out,
            "{prefix}└── … {rest} more {more_word} (treePath={}, childOffset={})",
            serde_json::to_string(path).unwrap_or_default(),
            n.offset + count
        );
    }
}

// --- modules and dependencies ----------------------------------------------------

const MANIFESTS: &[&str] = &["Cargo.toml", "package.json", "go.mod", "pyproject.toml"];
const SCAN_DEPTH: usize = 4;
const SCAN_MAX_DIRS: usize = 3000;
const LIBRARY_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_LIBRARY_ENTRIES: usize = 300;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceFolderOut {
    path: String,
    /// `source`, `test`, `resources`, `testResources` or `excluded`.
    kind: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Module {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    /// Project-relative directory (`.` = root), absolute outside the project.
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    source_folders: Vec<SourceFolderOut>,
}

/// Build files below the project (ignored and excluded folders skipped), shallow first.
fn scan_manifests(call: &Call) -> Vec<PathBuf> {
    let host = call.host();
    let mut out = Vec::new();
    let mut dirs = std::collections::VecDeque::from([(call.root().to_path_buf(), 0usize)]);
    let mut visited = 0;
    while let Some((dir, depth)) = dirs.pop_front() {
        visited += 1;
        if visited > SCAN_MAX_DIRS {
            break;
        }
        let Ok(entries) = ide_host::ops::fs::read_dir(&host, call.window(), dir) else { continue };
        for e in entries {
            if e.ignored || e.excluded {
                continue;
            }
            if e.kind == ide_vfs::EntryKind::Dir {
                if depth < SCAN_DEPTH
                    && !e.name.starts_with('.')
                    && !matches!(e.name.as_str(), "node_modules" | "target" | "vendor")
                {
                    dirs.push_back((e.path.into_path_buf(), depth + 1));
                }
            } else if MANIFESTS.contains(&e.name.as_str()) {
                out.push(e.path.into_path_buf());
            }
        }
    }
    out
}

fn rel_dir(call: &Call, manifest: &Path) -> String {
    manifest.parent().map(|d| call.display(d)).unwrap_or_else(|| ".".into())
}

fn dir_name(path: &Path) -> String {
    path.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// A module described by a manifest: (name, type).
fn manifest_module(path: &Path, text: &str) -> Option<(String, String)> {
    let file = path.file_name()?.to_str()?;
    let fallback = dir_name(path);
    match file {
        "Cargo.toml" => {
            let t: toml::Table = text.parse().ok()?;
            match t.get("package").and_then(|p| p.get("name")).and_then(toml::Value::as_str) {
                Some(n) => Some((n.to_owned(), "cargo".into())),
                None if t.contains_key("workspace") => Some((fallback, "cargo-workspace".into())),
                None => None,
            }
        }
        "package.json" => {
            let v: Value = serde_json::from_str(text).ok()?;
            let name = v.get("name").and_then(Value::as_str).map(str::to_owned).unwrap_or(fallback);
            Some((name, "npm".into()))
        }
        "go.mod" => {
            let name = text
                .lines()
                .find_map(|l| l.trim().strip_prefix("module "))
                .map(|m| m.trim().trim_matches('"').to_owned());
            Some((name.unwrap_or(fallback), "go".into()))
        }
        "pyproject.toml" => {
            let t: toml::Table = text.parse().ok()?;
            let name = t
                .get("project")
                .and_then(|p| p.get("name"))
                .or_else(|| t.get("tool").and_then(|p| p.get("poetry")).and_then(|p| p.get("name")))
                .and_then(toml::Value::as_str)
                .map(str::to_owned);
            Some((name.unwrap_or(fallback), "python".into()))
        }
        _ => None,
    }
}

fn get_project_modules() -> Tool {
    Tool::new(
        "get_project_modules",
        McpToolKind::Read,
        "The project's modules: Maven / Gradle projects from the build model and the packages / crates / Go modules \
/ Python projects of the build files below the root, each with name, type, directory and the source / test / \
resource / excluded folders inside it. Folders attached from outside the project are listed as `contentRoot`.",
        |call| async move {
            let model = ide_host::ops::build::build_model(&call.host(), call.window()).await?;
            let project = call.project().clone();
            let mut modules: Vec<Module> = Vec::new();
            let dir_of = |dir: &str| if dir.is_empty() { ".".to_owned() } else { dir.to_owned() };
            if let Some(m) = &model.maven {
                for p in &m.projects {
                    let name = if p.display_name.is_empty() { p.artifact_id.clone() } else { p.display_name.clone() };
                    modules.push(Module {
                        name,
                        kind: "maven".into(),
                        path: dir_of(&p.dir),
                        manifest: Some(p.pom.clone()),
                        source_folders: Vec::new(),
                    });
                }
            }
            if let Some(g) = &model.gradle {
                for p in &g.projects {
                    modules.push(Module {
                        name: p.name.clone(),
                        kind: "gradle".into(),
                        path: dir_of(&p.dir),
                        manifest: p.build_file.clone(),
                        source_folders: Vec::new(),
                    });
                }
            }
            let manifests = {
                let call = &call;
                scan_manifests(call)
            };
            for m in manifests {
                let Ok(text) = std::fs::read_to_string(&m) else { continue };
                let Some((name, kind)) = manifest_module(&m, &text) else { continue };
                let path = rel_dir(&call, &m);
                if !modules.iter().any(|x| x.path == path && x.kind == kind) {
                    modules.push(Module {
                        name,
                        kind,
                        path,
                        manifest: Some(call.display(&m)),
                        source_folders: Vec::new(),
                    });
                }
            }
            if !modules.iter().any(|m| m.path == ".") {
                let name = ide_host::ops::project::info(&project).name;
                modules.insert(
                    0,
                    Module {
                        name,
                        kind: "directory".into(),
                        path: ".".into(),
                        manifest: None,
                        source_folders: Vec::new(),
                    },
                );
            }
            // Each source folder goes to the innermost module containing it.
            let roots = ide_host::ops::project::roots(&call.host(), call.window())?;
            for r in roots.roots {
                let inside =
                    |m: &Module| m.path == "." || r.path == m.path || r.path.starts_with(&format!("{}/", m.path));
                if let Some(m) = modules
                    .iter_mut()
                    .filter(|m| inside(m))
                    .max_by_key(|m| if m.path == "." { 0 } else { m.path.len() })
                {
                    let folder = SourceFolderOut {
                        path: if r.path.is_empty() { ".".into() } else { r.path.clone() },
                        kind: serde_json::to_value(r.kind).unwrap_or_default(),
                    };
                    m.source_folders.push(folder);
                }
            }
            for root in project.content_roots() {
                let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                modules.push(Module {
                    name,
                    kind: "contentRoot".into(),
                    path: root.display().to_string(),
                    manifest: None,
                    source_folders: Vec::new(),
                });
            }
            Output::json(json!({ "modules": modules }))
        },
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Dependency {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dependency_type: Option<String>,
    /// The manifest that declares it.
    source: String,
}

fn dep(name: &str, version: Option<String>, kind: &str, source: &str) -> Dependency {
    Dependency {
        name: name.to_owned(),
        version: version.filter(|v| !v.is_empty()),
        dependency_type: Some(kind.to_owned()),
        source: source.to_owned(),
    }
}

/// Direct dependencies a manifest declares.
fn manifest_dependencies(path: &Path, text: &str, source: &str) -> Vec<Dependency> {
    let mut out = Vec::new();
    match path.file_name().and_then(|n| n.to_str()) {
        Some("package.json") => {
            let Ok(v) = serde_json::from_str::<Value>(text) else { return out };
            for kind in ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] {
                for (name, spec) in v.get(kind).and_then(Value::as_object).into_iter().flatten() {
                    out.push(dep(name, spec.as_str().map(str::to_owned), kind, source));
                }
            }
        }
        Some("Cargo.toml") => {
            let Ok(t) = text.parse::<toml::Table>() else { return out };
            let cargo_version = |v: &toml::Value| -> Option<String> {
                match v {
                    toml::Value::String(s) => Some(s.clone()),
                    toml::Value::Table(t) => t
                        .get("version")
                        .and_then(toml::Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| {
                            t.get("workspace").and_then(toml::Value::as_bool).filter(|w| *w).map(|_| "workspace".into())
                        })
                        .or_else(|| t.get("path").and_then(toml::Value::as_str).map(|p| format!("path: {p}")))
                        .or_else(|| t.get("git").and_then(toml::Value::as_str).map(|g| format!("git: {g}"))),
                    _ => None,
                }
            };
            let mut tables: Vec<(String, &toml::Table)> = Vec::new();
            for kind in ["dependencies", "dev-dependencies", "build-dependencies"] {
                if let Some(d) = t.get(kind).and_then(toml::Value::as_table) {
                    tables.push((kind.to_owned(), d));
                }
                for (cfg, target) in t.get("target").and_then(toml::Value::as_table).into_iter().flatten() {
                    if let Some(d) = target.get(kind).and_then(toml::Value::as_table) {
                        tables.push((format!("{kind} ({cfg})"), d));
                    }
                }
            }
            if let Some(d) = t.get("workspace").and_then(|w| w.get("dependencies")).and_then(toml::Value::as_table) {
                tables.push(("workspace.dependencies".into(), d));
            }
            for (kind, table) in tables {
                for (name, v) in table {
                    let name = v.get("package").and_then(toml::Value::as_str).unwrap_or(name);
                    out.push(dep(name, cargo_version(v), &kind, source));
                }
            }
        }
        Some("go.mod") => {
            let mut block = false;
            for line in text.lines() {
                let line = line.trim();
                let entry = if block {
                    if line.starts_with(')') {
                        block = false;
                        continue;
                    }
                    line
                } else if let Some(rest) = line.strip_prefix("require") {
                    let rest = rest.trim();
                    if rest.starts_with('(') {
                        block = true;
                        continue;
                    }
                    rest
                } else {
                    continue;
                };
                let (spec, comment) = entry.split_once("//").map_or((entry, ""), |(s, c)| (s, c));
                let mut parts = spec.split_whitespace();
                if let Some(name) = parts.next() {
                    let kind = if comment.contains("indirect") { "indirect" } else { "require" };
                    out.push(dep(name, parts.next().map(str::to_owned), kind, source));
                }
            }
        }
        Some("pyproject.toml") => {
            let Ok(t) = text.parse::<toml::Table>() else { return out };
            let pep508 = |s: &str| -> (String, Option<String>) {
                let s = s.split(';').next().unwrap_or("").trim();
                let cut = s.find(|c: char| "<>=!~[ (@".contains(c)).unwrap_or(s.len());
                let rest = s[cut..].trim();
                (s[..cut].to_owned(), (!rest.is_empty()).then(|| rest.to_owned()))
            };
            let project = t.get("project");
            for spec in
                project.and_then(|p| p.get("dependencies")).and_then(toml::Value::as_array).into_iter().flatten()
            {
                if let Some(s) = spec.as_str() {
                    let (name, version) = pep508(s);
                    out.push(dep(&name, version, "dependencies", source));
                }
            }
            for (group, specs) in project
                .and_then(|p| p.get("optional-dependencies"))
                .and_then(toml::Value::as_table)
                .into_iter()
                .flatten()
            {
                for s in specs.as_array().into_iter().flatten().filter_map(toml::Value::as_str) {
                    let (name, version) = pep508(s);
                    out.push(dep(&name, version, &format!("optional ({group})"), source));
                }
            }
            let poetry = t.get("tool").and_then(|p| p.get("poetry"));
            for kind in ["dependencies", "dev-dependencies"] {
                for (name, v) in poetry.and_then(|p| p.get(kind)).and_then(toml::Value::as_table).into_iter().flatten()
                {
                    if name == "python" {
                        continue;
                    }
                    let version = v
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| v.get("version").and_then(toml::Value::as_str).map(str::to_owned));
                    out.push(dep(name, version, kind, source));
                }
            }
        }
        _ => {}
    }
    out
}

fn get_project_dependencies() -> Tool {
    Tool::new(
        "get_project_dependencies",
        McpToolKind::Read,
        "The project's dependencies: what its build files declare (package.json, Cargo.toml, go.mod, pyproject.toml, \
Maven POMs) with version, dependency type and declaring file, plus the resolved libraries OpenIDEA shows under \
External Libraries (SDKs, node_modules, Cargo / Go / Maven / Gradle packages).",
        |call| async move {
            let host = call.host();
            let model = ide_host::ops::build::build_model(&host, call.window()).await?;
            let mut deps: Vec<Dependency> = Vec::new();
            for m in scan_manifests(&call) {
                let Ok(text) = std::fs::read_to_string(&m) else { continue };
                deps.extend(manifest_dependencies(&m, &text, &call.display(&m)));
            }
            if let Some(m) = &model.maven {
                for p in &m.projects {
                    for d in &p.dependencies {
                        let name = format!("{}:{}", d.group_id, d.artifact_id);
                        deps.push(dep(&name, d.version.clone(), &d.scope, &p.pom));
                    }
                }
            }
            let libraries =
                tokio::time::timeout(LIBRARY_TIMEOUT, ide_host::ops::sdk::sdk_project_libraries(&host, call.window()))
                    .await;
            let mut out = json!({ "dependencies": deps });
            match libraries {
                Ok(Ok(groups)) => {
                    let groups: Vec<Value> = groups
                        .into_iter()
                        .map(|g| {
                            let total = g.roots.len();
                            let names: Vec<String> =
                                g.roots.into_iter().take(MAX_LIBRARY_ENTRIES).map(|r| r.name).collect();
                            let mut v = json!({ "name": g.name, "kind": g.kind, "entries": names });
                            if total > MAX_LIBRARY_ENTRIES {
                                v["more"] = (total - MAX_LIBRARY_ENTRIES).into();
                            }
                            v
                        })
                        .collect();
                    out["libraries"] = groups.into();
                }
                Ok(Err(e)) => out["librariesError"] = e.message.into(),
                Err(_) => out["librariesTimedOut"] = true.into(),
            }
            Output::json(out)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_qualified_names() {
        assert_eq!(split_fqn("crate::net::connect"), ["crate", "net", "connect"]);
        assert_eq!(split_fqn("com.x.Parser#parse(int, String)"), ["com", "x", "Parser", "parse"]);
        assert_eq!(split_fqn("src/util.ts.format"), ["src", "util", "ts", "format"]);
        assert!(subsequence(&["a".into(), "c".into()], &["a".into(), "b".into(), "c".into()]));
        assert!(!subsequence(&["c".into(), "a".into()], &["a".into(), "b".into(), "c".into()]));
    }

    #[test]
    fn finds_words() {
        assert_eq!(word_at("let größe = 1;", 6).as_deref(), Some("größe"));
        assert_eq!(word_at("foo(bar)", 4).as_deref(), Some("foo"));
        assert_eq!(char_column("a😀b", 4), 3);
        assert_eq!(char_column("a😀b", 1), 1);
        assert_eq!(word_at("  ", 1), None);
    }

    #[test]
    fn converts_columns() {
        // `😀` is two UTF-16 units.
        let line = "a😀b";
        assert_eq!(from_pos(line, Pos::new(0, 3)), (1, 4));
        assert_eq!(from_pos(line, Pos::new(0, 0)), (1, 1));
        let file =
            FileText { language: LanguageId::plain_text(), text: "x\na😀b\n".into(), large: false, served: false };
        assert_eq!(to_pos(&file, 2, 4).unwrap(), Pos::new(1, 3));
        assert!(to_pos(&file, 2, 6).is_err());
        assert!(to_pos(&file, 9, 1).is_err());
    }

    #[test]
    fn reads_manifests() {
        let cargo = r#"
[package]
name = "demo"
[dependencies]
serde = { version = "1", features = ["derive"] }
local = { path = "../local" }
[dev-dependencies]
tempfile = "3"
"#;
        let deps = manifest_dependencies(Path::new("Cargo.toml"), cargo, "Cargo.toml");
        let names: Vec<_> = deps.iter().map(|d| (d.name.as_str(), d.version.as_deref())).collect();
        assert_eq!(names, [("local", Some("path: ../local")), ("serde", Some("1")), ("tempfile", Some("3"))]);
        let gomod = "module x\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgolang.org/x/y v0.1.0 // indirect\n)\nrequire c.io/d v2.0.0\n";
        let deps = manifest_dependencies(Path::new("go.mod"), gomod, "go.mod");
        assert_eq!(deps.len(), 3);
        assert_eq!(deps[1].dependency_type.as_deref(), Some("indirect"));
        let py = "[project]\nname = \"p\"\ndependencies = [\"requests>=2.0\", \"rich\"]\n";
        let deps = manifest_dependencies(Path::new("pyproject.toml"), py, "pyproject.toml");
        assert_eq!(deps[0].name, "requests");
        assert_eq!(deps[0].version.as_deref(), Some(">=2.0"));
        assert_eq!(manifest_module(Path::new("/p/go.mod"), gomod), Some(("x".into(), "go".into())));
    }
}
