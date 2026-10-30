//! Line diffs (imara-diff Histogram) for gutter markers and partial staging.

use crate::{HunkKind, LineHunk};
use gix::diff::blob::{Algorithm, Diff, InternedInput};
use std::borrow::Cow;
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
fn quote_path(path: &str) -> String {
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
    let old_norm = normalize_eol(old);
    let new_norm = normalize_eol(new);
    let old_lines = split_lines(&old_norm);
    let new_lines = split_lines(&new_norm);
    let old_raw = split_raw_lines(old);
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
        if !selected.contains(&index) {
            continue;
        }
        for line in &old_raw[cursor..before.start as usize] {
            result.push_str(line);
        }
        for line in &new_lines[after.start as usize..after.end as usize] {
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
