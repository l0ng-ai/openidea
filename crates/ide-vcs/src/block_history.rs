//! History for Selection: the commits that changed a block of lines
//! (`git log -L`), each with the block as it was before and after.

use crate::text_encoding::{TextEncoding, decode};
use crate::{
    BlockHistory, BlockHistoryAnchor, BlockHistorySummary, BlockRevision, BlockRevisionSpot, BlockRevisionSummary,
    BlockSpotRange, LineHunk, Repo, cli,
};
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::path::Path;

/// Separates commits in the log output; fields of the header are separated by `\x1f`.
const RECORD: u8 = 0x1e;
const DIFF_BATCH: usize = 4;
/// Keeps additional diffs inline in [`summary`] while total diff text stays under this
/// budget, so small selections and short histories finish in one reply without follow-up reads.
const INLINE_DIFF_BYTES: usize = 512 * 1024;
const FORMAT: &str = "--format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s";

struct AnchorInfo {
    anchor: BlockHistoryAnchor,
    head: String,
}

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
        return Ok(BlockHistory { head_lines: None, head: None, revisions: Vec::new() });
    };
    let head = decode(&head, encoding);
    let current = match current_text {
        Some(text) => text.to_owned(),
        None => decode(&std::fs::read(r.abs_path(&rel))?, encoding).into_owned(),
    };
    let Some((start, end)) = head_range(&crate::diff::line_hunks(&head, &current), lines) else {
        return Ok(BlockHistory { head_lines: None, head: None, revisions: Vec::new() });
    };
    let range = format!("-L{},{}:{rel}", start + 1, end + 1);
    let args = ["log", "--no-color", "--no-ext-diff", "--no-textconv", FORMAT, &range, "HEAD"];
    let out = cli::run_cancellable(r.root(), &args, cancel)?;
    // The newest row's block can't stand in for HEAD's: a merge row has none.
    let mut block = String::new();
    for line in head.lines().skip(start as usize).take((end - start) as usize + 1) {
        push_line(&mut block, line);
    }
    let revisions = parse_log(&out.stdout, encoding);
    Ok(BlockHistory { head_lines: Some((start, end)), head: Some(block), revisions })
}

fn anchor(
    r: &Repo,
    rel: &str,
    current_text: Option<&str>,
    lines: (u32, u32),
    encoding: TextEncoding,
    cancel: &CancellationToken,
) -> IdeResult<Option<AnchorInfo>> {
    if cancel.is_cancelled() {
        return Err(IdeError::cancelled());
    }
    let repo = r.gix()?;
    let Some(id) = repo.head().map_err(crate::repo::gx)?.id() else { return Ok(None) };
    let oid = id.detach();
    let tree = repo
        .find_object(oid)
        .map_err(crate::repo::gx)?
        .peel_to_commit()
        .map_err(crate::repo::gx)?
        .tree()
        .map_err(crate::repo::gx)?;
    let Some(entry) = tree.lookup_entry_by_path(Path::new(rel)).map_err(crate::repo::gx)? else {
        return Ok(None);
    };
    if !entry.mode().is_blob_or_symlink() {
        return Ok(None);
    }
    let bytes = crate::repo::blob_data(&repo, entry.oid().to_owned())?;
    let head = decode(&bytes, encoding);
    let hunks = match current_text {
        Some(text) if text == head.as_ref() => Vec::new(),
        Some(text) => crate::diff::line_hunks(&head, text),
        None => {
            let disk = std::fs::read(r.abs_path(rel))?;
            if disk == bytes {
                Vec::new()
            } else {
                let current = decode(&disk, encoding);
                if current == head { Vec::new() } else { crate::diff::line_hunks(&head, &current) }
            }
        }
    };
    let Some((start, end)) = head_range(&hunks, lines) else { return Ok(None) };
    // The newest row's block can't stand in for HEAD's: a merge row has none.
    let mut block = String::new();
    for line in head.lines().skip(start as usize).take((end - start) as usize + 1) {
        push_line(&mut block, line);
    }
    Ok(Some(AnchorInfo { anchor: BlockHistoryAnchor { commit: oid.to_string(), lines: (start, end) }, head: block }))
}

fn anchor_range(rel: &str, anchor: &BlockHistoryAnchor) -> String {
    let (start, end) = anchor.lines;
    format!("-L{},{}:{rel}", u64::from(start) + 1, u64::from(end) + 1)
}

fn log_args<'a>(options: &[&'a str], ranges: &'a [String], commit: &'a str) -> Vec<&'a str> {
    let mut args = vec!["log", "--no-color", "--no-ext-diff", "--no-textconv", FORMAT];
    args.extend_from_slice(options);
    args.extend(ranges.iter().map(String::as_str));
    args.push(commit);
    args
}

/// Streams one `git log -L` pass: keeps the initial diff batch (and any further diffs that
/// fit within [`INLINE_DIFF_BYTES`]) inline, and keeps only each remaining commit's header
/// and spot ranges so deep rows can be read directly via [`revisions_at`].
pub(crate) fn summary(
    r: &Repo,
    path: &Path,
    current_text: Option<&str>,
    lines: (u32, u32),
    encoding: TextEncoding,
    cancel: &CancellationToken,
) -> IdeResult<BlockHistorySummary> {
    let rel = r.rel_path(path)?;
    let Some(info) = anchor(r, &rel, current_text, lines, encoding, cancel)? else {
        return Ok(BlockHistorySummary { anchor: None, head: None, diffs: Vec::new(), rest: Vec::new() });
    };
    let range = anchor_range(&rel, &info.anchor);
    let args = log_args(&[], std::slice::from_ref(&range), &info.anchor.commit);
    let mut reader = SummaryReader::new(encoding);
    cli::run_cancellable_lines(r.root(), &args, cancel, &mut |line| reader.line(line))?;
    let (diffs, rest) = reader.finish();
    Ok(BlockHistorySummary { anchor: Some(info.anchor), head: Some(info.head), diffs, rest })
}

struct SummaryReader {
    encoding: TextEncoding,
    diffs: Vec<BlockRevision>,
    rest: Vec<BlockRevisionSummary>,
    inline_bytes: usize,
    keep_inline: bool,
    raw: Vec<u8>,
    in_inline: bool,
    pending: Option<BlockRevisionSummary>,
    section: Section,
}

/// Where the spot reader is in a commit's diff.
#[derive(Default)]
enum Section {
    /// The commit header, before any file.
    #[default]
    Header,
    /// A file's header lines, with its `+++` path once read (None: not readable).
    File(Option<Option<String>>),
    /// A file's hunks.
    Hunks(Option<String>),
}

impl SummaryReader {
    fn new(encoding: TextEncoding) -> Self {
        Self {
            encoding,
            diffs: Vec::new(),
            rest: Vec::new(),
            inline_bytes: 0,
            keep_inline: true,
            raw: Vec::new(),
            in_inline: false,
            pending: None,
            section: Section::Header,
        }
    }

    fn flush_inline(&mut self) {
        if !self.in_inline {
            return;
        }
        if let Some(rev) = parse_record(&self.raw, self.encoding) {
            self.inline_bytes += rev.before.len() + rev.after.len();
            self.diffs.push(rev);
        }
        self.raw.clear();
        self.in_inline = false;
        if self.diffs.len() >= DIFF_BATCH && self.inline_bytes >= INLINE_DIFF_BYTES {
            self.keep_inline = false;
            self.raw = Vec::new();
        }
    }

    fn line(&mut self, line: &[u8]) {
        if let Some(header) = line.strip_prefix(&[RECORD]) {
            if self.in_inline {
                self.flush_inline();
            } else if let Some(summary) = self.pending.take() {
                self.rest.push(summary);
            }
            if self.keep_inline {
                self.raw.extend_from_slice(header);
                self.in_inline = true;
            } else {
                let header = header.strip_suffix(b"\n").unwrap_or(header);
                self.pending = parse_summary(header);
                self.section = Section::Header;
            }
            return;
        }
        if self.in_inline {
            self.raw.extend_from_slice(line);
            return;
        }
        // Almost all lines in a patch are context/add/del lines inside a hunk.
        if matches!(self.section, Section::Hunks(_)) && matches!(line.first(), Some(b' ' | b'+' | b'-' | b'\\') | None)
        {
            return;
        }
        let Some(summary) = self.pending.as_mut() else {
            return;
        };
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        if line.starts_with(b"diff --git ") {
            self.section = Section::File(None);
        } else if let (Section::File(path @ None), Some(name)) = (&mut self.section, line.strip_prefix(b"+++ ")) {
            *path = Some(unquote_path(name));
        } else if let Some(hunk) = line.strip_prefix(b"@@ ") {
            let path = match std::mem::take(&mut self.section) {
                Section::File(path) => path.flatten(),
                Section::Hunks(path) => path,
                Section::Header => None,
            };
            match (&mut summary.ranges, path.clone().zip(post_image(hunk))) {
                (Some(ranges), Some((path, (start, end)))) => ranges.push(BlockSpotRange { path, start, end }),
                (ranges, _) => *ranges = None,
            }
            self.section = Section::Hunks(path);
        }
    }

    fn finish(mut self) -> (Vec<BlockRevision>, Vec<BlockRevisionSummary>) {
        if self.in_inline {
            self.flush_inline();
        } else if let Some(summary) = self.pending.take() {
            self.rest.push(summary);
        }
        (self.diffs, self.rest)
    }
}

pub(crate) fn revisions(
    r: &Repo,
    path: &Path,
    anchor: &BlockHistoryAnchor,
    index: u32,
    commits: &[String],
    encoding: TextEncoding,
    cancel: &CancellationToken,
) -> IdeResult<Vec<BlockRevision>> {
    gix::ObjectId::from_hex(anchor.commit.as_bytes())
        .map_err(|_| IdeError::invalid("invalid selection history anchor"))?;
    if commits.is_empty() || commits.len() > DIFF_BATCH {
        return Err(IdeError::invalid("invalid selection history batch size"));
    }
    let ids: Vec<_> = commits.iter().map(String::as_str).collect();
    let skip = format!("--skip={index}");
    let limit = format!("-n{}", ids.len());
    let range = anchor_range(&r.rel_path(path)?, anchor);
    let args = log_args(&[&limit, &skip], std::slice::from_ref(&range), &anchor.commit);
    let out = cli::run_cancellable(r.root(), &args, cancel)?;
    let diffs = parse_log(&out.stdout, encoding);
    check_diffs(&diffs, ids.iter().copied())?;
    Ok(diffs)
}

fn check_diffs<'a>(diffs: &[BlockRevision], ids: impl Iterator<Item = &'a str>) -> IdeResult<()> {
    if diffs.iter().map(|diff| diff.id.as_str()).ne(ids) {
        return Err(IdeError::not_found("selection history revisions no longer match"));
    }
    Ok(())
}

/// The new side of a hunk header (`-12,3 +14,5 @@ …` → lines 14..=18); None for an empty side.
fn post_image(hunk: &[u8]) -> Option<(u32, u32)> {
    let hunk = std::str::from_utf8(hunk.split(|b| *b == b'@').next()?).ok()?;
    let side = hunk.split_whitespace().find_map(|part| part.strip_prefix('+'))?;
    let (start, count) = side.split_once(',').unwrap_or((side, "1"));
    let (start, count) = (start.parse::<u32>().ok()?, count.parse::<u32>().ok()?);
    if start == 0 || count == 0 {
        return None;
    }
    Some((start, start.checked_add(count - 1)?))
}

/// The repository path of a `+++ b/…` line, C-quoted or not; None when it is not UTF-8
/// (or not a `b/` path), as it then could not be passed back to Git.
fn unquote_path(path: &[u8]) -> Option<String> {
    // Git ends a name containing a space with a tab; a name with a tab of its own is quoted.
    let path = path.strip_suffix(b"\t").unwrap_or(path);
    let bytes = match path.strip_prefix(b"\"").and_then(|p| p.strip_suffix(b"\"")) {
        None => path.to_vec(),
        Some(inner) => {
            let mut out = Vec::new();
            let mut i = 0;
            while i < inner.len() {
                let c = inner[i];
                i += 1;
                if c != b'\\' {
                    out.push(c);
                    continue;
                }
                let escaped = *inner.get(i)?;
                i += 1;
                out.push(match escaped {
                    b'a' => 0x07,
                    b'b' => 0x08,
                    b't' => b'\t',
                    b'n' => b'\n',
                    b'v' => 0x0b,
                    b'f' => 0x0c,
                    b'r' => b'\r',
                    b'0'..=b'3' => {
                        let digits = inner.get(i..i + 2)?;
                        i += 2;
                        let raw = [escaped, digits[0], digits[1]];
                        let octal = std::str::from_utf8(&raw).ok()?;
                        u8::from_str_radix(octal, 8).ok()?
                    }
                    other => other,
                });
            }
            out
        }
    };
    String::from_utf8(bytes).ok()?.strip_prefix("b/").map(str::to_owned)
}

/// Reads each revision's diff starting at its own commit, with the ranges the full walk
/// followed there; the output equals that commit's record in the full walk.
pub(crate) fn revisions_at(
    r: &Repo,
    spots: &[BlockRevisionSpot],
    encoding: TextEncoding,
    cancel: &CancellationToken,
) -> IdeResult<Vec<BlockRevision>> {
    if spots.is_empty() || spots.len() > DIFF_BATCH {
        return Err(IdeError::invalid("invalid selection history batch size"));
    }
    let mut runs = Vec::with_capacity(spots.len());
    for spot in spots {
        gix::ObjectId::from_hex(spot.id.as_bytes()).map_err(|_| IdeError::invalid("invalid selection history spot"))?;
        let ranges = spot.ranges.as_deref().ok_or_else(|| IdeError::invalid("invalid selection history spot"))?;
        let valid = |range: &&BlockSpotRange| {
            range.start > 0
                && range.end >= range.start
                && !range.path.is_empty()
                && !range.path.contains('\0')
                && !Path::new(&range.path).is_absolute()
        };
        if ranges.len() > 64 || !ranges.iter().all(|range| valid(&range)) {
            return Err(IdeError::invalid("invalid selection history spot"));
        }
        let ranges: Vec<_> =
            ranges.iter().map(|range| format!("-L{},{}:{}", range.start, range.end, range.path)).collect();
        runs.push((spot.id.as_str(), ranges));
    }
    let read_one = |id: &str, ranges: &[String]| -> IdeResult<BlockRevision> {
        // A commit shown without a diff (a merge) is just its header.
        let options: &[&str] = if ranges.is_empty() { &["-n1", "--no-patch"] } else { &["-n1"] };
        let out = cli::run_cancellable(r.root(), &log_args(options, ranges, id), cancel)?;
        let diffs = parse_log(&out.stdout, encoding);
        check_diffs(&diffs, std::iter::once(id))?;
        Ok(diffs.into_iter().next().expect("checked above"))
    };
    let Some(((first_id, first_ranges), rest)) = runs.split_first() else {
        unreachable!("checked non-empty above");
    };
    if rest.is_empty() {
        return Ok(vec![read_one(first_id, first_ranges)?]);
    }
    std::thread::scope(|scope| {
        let handles: Vec<_> = rest
            .iter()
            .map(|(id, ranges)| {
                scope.spawn(move || {
                    let _execution = r.execution_scope();
                    read_one(id, ranges)
                })
            })
            .collect();
        let first = read_one(first_id, first_ranges);
        let mut results = Vec::with_capacity(runs.len());
        let mut error = None;
        match first {
            Ok(rev) => results.push(rev),
            Err(e) => error = Some(e),
        }
        for handle in handles {
            match handle.join().map_err(|_| IdeError::internal("selection history diff query panicked"))? {
                Ok(rev) => {
                    if error.is_none() {
                        results.push(rev);
                    }
                }
                Err(e) => {
                    if error.is_none() {
                        error = Some(e);
                    }
                }
            }
        }
        if let Some(e) = error { Err(e) } else { Ok(results) }
    })
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

fn parse_summary(header: &[u8]) -> Option<BlockRevisionSummary> {
    let header = String::from_utf8_lossy(header);
    let mut fields = header.splitn(6, '\x1f');
    Some(BlockRevisionSummary {
        id: fields.next()?.to_owned(),
        short_id: fields.next()?.to_owned(),
        author: fields.next()?.to_owned(),
        email: fields.next()?.to_owned(),
        time_ms: fields.next()?.trim().parse::<f64>().ok()? * 1000.0,
        summary: fields.next().unwrap_or_default().to_owned(),
        ranges: Some(Vec::new()),
    })
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

    #[test]
    fn reads_spot_paths_as_git_writes_them() {
        assert_eq!(unquote_path(b"b/src/a.txt").as_deref(), Some("src/a.txt"));
        // A space makes git end the name with a tab.
        assert_eq!(unquote_path(b"b/\xc3\xbc c.txt\t").as_deref(), Some("\u{fc} c.txt"));
        assert_eq!(unquote_path(br#""b/a\tb \"q\".txt""#).as_deref(), Some("a\tb \"q\".txt"));
        assert_eq!(unquote_path(br#""b/\303\274.txt""#).as_deref(), Some("\u{fc}.txt"));
        assert_eq!(unquote_path(br#""b/\377.txt""#), None);
        assert_eq!(unquote_path(b"/dev/null"), None);
    }
}
