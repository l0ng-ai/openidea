// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/SearchToolset.kt,
// SearchSymbolSupport.kt), Apache-2.0.
//! Text, regex, file and symbol search.
//!
//! Coordinates are 1-based, end exclusive; columns count UTF-16 code units like
//! the editor (one per character except emoji and other astral characters).

use crate::tool::{Call, Output, Param, ParamType, Tool};
use crate::tools::util::{INDEXING_PARTIAL_RESULT_REASON, MEDIUM_TIMEOUT};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use ide_core::mcp::McpToolKind;
use ide_core::{CancellationToken, IdeError, IdeResult, Location, Range};
use ide_host::ops::search::SearchEvent;
use ide_search::{FileMask, FileMatches, SearchQuery, SearchScope, SearchSummary};
use ide_vfs::EntryKind;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_RESULTS_UPPER_BOUND: usize = 5000;
const DEFAULT_LIMIT: i64 = 1000;
pub const SYMBOL_SEARCH_DEFAULT_LIMIT: i64 = 50;
pub const SEARCH_TIMEOUT_PARTIAL_RESULT_REASON: &str =
    "The search timed out after 10 s. Narrow the query or pass paths.";
/// Symbols requested from the index per result when `paths` filters them afterwards.
const SYMBOL_POOL_FACTOR: usize = 20;
const MAX_SYMBOL_POOL: usize = 20_000;

const PATHS_DESCRIPTION: &str = "Optional list of project-relative glob patterns to filter results. Supports '!' \
excludes. Trailing '/' expands to '**'. Patterns without '/' are treated as '**/pattern'. Empty strings are ignored.";
const LIMIT_DESCRIPTION: &str = "Maximum number of results to return";

pub fn tools() -> Vec<Tool> {
    vec![search_text(), search_regex(), search_symbol(), search_file()]
}

fn search_text() -> Tool {
    Tool::new(
        "search_text",
        McpToolKind::Read,
        "Searches for a text substring within project files.
Use this tool for fast text search with match coordinates.
Results include match coordinates when available (1-based line/column, end exclusive).

Paths are glob patterns relative to the project root.
Examples: [\"src/**\", \"!**/test/**\"], [\"**/*.kt\"], [\"foo/\"].",
        |call| async move { text_search(call, false).await },
    )
    .param(Param::required("q", ParamType::String, "Text to search for"))
    .param(Param::optional("paths", ParamType::StringList, PATHS_DESCRIPTION))
    .param(Param::optional("limit", ParamType::Integer, LIMIT_DESCRIPTION))
    .output(result_schema())
}

fn search_regex() -> Tool {
    Tool::new(
        "search_regex",
        McpToolKind::Read,
        "Searches for regex matches within project files.
Use this tool when you need regex search with match coordinates.
Results include match coordinates when available (1-based line/column, end exclusive).
The pattern uses Rust regex syntax and is case-sensitive; prefix `(?i)` to ignore case.

Paths are glob patterns relative to the project root.
Examples: [\"src/**\", \"!**/test/**\"], [\"**/*.kt\"], [\"foo/\"].",
        |call| async move { text_search(call, true).await },
    )
    .param(Param::required("q", ParamType::String, "Regex pattern to search for"))
    .param(Param::optional("paths", ParamType::StringList, PATHS_DESCRIPTION))
    .param(Param::optional("limit", ParamType::Integer, LIMIT_DESCRIPTION))
    .output(result_schema())
}

fn search_symbol() -> Tool {
    Tool::new(
        "search_symbol",
        McpToolKind::Read,
        "Searches for symbols (classes, methods, fields).
Use this tool for semantic lookup by identifier fragments.
Results include match coordinates when available (1-based line/column, end exclusive).
For call graph questions, use this only to locate the target symbol, then pass the fully qualified callable name
to `analyze_calls` instead of using text search or Find Usages manually.

Paths are glob patterns relative to the project root.
By default this searches project symbols only.
If you don't find a suitable result, try again with include_external=true to search SDK and library symbols too.",
        |call| async move { symbol_search(call).await },
    )
    .param(Param::required("q", ParamType::String, "Symbol query text"))
    .param(Param::optional("paths", ParamType::StringList, PATHS_DESCRIPTION))
    .param(Param::optional(
        "include_external",
        ParamType::Boolean,
        "Whether to include SDK and library symbols. Disabled by default; if nothing suitable is found, try again \
with include_external=true.",
    ))
    .param(Param::optional("limit", ParamType::Integer, LIMIT_DESCRIPTION))
    .output(result_schema())
}

fn search_file() -> Tool {
    Tool::new(
        "search_file",
        McpToolKind::Read,
        "Searches for files by glob pattern within the project.
Use this tool when you need to match file paths using glob syntax.

Glob patterns are relative to the project root.
Examples: \"**/*.kt\", \"src/**/Foo*.java\", \"build.gradle.kts\".
Patterns without '/' are treated as \"**/pattern\".
Paths are optional additional glob filters relative to the project root.",
        |call| async move { file_search(call).await },
    )
    .param(Param::required("q", ParamType::String, "Glob pattern to search for"))
    .param(Param::optional("paths", ParamType::StringList, PATHS_DESCRIPTION))
    .param(Param::optional(
        "includeExcluded",
        ParamType::Boolean,
        "Whether to include excluded/ignored files in results",
    ))
    .param(Param::optional("limit", ParamType::Integer, LIMIT_DESCRIPTION))
    .output(result_schema())
}

// --- results -------------------------------------------------------------------

/// One hit. Every search tool returns these, so they share one schema: `search_file`
/// fills only `filePath`, only `search_symbol` fills `name` and `container`.
#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SearchItem {
    file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    container: Option<String>,
}

impl SearchItem {
    fn at(file_path: String, r: Range) -> Self {
        Self {
            file_path,
            start_line: Some(r.start.line + 1),
            start_column: Some(r.start.col + 1),
            end_line: Some(r.end.line + 1),
            end_column: Some(r.end.col + 1),
            ..Default::default()
        }
    }
}

/// Empty fields are left out, so a search without hits is `{}`.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SearchResult {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    items: Vec<SearchItem>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    partial_result_reason: Option<&'static str>,
}

fn result_schema() -> Value {
    let int = json!({ "type": "integer" });
    let string = json!({ "type": "string" });
    json!({
        "type": "object",
        "properties": {
            "items": { "type": "array", "items": {
                "type": "object",
                "properties": {
                    "filePath": string, "startLine": int, "startColumn": int, "endLine": int, "endColumn": int,
                    "name": string, "container": string,
                },
                "required": ["filePath"],
            } },
            "more": { "type": "boolean" },
            "partialResultReason": string,
        },
    })
}

fn limit(call: &Call, default: i64) -> IdeResult<usize> {
    match call.opt_i64("limit")?.unwrap_or(default) {
        n if n <= 0 => Err(IdeError::invalid("limit must be > 0")),
        n => Ok((n as usize).min(MAX_RESULTS_UPPER_BOUND)),
    }
}

fn query(call: &Call, empty: &str) -> IdeResult<String> {
    let q = call.str("q")?;
    if q.trim().is_empty() {
        return Err(IdeError::invalid(empty));
    }
    Ok(q)
}

// --- path globs ----------------------------------------------------------------

/// The `paths` argument: project-relative globs, `!` excludes.
struct PathScope {
    /// `None` when only excludes were given (everything is included).
    include: Option<GlobSet>,
    exclude: GlobSet,
    /// The globs as `FileMask` masks for Find in Files (`{a,b}` expanded, as masks
    /// split on commas), `None` when they cannot be expressed.
    masks: Option<(Vec<String>, Vec<String>)>,
}

impl PathScope {
    fn new(root: &Path, patterns: &[String]) -> IdeResult<Self> {
        let (mut include, mut exclude) = (GlobSetBuilder::new(), GlobSetBuilder::new());
        let (mut include_masks, mut exclude_masks) = (Vec::new(), Vec::new());
        let mut has_include = false;
        let mut maskable = true;
        for raw in patterns {
            let raw = raw.trim();
            if raw.is_empty() {
                continue;
            }
            let (negated, pattern) = match raw.strip_prefix('!') {
                Some(rest) if rest.trim().is_empty() => return Err(IdeError::invalid("Exclude pattern is empty")),
                Some(rest) => (true, rest.trim()),
                None => (false, raw),
            };
            let mut glob = normalize_glob(pattern, root)?;
            // A path naming an existing directory covers the files below it.
            if index_of_glob_char(&glob).is_none() && root.join(&glob).is_dir() {
                glob.push_str("/**");
            }
            let alternatives = expand_braces(&glob);
            maskable &= alternatives.is_some();
            let (set, masks) =
                if negated { (&mut exclude, &mut exclude_masks) } else { (&mut include, &mut include_masks) };
            set.add(build_glob(&glob)?);
            masks.extend(alternatives.into_iter().flatten());
            has_include |= !negated;
        }
        let build = |b: GlobSetBuilder| b.build().map_err(|e| IdeError::invalid(format!("Invalid glob pattern: {e}")));
        Ok(Self {
            include: if has_include { Some(build(include)?) } else { None },
            exclude: build(exclude)?,
            masks: maskable.then_some((include_masks, exclude_masks)),
        })
    }

    fn is_all(&self) -> bool {
        self.include.is_none() && self.exclude.is_empty()
    }

    /// `path` is project-relative with `/` (absolute outside the project).
    fn matches(&self, path: &str) -> bool {
        self.include.as_ref().is_none_or(|s| s.is_match(path)) && !self.exclude.is_match(path)
    }
}

/// A glob as a project-relative pattern: `\` → `/`, leading `./` dropped, `dir/` → `dir/**`,
/// `name` → `**/name`, and its leading directories (`..`, absolute paths) resolved against
/// `root`. Errors when that points outside the project.
fn normalize_glob(raw: &str, root: &Path) -> IdeResult<String> {
    let mut value = raw.trim().replace('\\', "/");
    if value.is_empty() {
        return Err(IdeError::invalid("Glob pattern is empty"));
    }
    while let Some(rest) = value.strip_prefix("./") {
        value = rest.to_owned();
    }
    if value.ends_with('/') {
        let dir = value.trim_end_matches('/');
        value = if dir.is_empty() { "**".into() } else { format!("{dir}/**") };
    }
    if !value.contains('/') {
        value = format!("**/{value}");
    }
    let value = normalize_path_pattern(&value, root)?;
    if value.is_empty() {
        return Err(IdeError::invalid(format!("Invalid glob pattern: {raw}")));
    }
    Ok(value)
}

/// Resolves the whole directory segments before the first glob character against `root`.
/// (JetBrains resolves up to the glob character itself, turning `src/Foo*.java` into
/// `src/Foo/*.java`; only whole segments are resolved here.)
fn normalize_path_pattern(pattern: &str, root: &Path) -> IdeResult<String> {
    let outside = || {
        IdeError::invalid(format!("Specified path '{pattern}' points to the location outside of the project directory"))
    };
    let prefix_len = match index_of_glob_char(pattern) {
        None => pattern.len(),
        Some(i) => pattern[..i].rfind('/').map_or(0, |slash| slash + 1),
    };
    let prefix = pattern[..prefix_len].trim_end_matches('/');
    if prefix.is_empty() {
        if is_absolute_pattern(pattern) {
            return Err(outside());
        }
        return Ok(pattern.to_owned());
    }
    let prefix_path = Path::new(prefix);
    let absolute = crate::project::normalize(&if prefix_path.is_absolute() {
        prefix_path.to_path_buf()
    } else {
        root.join(prefix_path)
    });
    let relative = relative_to_root(root, &absolute).ok_or_else(outside)?;
    let suffix = pattern[prefix_len..].trim_start_matches('/');
    Ok(match (relative.is_empty(), suffix.is_empty()) {
        (true, _) => suffix.to_owned(),
        (false, true) => relative,
        (false, false) => format!("{relative}/{suffix}"),
    })
}

/// `path` relative to `root` with `/`, also when one of them is spelled through a symlink
/// (`/var` and `/private/var`); `None` outside `root`.
fn relative_to_root(root: &Path, path: &Path) -> Option<String> {
    let rel = match path.strip_prefix(root) {
        Ok(rel) => rel.to_path_buf(),
        Err(_) => {
            let canon_root = dunce::canonicalize(root).ok()?;
            let existing = path.ancestors().find(|a| a.exists())?;
            let real = dunce::canonicalize(existing).ok()?.join(path.strip_prefix(existing).ok()?);
            real.strip_prefix(&canon_root).ok()?.to_path_buf()
        }
    };
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn is_absolute_pattern(pattern: &str) -> bool {
    let b = pattern.as_bytes();
    pattern.starts_with('/') || (b.len() >= 3 && b[1] == b':' && b[2] == b'/')
}

fn index_of_glob_char(pattern: &str) -> Option<usize> {
    pattern.find(['*', '?', '[', ']', '{', '}'])
}

/// At most this many masks per glob from expanding its `{a,b}` groups.
const MAX_BRACE_ALTERNATIVES: usize = 64;

/// `glob` with its `{a,b}` groups expanded into separate globs without commas, for
/// `FileMask` (which splits on them). `None` for nested groups, braces or commas in a
/// character class, a comma outside a group, an unbalanced brace, or too many results.
fn expand_braces(glob: &str) -> Option<Vec<String>> {
    let mut out = vec![String::new()];
    let mut chars = glob.chars();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '{' | '}' | ',' if in_class => return None,
            '[' => {
                in_class = true;
                out.iter_mut().for_each(|o| o.push(c));
            }
            ']' => {
                in_class = false;
                out.iter_mut().for_each(|o| o.push(c));
            }
            '{' => {
                let mut group = String::new();
                loop {
                    match chars.next()? {
                        '}' => break,
                        '{' | '[' | ']' => return None,
                        g => group.push(g),
                    }
                }
                let options: Vec<&str> = group.split(',').collect();
                if out.len() * options.len() > MAX_BRACE_ALTERNATIVES {
                    return None;
                }
                out = out.iter().flat_map(|o| options.iter().map(move |a| format!("{o}{a}"))).collect();
            }
            '}' | ',' => return None,
            _ => out.iter_mut().for_each(|o| o.push(c)),
        }
    }
    (!in_class).then_some(out)
}

/// `**/` matches zero or more directories; case follows the file system (insensitive on
/// macOS and Windows, like Find in Files' masks).
fn build_glob(glob: &str) -> IdeResult<globset::Glob> {
    GlobBuilder::new(glob)
        .literal_separator(true)
        .backslash_escape(false)
        .case_insensitive(cfg!(any(target_os = "macos", target_os = "windows")))
        .build()
        .map_err(|_| IdeError::invalid(format!("Invalid glob pattern: {glob}")))
}

// --- text / regex --------------------------------------------------------------

/// A match before it becomes a [`SearchItem`]; 1-based, end exclusive.
struct TextHit {
    file_path: String,
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
}

async fn text_search(call: Call, is_regex: bool) -> IdeResult<Output> {
    let pattern = query(&call, if is_regex { "Regex pattern is empty" } else { "Search text is empty" })?;
    let limit = limit(&call, DEFAULT_LIMIT)?;
    let scope = PathScope::new(call.root(), &call.str_list("paths")?)?;
    // Globs Find in Files cannot take are applied afterwards, so the engine must not
    // stop at `limit` matches the filter may drop.
    let (masks, max_matches) = match scope.masks.clone() {
        // One more than asked tells whether there are more.
        Some(masks) => (masks, (limit + 1) as u32),
        None => (Default::default(), u32::MAX),
    };
    let (include, exclude) = masks;
    let query = SearchQuery {
        pattern: pattern.clone(),
        is_regex,
        case_sensitive: true,
        whole_word: false,
        include,
        exclude,
        scope: SearchScope::Project,
        max_matches,
        context: Default::default(),
    };
    if is_regex && let Err(e) = ide_search::match_ranges("", &query) {
        return Err(IdeError::invalid(format!("Invalid regex pattern: {pattern} ({})", e.message)));
    }
    let (files, summary, timed_out) = run_search(&call, query.clone()).await?;
    // Content roots outside the project are reported by absolute path.
    let mut files: Vec<(String, FileMatches)> =
        files.into_iter().map(|f| (call.display(&f.path.0), f)).filter(|(path, _)| scope.matches(path)).collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    // Only these can match a line break.
    let may_span = is_regex || pattern.contains('\n');
    let mut hits = Vec::new();
    let mut spanning = Vec::new();
    for (path, file) in &files {
        for m in &file.matches {
            let line_end = m.text_offset + m.text.encode_utf16().count() as u32;
            for &(a, b) in &m.ranges {
                let (a, b) = (m.text_offset + a, m.text_offset + b);
                if may_span && b == line_end && hits.len() < limit {
                    spanning.push((hits.len(), file.path.0.clone()));
                }
                hits.push(TextHit {
                    file_path: path.clone(),
                    line: m.line + 1,
                    column: a + 1,
                    end_line: m.line + 1,
                    end_column: b + 1,
                });
            }
        }
    }
    let more = hits.len() > limit || summary.limit_hit || timed_out;
    hits.truncate(limit);
    extend_spanning(&call, &query, &mut hits, spanning).await;
    let items = hits
        .into_iter()
        .map(|h| SearchItem {
            file_path: h.file_path,
            start_line: Some(h.line),
            start_column: Some(h.column),
            end_line: Some(h.end_line),
            end_column: Some(h.end_column),
            ..Default::default()
        })
        .collect();
    let partial_result_reason = timed_out.then_some(SEARCH_TIMEOUT_PARTIAL_RESULT_REASON);
    Output::json(SearchResult { items, more, partial_result_reason })
}

/// A file's path, text, line start offsets and match byte ranges.
type FileText = (PathBuf, String, Vec<usize>, Vec<(usize, usize)>);

/// Find in Files reports only the first line of a match that spans lines: matches
/// ending at a line end get their real end from matching the file's text again.
async fn extend_spanning(call: &Call, query: &SearchQuery, hits: &mut [TextHit], spanning: Vec<(usize, PathBuf)>) {
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
        let h = &mut hits[i];
        let Some(&line_start) = starts.get(h.line as usize - 1) else { continue };
        let Some(start) = byte_at(&text[line_start..], h.column - 1).map(|b| line_start + b) else { continue };
        let Ok(found) = ranges.binary_search_by_key(&start, |r| r.0) else { continue };
        let end = ranges[found].1;
        let end_line = starts.partition_point(|&s| s <= end) - 1;
        h.end_line = end_line as u32 + 1;
        h.end_column = text[starts[end_line]..end].encode_utf16().count() as u32 + 1;
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

/// Runs Find in Files for at most [`MEDIUM_TIMEOUT`], cancelling it when the call is
/// cancelled. Returns what was found and whether the time ran out.
async fn run_search(call: &Call, query: SearchQuery) -> IdeResult<(Vec<FileMatches>, SearchSummary, bool)> {
    let host = call.host();
    let request = crate::tool::request_id();
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
    let mut timed_out = false;
    tokio::select! {
        r = &mut search => r?,
        _ = call.cancel.cancelled() => {
            host.cancel_request(request);
            let _ = search.await;
            return Err(IdeError::cancelled());
        }
        _ = tokio::time::sleep(MEDIUM_TIMEOUT) => {
            host.cancel_request(request);
            let _ = search.await;
            timed_out = true;
        }
    }
    let summary = done.lock().take().unwrap_or_default();
    if summary.cancelled && !timed_out {
        return Err(IdeError::cancelled());
    }
    let files = std::mem::take(&mut *files.lock());
    Ok((files, summary, timed_out))
}

// --- files ---------------------------------------------------------------------

async fn file_search(call: Call) -> IdeResult<Output> {
    let q = query(&call, "Glob pattern is empty")?;
    let limit = limit(&call, DEFAULT_LIMIT)?;
    let scope = PathScope::new(call.root(), &call.str_list("paths")?)?;
    let include_excluded = call.flag("includeExcluded", false)?;
    let glob = GlobSetBuilder::new()
        .add(build_glob(&normalize_glob(&q, call.root())?)?)
        .build()
        .map_err(|_| IdeError::invalid(format!("Invalid glob pattern: {q}")))?;
    // Ignored names and "Exclude files" patterns, which `read_dir` does not flag.
    let excludes = if include_excluded { None } else { Some(FileMask::new(&[], &call.project().search_excludes())?) };
    let root = call.root().to_path_buf();
    // The project folder and the content roots outside it.
    let roots: Vec<PathBuf> = std::iter::once(root.clone())
        .chain(call.project().content_roots().into_iter().filter(|r| relative_to_root(&root, r).is_none()))
        .collect();
    let host = call.host();
    let walk = Walk {
        host: host.clone(),
        window: call.window().to_owned(),
        root,
        include_excluded,
        excludes,
        glob,
        scope,
        limit,
        cancel: call.cancel.clone(),
        deadline: Instant::now() + MEDIUM_TIMEOUT,
        timed_out: Cell::new(false),
    };
    let (paths, more, timed_out) = host
        .blocking(move || {
            let mut found = Vec::new();
            let more = roots.iter().any(|base| walk.dir(base, base, &mut found));
            if walk.cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            Ok((found, more, walk.timed_out.get()))
        })
        .await?;
    let items = paths.into_iter().map(|file_path| SearchItem { file_path, ..Default::default() }).collect();
    let partial_result_reason = timed_out.then_some(SEARCH_TIMEOUT_PARTIAL_RESULT_REASON);
    Output::json(SearchResult { items, more, partial_result_reason })
}

struct Walk {
    host: Arc<ide_host::Host>,
    window: String,
    root: PathBuf,
    include_excluded: bool,
    excludes: Option<FileMask>,
    glob: GlobSet,
    scope: PathScope,
    limit: usize,
    cancel: CancellationToken,
    deadline: Instant,
    timed_out: Cell<bool>,
}

impl Walk {
    /// Collects matching files under `dir` (inside the walked root `base`) depth first in
    /// name order; true when it stopped early: more than `limit` match or the time ran out.
    fn dir(&self, dir: &Path, base: &Path, found: &mut Vec<String>) -> bool {
        let Ok(mut entries) = ide_host::ops::fs::read_dir(&self.host, &self.window, dir.to_path_buf()) else {
            return false;
        };
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        for entry in entries {
            if self.cancel.is_cancelled() {
                return false;
            }
            if Instant::now() >= self.deadline {
                self.timed_out.set(true);
                return true;
            }
            if entry.name == ".git" || (!self.include_excluded && (entry.ignored || entry.excluded)) {
                continue;
            }
            let Ok(in_base) = entry.path.strip_prefix(base) else { continue };
            if self.excludes.as_ref().is_some_and(|m| !m.matches(&in_base.to_string_lossy().replace('\\', "/"))) {
                continue;
            }
            match entry.kind {
                // Symlinked directories are not followed (they may loop).
                EntryKind::Dir => {
                    if self.dir(&entry.path, base, found) {
                        return true;
                    }
                }
                EntryKind::File => {
                    // Files of content roots outside the project go by absolute path.
                    let path = relative_to_root(&self.root, &entry.path)
                        .unwrap_or_else(|| entry.path.to_string_lossy().into_owned());
                    if self.glob.is_match(&path) && self.scope.matches(&path) {
                        if found.len() == self.limit {
                            return true;
                        }
                        found.push(path);
                    }
                }
                _ => {}
            }
        }
        false
    }
}

// --- symbols -------------------------------------------------------------------

async fn symbol_search(call: Call) -> IdeResult<Output> {
    let started = Instant::now();
    let q = query(&call, "Search query is empty")?;
    let limit = limit(&call, SYMBOL_SEARCH_DEFAULT_LIMIT)?;
    let scope = PathScope::new(call.root(), &call.str_list("paths")?)?;
    let external = call.flag("include_external", false)?;
    let host = call.host();
    let project = call.project().clone();
    let indexing_before = project.index.status().indexing;
    let pool = if scope.is_all() { limit + 1 } else { ((limit + 1) * SYMBOL_POOL_FACTOR).min(MAX_SYMBOL_POOL) };
    let found = {
        let (project, q) = (project.clone(), q.clone());
        host.blocking(move || Ok(project.index.find_symbols(&q, ide_index::SymbolFilter::All, pool))).await?
    };
    let mut items: Vec<SearchItem> = found
        .into_iter()
        .filter(|s| scope.matches(&s.rel_path))
        .map(|s| SearchItem {
            name: Some(s.name),
            container: s.container.filter(|c| !c.is_empty()),
            ..SearchItem::at(s.rel_path, s.range)
        })
        .collect();
    let mut timed_out = false;
    if external && items.len() <= limit {
        let budget = MEDIUM_TIMEOUT.saturating_sub(started.elapsed());
        let (symbols, out_of_time) = workspace_symbols(&call, &q, budget).await;
        timed_out = out_of_time;
        for (name, container, location) in symbols {
            let path = location.uri.clone().unwrap_or_else(|| call.display(&location.path));
            // Project files obey `paths`; library symbols are what was asked for.
            let inside = location.uri.is_none() && !Path::new(&path).is_absolute();
            if inside && !scope.matches(&path) {
                continue;
            }
            let item = SearchItem {
                name: Some(name),
                container: container.filter(|c| !c.is_empty()),
                ..SearchItem::at(path, location.range)
            };
            if !items
                .iter()
                .any(|e| e.name == item.name && e.file_path == item.file_path && e.start_line == item.start_line)
            {
                items.push(item);
            }
            if items.len() > limit {
                break;
            }
        }
    }
    let more = items.len() > limit || timed_out;
    items.truncate(limit);
    let indexing = indexing_before || project.index.status().indexing;
    let partial_result_reason = if indexing {
        Some(INDEXING_PARTIAL_RESULT_REASON)
    } else {
        timed_out.then_some(SEARCH_TIMEOUT_PARTIAL_RESULT_REASON)
    };
    Output::json(SearchResult { items, more, partial_result_reason })
}

/// The language servers' workspace symbols, and whether `budget` ran out first; empty
/// when none runs or they fail.
async fn workspace_symbols(call: &Call, q: &str, budget: Duration) -> (Vec<(String, Option<String>, Location)>, bool) {
    let host = call.host();
    let request = crate::tool::request_id();
    let symbols = ide_host::ops::lsp::lsp_workspace_symbols(&host, call.window(), request, q.to_owned());
    tokio::pin!(symbols);
    let result = tokio::select! {
        r = tokio::time::timeout(budget, &mut symbols) => r.ok(),
        _ = call.cancel.cancelled() => None,
    };
    match result {
        Some(Ok(symbols)) => (symbols.into_iter().map(|s| (s.name, s.container, s.location)).collect(), false),
        Some(Err(e)) => {
            tracing::debug!("MCP search_symbol: workspace symbols: {e}");
            (Vec::new(), false)
        }
        None => {
            host.cancel_request(request);
            (Vec::new(), !call.cancel.is_cancelled())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap().join("project");
        std::fs::create_dir_all(root.join("subdir1/nested")).unwrap();
        (dir, root)
    }

    fn scope(root: &Path, p: &[&str]) -> PathScope {
        PathScope::new(root, &p.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn normalizes_globs() {
        let (_dir, root) = root();
        let n = |p: &str| normalize_glob(p, &root);
        assert_eq!(n("*.rs").unwrap(), "**/*.rs");
        assert_eq!(n("./foo/bar.txt").unwrap(), "foo/bar.txt");
        assert_eq!(n("foo/").unwrap(), "foo/**");
        assert_eq!(n("/").unwrap(), "**/**");
        assert_eq!(n("./src/**/*.ts").unwrap(), "src/**/*.ts");
        assert_eq!(n("src\\gen\\*.rs").unwrap(), "src/gen/*.rs");
        assert_eq!(n("src/a/../Foo*.java").unwrap(), "src/Foo*.java");
        assert_eq!(n(&root.join("sub/Foo.kt").to_string_lossy()).unwrap(), "sub/Foo.kt");
        assert_eq!(n(&format!("{}/**/*.kt", root.display())).unwrap(), "**/*.kt");
        for outside in ["../outside/**", "/elsewhere/*.rs", "/**"] {
            let err = n(outside).unwrap_err().message;
            assert!(err.contains("outside of the project directory"), "{outside}: {err}");
        }
        assert!(n("  ").unwrap_err().message.contains("Glob pattern is empty"));
    }

    #[test]
    fn expands_brace_groups() {
        let e = |g: &str| expand_braces(g);
        assert_eq!(e("src/**/*.rs"), Some(vec!["src/**/*.rs".to_owned()]));
        assert_eq!(e("src/**/*.{ts,tsx}"), Some(vec!["src/**/*.ts".to_owned(), "src/**/*.tsx".to_owned()]));
        assert_eq!(e("{a,b}/*.{x,y}"), Some(["a/*.x", "a/*.y", "b/*.x", "b/*.y"].map(String::from).to_vec()));
        assert_eq!(e("a{,.bak}"), Some(vec!["a".to_owned(), "a.bak".to_owned()]));
        assert_eq!(e("[{]x"), None);
        assert_eq!(e("{a,{b,c}}"), None);
        assert_eq!(e("a,b"), None);
        assert_eq!(e("{a,b"), None);
        assert_eq!(e("a}"), None);
        assert_eq!(e(&"{a,b}".repeat(7)), None);
        assert_eq!(e(&"{a,b}".repeat(6)).map(|v| v.len()), Some(64));
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
        let (_dir, root) = root();
        let root = root.as_path();
        assert!(scope(root, &[]).is_all());
        assert!(scope(root, &["", " "]).is_all());
        let s = scope(root, &["subdir1/**", "!**/*.java"]);
        assert!(s.matches("subdir1/foo.txt"));
        assert!(!s.matches("subdir1/foo.java"));
        assert!(!s.matches("subdir2/foo.txt"));
        let s = scope(root, &["subdir1/**", "!subdir1/excluded/**"]);
        assert!(s.matches("subdir1/foo.txt") && !s.matches("subdir1/excluded/foo.txt"));
        // An existing directory covers the files below it; other names match files only.
        let s = scope(root, &["subdir1/nested"]);
        assert!(s.matches("subdir1/nested/foo.txt") && !s.matches("subdir1/other/foo.txt"));
        let s = scope(root, &["!gen"]);
        assert!(s.matches("src/gen/a.rs") && !s.matches("src/gen"));
        let s = scope(root, &["*.rs"]);
        assert!(s.matches("a.rs") && s.matches("x/y/a.rs") && !s.matches("a.ts"));
        assert!(s.matches("/abs/content/root/a.rs"));
        let s = scope(root, &["!*.md"]);
        assert!(s.matches("a.rs") && !s.matches("docs/a.md"));
        assert!(scope(root, &["*.{rs,ts}"]).masks.is_some());
        assert!(scope(root, &["*.{rs,{ts,js}}"]).masks.is_none());
        let err = |p: &str| PathScope::new(root, &[p.to_owned()]).err().unwrap().message;
        assert!(err("a[").contains("Invalid glob pattern"));
        assert!(err("!").contains("Exclude pattern is empty"));
        assert!(err("../x/**").contains("outside of the project directory"));
    }
}
