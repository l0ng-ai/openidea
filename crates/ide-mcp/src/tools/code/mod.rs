//! Code insight and analysis: symbol info, problems, call hierarchy, modules, dependencies.
//!
//! The JetBrains tools run IntelliJ's inspections and PSI; here language servers do that
//! work, with tree-sitter (syntax errors) and the symbol index as fallbacks. Contracts
//! (parameters, defaults, result shapes, messages) follow the JetBrains MCP server.
//!
//! Language server features need the file as an open document. A call takes
//! its own reference ([`Docs`]) and gives it back when it ends (also on timeout
//! or cancellation), so a buffer the user has open stays open and nothing
//! opened here outlives the call. Files no installed language server serves are
//! never opened (that would start one, or offer to install it).
//!
//! Lines are 1-based, columns 1-based UTF-16 code units, like the search tools'.

mod calls;
mod html;
mod problems;
mod project_model;
mod symbol;

use crate::tool::{Call, Tool};
use ide_core::{DocId, IdeError, IdeResult, LanguageId, Pos, Range};
use ide_host::Project;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub fn tools() -> Vec<Tool> {
    vec![
        symbol::get_symbol_info(),
        problems::get_file_problems(),
        problems::lint_files(),
        calls::analyze_calls(),
        project_model::get_project_modules(),
        project_model::get_project_dependencies(),
    ]
}

/// JetBrains' `Constants.TIMEOUT_MILLISECONDS_DESCRIPTION`.
const TIMEOUT_DESCRIPTION: &str = "Timeout in milliseconds";
/// JetBrains' `Constants.RELATIVE_PATH_IN_PROJECT_DESCRIPTION`.
const RELATIVE_PATH_DESCRIPTION: &str = "Path relative to the project root";
/// JetBrains' `Constants.TIMED_OUT_DESCRIPTION`.
const TIMED_OUT_DESCRIPTION: &str = "Indicates whether the operation was timed out. 'true' value may mean that the \
results may be incomplete or partial. 'false', 'null' or missing value means that the operation has not been timed out.";
/// JetBrains' `INDEXING_PARTIAL_RESULT_REASON` (`analysis.util.kt`).
const INDEXING_PARTIAL_RESULT_REASON: &str =
    "Project indexing was in progress; results may be incomplete — retry once indexing completes.";

/// A `timeout` argument in milliseconds; negative counts as 0 (time is up at once).
fn timeout_ms(call: &Call, default: u64) -> IdeResult<u64> {
    Ok(call.opt_i64("timeout")?.map_or(default, |ms| ms.max(0) as u64))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// Whether the symbol index is (re)building: answers built on it may miss symbols.
fn indexing(project: &Project) -> bool {
    project.index.status().indexing
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

/// Why a file has no text to analyse.
enum Unloadable {
    Binary,
    TooLarge,
    Unreadable,
}

fn load_text(project: &Project, path: &Path) -> Result<FileText, Unloadable> {
    if let Some(doc) = project.documents.by_path(path)
        && let Ok(snap) = project.documents.text_snapshot(doc)
    {
        return Ok(FileText { language: snap.language, text: snap.text, large: snap.large, served: !snap.large });
    }
    let loaded = project.documents.load_file(path).map_err(|_| Unloadable::Unreadable)?;
    if loaded.binary {
        return Err(Unloadable::Binary);
    }
    if loaded.too_large {
        return Err(Unloadable::TooLarge);
    }
    let text = loaded.text.replace("\r\n", "\n").replace('\r', "\n");
    let language = project.languages.detect(path, text.lines().next());
    let served = !loaded.large && project.lsp.serves_path(path);
    Ok(FileText { language, text, large: loaded.large, served })
}

/// Inside the project directory or one of its content roots (JetBrains' `isInProjectDirectories`).
fn inside_project(project: &Project, path: &Path) -> bool {
    let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let path = canon(path);
    std::iter::once(project.root.clone()).chain(project.content_roots()).any(|root| path.starts_with(canon(&root)))
}

/// JetBrains' `resolveExistingRegularFileInProject`: a project file that exists, or the call fails.
fn resolve_existing_file(call: &Call, requested: &str) -> IdeResult<PathBuf> {
    let path = call.resolve(requested)?;
    if !inside_project(call.project(), &path) {
        return Err(IdeError::invalid(format!(
            "Specified path '{}' points to the location outside of the project directory",
            path.display()
        )));
    }
    match std::fs::metadata(&path) {
        Err(_) => Err(IdeError::not_found(format!("File not found: {requested}"))),
        Ok(m) if !m.is_file() => Err(IdeError::invalid(format!("Not a file: {requested}"))),
        Ok(_) => Ok(path),
    }
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

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// The identifier at (or just before) 1-based character `column` of `line`.
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

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", &s[..cut]),
        None => s.to_owned(),
    }
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

/// Where `name` starts at or after `range.start` (the range may cover a whole declaration).
fn name_position(text: &str, name: &str, range: Range) -> Pos {
    let lines: Vec<&str> = text.split('\n').collect();
    let last = (range.end.line.max(range.start.line + 3) as usize).min(lines.len().saturating_sub(1));
    for l in range.start.line as usize..=last {
        let Some(line) = lines.get(l) else { break };
        let from = if l == range.start.line as usize { utf16_to_byte(line, range.start.col) } else { 0 };
        let mut search = from;
        while let Some(i) = line[search..].find(name) {
            let at = search + i;
            let before = line[..at].chars().next_back();
            let after = line[at + name.len()..].chars().next();
            if !before.is_some_and(is_word) && !after.is_some_and(is_word) {
                return Pos::new(l as u32, line[..at].encode_utf16().count() as u32);
            }
            search = at + name.len();
        }
    }
    range.start
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_words() {
        assert_eq!(word_at("let größe = 1;", 6).as_deref(), Some("größe"));
        assert_eq!(word_at("foo(bar)", 4).as_deref(), Some("foo"));
        assert_eq!(char_column("a😀b", 4), 3);
        assert_eq!(char_column("a😀b", 1), 1);
        assert_eq!(word_at("  ", 1), None);
    }

    #[test]
    fn finds_names_in_declarations() {
        let text = "pub fn run_all() {}\n/// x\nfn run() {}\n";
        let range = Range::new(Pos::new(2, 0), Pos::new(2, 11));
        assert_eq!(name_position(text, "run", range), Pos::new(2, 3));
        assert_eq!(name_position("a😀 run", "run", Range::new(Pos::new(0, 0), Pos::new(0, 0))), Pos::new(0, 4));
    }
}
