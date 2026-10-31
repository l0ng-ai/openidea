//! Text, regex, file and symbol search.
//!
//! Coordinates are 1-based, end exclusive; columns count UTF-16 code units like
//! the editor (one per character except emoji and other astral characters).

use crate::tool::{Call, Output, Param, ParamType, Tool};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ide_core::mcp::McpToolKind;
use ide_core::{CancellationToken, IdeError, IdeResult, Location, Range, RequestId};
use ide_host::ops::search::SearchEvent;
use ide_search::{FileMask, FileMatches, SearchQuery, SearchScope, SearchSummary};
use ide_vfs::EntryKind;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1000;
/// Symbols requested from the index per result when `paths` filters them afterwards.
const SYMBOL_POOL_FACTOR: usize = 20;
const MAX_SYMBOL_POOL: usize = 20_000;
const LSP_TIMEOUT: Duration = Duration::from_secs(15);

const PATHS: &str = "Optional project-relative glob patterns that limit the search, e.g. [\"src/**\", \"!**/test/**\"], \
[\"**/*.kt\"], [\"foo/\"]. A leading `!` excludes; a trailing `/` means everything below; a pattern without `/` \
matches at any depth (`*.rs` = `**/*.rs`); a pattern naming a directory covers the files below it.";
const LIMIT: &str = "Maximum number of results (default 100, at most 1000)";

pub fn tools() -> Vec<Tool> {
    vec![search_text(), search_regex(), search_file(), search_symbol()]
}

fn search_text() -> Tool {
    Tool::new(
        "search_text",
        McpToolKind::Read,
        "Finds a literal substring (case-sensitive) in the project's files, like Find in Files: unsaved editor \
changes are searched, ignored and excluded files are not. Returns `entries` of `{filePath, line, column, endLine, \
endColumn, lineText}` (1-based, end exclusive) sorted by file and line, and `more: true` when `limit` cut the \
results. Prefer it to grep.",
        |call| async move { text_search(call, false).await },
    )
    .param(Param::required("q", ParamType::String, "The text to find"))
    .param(Param::optional("paths", ParamType::StringList, PATHS))
    .param(Param::optional("limit", ParamType::Integer, LIMIT))
}

fn search_regex() -> Tool {
    Tool::new(
        "search_regex",
        McpToolKind::Read,
        "Finds matches of a regular expression (Rust regex syntax, case-sensitive; prefix `(?i)` to ignore case) \
in the project's files, like Find in Files: unsaved editor changes are searched, ignored and excluded files are not. \
`^`/`$` match at line boundaries; a pattern containing `\\n` can match across lines. Returns `entries` of \
`{filePath, line, column, endLine, endColumn, lineText}` (1-based, end exclusive) sorted by file and line, and \
`more: true` when `limit` cut the results.",
        |call| async move { text_search(call, true).await },
    )
    .param(Param::required("q", ParamType::String, "The regular expression"))
    .param(Param::optional("paths", ParamType::StringList, PATHS))
    .param(Param::optional("limit", ParamType::Integer, LIMIT))
}

fn search_file() -> Tool {
    Tool::new(
        "search_file",
        McpToolKind::Read,
        "Finds project files whose project-relative path matches a glob, e.g. `**/*.kt`, `src/**/Foo*.java`, \
`build.gradle.kts` (a glob without `/` matches the file name at any depth). Ignored and excluded files are left out \
unless `includeExcluded` is true. Returns `entries` of `{filePath}` sorted by path, and `more: true` when `limit` cut \
the results.",
        |call| async move { file_search(call).await },
    )
    .param(Param::required("q", ParamType::String, "The glob the file paths must match"))
    .param(Param::optional("paths", ParamType::StringList, PATHS))
    .param(Param::optional(
        "includeExcluded",
        ParamType::Boolean,
        "Also search ignored (.gitignore) and excluded files, e.g. build output or node_modules (default false)",
    ))
    .param(Param::optional("limit", ParamType::Integer, LIMIT))
}

fn search_symbol() -> Tool {
    Tool::new(
        "search_symbol",
        McpToolKind::Read,
        "Finds declarations (classes, functions, methods, fields, ...) by a fragment of their name, like Go to \
Symbol: fuzzy and CamelHumps aware (`OCo` finds `OrderController`), best matches first. Searches the project's \
symbol index; with `include_external` the running language servers are asked too, which can add library and SDK \
symbols. Returns `entries` of `{name, kind, container?, filePath, line, column, endLine, endColumn}` (1-based, end \
exclusive), `more: true` when `limit` cut the results, and `indexing: true` while the index is still being built.",
        |call| async move { symbol_search(call).await },
    )
    .param(Param::required("q", ParamType::String, "The name or a fragment of it"))
    .param(Param::optional("paths", ParamType::StringList, PATHS))
    .param(Param::optional(
        "include_external",
        ParamType::Boolean,
        "Also ask the language servers, for library and SDK symbols (default false). Try it when the project \
has no suitable match.",
    ))
    .param(Param::optional("limit", ParamType::Integer, LIMIT))
}

// --- path globs ----------------------------------------------------------------

/// The `paths` argument: project-relative globs, `!` excludes.
struct PathScope {
    include: GlobSet,
    exclude: GlobSet,
    has_include: bool,
    /// The globs as `FileMask` masks for Find in Files, `None` when they cannot be
    /// expressed (`FileMask` splits on commas, which `{a,b}` contains).
    masks: Option<(Vec<String>, Vec<String>)>,
}

impl PathScope {
    fn new(patterns: &[String]) -> IdeResult<Self> {
        let (mut include, mut exclude) = (GlobSetBuilder::new(), GlobSetBuilder::new());
        let (mut include_masks, mut exclude_masks) = (Vec::new(), Vec::new());
        let mut has_include = false;
        let mut maskable = true;
        for raw in patterns {
            let raw = raw.trim();
            let (negated, pattern) = match raw.strip_prefix('!') {
                Some(rest) => (true, rest.trim()),
                None => (false, raw),
            };
            if pattern.is_empty() {
                continue;
            }
            let glob = normalize_glob(pattern);
            maskable &= !glob.contains(',');
            // A glob naming a directory covers the files below it.
            let (set, masks) =
                if negated { (&mut exclude, &mut exclude_masks) } else { (&mut include, &mut include_masks) };
            for g in [glob.clone(), format!("{glob}/**")] {
                set.add(build_glob(&g, pattern)?);
                masks.push(g);
            }
            has_include |= !negated;
        }
        let build = |b: GlobSetBuilder| b.build().map_err(|e| IdeError::invalid(format!("Invalid path glob: {e}")));
        Ok(Self {
            include: build(include)?,
            exclude: build(exclude)?,
            has_include,
            masks: maskable.then_some((include_masks, exclude_masks)),
        })
    }

    fn is_all(&self) -> bool {
        !self.has_include && self.exclude.is_empty()
    }

    /// `rel` is project-relative with `/`.
    fn matches(&self, rel: &str) -> bool {
        (!self.has_include || self.include.is_match(rel)) && !self.exclude.is_match(rel)
    }
}

/// `dir/` → `dir/**`, `name` → `**/name`, a leading `./` or `/` dropped.
fn normalize_glob(pattern: &str) -> String {
    let p = pattern.replace('\\', "/");
    let p = p.trim_start_matches("./").trim_start_matches('/');
    let p = match p.strip_suffix('/') {
        Some(dir) => format!("{dir}/**"),
        None => p.to_owned(),
    };
    if p.contains('/') { p } else { format!("**/{p}") }
}

fn build_glob(glob: &str, original: &str) -> IdeResult<globset::Glob> {
    GlobBuilder::new(glob)
        .literal_separator(true)
        .backslash_escape(false)
        .case_insensitive(cfg!(any(target_os = "macos", target_os = "windows")))
        .build()
        .map_err(|e| IdeError::invalid(format!("Invalid glob `{original}`: {}", e.kind())))
}

fn limit(call: &Call) -> IdeResult<usize> {
    call.count("limit", DEFAULT_LIMIT, MAX_LIMIT)
}

fn query(call: &Call) -> IdeResult<String> {
    let q = call.str("q")?;
    if q.is_empty() {
        return Err(IdeError::invalid("`q` is empty"));
    }
    Ok(q)
}

/// A request id the UI never allocates (its ids stay below `0x8000_0000`).
fn next_request() -> RequestId {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    RequestId(0x8000_0000 | (NEXT.fetch_add(1, Ordering::Relaxed) & 0x7fff_ffff))
}

// --- text / regex --------------------------------------------------------------

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct TextEntry {
    file_path: String,
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
    line_text: String,
}

#[derive(Serialize)]
struct Entries<T> {
    entries: Vec<T>,
    more: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    indexing: bool,
}

async fn text_search(call: Call, is_regex: bool) -> IdeResult<Output> {
    let pattern = query(&call)?;
    let limit = limit(&call)?;
    let scope = PathScope::new(&call.str_list("paths")?)?;
    let (include, exclude) = scope.masks.clone().unwrap_or_default();
    let query = SearchQuery {
        pattern: pattern.clone(),
        is_regex,
        case_sensitive: true,
        whole_word: false,
        include,
        exclude,
        scope: SearchScope::Project,
        // One more than asked tells whether there are more.
        max_matches: (limit + 1) as u32,
        context: Default::default(),
    };
    let (mut files, summary) = run_search(&call, query.clone()).await?;
    files.retain(|f| scope.matches(&f.rel_path));
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    // Only these can match a line break.
    let may_span = is_regex || pattern.contains('\n');
    let mut entries = Vec::new();
    let mut spanning = Vec::new();
    for file in &files {
        for m in &file.matches {
            let line_end = m.text_offset + m.text.encode_utf16().count() as u32;
            for &(a, b) in &m.ranges {
                let (a, b) = (m.text_offset + a, m.text_offset + b);
                if may_span && b == line_end && entries.len() < limit {
                    spanning.push((entries.len(), file.path.0.clone()));
                }
                entries.push(TextEntry {
                    file_path: file.rel_path.clone(),
                    line: m.line + 1,
                    column: a + 1,
                    end_line: m.line + 1,
                    end_column: b + 1,
                    line_text: m.text.trim_end().to_owned(),
                });
            }
        }
    }
    let more = entries.len() > limit || summary.limit_hit;
    entries.truncate(limit);
    extend_spanning(&call, &query, &mut entries, spanning).await;
    Output::json(Entries { entries, more, indexing: false })
}

/// A file's path, text, line start offsets and match byte ranges.
type FileText = (std::path::PathBuf, String, Vec<usize>, Vec<(usize, usize)>);

/// Find in Files reports only the first line of a match that spans lines: matches
/// ending at a line end get their real end from matching the file's text again.
async fn extend_spanning(
    call: &Call,
    query: &SearchQuery,
    entries: &mut [TextEntry],
    spanning: Vec<(usize, std::path::PathBuf)>,
) {
    let host = call.host();
    let mut current: Option<FileText> = None;
    for (i, path) in spanning {
        if current.as_ref().is_none_or(|(p, ..)| p != &path) {
            let Ok(text) = ide_host::ops::fs::read_text(&host, call.window(), path.clone()).await else { continue };
            let Ok(ranges) = ide_search::match_ranges(&text, query) else { continue };
            let starts = std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1)).collect();
            current = Some((path, text, starts, ranges));
        }
        let Some((_, text, starts, ranges)) = &current else { continue };
        let e = &mut entries[i];
        let Some(&line_start) = starts.get(e.line as usize - 1) else { continue };
        let Some(start) = byte_at(&text[line_start..], e.column - 1).map(|b| line_start + b) else { continue };
        let Ok(found) = ranges.binary_search_by_key(&start, |r| r.0) else { continue };
        let end = ranges[found].1;
        let end_line = starts.partition_point(|&s| s <= end) - 1;
        e.end_line = end_line as u32 + 1;
        e.end_column = text[starts[end_line]..end].encode_utf16().count() as u32 + 1;
    }
}

/// The byte offset of UTF-16 column `col` in `line`.
fn byte_at(line: &str, col: u32) -> Option<usize> {
    let mut units = 0;
    for (i, c) in line.char_indices() {
        if units == col {
            return Some(i);
        }
        units += c.len_utf16() as u32;
    }
    (units == col).then_some(line.len())
}

/// Runs Find in Files, cancelling it when the call is cancelled.
async fn run_search(call: &Call, query: SearchQuery) -> IdeResult<(Vec<FileMatches>, SearchSummary)> {
    let host = call.host();
    let request = next_request();
    let files = Arc::new(Mutex::new(Vec::new()));
    let done = Arc::new(Mutex::new(None));
    let emit: ide_host::ops::Emit<SearchEvent> = {
        let (files, done) = (files.clone(), done.clone());
        Arc::new(move |event| match event {
            SearchEvent::File { file } => files.lock().push(file),
            SearchEvent::Done { summary } => *done.lock() = Some(summary),
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
    let summary = done.lock().take().unwrap_or_default();
    if summary.cancelled {
        return Err(IdeError::cancelled());
    }
    let files = std::mem::take(&mut *files.lock());
    Ok((files, summary))
}

// --- files ---------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    file_path: String,
}

async fn file_search(call: Call) -> IdeResult<Output> {
    let q = query(&call)?;
    let limit = limit(&call)?;
    let scope = PathScope::new(&call.str_list("paths")?)?;
    let include_excluded = call.flag("includeExcluded", false)?;
    let glob = GlobSetBuilder::new()
        .add(build_glob(&normalize_glob(&q), &q)?)
        .build()
        .map_err(|e| IdeError::invalid(format!("Invalid glob `{q}`: {e}")))?;
    // Ignored names and "Exclude files" patterns, which `read_dir` does not flag.
    let excludes = if include_excluded { None } else { Some(FileMask::new(&[], &call.project().search_excludes())?) };
    let host = call.host();
    let walk = Walk {
        host: host.clone(),
        window: call.window().to_owned(),
        root: call.root().to_path_buf(),
        include_excluded,
        excludes,
        glob,
        scope,
        limit,
        cancel: call.cancel.clone(),
    };
    let (paths, more) = host
        .blocking(move || {
            let mut found = Vec::new();
            let more = walk.dir(&walk.root, &mut found);
            if walk.cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            Ok((found, more))
        })
        .await?;
    let entries = paths.into_iter().map(|file_path| FileEntry { file_path }).collect();
    Output::json(Entries { entries, more, indexing: false })
}

struct Walk {
    host: Arc<ide_host::Host>,
    window: String,
    root: std::path::PathBuf,
    include_excluded: bool,
    excludes: Option<FileMask>,
    glob: GlobSet,
    scope: PathScope,
    limit: usize,
    cancel: CancellationToken,
}

impl Walk {
    /// Collects matching files depth first in name order; true when more than `limit` match.
    fn dir(&self, dir: &Path, found: &mut Vec<String>) -> bool {
        let Ok(mut entries) = ide_host::ops::fs::read_dir(&self.host, &self.window, dir.to_path_buf()) else {
            return false;
        };
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        for entry in entries {
            if self.cancel.is_cancelled() {
                return false;
            }
            if entry.name == ".git" || (!self.include_excluded && (entry.ignored || entry.excluded)) {
                continue;
            }
            let Ok(rel) = entry.path.strip_prefix(&self.root) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if self.excludes.as_ref().is_some_and(|m| !m.matches(&rel)) {
                continue;
            }
            match entry.kind {
                // Symlinked directories are not followed (they may loop).
                EntryKind::Dir => {
                    if self.dir(&entry.path, found) {
                        return true;
                    }
                }
                EntryKind::File if self.glob.is_match(&rel) && self.scope.matches(&rel) => {
                    if found.len() == self.limit {
                        return true;
                    }
                    found.push(rel);
                }
                _ => {}
            }
        }
        false
    }
}

// --- symbols -------------------------------------------------------------------

#[derive(Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SymbolEntry {
    name: String,
    kind: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    container: Option<String>,
    file_path: String,
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
}

impl SymbolEntry {
    fn new(name: String, kind: ide_core::SymbolKind, container: Option<String>, file_path: String, r: Range) -> Self {
        Self {
            name,
            kind: serde_json::to_value(kind).unwrap_or(Value::Null),
            container: container.filter(|c| !c.is_empty()),
            file_path,
            line: r.start.line + 1,
            column: r.start.col + 1,
            end_line: r.end.line + 1,
            end_column: r.end.col + 1,
        }
    }
}

async fn symbol_search(call: Call) -> IdeResult<Output> {
    let q = query(&call)?;
    let limit = limit(&call)?;
    let scope = PathScope::new(&call.str_list("paths")?)?;
    let external = call.flag("include_external", false)?;
    let host = call.host();
    let project = call.project().clone();
    let indexing = project.index.status().indexing;
    let pool = if scope.is_all() { limit + 1 } else { ((limit + 1) * SYMBOL_POOL_FACTOR).min(MAX_SYMBOL_POOL) };
    let found = {
        let (project, q) = (project.clone(), q.clone());
        host.blocking(move || Ok(project.index.find_symbols(&q, ide_index::SymbolFilter::All, pool))).await?
    };
    let mut entries: Vec<SymbolEntry> = found
        .into_iter()
        .filter(|s| scope.matches(&s.rel_path))
        .map(|s| SymbolEntry::new(s.name, s.kind, s.container, s.rel_path, s.range))
        .collect();
    if external && entries.len() <= limit {
        for (name, kind, container, location) in workspace_symbols(&call, &q).await {
            let path = location.uri.clone().unwrap_or_else(|| call.display(&location.path));
            // Project files obey `paths`; library symbols are what was asked for.
            let inside = location.uri.is_none() && !Path::new(&path).is_absolute();
            if inside && !scope.matches(&path) {
                continue;
            }
            let entry = SymbolEntry::new(name, kind, container, path, location.range);
            if !entries.iter().any(|e| e.name == entry.name && e.file_path == entry.file_path && e.line == entry.line) {
                entries.push(entry);
            }
            if entries.len() > limit {
                break;
            }
        }
    }
    let more = entries.len() > limit;
    entries.truncate(limit);
    Output::json(Entries { entries, more, indexing })
}

/// The language servers' workspace symbols; empty when none runs or they fail.
async fn workspace_symbols(call: &Call, q: &str) -> Vec<(String, ide_core::SymbolKind, Option<String>, Location)> {
    let host = call.host();
    let request = next_request();
    let symbols = ide_host::ops::lsp::lsp_workspace_symbols(&host, call.window(), request, q.to_owned());
    tokio::pin!(symbols);
    let result = tokio::select! {
        r = tokio::time::timeout(LSP_TIMEOUT, &mut symbols) => r.ok(),
        _ = call.cancel.cancelled() => None,
    };
    match result {
        Some(Ok(symbols)) => symbols.into_iter().map(|s| (s.name, s.kind, s.container, s.location)).collect(),
        Some(Err(e)) => {
            tracing::debug!("MCP search_symbol: workspace symbols: {e}");
            Vec::new()
        }
        None => {
            host.cancel_request(request);
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(p: &[&str]) -> PathScope {
        PathScope::new(&p.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn normalizes_globs() {
        assert_eq!(normalize_glob("*.rs"), "**/*.rs");
        assert_eq!(normalize_glob("src/"), "src/**");
        assert_eq!(normalize_glob("./src/**/*.ts"), "src/**/*.ts");
        assert_eq!(normalize_glob("/a/b"), "a/b");
    }

    #[test]
    fn utf16_columns_to_bytes() {
        assert_eq!(byte_at("a😀b", 0), Some(0));
        assert_eq!(byte_at("a😀b", 3), Some(5));
        assert_eq!(byte_at("a😀b", 4), Some(6));
        assert_eq!(byte_at("a😀b", 2), None);
        assert_eq!(byte_at("ab", 5), None);
    }

    #[test]
    fn path_scopes() {
        assert!(scope(&[]).is_all());
        assert!(scope(&["", " "]).is_all());
        let s = scope(&["src/", "!**/test/**"]);
        assert!(s.matches("src/a.rs"));
        assert!(!s.matches("src/test/a.rs"));
        assert!(!s.matches("lib/a.rs"));
        let s = scope(&["*.rs"]);
        assert!(s.matches("a.rs") && s.matches("x/y/a.rs") && !s.matches("a.ts"));
        // A directory name covers what is below it.
        let s = scope(&["src/main", "!gen"]);
        assert!(s.matches("src/main/a.rs"));
        assert!(!s.matches("src/main/gen/a.rs"));
        let s = scope(&["!*.md"]);
        assert!(s.matches("a.rs") && !s.matches("docs/a.md"));
        assert!(scope(&["*.{rs,ts}"]).masks.is_none());
        assert!(scope(&["*.rs"]).masks.is_some());
        assert!(PathScope::new(&["a[".into()]).is_err());
    }
}
