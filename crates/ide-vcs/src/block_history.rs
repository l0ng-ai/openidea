//! History for Selection: the commits that changed a block of lines
//! (`git log -L`), each with the block as it was before and after.

use crate::text_encoding::{TextEncoding, decode};
use crate::{BlockHistory, BlockRevision, LineHunk, Repo, cli};
use ide_core::{CancellationToken, IdeResult};
use std::path::Path;

/// Separates commits in the log output; fields of the header are separated by `\x1f`.
const RECORD: u8 = 0x1e;
const FORMAT: &str = "--format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s";

pub(crate) fn block_history(
    r: &Repo,
    path: &Path,
    current_text: Option<&str>,
    lines: (u32, u32),
    encoding: TextEncoding,
    cancel: &CancellationToken,
) -> IdeResult<BlockHistory> {
    let rel = r.rel_path(path)?;
    let head = {
        let repo = r.gix()?;
        crate::repo::blob_at(&repo, &rel, "HEAD")?
    };
    let Some(head) = head else {
        return Ok(BlockHistory { head_lines: None, revisions: Vec::new() });
    };
    let head = decode(&head, encoding);
    let current = match current_text {
        Some(text) => text.to_owned(),
        None => decode(&std::fs::read(r.abs_path(&rel))?, encoding).into_owned(),
    };
    let Some((start, end)) = head_range(&crate::diff::line_hunks(&head, &current), lines) else {
        return Ok(BlockHistory { head_lines: None, revisions: Vec::new() });
    };
    let range = format!("-L{},{}:{rel}", start + 1, end + 1);
    let args = ["log", "--no-color", "--no-ext-diff", "--no-textconv", FORMAT, &range, "HEAD"];
    let out = cli::run_cancellable(r.root(), &args, cancel)?;
    Ok(BlockHistory { head_lines: Some((start, end)), revisions: parse_log(&out.stdout, encoding) })
}

/// The HEAD lines (0-based, inclusive) of `lines` in the current text, given the
/// hunks between HEAD and it. A selection end inside a changed region takes the
/// whole region; None when every selected line is new.
pub(crate) fn head_range(hunks: &[LineHunk], (start, end): (u32, u32)) -> Option<(u32, u32)> {
    let (start, end) = (start.min(end), start.max(end));
    let to_head = |line: u32, at_end: bool| -> i64 {
        let mut shift = 0i64;
        for h in hunks {
            if line < h.start {
                break;
            }
            if line < h.start + h.lines {
                return if at_end {
                    i64::from(h.old_start) + i64::from(h.old_lines) - 1
                } else {
                    i64::from(h.old_start)
                };
            }
            shift += i64::from(h.lines) - i64::from(h.old_lines);
        }
        i64::from(line) - shift
    };
    let (from, to) = (to_head(start, false), to_head(end, true));
    (from >= 0 && from <= to).then_some((from as u32, to as u32))
}

/// Commits of `git log -L` output, newest first.
pub(crate) fn parse_log(stdout: &[u8], encoding: TextEncoding) -> Vec<BlockRevision> {
    stdout
        .split(|b| *b == RECORD)
        .filter(|r| !r.is_empty())
        .filter_map(|record| parse_record(record, encoding))
        .collect()
}

fn parse_record(record: &[u8], encoding: TextEncoding) -> Option<BlockRevision> {
    let newline = record.iter().position(|b| *b == b'\n').unwrap_or(record.len());
    let header = String::from_utf8_lossy(&record[..newline]);
    let mut fields = header.split('\x1f');
    let id = fields.next()?.to_owned();
    let short_id = fields.next()?.to_owned();
    let author = fields.next()?.to_owned();
    let email = fields.next()?.to_owned();
    let time_ms = fields.next()?.trim().parse::<f64>().ok()? * 1000.0;
    let summary = fields.next().unwrap_or_default().to_owned();
    let patch = decode(record.get(newline + 1..).unwrap_or_default(), encoding);
    let mut revision = BlockRevision {
        id,
        short_id,
        author,
        email,
        time_ms,
        summary,
        path: String::new(),
        before: String::new(),
        after: String::new(),
        before_line: 0,
        after_line: 0,
    };
    let mut in_hunk = false;
    for line in patch.lines() {
        if let Some(path) = line.strip_prefix("+++ ") {
            revision.path = unquote(path).trim_start_matches("b/").to_owned();
        } else if let Some(ranges) = line.strip_prefix("@@ ") {
            in_hunk = true;
            let mut parts = ranges.split_whitespace();
            revision.before_line = hunk_start(parts.next().unwrap_or_default());
            revision.after_line = hunk_start(parts.next().unwrap_or_default());
        } else if in_hunk {
            match line.as_bytes().first() {
                Some(b' ') => {
                    push_line(&mut revision.before, &line[1..]);
                    push_line(&mut revision.after, &line[1..]);
                }
                Some(b'-') => push_line(&mut revision.before, &line[1..]),
                Some(b'+') => push_line(&mut revision.after, &line[1..]),
                _ => {}
            }
        }
    }
    Some(revision)
}

/// 0-based first line of a hunk side (`-12,3` → 11; `+0,0` for a file that did not exist → 0).
fn hunk_start(side: &str) -> u32 {
    let n = side.trim_start_matches(['-', '+']).split(',').next().unwrap_or_default();
    n.parse::<u32>().unwrap_or(0).saturating_sub(1)
}

fn push_line(block: &mut String, line: &str) {
    block.push_str(line);
    block.push('\n');
}

/// A C-quoted path (`"b/a \"b\".txt"`), as git writes unusual names.
fn unquote(path: &str) -> String {
    let Some(inner) = path.strip_prefix('"').and_then(|p| p.strip_suffix('"')) else {
        return path.to_owned();
    };
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HunkKind;

    fn hunk(start: u32, lines: u32, old_start: u32, old_lines: u32) -> LineHunk {
        LineHunk { kind: HunkKind::Modified, start, lines, old_start, old_lines, old_text: String::new() }
    }

    #[test]
    fn maps_the_selection_to_head_lines() {
        // Unchanged file.
        assert_eq!(head_range(&[], (3, 5)), Some((3, 5)));
        // Two lines inserted at 1: current 4..=6 were HEAD 2..=4; a reversed selection too.
        let inserted = [hunk(1, 2, 1, 0)];
        assert_eq!(head_range(&inserted, (4, 6)), Some((2, 4)));
        assert_eq!(head_range(&inserted, (6, 4)), Some((2, 4)));
        // Selecting only the inserted lines: nothing committed.
        assert_eq!(head_range(&inserted, (1, 2)), None);
        // From an inserted line on: the HEAD lines after the insertion.
        assert_eq!(head_range(&inserted, (2, 4)), Some((1, 2)));
        // Three HEAD lines (5..=7) replaced by one: a selection ending in it takes all three.
        let replaced = [hunk(5, 1, 5, 3)];
        assert_eq!(head_range(&replaced, (4, 5)), Some((4, 7)));
        assert_eq!(head_range(&replaced, (6, 6)), Some((8, 8)));
        // Two HEAD lines deleted at 2: later lines move down by two.
        let deleted = [hunk(2, 0, 2, 2)];
        assert_eq!(head_range(&deleted, (2, 3)), Some((4, 5)));
    }

    #[test]
    fn parses_git_log_line_ranges() {
        let out = [
            "\x1eaaaa1111\x1faaaa\x1fAda\x1fada@example.com\x1f1700000000\x1fRename greet",
            "",
            "diff --git a/src/a.txt b/src/b.txt",
            "--- a/src/a.txt",
            "+++ b/src/b.txt",
            "@@ -2,2 +2,2 @@",
            " keep",
            "-hello",
            "+hi",
            "\x1ebbbb2222\x1fbbbb\x1fBo\x1fbo@example.com\x1f1600000000\x1fAdd",
            "",
            "diff --git a/src/a.txt b/src/a.txt",
            "--- /dev/null",
            "+++ b/src/a.txt",
            "@@ -0,0 +2,2 @@",
            "+keep",
            "+hello",
        ]
        .join("\n");
        let revisions = parse_log(out.as_bytes(), TextEncoding::from(encoding_rs::UTF_8));
        assert_eq!(revisions.len(), 2);
        let [newer, older] = &revisions[..] else { unreachable!() };
        assert_eq!((newer.id.as_str(), newer.short_id.as_str(), newer.author.as_str()), ("aaaa1111", "aaaa", "Ada"));
        assert_eq!((newer.time_ms, newer.summary.as_str(), newer.path.as_str()), (1.7e12, "Rename greet", "src/b.txt"));
        assert_eq!((newer.before.as_str(), newer.after.as_str()), ("keep\nhello\n", "keep\nhi\n"));
        assert_eq!((newer.before_line, newer.after_line), (1, 1));
        assert_eq!((older.before.as_str(), older.after.as_str()), ("", "keep\nhello\n"));
        assert_eq!((older.before_line, older.after_line), (0, 1));
    }

    #[test]
    fn unquotes_c_quoted_paths() {
        assert_eq!(unquote(r#""b/a \"q\"\tb.txt""#), "b/a \"q\"\tb.txt");
        assert_eq!(unquote("b/plain.txt"), "b/plain.txt");
    }
}
