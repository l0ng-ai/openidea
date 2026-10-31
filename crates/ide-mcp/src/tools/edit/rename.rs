// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/RefactoringToolset.kt, renameTarget.kt), Apache-2.0.
//! `rename_refactoring` with the language server's rename. The target is given
//! as in JetBrains: a `contextSnippet`, else `line` + `column`, else the one
//! declaration of `symbolName` in the file; `targetIndex` picks from the
//! candidates an earlier call listed. Failures are results (`ok: false` with an
//! `error.kind`), not tool errors, so the agent can correct the call.
//!
//! Symbols are told apart by their definition (go to definition): the language
//! server has no PSI elements to compare. It renames code references only;
//! `searchInComments` / `searchInText` add whole-word occurrences found with
//! Find in Files.

use super::normalize_newlines;
use crate::tool::{Call, Output, Param, ParamType, Tool};
use ide_core::mcp::McpToolKind;
use ide_core::{DocId, FileEdit, IdeError, IdeResult, Pos, Range, TextEdit, WorkspaceEdit};
use ide_host::ops::search::SearchEvent;
use ide_lsp::types::GotoKind;
use ide_search::{SearchContext, SearchQuery, SearchScope};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Occurrences of the name whose definition is looked up when no position is given.
const MAX_LOOKUPS: usize = 50;

/// Files `searchInText` treats as plain text.
const TEXT_EXTENSIONS: &[&str] = &["txt", "text", "md", "markdown", "rst", "adoc", "asciidoc", "properties"];

pub(super) fn rename_refactoring() -> Tool {
    Tool::new(
        "rename_refactoring",
        McpToolKind::Edit,
        "Rename a symbol and every reference to it. Set preview=true to analyze the rename and write nothing.
The language server resolves the symbol, so it also updates a reference that a text search cannot
find. Always prefer this tool over a text replacement.

Point at the symbol with ONE of these, in order of preference: contextSnippet, then line and column.
With neither of them, the file must declare one symbol with this name. symbolName is always required.
A position that resolves to another name refuses the rename.

targetIndex is not a third way to point at the symbol. It picks from a candidates list an earlier call
returned, so repeat that call with every argument it had, and add targetIndex.

Read `applied`. It is the only success signal. Nothing is written in part, except after
error.kind=write_failed, and its hint says what was written.
ok=false with candidates asks you to pick one with targetIndex. ok=false with conflicts asks for another
newName. ok=false with error tells you in `hint` what to correct.

applyAutomaticRenamers has no effect here: the language server renames the symbol and its references. A library or \
compiled symbol cannot be renamed.

By default, the rename changes no comment, no string literal and no plain-text occurrence of the name.
Set searchInComments or searchInText to change them too.",
        |call| async move { run(&call).await },
    )
    .param(Param::required("pathInProject", ParamType::String, "Path relative to the project root"))
    .param(Param::required("symbolName", ParamType::String, "Exact, case-sensitive name of the symbol to rename."))
    .param(Param::required(
        "newName",
        ParamType::String,
        "New name for the symbol. It must be a valid identifier for the symbol's language.",
    ))
    .param(Param::optional(
        "contextSnippet",
        ParamType::String,
        "Optional. Exact fragment of the file that shows the symbol. It must match the file once, and contain \
symbolName.",
    ))
    .param(Param::optional(
        "line",
        ParamType::Integer,
        "Optional. 1-based line of the symbol. Copy it from search_symbol output. Needs column too.",
    ))
    .param(Param::optional(
        "column",
        ParamType::Integer,
        "Optional. 1-based column of the symbol. Copy it from search_symbol output. Needs line too.",
    ))
    .param(Param::optional(
        "targetIndex",
        ParamType::Integer,
        "Optional. 1-based pick from the candidates list an earlier call returned. Repeat every other argument of \
that call.",
    ))
    .param(Param::optional(
        "preview",
        ParamType::Boolean,
        "Optional. Analyze only: report affects and conflicts, and write nothing. The default is false.",
    ))
    .param(Param::optional(
        "applyAutomaticRenamers",
        ParamType::Boolean,
        "Optional. Also rename what the IDE renames along with the symbol. The default is false.",
    ))
    .param(Param::optional(
        "searchInComments",
        ParamType::Boolean,
        "Optional. Also rename the name in comments and string literals. The default is false.",
    ))
    .param(Param::optional(
        "searchInText",
        ParamType::Boolean,
        "Optional. Also rename the name in plain-text occurrences, such as non-code files. The default is false.",
    ))
}

// --- the result ------------------------------------------------------------------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct RenameResult {
    ok: bool,
    applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_symbol: Option<SymbolInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    affects: Option<Affects>,
    #[serde(skip_serializing_if = "Option::is_none")]
    renamed_file: Option<RenamedFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidates: Option<Vec<Candidate>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conflicts: Option<Vec<Conflict>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RenameError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

impl RenameResult {
    fn failed(kind: &'static str, hint: impl Into<String>) -> Self {
        Self { error: Some(RenameError { kind, hint: hint.into() }), ..Self::default() }
    }

    fn with_symbol(mut self, symbol: Option<SymbolInfo>) -> Self {
        self.resolved_symbol = symbol;
        self
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SymbolInfo {
    name: String,
    declaration_text: String,
    declaration_file: String,
    declaration_line: u32,
    language: String,
}

/// The blast radius: files with an edit, and the edits.
#[derive(Serialize)]
struct Affects {
    files: usize,
    usages: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenamedFile {
    previous_path: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    target_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    symbol: SymbolInfo,
}

#[derive(Serialize)]
struct Conflict {
    description: String,
}

#[derive(Serialize)]
struct RenameError {
    kind: &'static str,
    hint: String,
}

// --- the call --------------------------------------------------------------------

struct Request {
    name: String,
    new_name: String,
    snippet: Option<String>,
    position: Option<(i64, i64)>,
    target_index: Option<i64>,
    preview: bool,
    automatic_renamers: bool,
    in_comments: bool,
    in_text: bool,
}

async fn run(call: &Call) -> IdeResult<Output> {
    let raw = call.str("pathInProject")?;
    let name = call.str("symbolName")?;
    let new_name = call.str("newName")?;
    for (value, arg) in [(&raw, "pathInProject"), (&name, "symbolName"), (&new_name, "newName")] {
        if value.trim().is_empty() {
            return Err(IdeError::invalid(format!("{arg} is empty")));
        }
    }
    let (line, column) = (call.opt_i64("line")?, call.opt_i64("column")?);
    if line.is_some() != column.is_some() {
        return Err(IdeError::invalid("line and column must be given together"));
    }
    let request = Request {
        name,
        new_name,
        snippet: call.opt_str("contextSnippet")?,
        position: line.zip(column),
        target_index: call.opt_i64("targetIndex")?,
        preview: call.flag("preview", false)?,
        automatic_renamers: call.flag("applyAutomaticRenamers", false)?,
        in_comments: call.flag("searchInComments", false)?,
        in_text: call.flag("searchInText", false)?,
    };
    let path = call.resolve_inside(&raw)?;
    if !path.is_file() {
        return Err(IdeError::not_found(format!("File not found: {raw}")));
    }
    let host = call.host();
    let project = call.project().clone();
    let (p, target) = (project.clone(), path.clone());
    let (doc, transient) = host.blocking(move || super::open_document(&p, &target)).await?;
    let result = rename(call, doc, &path, &request).await;
    if transient {
        project.documents.close(doc);
    }
    Output::json(result?)
}

async fn rename(call: &Call, doc: DocId, path: &Path, req: &Request) -> IdeResult<RenameResult> {
    let snap = call.project().documents.text_snapshot(doc)?;
    let file = File { call, doc, path, text: &snap.text, language: snap.language.0.clone() };
    let pos = match resolve_target(&file, req).await? {
        Resolution::Resolved(pos) => pos,
        Resolution::Unresolved(kind, hint) => return Ok(RenameResult::failed(kind, hint)),
        Resolution::Ambiguous(positions) => {
            let mut candidates = Vec::new();
            for (i, pos) in positions.iter().enumerate() {
                let (symbol, kind) = file.symbol_at(&req.name, *pos).await;
                candidates.push(Candidate { target_index: i + 1, kind, symbol });
            }
            let hint = format!(
                "'{}' matches {} symbols here. Nothing changed. Call again with every argument of this call plus \
targetIndex, or narrow the call with a contextSnippet that shows the one you mean.",
                req.name,
                positions.len()
            );
            return Ok(RenameResult { candidates: Some(candidates), ..RenameResult::failed("ambiguous_symbol", hint) });
        }
    };
    let symbol = Some(file.symbol_at(&req.name, pos).await.0);
    if req.name == req.new_name {
        let hint = format!("The symbol already has the name '{}'.", req.new_name);
        return Ok(RenameResult::failed("new_name_matches_current", hint).with_symbol(symbol));
    }
    if !plausible_identifier(&req.new_name) {
        let hint = format!("'{}' is not a valid identifier for {}.", req.new_name, file.language);
        return Ok(RenameResult::failed("new_name_invalid", hint).with_symbol(symbol));
    }
    let host = call.host();
    let window = call.window();
    match ide_host::ops::lsp::lsp_prepare_rename(&host, window, doc, pos).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            let hint = "This symbol cannot be renamed. A library or compiled symbol has to change upstream.";
            return Ok(RenameResult::failed("not_renamable", hint).with_symbol(symbol));
        }
        Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => return Err(e),
        Err(e) => return Ok(RenameResult::failed("language_not_supported", no_server_hint(&e)).with_symbol(symbol)),
    }
    let request = crate::tool::request_id();
    let renamed = tokio::select! {
        r = ide_host::ops::lsp::lsp_rename(&host, window, request, doc, pos, req.new_name.clone()) => r,
        _ = call.cancel.cancelled() => {
            host.cancel_request(request);
            return Err(IdeError::cancelled());
        }
    };
    let renamed = match renamed {
        Ok(r) => r,
        Err(e) if e.kind == ide_core::error::ErrorKind::Cancelled => return Err(e),
        // Servers explain a clash with an existing name in the error (gopls: "would conflict with").
        Err(e) if e.message.to_lowercase().contains("conflict") => {
            let hint = "A conflict refused the rename and nothing changed. Choose another newName.";
            let conflicts = Some(vec![Conflict { description: e.message }]);
            return Ok(RenameResult { conflicts, ..RenameResult::failed("conflicts_found", hint) }.with_symbol(symbol));
        }
        Err(e) => return Ok(RenameResult::failed("new_name_refused", e.message).with_symbol(symbol)),
    };
    let mut edit = renamed.edit;
    if edit.files.is_empty() {
        return Ok(RenameResult::failed("unknown", "The language server found nothing to rename.").with_symbol(symbol));
    }
    if req.in_comments || req.in_text {
        add_text_occurrences(call, &mut edit, req).await?;
    }
    for f in &edit.files {
        let paths: Vec<&Path> = match f {
            FileEdit::Edit { path, .. } | FileEdit::Create { path, .. } | FileEdit::Delete { path, .. } => vec![path],
            FileEdit::Rename { from, to } => vec![from, to],
        };
        for p in paths {
            if let Err(e) = crate::project::ensure_inside(call.root(), p) {
                let hint = format!(
                    "{}. Nothing was renamed. A rename that must change a file outside the project cannot run here.",
                    e.message
                );
                return Ok(RenameResult::failed("read_only_usages", hint).with_symbol(symbol));
            }
        }
    }
    let mut files: Vec<&Path> = Vec::new();
    let mut usages = 0;
    for f in &edit.files {
        if let FileEdit::Edit { path, edits } = f {
            usages += edits.len();
            if !files.contains(&&**path) {
                files.push(path);
            }
        }
    }
    let affects = Some(Affects { files: files.len(), usages });
    let mut notes = Vec::new();
    if renamed.incomplete.is_some() {
        notes.push("The language server reported that the references may be incomplete.");
    }
    if req.automatic_renamers {
        notes.push(
            "applyAutomaticRenamers had no effect: the language server renames the symbol and its references only.",
        );
    }
    let note = (!notes.is_empty()).then(|| notes.join(" "));
    if req.preview {
        return Ok(RenameResult { ok: true, affects, resolved_symbol: symbol, note, ..RenameResult::default() });
    }
    let renamed_file = edit.files.iter().find_map(|f| match f {
        FileEdit::Rename { from, to } if super::same_file(from, path) => {
            Some(RenamedFile { previous_path: call.display(from), path: call.display(to) })
        }
        _ => None,
    });
    let touched: Vec<PathBuf> = edit
        .files
        .iter()
        .flat_map(|f| match f {
            FileEdit::Edit { path, .. } | FileEdit::Create { path, .. } | FileEdit::Delete { path, .. } => {
                vec![path.to_path_buf()]
            }
            FileEdit::Rename { from, to } => vec![from.to_path_buf(), to.to_path_buf()],
        })
        .collect();
    let (h, w) = (host.clone(), window.to_owned());
    let written = host.blocking(move || ide_host::ops::lsp::apply_workspace_edit(&h, &w, edit)).await;
    // A failed write may have changed some of the files already.
    for path in &touched {
        call.record_change(path);
    }
    if let Err(e) = written {
        let hint = format!("The rename stopped while it wrote. {} Read the files again before you retry.", e.message);
        return Ok(RenameResult::failed("write_failed", hint).with_symbol(symbol));
    }
    Ok(RenameResult {
        ok: true,
        applied: true,
        resolved_symbol: symbol,
        affects,
        renamed_file,
        note,
        ..RenameResult::default()
    })
}

fn no_server_hint(e: &IdeError) -> String {
    format!(
        "No language server can rename in this file ({}), so nothing was renamed. Without one, change the \
occurrences with apply_patch.",
        e.message
    )
}

/// Refuses only what no language accepts in a name: whitespace, separators, a leading digit.
fn plausible_identifier(name: &str) -> bool {
    !name.starts_with(|c: char| c.is_ascii_digit())
        && !name.chars().any(|c| c.is_whitespace() || c.is_control() || ".,;:()[]{}<>\"'`/\\+*=!?&|^%#~".contains(c))
}

// --- the target ------------------------------------------------------------------

enum Resolution {
    Resolved(Pos),
    /// Several symbols, in document order; `targetIndex` is 1-based.
    Ambiguous(Vec<Pos>),
    Unresolved(&'static str, String),
}

/// The file the rename starts in.
struct File<'a> {
    call: &'a Call,
    doc: DocId,
    path: &'a Path,
    text: &'a str,
    language: String,
}

impl File<'_> {
    fn line(&self, line: u32) -> &str {
        self.text.split('\n').nth(line as usize).unwrap_or("")
    }

    /// Where the symbol at `pos` is defined; `None` without an answer.
    async fn definition(&self, pos: Pos) -> Option<(PathBuf, Pos)> {
        let host = self.call.host();
        let found = ide_host::ops::lsp::lsp_goto(&host, self.call.window(), self.doc, pos, GotoKind::Definition).await;
        let loc = found.ok()?.into_iter().find(|l| l.uri.is_none())?;
        Some((PathBuf::from(&*loc.path), loc.range.start))
    }

    /// Whether the language server can rename at `pos`; `Err` without one.
    async fn renameable(&self, pos: Pos) -> Result<bool, Resolution> {
        let host = self.call.host();
        match ide_host::ops::lsp::lsp_prepare_rename(&host, self.call.window(), self.doc, pos).await {
            Ok(found) => Ok(found.is_some()),
            Err(e) => Err(Resolution::Unresolved("language_not_supported", no_server_hint(&e))),
        }
    }

    /// The symbol (from its definition when known) and its outline kind.
    async fn symbol_at(&self, name: &str, pos: Pos) -> (SymbolInfo, Option<String>) {
        let (file, at) = match self.definition(pos).await {
            Some((file, at)) if super::same_file(&file, self.path) => (self.path.to_path_buf(), at),
            Some((file, at)) => (file, at),
            None => (self.path.to_path_buf(), pos),
        };
        let declaration_text = if file == self.path {
            self.line(at.line).trim().to_owned()
        } else {
            let project = self.call.project();
            project
                .text_of(&file)
                .ok()
                .and_then(|t| t.split('\n').nth(at.line as usize).map(|l| l.trim().to_owned()))
                .unwrap_or_default()
        };
        let kind = if file == self.path { self.kind_at(at).await } else { None };
        let symbol = SymbolInfo {
            name: name.to_owned(),
            declaration_text,
            declaration_file: self.call.display(&file),
            declaration_line: at.line + 1,
            language: self.language.clone(),
        };
        (symbol, kind)
    }

    /// The outline kind (`field`, `method`) of the declaration whose name is at `pos`.
    async fn kind_at(&self, pos: Pos) -> Option<String> {
        let host = self.call.host();
        let outline = ide_host::ops::doc::doc_outline(&host, self.call.window(), self.doc).await.ok()?;
        let mut stack: Vec<&ide_core::OutlineItem> = outline.iter().collect();
        while let Some(item) = stack.pop() {
            let r = item.selection_range;
            if r.start <= pos && pos <= r.end {
                let kind = format!("{:?}", item.kind);
                return Some(kind[..1].to_lowercase() + &kind[1..]);
            }
            stack.extend(item.children.iter());
        }
        None
    }

    /// Positions of `name` as an identifier (outside comments and strings when a grammar knows them).
    async fn identifiers(&self, name: &str) -> Vec<Pos> {
        let host = self.call.host();
        match ide_host::ops::syntax::syntax_identifiers(&host, self.call.window(), self.doc, name.to_owned(), None)
            .await
        {
            Ok(found) if !found.is_empty() => found.into_iter().map(|o| o.range.start).collect(),
            _ => word_positions(self.text, name),
        }
    }
}

/// The symbol the caller pointed at, or why the tool cannot tell which one it is.
/// `targetIndex` picks from the list of the branch the other arguments select.
async fn resolve_target(file: &File<'_>, req: &Request) -> IdeResult<Resolution> {
    let resolution = if let Some(snippet) = &req.snippet {
        by_snippet(file, snippet, &req.name).await
    } else if let Some((line, column)) = req.position {
        by_position(file, line, column, &req.name).await
    } else {
        by_declaration(file, &req.name).await?
    };
    let Some(index) = req.target_index else { return Ok(resolution) };
    Ok(match resolution {
        Resolution::Ambiguous(candidates) => pick(&candidates, index),
        // One symbol now: only a pick of the first agrees with it; the code changed since the list.
        Resolution::Resolved(pos) if index == 1 => Resolution::Resolved(pos),
        Resolution::Resolved(pos) => pick(&[pos], index),
        unresolved => unresolved,
    })
}

fn pick(candidates: &[Pos], index: i64) -> Resolution {
    let n = candidates.len();
    if index < 1 || index as usize > n {
        return Resolution::Unresolved(
            "target_index_out_of_range",
            format!(
                "targetIndex {index} is outside 1..{n}. This call reports {n} candidate(s). Send the same \
pathInProject, symbolName and contextSnippet as the call that listed them."
            ),
        );
    }
    Resolution::Resolved(candidates[index as usize - 1])
}

async fn by_snippet(file: &File<'_>, snippet: &str, name: &str) -> Resolution {
    if snippet.trim().is_empty() {
        return Resolution::Unresolved("snippet_not_found", "contextSnippet is blank.".into());
    }
    let needle = normalize_newlines(snippet);
    if !needle.contains(name) {
        return Resolution::Unresolved(
            "name_mismatch",
            format!("contextSnippet does not contain '{name}'. Pass a snippet that shows the symbol."),
        );
    }
    let Some(start) = file.text.find(&needle) else {
        return Resolution::Unresolved(
            "snippet_not_found",
            "contextSnippet is not in this file. Read the file again and copy the snippet from its current text."
                .into(),
        );
    };
    if file.text[start + 1..].contains(&needle) {
        return Resolution::Unresolved(
            "snippet_not_unique",
            "contextSnippet matches this file more than once. Extend it until it is unique.".into(),
        );
    }
    let before = &file.text[..start];
    let base_line = before.matches('\n').count() as u32;
    let base_col = before.rsplit('\n').next().unwrap_or("").encode_utf16().count() as u32;
    let mut symbols: Vec<(Option<(PathBuf, Pos)>, Pos)> = Vec::new();
    for p in word_positions(&needle, name) {
        let pos = if p.line == 0 { Pos::new(base_line, base_col + p.col) } else { Pos::new(base_line + p.line, p.col) };
        match file.renameable(pos).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(no_server) => return no_server,
        }
        let definition = file.definition(pos).await;
        if definition.is_none() || !symbols.iter().any(|(d, _)| *d == definition) {
            symbols.push((definition, pos));
        }
    }
    match symbols.len() {
        0 => Resolution::Unresolved(
            "symbol_not_found",
            format!("'{name}' inside contextSnippet does not resolve to a symbol that can be renamed."),
        ),
        1 => Resolution::Resolved(symbols[0].1),
        _ => Resolution::Ambiguous(symbols.into_iter().map(|(_, p)| p).collect()),
    }
}

async fn by_position(file: &File<'_>, line: i64, column: i64, name: &str) -> Resolution {
    let line_count = file.text.split('\n').count() as i64;
    if line < 1 || column < 1 || line > line_count {
        return Resolution::Unresolved(
            "position_out_of_bounds",
            format!("Position {line}:{column} is outside this file. Both numbers are 1-based."),
        );
    }
    let text = file.line(line as u32 - 1);
    let units: Vec<u16> = text.encode_utf16().collect();
    // The column has to stay on the named line: past its end it would land further down.
    if column as usize - 1 > units.len() {
        return Resolution::Unresolved(
            "position_out_of_bounds",
            format!("Column {column} is past the end of line {line}. Both numbers are 1-based."),
        );
    }
    let pos = Pos::new(line as u32 - 1, column as u32 - 1);
    let word = word_at(&units, pos.col as usize);
    let in_code = file
        .identifiers(name)
        .await
        .iter()
        .any(|p| p.line == pos.line && p.col <= pos.col && pos.col <= p.col + units_len(name));
    match word {
        Some((start, w)) if w == name && in_code => {
            let at = Pos::new(pos.line, start as u32);
            match file.renameable(at).await {
                Ok(true) => Resolution::Resolved(at),
                Ok(false) => Resolution::Unresolved(
                    "symbol_not_found",
                    format!("No symbol that can be renamed sits at {line}:{column}."),
                ),
                Err(no_server) => no_server,
            }
        }
        Some((_, other)) if other != name => Resolution::Unresolved(
            "name_mismatch",
            format!("Position {line}:{column} resolves to '{other}', not to '{name}'. Nothing was renamed."),
        ),
        _ => Resolution::Unresolved(
            "symbol_not_found",
            format!("No symbol that can be renamed sits at {line}:{column}."),
        ),
    }
}

/// The declarations of `name` in this file: the distinct definitions of its occurrences
/// that lie in this file (declared-looking occurrences without go to definition).
async fn by_declaration(file: &File<'_>, name: &str) -> IdeResult<Resolution> {
    let occurrences = file.identifiers(name).await;
    let mut declarations: Vec<Pos> = Vec::new();
    let mut answered = false;
    for pos in occurrences.iter().take(MAX_LOOKUPS) {
        if file.call.cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if let Some((path, at)) = file.definition(*pos).await {
            answered = true;
            if super::same_file(&path, file.path) && !declarations.contains(&at) {
                declarations.push(at);
            }
        }
    }
    if !answered {
        declarations = occurrences.into_iter().filter(|p| is_declaration(file.text, *p)).collect();
    }
    declarations.sort();
    Ok(match declarations.len() {
        0 => Resolution::Unresolved(
            "symbol_not_found",
            format!("No symbol named '{name}' is declared in this file. Pass the file that declares it."),
        ),
        1 => Resolution::Resolved(declarations[0]),
        _ => Resolution::Ambiguous(declarations),
    })
}

fn units_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

fn is_word_unit(u: u16) -> bool {
    char::from_u32(u as u32).is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$') || u >= 0x80
}

/// The identifier-like word touching UTF-16 column `col`: (start column, word).
fn word_at(units: &[u16], col: usize) -> Option<(usize, String)> {
    let touches = |i: usize| units.get(i).is_some_and(|&u| is_word_unit(u));
    let at = if touches(col) {
        col
    } else if col > 0 && touches(col - 1) {
        col - 1
    } else {
        return None;
    };
    let start = (0..=at).rev().take_while(|&i| touches(i)).last().unwrap_or(at);
    let end = (at..units.len()).take_while(|&i| touches(i)).last().map_or(at, |e| e + 1);
    Some((start, String::from_utf16_lossy(&units[start..end])))
}

/// Whole-word occurrences of `name` (0-based line, UTF-16 column).
fn word_positions(text: &str, name: &str) -> Vec<Pos> {
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    let mut out = Vec::new();
    for (line_no, line) in text.split('\n').enumerate() {
        for (at, _) in line.match_indices(name) {
            let before = line[..at].chars().next_back();
            let after = line[at + name.len()..].chars().next();
            if before.is_some_and(is_word) || after.is_some_and(is_word) {
                continue;
            }
            out.push(Pos::new(line_no as u32, units_len(&line[..at])));
        }
    }
    out
}

/// Words that introduce a declaration of the name after them.
const DECLARATION_KEYWORDS: &[&str] = &[
    "fn",
    "def",
    "class",
    "struct",
    "enum",
    "trait",
    "interface",
    "type",
    "func",
    "function",
    "fun",
    "let",
    "const",
    "var",
    "val",
    "mod",
    "module",
    "object",
    "record",
    "typealias",
    "protocol",
    "union",
    "namespace",
    "package",
    "static",
    "macro_rules!",
];

/// Whether the occurrence at `p` follows a declaration keyword (`fn name`, `let mut name`).
fn is_declaration(text: &str, p: Pos) -> bool {
    let Some(line) = text.split('\n').nth(p.line as usize) else { return false };
    let mut units = 0u32;
    let byte = line
        .char_indices()
        .find(|(_, c)| {
            let here = units >= p.col;
            units += c.len_utf16() as u32;
            here
        })
        .map_or(line.len(), |(i, _)| i);
    let mut words = line[..byte].split_whitespace().rev();
    match words.next() {
        Some("mut") => words.next() == Some("let"),
        Some(w) => DECLARATION_KEYWORDS.contains(&w),
        None => false,
    }
}

// --- comments and text -------------------------------------------------------------

/// Adds whole-word occurrences of the old name to `edit`: in comments and string
/// literals of the files it changes, and in plain-text files of the project.
async fn add_text_occurrences(call: &Call, edit: &mut WorkspaceEdit, req: &Request) -> IdeResult<()> {
    let edited: Vec<PathBuf> = edit
        .files
        .iter()
        .filter_map(|f| match f {
            FileEdit::Edit { path, .. } => Some(path.to_path_buf()),
            _ => None,
        })
        .collect();
    let mut found = Vec::new();
    if req.in_comments {
        let scope = || SearchScope::Files { paths: edited.iter().cloned().map(Into::into).collect() };
        found.extend(occurrences(call, &req.name, scope(), SearchContext::InComments).await?);
        found.extend(occurrences(call, &req.name, scope(), SearchContext::InStringLiterals).await?);
    }
    if req.in_text {
        let text_file = |p: &Path| {
            p.extension().and_then(|e| e.to_str()).is_some_and(|e| TEXT_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        };
        found.extend(
            occurrences(call, &req.name, SearchScope::Project, SearchContext::Any)
                .await?
                .into_iter()
                .filter(|(p, _)| text_file(p) && !edited.iter().any(|e| super::same_file(e, p))),
        );
    }
    for (path, range) in found {
        let text_edit = TextEdit { range, new_text: req.new_name.clone() };
        let entry = edit.files.iter_mut().find_map(|f| match f {
            FileEdit::Edit { path: p, edits } if super::same_file(p, &path) => Some(edits),
            _ => None,
        });
        match entry {
            Some(edits) => {
                let overlaps =
                    edits.iter().any(|e| e.range.start < range.end && range.start < e.range.end || e.range == range);
                if !overlaps {
                    edits.push(text_edit);
                }
            }
            None => edit.files.push(FileEdit::Edit { path: path.into(), edits: vec![text_edit] }),
        }
    }
    Ok(())
}

/// Whole-word, case-sensitive Find in Files matches of `name`.
async fn occurrences(
    call: &Call,
    name: &str,
    scope: SearchScope,
    context: SearchContext,
) -> IdeResult<Vec<(PathBuf, Range)>> {
    let query = SearchQuery {
        pattern: name.to_owned(),
        is_regex: false,
        case_sensitive: true,
        whole_word: true,
        include: Vec::new(),
        exclude: Vec::new(),
        scope,
        max_matches: 0,
        context,
    };
    let host = call.host();
    let request = crate::tool::request_id();
    let files = Arc::new(Mutex::new(Vec::new()));
    let emit: ide_host::ops::Emit<SearchEvent> = {
        let files = files.clone();
        Arc::new(move |event| {
            if let SearchEvent::File { file } = event {
                files.lock().push(file);
            }
        })
    };
    let search = ide_host::ops::search::start(&host, call.window(), request, query, emit);
    tokio::pin!(search);
    tokio::select! {
        r = &mut search => r?,
        _ = call.cancel.cancelled() => {
            host.cancel_request(request);
            let _ = search.await;
            return Err(IdeError::cancelled());
        }
    }
    let width = units_len(name);
    let mut out = Vec::new();
    for file in std::mem::take(&mut *files.lock()) {
        for m in &file.matches {
            for &(from, _) in &m.ranges {
                let start = Pos::new(m.line, m.text_offset + from);
                out.push((file.path.to_path_buf(), Range::new(start, Pos::new(m.line, start.col + width))));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_whole_words_in_utf16_columns() {
        let text = "let foo = foo_bar + foo;\n// ä foo\nfoofoo";
        assert_eq!(word_positions(text, "foo"), vec![Pos::new(0, 4), Pos::new(0, 20), Pos::new(1, 5)]);
        let units: Vec<u16> = "  int counter;".encode_utf16().collect();
        assert_eq!(word_at(&units, 6), Some((6, "counter".into())));
        assert_eq!(word_at(&units, 13), Some((6, "counter".into())));
        assert_eq!(word_at(&units, 0), None);
    }

    #[test]
    fn recognizes_declarations_and_identifiers() {
        let text = "use x;\nprint(count)\nlet mut count = 1;\nfn count() {}\n";
        assert!(!is_declaration(text, Pos::new(1, 6)));
        assert!(is_declaration(text, Pos::new(2, 8)) && is_declaration(text, Pos::new(3, 3)));
        assert!(plausible_identifier("hitCount") && plausible_identifier("kebab-case") && plausible_identifier("$x"));
        assert!(!plausible_identifier("1abc") && !plausible_identifier("bad name") && !plausible_identifier("a.b"));
    }
}
