//! Replace in Files (⇧⌘R): per-match edits, IDEA's "Preserve case", and the
//! cancellable multi-file run that applies them through a [`ReplaceHost`]
//! (the document layer in the app, so open editors update and each file is one
//! undoable step).

use crate::{SearchQuery, iter, query};
use grep_matcher::{Captures, Matcher};
use ide_core::{CancellationToken, IdeError, IdeResult, Pos, Range, TextEdit};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::path::Path;
use std::time::Instant;

/// One file to replace in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub path: ide_core::IpcPath,
    /// Start positions (0-based line, UTF-16 column) of the matches to replace,
    /// as reported by the search; `None` replaces every match in the file.
    /// Positions where no match starts any more are skipped.
    #[specta(optional)]
    pub only: Option<Vec<Pos>>,
    /// Start positions of matches to leave as they are (excluded or already
    /// replaced usages) when every other match in the file is replaced.
    #[serde(default)]
    #[specta(optional)]
    pub skip: Option<Vec<Pos>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ReplaceEvent {
    /// A file was changed (`replacements` > 0) or had nothing left to replace.
    File {
        path: ide_core::IpcPath,
        replacements: u32,
        done: u32,
        total: u32,
    },
    Failed {
        path: ide_core::IpcPath,
        message: String,
        done: u32,
        total: u32,
    },
    Done {
        summary: ReplaceSummary,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSummary {
    /// Files actually changed.
    pub files: u32,
    pub replacements: u32,
    pub failed: u32,
    pub cancelled: bool,
    pub elapsed_ms: u32,
}

/// Before / after text of one file for the Replace preview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreview {
    pub before: String,
    pub after: String,
    pub edits: Vec<TextEdit>,
}

/// Where replacements are applied. `compute` receives the file's current text
/// (unsaved editor buffer included) and returns the edits for it; the host
/// applies them atomically and returns how many it applied.
pub trait ReplaceHost: Sync {
    fn edit_file(&self, path: &Path, compute: &mut dyn FnMut(&str) -> IdeResult<Vec<TextEdit>>) -> IdeResult<u32>;
}

/// IDEA's "Preserve case": `FOO` → upper-cases the replacement, `Foo` →
/// capitalises it, `foo` → lower-cases its first letter.
pub fn preserve_case(found: &str, replacement: &str) -> String {
    let letters: Vec<char> = found.chars().filter(|c| c.is_alphabetic()).collect();
    let Some(first) = found.chars().find(|c| c.is_alphabetic()) else { return replacement.to_owned() };
    if letters.len() > 1 && letters.iter().all(|c| c.is_uppercase()) {
        return replacement.to_uppercase();
    }
    let mut chars = replacement.chars();
    let Some(head) = chars.next() else { return String::new() };
    let rest = chars.as_str();
    if first.is_uppercase() {
        head.to_uppercase().chain(rest.chars()).collect()
    } else if first.is_lowercase() {
        head.to_lowercase().chain(rest.chars()).collect()
    } else {
        replacement.to_owned()
    }
}

/// Byte offset → 0-based line / UTF-16 column.
struct Lines<'a> {
    text: &'a str,
    starts: Vec<usize>,
}

impl<'a> Lines<'a> {
    fn new(text: &'a str) -> Self {
        let mut starts = vec![0];
        starts.extend(memchr::memchr_iter(b'\n', text.as_bytes()).map(|i| i + 1));
        Self { text, starts }
    }

    fn pos(&self, byte: usize) -> Pos {
        let line = self.starts.partition_point(|&s| s <= byte) - 1;
        let start = self.starts[line];
        let col = self.text[start..byte].encode_utf16().count();
        Pos::new(line as u32, col as u32)
    }
}

/// The edits Replace makes in `text`, in document order. With `only`, just the
/// matches starting at those positions. Regex replacements support `$1`,
/// `${name}`, `$$` and IDEA's `\n` / `\t` escapes (see [`crate::replace_in_text`]).
pub fn replacement_edits(
    text: &str,
    query: &SearchQuery,
    replacement: &str,
    preserve: bool,
    only: Option<&[Pos]>,
) -> IdeResult<Vec<TextEdit>> {
    edits_except(text, query, replacement, preserve, only, None)
}

/// [`replacement_edits`] leaving out the matches that start at `skip`.
fn edits_except(
    text: &str,
    query: &SearchQuery,
    replacement: &str,
    preserve: bool,
    only: Option<&[Pos]>,
    skip: Option<&[Pos]>,
) -> IdeResult<Vec<TextEdit>> {
    if query.pattern.is_empty() {
        return Ok(Vec::new());
    }
    let compiled = query::compile(query)?;
    let matcher = &compiled.matcher;
    let haystack = text.as_bytes();
    let template = if query.is_regex { crate::unescape_replacement(replacement) } else { replacement.to_owned() };
    let only: Option<HashSet<Pos>> = only.map(|o| o.iter().copied().collect());
    let skip: HashSet<Pos> = skip.unwrap_or_default().iter().copied().collect();
    let lines = Lines::new(text);
    let mut caps = matcher.new_captures().map_err(|e| IdeError::internal(e.to_string()))?;
    let mut edits = Vec::new();
    let mut buf = Vec::new();
    iter::for_each_captures(matcher, haystack, &mut caps, |caps| {
        let Some(m) = caps.get(0) else { return };
        let start = lines.pos(m.start());
        if only.as_ref().is_some_and(|o| !o.contains(&start)) || skip.contains(&start) {
            return;
        }
        let mut new_text = if query.is_regex {
            buf.clear();
            caps.interpolate(|name| matcher.capture_index(name), haystack, template.as_bytes(), &mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        } else {
            template.clone()
        };
        if preserve {
            new_text = preserve_case(&text[m.start()..m.end()], &new_text);
        }
        edits.push(TextEdit { range: Range::new(start, lines.pos(m.end())), new_text });
    });
    Ok(edits)
}

/// Applies non-overlapping, ordered `edits` (from [`replacement_edits`]) to `text`.
pub fn apply_edits(text: &str, edits: &[TextEdit]) -> String {
    let lines = Lines::new(text);
    let offset = |p: Pos| -> usize {
        let Some(&start) = lines.starts.get(p.line as usize) else { return text.len() };
        let mut units = 0u32;
        for (i, c) in text[start..].char_indices() {
            if units >= p.col || c == '\n' {
                return start + i;
            }
            units += c.len_utf16() as u32;
        }
        text.len()
    };
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for e in edits {
        let (from, to) = (offset(e.range.start), offset(e.range.end));
        if from < last {
            continue;
        }
        out.push_str(&text[last..from]);
        out.push_str(&e.new_text);
        last = to;
    }
    out.push_str(&text[last..]);
    out
}

/// Before / after text of one file (Replace › Preview).
pub fn preview(
    text: &str,
    query: &SearchQuery,
    replacement: &str,
    preserve: bool,
    only: Option<&[Pos]>,
) -> IdeResult<ReplacePreview> {
    let edits = replacement_edits(text, query, replacement, preserve, only)?;
    Ok(ReplacePreview { before: text.to_owned(), after: apply_edits(text, &edits), edits })
}

/// Replaces in every target through `host`, one atomic edit per file, checking
/// `cancel` between files. Per-file failures are reported and skipped; the
/// summary says how far it got.
pub fn replace_files(
    host: &dyn ReplaceHost,
    query: &SearchQuery,
    replacement: &str,
    preserve: bool,
    targets: &[ReplaceTarget],
    cancel: &CancellationToken,
    on_event: &dyn Fn(ReplaceEvent),
) -> IdeResult<ReplaceSummary> {
    // Fail fast on an invalid pattern instead of once per file.
    if !query.pattern.is_empty() {
        query::compile(query)?;
    }
    let started = Instant::now();
    let total = targets.len() as u32;
    let mut summary = ReplaceSummary::default();
    for (i, target) in targets.iter().enumerate() {
        if cancel.is_cancelled() {
            summary.cancelled = true;
            break;
        }
        let done = i as u32 + 1;
        let (only, skip) = (target.only.as_deref(), target.skip.as_deref());
        if only.is_some_and(|o| o.is_empty()) {
            continue;
        }
        let result =
            host.edit_file(&target.path, &mut |text| edits_except(text, query, replacement, preserve, only, skip));
        match result {
            Ok(n) => {
                if n > 0 {
                    summary.files += 1;
                    summary.replacements += n;
                }
                on_event(ReplaceEvent::File { path: target.path.clone(), replacements: n, done, total });
            }
            Err(e) => {
                summary.failed += 1;
                on_event(ReplaceEvent::Failed { path: target.path.clone(), message: e.message.clone(), done, total });
            }
        }
    }
    summary.elapsed_ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
    Ok(summary)
}
