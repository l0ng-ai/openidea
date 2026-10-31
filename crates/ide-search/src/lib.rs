//! Find / Replace in Files (⌘⇧F / ⌘⇧R).
//!
//! Built on ripgrep's engine crates: a parallel `ignore` walk (honouring
//! `.gitignore` / `.ignore`, skipping hidden files and `.git`) feeding
//! `grep-searcher` with a `grep-regex` matcher. Binary files are skipped,
//! unsaved editor buffers (the overlay) take precedence over disk content,
//! and all columns are UTF-16.

mod engine;
mod files;
mod iter;
mod line;
mod mask;
mod pattern;
mod query;
mod replace;
mod words;

pub use files::{ScopeFile, scope_files};
pub use mask::FileMask;
pub use pattern::ScopePattern;
pub use replace::{
    ReplaceEvent, ReplaceHost, ReplacePreview, ReplaceSummary, ReplaceTarget, apply_edits, preserve_case, preview,
    replace_files, replacement_edits,
};
pub use words::{WordFiles, WordQuery, files_with_word};

use grep_matcher::{Captures, Matcher};
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub pattern: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    /// File masks, e.g. `*.kt`, `src/**/*.ts`; an entry may also be a
    /// comma-separated list where `!mask` excludes. Empty = all files.
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub scope: SearchScope,
    /// Stop after this many matches overall (0 = 10 000).
    pub max_matches: u32,
    /// Where in the code a match may lie (IDEA's search context filter).
    #[serde(default)]
    #[specta(optional)]
    pub context: SearchContext,
}

/// IDEA's search context: matches anywhere, only in, or outside comments and
/// string literals. Files whose language has no syntax tree contain neither.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SearchContext {
    #[default]
    Any,
    InComments,
    InStringLiterals,
    ExceptComments,
    ExceptStringLiterals,
    ExceptCommentsAndStringLiterals,
}

/// What a [`LiteralRange`] is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiteralKind {
    Comment,
    String,
}

/// Byte range of a comment or string literal in a file's text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiteralRange {
    pub start: usize,
    pub end: usize,
    pub kind: LiteralKind,
}

impl SearchContext {
    /// Whether a match starting in `kind` (`None`: plain code) is kept.
    pub fn accepts(self, kind: Option<LiteralKind>) -> bool {
        match self {
            Self::Any => true,
            Self::InComments => kind == Some(LiteralKind::Comment),
            Self::InStringLiterals => kind == Some(LiteralKind::String),
            Self::ExceptComments => kind != Some(LiteralKind::Comment),
            Self::ExceptStringLiterals => kind != Some(LiteralKind::String),
            Self::ExceptCommentsAndStringLiterals => kind.is_none(),
        }
    }

    /// Only matches inside comments / string literals: files without any are skipped.
    fn needs_literals(self) -> bool {
        matches!(self, Self::InComments | Self::InStringLiterals)
    }
}

/// Comments and string literals of a file's text (sorted, non-overlapping),
/// or `None` when its language has no syntax tree.
pub type Literals<'a> = &'a (dyn Fn(&Path, &str) -> Option<Vec<LiteralRange>> + Sync);

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SearchScope {
    Project,
    Directory {
        path: ide_core::IpcPath,
    },
    Files {
        paths: Vec<ide_core::IpcPath>,
    },
    /// IDEA's named scopes over the project's roots ("Project Production Files" …).
    /// Walks the project like `Project`; the caller passes the matching [`PathFilter`].
    FileSet {
        set: ProjectFileSet,
    },
    /// A custom scope: the project's files matching a [`ScopePattern`]
    /// (`file:src//*.ts&&!file:*test*`).
    Pattern {
        pattern: String,
    },
}

impl SearchScope {
    /// The file pattern of a [`SearchScope::Pattern`].
    pub fn pattern(&self) -> IdeResult<Option<ScopePattern>> {
        match self {
            Self::Pattern { pattern } => ScopePattern::parse(pattern).map(Some),
            _ => Ok(None),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProjectFileSet {
    /// "Project Files": everything not excluded.
    All,
    /// "Project Production Files": not under a test root and not a test file.
    Production,
    /// "Project Test Files".
    Test,
}

/// Keeps a file (by `/`-separated project-relative path) in the search.
pub type PathFilter<'a> = &'a (dyn Fn(&str) -> bool + Sync);

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 0-based line.
    pub line: u32,
    /// Line text, truncated around the match for very long lines.
    pub text: String,
    /// UTF-16 column ranges within `text`.
    pub ranges: Vec<(u32, u32)>,
    /// Column offset of `text` in the real line (non-zero when truncated).
    pub text_offset: u32,
}

/// All matches in one file; streamed to the UI as they are found.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: ide_core::IpcPath,
    pub rel_path: String,
    pub matches: Vec<LineMatch>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    pub files: u32,
    pub matches: u32,
    pub limit_hit: bool,
    pub cancelled: bool,
    pub elapsed_ms: u32,
}

/// Text of unsaved open documents takes precedence over disk content.
pub type Overlay<'a> = &'a (dyn Fn(&Path) -> Option<String> + Sync);

/// Searches `root` in parallel, calling `on_file` for each file with matches.
///
/// `on_file` is called from worker threads as files complete. Cancellation
/// and the match limit are reported in the summary rather than as errors.
pub fn search(
    root: &Path,
    query: &SearchQuery,
    overlay: Overlay<'_>,
    cancel: &CancellationToken,
    on_file: &(dyn Fn(FileMatches) + Sync),
) -> IdeResult<SearchSummary> {
    search_filtered(root, query, None, overlay, cancel, on_file)
}

/// [`search`], keeping only files `filter` accepts (e.g. a [`SearchScope::FileSet`]).
pub fn search_filtered(
    root: &Path,
    query: &SearchQuery,
    filter: Option<PathFilter<'_>>,
    overlay: Overlay<'_>,
    cancel: &CancellationToken,
    on_file: &(dyn Fn(FileMatches) + Sync),
) -> IdeResult<SearchSummary> {
    search_in_context(root, query, filter, None, overlay, cancel, on_file)
}

/// [`search_filtered`] honouring [`SearchQuery::context`] with the comments and
/// string literals `literals` finds; without it every match is plain code.
pub fn search_in_context(
    root: &Path,
    query: &SearchQuery,
    filter: Option<PathFilter<'_>>,
    literals: Option<Literals<'_>>,
    overlay: Overlay<'_>,
    cancel: &CancellationToken,
    on_file: &(dyn Fn(FileMatches) + Sync),
) -> IdeResult<SearchSummary> {
    let mask = FileMask::new(&query.include, &query.exclude)?;
    if query.pattern.is_empty() {
        return Ok(SearchSummary::default());
    }
    engine::run(engine::Request {
        root,
        scope: &query.scope,
        compiled: query::compile(query)?,
        mask,
        pattern: query.scope.pattern()?,
        filter,
        context: query.context,
        literals,
        max_matches: query.max_matches,
        overlay,
        cancel,
        on_file,
    })
}

/// Checks the pattern and file masks without searching, so the UI can flag an
/// invalid regex while the user types.
pub fn validate_query(query: &SearchQuery) -> IdeResult<()> {
    FileMask::new(&query.include, &query.exclude)?;
    query.scope.pattern()?;
    if !query.pattern.is_empty() {
        query::compile(query)?;
    }
    Ok(())
}

/// Byte ranges of the matches of `query` in `text`, matched as [`search`] does.
/// Unlike [`LineMatch`]es, a match spanning lines comes back whole.
pub fn match_ranges(text: &str, query: &SearchQuery) -> IdeResult<Vec<(usize, usize)>> {
    if query.pattern.is_empty() {
        return Ok(Vec::new());
    }
    let compiled = query::compile(query)?;
    let mut out = Vec::new();
    iter::for_each_match(&compiled.matcher, text.as_bytes(), 0, |m| out.push((m.start(), m.end())));
    Ok(out)
}

/// Computes the replacement text for every match of `query` in `text`
/// (supports `$1` group references for regex queries).
///
/// Matching is identical to [`search`] (same case, whole-word and multi-line
/// rules). For regex queries the replacement supports `$1`, `${1}`, `$name`,
/// `${name}` and `$$`, plus IDEA's escapes `\n`, `\t`, `\r`, `\$` and `\\`.
/// Literal queries insert `replacement` verbatim.
pub fn replace_in_text(text: &str, query: &SearchQuery, replacement: &str) -> IdeResult<(String, u32)> {
    if query.pattern.is_empty() {
        return Ok((text.to_owned(), 0));
    }
    let compiled = query::compile(query)?;
    let matcher = &compiled.matcher;
    let haystack = text.as_bytes();
    let template = if query.is_regex { unescape_replacement(replacement) } else { replacement.to_owned() };
    let mut caps = matcher.new_captures().map_err(|e| IdeError::internal(e.to_string()))?;
    let mut out = Vec::with_capacity(text.len());
    let mut count = 0u32;
    let mut last = 0;
    iter::for_each_captures(matcher, haystack, &mut caps, |caps| {
        let Some(m) = caps.get(0) else { return };
        out.extend_from_slice(&haystack[last..m.start()]);
        last = m.end();
        count += 1;
        if query.is_regex {
            caps.interpolate(|name| matcher.capture_index(name), haystack, template.as_bytes(), &mut out);
        } else {
            out.extend_from_slice(template.as_bytes());
        }
    });
    out.extend_from_slice(&haystack[last..]);
    let out = String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    Ok((out, count))
}

/// Translates IDEA-style escapes in a regex replacement template; `\$`
/// becomes `$$` so the interpolator emits a literal dollar.
pub(crate) fn unescape_replacement(replacement: &str) -> String {
    let mut out = String::with_capacity(replacement.len());
    let mut chars = replacement.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some('$') => out.push_str("$$"),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}
