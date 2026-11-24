//! Line diffs (imara-diff Histogram) for gutter markers and partial staging.

use crate::{HunkKind, LineHunk, PartialCommitHunk, StagingLineHunk};
use gix::diff::blob::{Algorithm, Diff, InternedInput};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
use std::ops::Range;

/// Converts CRLF (and lone CR) line endings to LF.
pub(crate) fn normalize_eol(text: &str) -> Cow<'_, str> {
    if text.contains('\r') { Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n")) } else { Cow::Borrowed(text) }
}

/// Splits into lines, each keeping its terminating `\n` (the last one may lack it).
fn split_lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// Raw hunks (`before` = old line range, `after` = new line range) between two texts.
fn raw_hunks(old: &[&str], new: &[&str]) -> Vec<(Range<u32>, Range<u32>)> {
    let mut input: InternedInput<&str> = InternedInput::default();
    input.reserve(old.len() as u32, new.len() as u32);
    input.update_before(old.iter().copied());
    input.update_after(new.iter().copied());
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);
    diff.hunks().map(|h| (h.before, h.after)).collect()
}

/// Gutter hunks of `new` against `old` (both are normalised to LF first).
pub fn line_hunks(old: &str, new: &str) -> Vec<LineHunk> {
    let old = normalize_eol(old);
    let new = normalize_eol(new);
    let old_lines = split_lines(&old);
    let new_lines = split_lines(&new);
    raw_hunks(&old_lines, &new_lines)
        .into_iter()
        .map(|(before, after)| {
            let kind = if before.is_empty() {
                HunkKind::Added
            } else if after.is_empty() {
                HunkKind::Deleted
            } else {
                HunkKind::Modified
            };
            LineHunk {
                kind,
                start: after.start,
                lines: after.end - after.start,
                old_start: before.start,
                old_lines: before.end - before.start,
                old_text: old_lines[before.start as usize..before.end as usize].concat(),
            }
        })
        .collect()
}

struct IndexRange {
    lines: Range<u32>,
    head_delta: i64,
    working_delta: i64,
    staged: bool,
    unstaged: bool,
}

/// Combine the two diffs in index coordinates, then project each connected
/// block onto HEAD and the working text.
pub(crate) fn staging_line_hunks(head: &str, index: &str, working: &str) -> Vec<StagingLineHunk> {
    let head = normalize_eol(head);
    let working = normalize_eol(working);
    let head = split_lines(&head);
    let index = split_lines(index);
    let working = split_lines(&working);
    let delta = |from: &Range<u32>, to: &Range<u32>| to.len() as i64 - from.len() as i64;
    let mut changes: Vec<_> = raw_hunks(&head, &index)
        .into_iter()
        .map(|(before, after)| IndexRange {
            head_delta: delta(&after, &before),
            lines: after,
            working_delta: 0,
            staged: true,
            unstaged: false,
        })
        .chain(raw_hunks(&index, &working).into_iter().map(|(before, after)| IndexRange {
            working_delta: delta(&before, &after),
            lines: before,
            head_delta: 0,
            staged: false,
            unstaged: true,
        }))
        .collect();
    changes.sort_unstable_by_key(|block| block.lines.start);
    let mut blocks: Vec<IndexRange> = Vec::new();
    for change in changes {
        if let Some(block) = blocks.last_mut().filter(|block| change.lines.start <= block.lines.end) {
            block.lines.end = block.lines.end.max(change.lines.end);
            block.head_delta += change.head_delta;
            block.working_delta += change.working_delta;
            block.staged |= change.staged;
            block.unstaged |= change.unstaged;
        } else {
            blocks.push(change);
        }
    }
    let mut head_shift = 0;
    let mut working_shift = 0;
    blocks
        .into_iter()
        .map(|block| {
            let head_start = (i64::from(block.lines.start) + head_shift) as u32;
            let start = (i64::from(block.lines.start) + working_shift) as u32;
            head_shift += block.head_delta;
            working_shift += block.working_delta;
            let head_end = (i64::from(block.lines.end) + head_shift) as u32;
            let end = (i64::from(block.lines.end) + working_shift) as u32;
            let index_start = block.lines.start;
            let index_end = block.lines.end;
            let before_is_empty = if block.unstaged { index_end == index_start } else { head_end == head_start };
            let kind = if end == start {
                HunkKind::Deleted
            } else if before_is_empty {
                HunkKind::Added
            } else {
                HunkKind::Modified
            };
            StagingLineHunk {
                kind,
                start,
                lines: end - start,
                head_start,
                head_lines: head_end - head_start,
                head_text: head[head_start as usize..head_end as usize].concat(),
                index_start,
                index_lines: index_end - index_start,
                index_text: index[index_start as usize..index_end as usize].concat(),
                staged: block.staged,
                unstaged: block.unstaged,
            }
        })
        .collect()
}

/// Hunks for a file that does not exist in the base (untracked / newly added).
pub(crate) fn all_added(new: &str) -> Vec<LineHunk> {
    let new = normalize_eol(new);
    let count = split_lines(&new).len() as u32;
    if count == 0 {
        return Vec::new();
    }
    vec![LineHunk {
        kind: HunkKind::Added,
        start: 0,
        lines: count,
        old_start: 0,
        old_lines: 0,
        old_text: String::new(),
    }]
}

/// Builds a zero-context unified diff that applies only the selected hunks of
/// `new_text` on top of `old_text`.
///
/// Hunk indices are those returned by [`line_hunks`]`(old_text, new_text)` (the same
/// order the gutter shows). `old_text` should be the index version of the file and the
/// result is meant for [`crate::Repo::stage_patch`] (`git apply --cached --unidiff-zero`).
/// Removed lines are emitted exactly as they appear in `old_text`; added lines use
/// `old_text`'s line ending convention so the index keeps its EOL style.
/// Returns an empty string when nothing is selected.
pub fn build_partial_patch(path: &str, old_text: &str, new_text: &str, selected: &[usize]) -> String {
    let crlf = old_text.contains("\r\n");
    let eol = if crlf { "\r\n" } else { "\n" };
    let old_norm = normalize_eol(old_text);
    let new_norm = normalize_eol(new_text);
    let old_lines = split_lines(&old_norm);
    let new_lines = split_lines(&new_norm);
    // Raw `old_text` lines (with their original terminators) for exact context matching.
    let old_raw: Vec<&str> = split_raw_lines(old_text);
    let hunks = raw_hunks(&old_lines, &new_lines);

    let path = path.replace('\\', "/");
    let quoted = quote_path(&path);
    let mut body = String::new();
    // Net line delta of the hunks applied so far, to place the "+" ranges.
    let mut delta: i64 = 0;
    let mut any = false;
    for (idx, (before, after)) in hunks.iter().enumerate() {
        if !selected.contains(&idx) {
            continue;
        }
        any = true;
        let old_count = before.end - before.start;
        let new_count = after.end - after.start;
        let old_start = if old_count == 0 { before.start } else { before.start + 1 };
        let new_pos = before.start as i64 + delta;
        let new_start = if new_count == 0 { new_pos } else { new_pos + 1 };
        body.push_str(&format!(
            "@@ -{} +{} @@\n",
            range_spec(old_start as i64, old_count),
            range_spec(new_start, new_count)
        ));
        for i in before.clone() {
            let raw = old_raw.get(i as usize).copied().unwrap_or(old_lines[i as usize]);
            push_line(&mut body, '-', raw);
        }
        for i in after.clone() {
            let line = new_lines[i as usize];
            let line: Cow<'_, str> = match line.strip_suffix('\n') {
                Some(content) if crlf => Cow::Owned(format!("{content}{eol}")),
                _ => Cow::Borrowed(line),
            };
            push_line(&mut body, '+', &line);
        }
        delta += new_count as i64 - old_count as i64;
    }
    if !any {
        return String::new();
    }
    format!("diff --git a/{p} b/{p}\n--- a/{p}\n+++ b/{p}\n{body}", p = quoted)
}

fn split_raw_lines(text: &str) -> Vec<&str> {
    // Split on "\n" (keeping it), which matches `normalize_eol` line indices as long as
    // there are no lone CRs; with lone CRs fall back to normalised content.
    if text.contains('\r') && text.replace("\r\n", "").contains('\r') {
        return Vec::new();
    }
    text.split_inclusive('\n').collect()
}

fn range_spec(start: i64, count: u32) -> String {
    if count == 1 { format!("{start}") } else { format!("{start},{count}") }
}

fn push_line(out: &mut String, prefix: char, line: &str) {
    out.push(prefix);
    out.push_str(line);
    if !line.ends_with('\n') {
        out.push_str("\n\\ No newline at end of file\n");
    }
}

/// C-style quoting for paths git would quote in patch headers.
pub(crate) fn quote_path(path: &str) -> String {
    let needs = path.chars().any(|c| c == '"' || c == '\\' || c.is_control() || c == ' ' || c == '\t');
    if !needs {
        return path.to_string();
    }
    let mut out = String::from("\"");
    for c in path.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            c if c.is_control() => out.push_str(&format!("\\{:03o}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Apply selected line hunks while retaining the base's line separators.
pub(crate) fn selected_text(old: &str, new: &str, selected: &[usize]) -> String {
    selected_lines_text(old, new, selected, &BTreeMap::new())
}

pub(crate) fn selected_lines_text(
    old: &str,
    new: &str,
    selected: &[usize],
    lines: &BTreeMap<usize, &PartialCommitHunk>,
) -> String {
    apply_text_hunks(old, new, |index| match lines.get(&index) {
        Some(selection) => HunkSelection::Lines(selection),
        None if selected.contains(&index) => HunkSelection::Whole,
        None => HunkSelection::Excluded,
    })
}

pub(crate) fn replace_text(old: &str, new: &str) -> String {
    apply_text_hunks(old, new, |_| HunkSelection::Whole)
}

enum HunkSelection<'a> {
    Whole,
    Lines(&'a PartialCommitHunk),
    Excluded,
}

fn apply_text_hunks<'a>(old: &str, new: &str, included: impl Fn(usize) -> HunkSelection<'a>) -> String {
    let old_norm = normalize_eol(old);
    let new_norm = normalize_eol(new);
    let old_lines = split_lines(&old_norm);
    let new_lines = split_lines(&new_norm);
    let mut start = 0;
    let old_raw: Vec<_> = old
        .bytes()
        .enumerate()
        .filter_map(|(i, byte)| {
            let end = i + 1;
            let separator = byte == b'\n' || (byte == b'\r' && old.as_bytes().get(end) != Some(&b'\n'));
            if separator || end == old.len() {
                let line = &old[start..end];
                start = end;
                Some(line)
            } else {
                None
            }
        })
        .collect();
    let eol = if old.contains("\r\n") {
        "\r\n"
    } else if old.contains('\r') {
        "\r"
    } else {
        "\n"
    };
    let mut result = String::new();
    let mut cursor = 0;
    for (index, (before, after)) in raw_hunks(&old_lines, &new_lines).iter().enumerate() {
        let lines = match included(index) {
            HunkSelection::Excluded => continue,
            HunkSelection::Whole => None,
            HunkSelection::Lines(lines) => Some(lines),
        };
        for line in &old_raw[cursor..before.start as usize] {
            result.push_str(line);
        }
        if let Some(lines) = lines {
            let deletions: HashSet<_> = lines.deletions.iter().copied().collect();
            for (offset, line) in old_raw[before.start as usize..before.end as usize].iter().enumerate() {
                if !deletions.contains(&(offset as u32)) {
                    result.push_str(line);
                }
            }
        }
        let additions = lines.map(|lines| lines.additions.iter().copied().collect::<HashSet<_>>());
        for (offset, line) in new_lines[after.start as usize..after.end as usize].iter().enumerate() {
            if additions.as_ref().is_some_and(|lines| !lines.contains(&(offset as u32))) {
                continue;
            }
            if lines.is_some() && !result.is_empty() && !result.ends_with(['\r', '\n']) {
                result.push_str(eol);
            }
            if let Some(body) = line.strip_suffix('\n') {
                result.push_str(body);
                result.push_str(eol);
            } else {
                result.push_str(line);
            }
        }
        cursor = before.end as usize;
    }
    for line in &old_raw[cursor..] {
        result.push_str(line);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staging_line_hunks_keep_both_changes_when_head_and_worktree_match() {
        let hunks = staging_line_hunks("top\r\nhead\r\nend", "top\nindex\nend", "top\nhead\nend");
        assert_eq!(hunks.len(), 1);
        let hunk = &hunks[0];
        assert!(hunk.staged && hunk.unstaged);
        assert_eq!((hunk.start, hunk.lines, hunk.index_start, hunk.index_lines), (1, 1, 1, 1));
        assert_eq!(hunk.head_text, "head\n");
        assert_eq!(hunk.index_text, "index\n");
    }

    #[test]
    fn staging_line_hunks_project_deletions_and_insertions_into_worktree_lines() {
        let hunks = staging_line_hunks(
            "intro\nremoved\npivot\ntarget\ntail\nend\n",
            "intro\npivot\ntarget\ntail\nstaged tail\nend\n",
            "intro\ninserted A\ninserted B\npivot\nworking target\ntail\nstaged tail\nend\n",
        );
        assert_eq!(hunks.len(), 3);
        assert!(hunks[0].staged && hunks[0].unstaged);
        assert_eq!((hunks[0].start, hunks[0].lines, hunks[0].head_start), (1, 2, 1));
        assert_eq!(hunks[0].head_text, "removed\n");
        assert_eq!(hunks[0].index_text, "");
        assert!(!hunks[1].staged && hunks[1].unstaged);
        assert_eq!((hunks[1].start, hunks[1].head_start, hunks[1].index_start), (4, 3, 2));
        assert_eq!(hunks[1].index_text, "target\n");
        assert!(hunks[2].staged && !hunks[2].unstaged);
        assert_eq!((hunks[2].start, hunks[2].head_start, hunks[2].index_start), (6, 5, 4));
    }

    #[test]
    fn selected_text_handles_lone_carriage_returns() {
        assert_eq!(selected_text("old\rkeep\r", "new\rkeep\r", &[0]), "new\rkeep\r");
    }

    #[test]
    fn hunk_kinds() {
        let old = "a\nb\nc\nd\n";
        let h = line_hunks(old, "a\nB\nc\nd\n");
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].kind, HunkKind::Modified);
        assert_eq!((h[0].start, h[0].lines, h[0].old_start, h[0].old_lines), (1, 1, 1, 1));
        assert_eq!(h[0].old_text, "b\n");

        let h = line_hunks(old, "x\na\nb\nc\nd\n");
        assert_eq!(h[0].kind, HunkKind::Added);
        assert_eq!((h[0].start, h[0].lines, h[0].old_lines), (0, 1, 0));

        let h = line_hunks(old, "a\nb\nc\nd\ne\n");
        assert_eq!(h[0].kind, HunkKind::Added);
        assert_eq!((h[0].start, h[0].lines), (4, 1));

        let h = line_hunks(old, "a\nd\n");
        assert_eq!(h[0].kind, HunkKind::Deleted);
        assert_eq!((h[0].start, h[0].lines, h[0].old_start, h[0].old_lines), (1, 0, 1, 2));
        assert_eq!(h[0].old_text, "b\nc\n");

        let h = line_hunks(old, "b\nc\nd\n");
        assert_eq!(h[0].kind, HunkKind::Deleted);
        assert_eq!((h[0].start, h[0].lines), (0, 0));

        let h = line_hunks(old, "a\nb\nc\n");
        assert_eq!(h[0].kind, HunkKind::Deleted);
        assert_eq!((h[0].start, h[0].old_start), (3, 3));
    }

    #[test]
    fn crlf_is_normalised() {
        assert!(line_hunks("a\r\nb\r\n", "a\nb\n").is_empty());
        assert_eq!(line_hunks("a\r\nb\r\n", "a\nc\n").len(), 1);
    }

    #[test]
    fn partial_patch_ranges() {
        let old = "1\n2\n3\n4\n5\n6\n";
        let new = "0\n1\n3\n4\nX\n5\n6\n7\n";
        let hunks = line_hunks(old, new);
        assert_eq!(hunks.len(), 4);
        let p = build_partial_patch("f.txt", old, new, &[1, 3]);
        assert!(p.contains("@@ -2 +1,0 @@\n-2\n"), "{p}");
        assert!(p.contains("@@ -6,0 +6 @@\n+7\n"), "{p}");
        assert!(build_partial_patch("f.txt", old, new, &[]).is_empty());
    }

    #[test]
    fn partial_patch_no_newline() {
        let p = build_partial_patch("f", "a\nb", "a\nc", &[0]);
        assert!(p.contains("-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n"), "{p}");
    }
}
