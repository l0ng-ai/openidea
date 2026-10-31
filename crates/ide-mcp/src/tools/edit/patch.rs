//! Patches as AI agents write them: the Codex `apply_patch` format and unified
//! (git) diffs. Parsing and applying hunks to a text are pure, so they are tested
//! here; the tool in `edit.rs` resolves paths and writes through the documents.

use std::fmt::Write as _;

/// One file of a patch, paths as written in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileOp {
    Add { path: String, text: String },
    Delete { path: String },
    Update { path: String, move_to: Option<String>, hunks: Vec<Hunk> },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Hunk {
    /// Codex `@@ <line>` anchors: found in order before the hunk's lines.
    pub anchors: Vec<String>,
    /// Unified diffs: the 1-based start in the old file, a hint where to look.
    pub old_start: Option<usize>,
    pub lines: Vec<Line>,
    /// Codex `*** End of File`: the lines end the file.
    pub at_eof: bool,
    /// `\ No newline at end of file` after the old / new side.
    pub old_no_newline: bool,
    pub new_no_newline: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Line {
    Context(String),
    Remove(String),
    Add(String),
}

impl Hunk {
    fn old_lines(&self) -> Vec<&str> {
        self.lines
            .iter()
            .filter_map(|l| match l {
                Line::Context(s) | Line::Remove(s) => Some(s.as_str()),
                Line::Add(_) => None,
            })
            .collect()
    }

    fn new_lines(&self) -> Vec<&str> {
        self.lines
            .iter()
            .filter_map(|l| match l {
                Line::Context(s) | Line::Add(s) => Some(s.as_str()),
                Line::Remove(_) => None,
            })
            .collect()
    }

    /// How the hunk is named in errors.
    fn label(&self, n: usize) -> String {
        match (self.anchors.last(), self.old_start) {
            (Some(a), _) => format!("hunk {n} (@@ {a})"),
            (None, Some(s)) => format!("hunk {n} (at line {s})"),
            _ => format!("hunk {n}"),
        }
    }
}

/// Parses either format (detected from its first header).
pub fn parse(input: &str) -> Result<Vec<FileOp>, String> {
    let lines: Vec<&str> = input.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let codex = lines.iter().position(|l| l.trim() == "*** Begin Patch");
    let unified = lines.iter().position(|l| {
        l.starts_with("diff --git ") || l.starts_with("--- ") || l.starts_with("+++ ") || l.starts_with("@@ -")
    });
    let ops = match (codex, unified) {
        (Some(c), u) if u.is_none_or(|u| c < u) => parse_codex(&lines, c)?,
        (_, Some(_)) => parse_unified(&lines)?,
        _ => {
            return Err("the input is not a patch: expected the apply_patch format (`*** Begin Patch` … \
`*** End Patch`) or a unified diff (`--- a/path`, `+++ b/path`, `@@ -1,2 +1,3 @@`)"
                .into());
        }
    };
    if ops.is_empty() {
        return Err("the patch changes no files".into());
    }
    Ok(ops)
}

// --- the Codex format -----------------------------------------------------------

const ADD: &str = "*** Add File: ";
const DELETE: &str = "*** Delete File: ";
const UPDATE: &str = "*** Update File: ";
const MOVE: &str = "*** Move to: ";
const END_PATCH: &str = "*** End Patch";
const END_OF_FILE: &str = "*** End of File";

fn is_codex_header(line: &str) -> bool {
    line.starts_with(ADD) || line.starts_with(DELETE) || line.starts_with(UPDATE) || line.trim() == END_PATCH
}

fn header_path(line: &str, prefix: &str, n: usize) -> Result<String, String> {
    let path = line[prefix.len()..].trim();
    if path.is_empty() { Err(format!("line {n}: `{}` without a path", prefix.trim())) } else { Ok(path.to_owned()) }
}

fn parse_codex(lines: &[&str], start: usize) -> Result<Vec<FileOp>, String> {
    let mut ops = Vec::new();
    let mut i = start + 1;
    loop {
        let Some(&line) = lines.get(i) else {
            return Err(format!("missing `{END_PATCH}`: the patch looks truncated"));
        };
        let n = i + 1;
        if line.trim() == END_PATCH {
            return Ok(ops);
        }
        if line.starts_with(ADD) {
            let path = header_path(line, ADD, n)?;
            i += 1;
            // (text, written with `+`): blank separator lines before the next header are dropped.
            let mut content: Vec<(&str, bool)> = Vec::new();
            while let Some(&l) = lines.get(i).filter(|l| !is_codex_header(l)) {
                match l.strip_prefix('+') {
                    Some(text) => content.push((text, true)),
                    None if l.trim().is_empty() => content.push(("", false)),
                    None => {
                        return Err(format!(
                            "line {}: every line of `{ADD}{path}` must start with `+`, found `{l}`",
                            i + 1
                        ));
                    }
                }
                i += 1;
            }
            while content.last().is_some_and(|(_, explicit)| !explicit) {
                content.pop();
            }
            let mut text = content.iter().map(|(t, _)| *t).collect::<Vec<_>>().join("\n");
            if !content.is_empty() {
                text.push('\n');
            }
            ops.push(FileOp::Add { path, text });
        } else if line.starts_with(DELETE) {
            ops.push(FileOp::Delete { path: header_path(line, DELETE, n)? });
            i += 1;
        } else if line.starts_with(UPDATE) {
            let path = header_path(line, UPDATE, n)?;
            i += 1;
            let mut move_to = None;
            if let Some(&l) = lines.get(i).filter(|l| l.starts_with(MOVE)) {
                move_to = Some(header_path(l, MOVE, i + 1)?);
                i += 1;
            }
            let hunks = parse_codex_hunks(lines, &mut i, &path)?;
            if hunks.is_empty() && move_to.is_none() {
                return Err(format!("line {n}: `{UPDATE}{path}` has no changes"));
            }
            ops.push(FileOp::Update { path, move_to, hunks });
        } else if line.trim().is_empty() {
            i += 1;
        } else {
            return Err(format!("line {n}: expected `{ADD}`, `{DELETE}`, `{UPDATE}` or `{END_PATCH}`, found `{line}`"));
        }
    }
}

fn parse_codex_hunks(lines: &[&str], i: &mut usize, path: &str) -> Result<Vec<Hunk>, String> {
    let mut hunks = Vec::new();
    let mut cur: Option<Hunk> = None;
    // Blank lines at the end of a hunk are usually separators, not context.
    let mut implicit_blanks = 0usize;
    let finish = |h: Option<Hunk>, blanks: usize, hunks: &mut Vec<Hunk>| {
        if let Some(mut h) = h {
            h.lines.truncate(h.lines.len() - blanks);
            if !h.lines.is_empty() {
                hunks.push(h);
            }
        }
    };
    while let Some(&line) = lines.get(*i).filter(|l| !is_codex_header(l)) {
        let n = *i + 1;
        *i += 1;
        if line.trim_end() == END_OF_FILE {
            match cur.as_mut() {
                Some(h) => h.at_eof = true,
                None => return Err(format!("line {n}: `{END_OF_FILE}` before any change in `{path}`")),
            }
            finish(cur.take(), implicit_blanks, &mut hunks);
            implicit_blanks = 0;
            continue;
        }
        if let Some(anchor) = line.strip_prefix("@@") {
            if cur.as_ref().is_some_and(|h| !h.lines.is_empty()) {
                finish(cur.take(), implicit_blanks, &mut hunks);
            }
            implicit_blanks = 0;
            // `@@ fn main() @@` repeats the marker at the end sometimes.
            let anchor = anchor.trim();
            let anchor = anchor.strip_suffix("@@").map(str::trim_end).unwrap_or(anchor);
            let h = cur.get_or_insert_with(Hunk::default);
            if !anchor.is_empty() {
                h.anchors.push(anchor.to_owned());
            }
            continue;
        }
        let h = cur.get_or_insert_with(Hunk::default);
        let parsed = match line.chars().next() {
            Some(' ') => Line::Context(line[1..].to_owned()),
            Some('-') => Line::Remove(line[1..].to_owned()),
            Some('+') => Line::Add(line[1..].to_owned()),
            None => Line::Context(String::new()),
            Some(_) => {
                return Err(format!(
                    "line {n}: unexpected `{line}` in the changes of `{path}`: lines must start with ' ' (context), \
'-' (remove) or '+' (add)"
                ));
            }
        };
        implicit_blanks = if line.is_empty() { implicit_blanks + 1 } else { 0 };
        h.lines.push(parsed);
    }
    finish(cur, implicit_blanks, &mut hunks);
    Ok(hunks)
}

// --- unified diffs -------------------------------------------------------------

#[derive(Default)]
struct Section {
    git_old: Option<String>,
    git_new: Option<String>,
    /// `---` / `+++` seen; `None` inside is `/dev/null`.
    old: Option<Option<String>>,
    new: Option<Option<String>>,
    new_file: bool,
    deleted: bool,
    rename_from: Option<String>,
    rename_to: Option<String>,
    hunks: Vec<Hunk>,
    line: usize,
}

fn is_file_start(lines: &[&str], i: usize) -> bool {
    let l = lines[i];
    l.starts_with("diff --git ")
        || (l.starts_with("--- ") && lines.get(i + 1).is_some_and(|n| n.starts_with("+++ ")) && l != "--- ")
}

fn parse_unified(lines: &[&str]) -> Result<Vec<FileOp>, String> {
    let mut ops = Vec::new();
    let mut i = 0;
    let mut section: Option<Section> = None;
    while i < lines.len() {
        let line = lines[i];
        let n = i + 1;
        if is_file_start(lines, i)
            && (line.starts_with("diff --git ") || section.as_ref().is_none_or(|s| s.old.is_some()))
        {
            if let Some(s) = section.take() {
                ops.push(finish_section(s)?);
            }
            let mut s = Section { line: n, ..Section::default() };
            if let Some(rest) = line.strip_prefix("diff --git ") {
                (s.git_old, s.git_new) = split_git_paths(rest);
                i += 1;
            }
            section = Some(s);
            continue;
        }
        let Some(s) = section.as_mut() else {
            if line.starts_with("@@ ") {
                return Err(format!("line {n}: a hunk without a `--- a/path` / `+++ b/path` header before it"));
            }
            // Text before the first file (a commit message, `Index:` lines).
            i += 1;
            continue;
        };
        if let Some(p) = line.strip_prefix("--- ") {
            s.old = Some(diff_path(p, "a/"));
        } else if let Some(p) = line.strip_prefix("+++ ") {
            s.new = Some(diff_path(p, "b/"));
        } else if line.starts_with("new file mode") {
            s.new_file = true;
        } else if line.starts_with("deleted file mode") {
            s.deleted = true;
        } else if let Some(p) = line.strip_prefix("rename from ") {
            s.rename_from = Some(unquote(p.trim()));
        } else if let Some(p) = line.strip_prefix("rename to ") {
            s.rename_to = Some(unquote(p.trim()));
        } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            return Err(format!("line {n}: binary patches are not supported"));
        } else if line.starts_with("copy from ") || line.starts_with("copy to ") {
            return Err(format!("line {n}: copies are not supported; add the new file instead"));
        } else if line.starts_with("@@") {
            if s.old.is_none() && s.new.is_none() && s.git_old.is_none() {
                return Err(format!("line {n}: a hunk without a `--- a/path` / `+++ b/path` header before it"));
            }
            i += 1;
            let hunk = parse_unified_hunk(lines, &mut i, line, n)?;
            s.hunks.push(hunk);
            continue;
        } else if !s.hunks.is_empty() && (line.starts_with('+') || line.starts_with('-') || line.starts_with(' ')) {
            // Lines after a hunk that its counts left out (`-- ` ends `git format-patch` output).
            if line != "-- " {
                return Err(format!(
                    "line {n}: `{line}` follows a hunk but is not part of it; check the hunk's counts"
                ));
            }
            if let Some(s) = section.take() {
                ops.push(finish_section(s)?);
            }
        }
        // Other extended headers (`index`, modes, similarity) need nothing.
        i += 1;
    }
    if let Some(s) = section {
        ops.push(finish_section(s)?);
    }
    Ok(ops)
}

/// `@@ -a,b +c,d @@`: hunk lines until the counts are used up; lines beyond
/// counts that are too small are taken too, and a bare `@@` reads to the next header.
fn parse_unified_hunk(lines: &[&str], i: &mut usize, header: &str, n: usize) -> Result<Hunk, String> {
    let counts = parse_range_header(header);
    if counts.is_none() && header.starts_with("@@ -") {
        return Err(format!("line {n}: cannot read the hunk header `{header}`"));
    }
    let mut hunk = Hunk { old_start: counts.map(|c| c.0), ..Hunk::default() };
    let (mut old_left, mut new_left) = counts.map_or((usize::MAX, usize::MAX), |c| (c.1, c.2));
    let mut implicit_blanks = 0usize;
    while let Some(&line) = lines.get(*i) {
        let done = old_left == 0 && new_left == 0;
        if line.starts_with("@@") || is_file_start(lines, *i) {
            break;
        }
        if line.starts_with('\\') {
            match hunk.lines.last() {
                Some(Line::Remove(_)) => hunk.old_no_newline = true,
                Some(Line::Add(_)) => hunk.new_no_newline = true,
                Some(Line::Context(_)) => {
                    hunk.old_no_newline = true;
                    hunk.new_no_newline = true;
                }
                None => {}
            }
            *i += 1;
            continue;
        }
        let parsed = match line.chars().next() {
            _ if done && (line.is_empty() || line == "-- ") => break,
            Some(' ') => Line::Context(line[1..].to_owned()),
            Some('-') => Line::Remove(line[1..].to_owned()),
            Some('+') => Line::Add(line[1..].to_owned()),
            // Editors strip the space of empty context lines.
            None => Line::Context(String::new()),
            Some(_) => break,
        };
        match parsed {
            Line::Context(_) => {
                old_left = old_left.saturating_sub(1);
                new_left = new_left.saturating_sub(1);
            }
            Line::Remove(_) => old_left = old_left.saturating_sub(1),
            Line::Add(_) => new_left = new_left.saturating_sub(1),
        }
        implicit_blanks = if line.is_empty() { implicit_blanks + 1 } else { 0 };
        hunk.lines.push(parsed);
        *i += 1;
    }
    if counts.is_none() {
        hunk.lines.truncate(hunk.lines.len() - implicit_blanks);
    }
    if hunk.lines.is_empty() {
        return Err(format!("line {n}: the hunk `{header}` has no lines"));
    }
    Ok(hunk)
}

/// (old start, old count, new count) of `@@ -a[,b] +c[,d] @@`.
fn parse_range_header(header: &str) -> Option<(usize, usize, usize)> {
    let rest = header.strip_prefix("@@ -")?;
    let (ranges, _) = rest.split_once(" @@").unwrap_or((rest, ""));
    let (old, new) = ranges.split_once(" +")?;
    let range = |r: &str| -> Option<(usize, usize)> {
        match r.trim().split_once(',') {
            Some((s, c)) => Some((s.parse().ok()?, c.parse().ok()?)),
            None => Some((r.trim().parse().ok()?, 1)),
        }
    };
    let (start, old_count) = range(old)?;
    let (_, new_count) = range(new)?;
    Some((start, old_count, new_count))
}

/// The two paths of `diff --git a/x b/y` (ambiguous with spaces: equal halves win).
fn split_git_paths(rest: &str) -> (Option<String>, Option<String>) {
    let rest = rest.trim();
    if let Some((a, b)) = rest.strip_prefix('"').and_then(|r| r.split_once("\" ")) {
        return (Some(strip_prefix(&unquote(&format!("\"{a}\"")), "a/")), Some(strip_prefix(&unquote(b), "b/")));
    }
    let splits: Vec<usize> = rest.match_indices(" b/").map(|(i, _)| i).collect();
    let pick = splits.iter().find(|&&i| rest[..i].strip_prefix("a/") == Some(&rest[i + 3..])).or(splits.first());
    match pick {
        Some(&i) => (Some(strip_prefix(&rest[..i], "a/")), Some(rest[i + 3..].to_owned())),
        None => (None, None),
    }
}

/// A `---` / `+++` path: `None` for `/dev/null`; timestamps and the `a/` / `b/` prefix removed.
fn diff_path(raw: &str, prefix: &str) -> Option<String> {
    let raw = raw.split('\t').next().unwrap_or(raw).trim_end();
    let path = unquote(raw);
    if path == "/dev/null" {
        return None;
    }
    Some(strip_prefix(&path, prefix))
}

fn strip_prefix(path: &str, prefix: &str) -> String {
    path.strip_prefix(prefix).unwrap_or(path).to_owned()
}

/// Git quotes paths with special characters: `"a/x \"y\""`.
fn unquote(s: &str) -> String {
    let Some(inner) = s.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else { return s.to_owned() };
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(c) => out.push(c),
            None => {}
        }
    }
    out
}

fn finish_section(s: Section) -> Result<FileOp, String> {
    let n = s.line;
    let old = match &s.old {
        Some(p) => p.clone(),
        None => s.rename_from.clone().or_else(|| s.git_old.clone()),
    };
    let new = match &s.new {
        Some(p) => p.clone(),
        None => s.rename_to.clone().or_else(|| s.git_new.clone()),
    };
    if s.new_file || (s.old.as_ref().is_some_and(|o| o.is_none())) {
        let path = new.ok_or_else(|| format!("line {n}: a new file without a path"))?;
        let mut lines = Vec::new();
        let mut no_newline = false;
        for h in &s.hunks {
            for l in &h.lines {
                match l {
                    Line::Add(t) => lines.push(t.as_str()),
                    _ => return Err(format!("`{path}` is a new file, but its hunk has context or removed lines")),
                }
            }
            no_newline |= h.new_no_newline;
        }
        let mut text = lines.join("\n");
        if !lines.is_empty() && !no_newline {
            text.push('\n');
        }
        return Ok(FileOp::Add { path, text });
    }
    if s.deleted || (s.new.as_ref().is_some_and(|n| n.is_none())) {
        let path = old.ok_or_else(|| format!("line {n}: a deleted file without a path"))?;
        return Ok(FileOp::Delete { path });
    }
    let path = old.or(new.clone()).ok_or_else(|| format!("line {n}: a file without a path"))?;
    let move_to = new.filter(|p| *p != path);
    if s.hunks.is_empty() && move_to.is_none() {
        return Err(format!("line {n}: `{path}` has no changes"));
    }
    Ok(FileOp::Update { path, move_to, hunks: s.hunks })
}

// --- applying -------------------------------------------------------------------

/// How exactly a hunk's lines matched the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Fuzz {
    Exact,
    TrailingWhitespace,
    Whitespace,
}

impl Fuzz {
    fn same(self, a: &str, b: &str) -> bool {
        match self {
            Fuzz::Exact => a == b,
            Fuzz::TrailingWhitespace => a.trim_end() == b.trim_end(),
            Fuzz::Whitespace => a.trim() == b.trim(),
        }
    }
}

const LEVELS: [Fuzz; 3] = [Fuzz::Exact, Fuzz::TrailingWhitespace, Fuzz::Whitespace];

/// The result of [`apply`]: the new text and the hunks that matched only loosely.
#[derive(Debug, PartialEq, Eq)]
pub struct Applied {
    pub text: String,
    /// (1-based hunk, how it matched) for hunks that did not match exactly.
    pub fuzzy: Vec<(usize, Fuzz)>,
}

/// Applies `hunks` in order to `text` (`\n` line endings). Errors name the
/// hunk and the lines that were not found.
pub fn apply(text: &str, hunks: &[Hunk]) -> Result<Applied, String> {
    let trailing_newline = text.ends_with('\n');
    let lines: Vec<&str> = if text.is_empty() {
        Vec::new()
    } else {
        let mut l: Vec<&str> = text.split('\n').collect();
        if trailing_newline {
            l.pop();
        }
        l
    };
    let mut cursor = 0usize;
    // (start, removed count, replacement lines), in file order.
    let mut replacements: Vec<(usize, usize, Vec<&str>)> = Vec::new();
    let mut fuzzy = Vec::new();
    let mut ends_without_newline = None;
    for (index, hunk) in hunks.iter().enumerate() {
        let n = index + 1;
        for anchor in &hunk.anchors {
            let found = LEVELS
                .iter()
                .find_map(|level| (cursor..lines.len()).find(|&i| level.same(lines[i], anchor)))
                .ok_or_else(|| {
                format!("{}: cannot find the line `{anchor}` its `@@` header names", hunk.label(n))
            })?;
            cursor = found + 1;
        }
        let mut old = hunk.old_lines();
        let hint = hunk.old_start.map(|s| s.saturating_sub(1));
        if old.is_empty() {
            let at = if !hunk.anchors.is_empty() {
                cursor
            } else if hunk.at_eof {
                lines.len()
            } else {
                // `@@ -5,0 +6,2 @@` inserts after line 5; without a position, at the end.
                hunk.old_start.map_or(lines.len(), |s| s.min(lines.len())).max(cursor)
            };
            replacements.push((at, 0, hunk.new_lines()));
            cursor = at;
            continue;
        }
        let mut found = find_block(&lines, &old, cursor, hint, hunk.at_eof);
        // A blank last line in the patch that the file does not have (Codex does the same).
        if found.is_none() && old.last() == Some(&"") {
            old.pop();
            if !old.is_empty() {
                found = find_block(&lines, &old, cursor, hint, hunk.at_eof);
            }
        }
        let Some((at, level)) = found else {
            return Err(mismatch(&lines, &old, cursor, hint, &hunk.label(n)));
        };
        if level != Fuzz::Exact {
            fuzzy.push((n, level));
        }
        if at + old.len() == lines.len() {
            if hunk.new_no_newline {
                ends_without_newline = Some(true);
            } else if hunk.old_no_newline {
                ends_without_newline = Some(false);
            }
        }
        // Context lines keep the file's spelling (a loose match must not re-indent them).
        let mut new = Vec::new();
        let mut matched = 0usize;
        for line in &hunk.lines {
            match line {
                Line::Context(_) | Line::Remove(_) if matched >= old.len() => {}
                Line::Context(_) => {
                    new.push(lines[at + matched]);
                    matched += 1;
                }
                Line::Remove(_) => matched += 1,
                Line::Add(s) => new.push(s.as_str()),
            }
        }
        replacements.push((at, old.len(), new));
        cursor = at + old.len();
    }
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut pos = 0;
    for (at, removed, new) in &replacements {
        out.extend_from_slice(&lines[pos..*at]);
        out.extend(new.iter().copied());
        pos = at + removed;
    }
    out.extend_from_slice(&lines[pos.min(lines.len())..]);
    let mut result = out.join("\n");
    let newline = match ends_without_newline {
        Some(no) => !no,
        None => trailing_newline || text.is_empty(),
    };
    if newline && !out.is_empty() {
        result.push('\n');
    }
    Ok(Applied { text: result, fuzzy })
}

/// Where `old` occurs at or after `from`, as exactly as possible; with a hint,
/// the occurrence nearest to it.
fn find_block(lines: &[&str], old: &[&str], from: usize, hint: Option<usize>, at_eof: bool) -> Option<(usize, Fuzz)> {
    if old.len() > lines.len() {
        return None;
    }
    let last = lines.len() - old.len();
    let matches = |at: usize, level: Fuzz| old.iter().zip(&lines[at..]).all(|(o, l)| level.same(l, o));
    for level in LEVELS {
        if at_eof && last >= from && matches(last, level) {
            return Some((last, level));
        }
        let mut best: Option<usize> = None;
        for at in from..=last {
            if !matches(at, level) {
                continue;
            }
            match hint {
                None => return Some((at, level)),
                Some(h) => {
                    if best.is_none_or(|b| at.abs_diff(h) < b.abs_diff(h)) {
                        best = Some(at);
                    }
                }
            }
        }
        if let Some(at) = best {
            return Some((at, level));
        }
    }
    None
}

/// The error for lines that were not found, with the closest partial match.
fn mismatch(lines: &[&str], old: &[&str], from: usize, hint: Option<usize>, label: &str) -> String {
    let mut msg = format!("{label} does not apply: these lines were not found");
    if from > 0 {
        let _ = write!(msg, " after line {from}");
    }
    msg.push_str(":\n");
    for l in old {
        let _ = writeln!(msg, "  {l}");
    }
    // The start with the longest run of matching lines (ignoring whitespace).
    let mut best: Option<(usize, usize)> = None;
    for at in 0..lines.len() {
        let run = old.iter().zip(&lines[at..]).take_while(|(o, l)| o.trim() == l.trim()).count();
        let better = match best {
            None => run > 0,
            Some((b, r)) => run > r || (run == r && hint.is_some_and(|h| at.abs_diff(h) < b.abs_diff(h))),
        };
        if better {
            best = Some((at, run));
        }
    }
    match best {
        Some((at, run)) if run < old.len() => {
            let actual = lines.get(at + run).map_or("(end of file)".to_owned(), |l| format!("`{l}`"));
            let _ = write!(
                msg,
                "Closest match at line {}: line {} is {actual}, but the patch expects `{}`.",
                at + 1,
                at + run + 1,
                old[run]
            );
        }
        Some((at, _)) => {
            let _ = write!(msg, "They occur at line {}, before the previous hunk; keep hunks in file order.", at + 1);
        }
        None => {
            // A common mistake: only part of a line after `-` / ` `.
            let partial = old
                .iter()
                .filter(|o| !o.trim().is_empty())
                .find_map(|o| lines.iter().position(|l| l.contains(o.trim())).map(|i| (o.trim(), i)));
            match partial {
                Some((o, i)) => {
                    let _ = write!(
                        msg,
                        "Line {} contains `{o}` but is `{}`: patch lines must be whole lines, with their indentation.",
                        i + 1,
                        lines[i]
                    );
                }
                None => msg.push_str("No line of them is in the file; read the file again before patching it."),
            }
        }
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(ops: &[FileOp]) -> &[Hunk] {
        match &ops[0] {
            FileOp::Update { hunks, .. } => hunks,
            other => panic!("not an update: {other:?}"),
        }
    }

    fn apply_patch(text: &str, patch: &str) -> Result<String, String> {
        let ops = parse(patch)?;
        apply(text, update(&ops)).map(|a| a.text)
    }

    // --- Codex format -------------------------------------------------------

    #[test]
    fn parses_every_codex_operation() {
        let ops = parse(
            "*** Begin Patch\n*** Add File: new.txt\n+one\n+two\n*** Delete File: old.txt\n*** Update File: a.rs\n\
*** Move to: b.rs\n@@ fn main\n ctx\n-old\n+new\n*** End Patch\n",
        )
        .unwrap();
        assert_eq!(
            ops,
            vec![
                FileOp::Add { path: "new.txt".into(), text: "one\ntwo\n".into() },
                FileOp::Delete { path: "old.txt".into() },
                FileOp::Update {
                    path: "a.rs".into(),
                    move_to: Some("b.rs".into()),
                    hunks: vec![Hunk {
                        anchors: vec!["fn main".into()],
                        lines: vec![Line::Context("ctx".into()), Line::Remove("old".into()), Line::Add("new".into())],
                        ..Hunk::default()
                    }],
                },
            ]
        );
    }

    #[test]
    fn codex_tolerates_wrappers_crlf_and_blank_separators() {
        let ops = parse(
            "apply_patch <<'EOF'\r\n*** Begin Patch\r\n*** Add File: x\r\n+a\r\n+\r\n\r\n*** Update File: y\r\n-a\r\n+b\r\n\r\n*** End Patch\r\nEOF",
        )
        .unwrap();
        assert_eq!(ops[0], FileOp::Add { path: "x".into(), text: "a\n\n".into() });
        assert_eq!(update(&ops[1..])[0].lines, vec![Line::Remove("a".into()), Line::Add("b".into())]);
    }

    #[test]
    fn codex_empty_add_and_move_only() {
        let ops = parse("*** Begin Patch\n*** Add File: e\n*** Update File: a\n*** Move to: b\n*** End Patch").unwrap();
        assert_eq!(ops[0], FileOp::Add { path: "e".into(), text: String::new() });
        assert_eq!(ops[1], FileOp::Update { path: "a".into(), move_to: Some("b".into()), hunks: vec![] });
    }

    #[test]
    fn codex_errors() {
        let e = parse("*** Begin Patch\n*** Update File: a\n-x\n+y\n").unwrap_err();
        assert!(e.contains("truncated"), "{e}");
        let e = parse("*** Begin Patch\n*** Add File: a\nno plus\n*** End Patch").unwrap_err();
        assert!(e.contains("line 3") && e.contains("must start with `+`"), "{e}");
        let e = parse("*** Begin Patch\n*** Update File: a\n*** End Patch").unwrap_err();
        assert!(e.contains("no changes"), "{e}");
        let e = parse("*** Begin Patch\n*** Frobnicate: a\n*** End Patch").unwrap_err();
        assert!(e.contains("line 2"), "{e}");
        let e = parse("*** Begin Patch\n*** Update File: a\n@@\n#bad\n*** End Patch").unwrap_err();
        assert!(e.contains("line 4") && e.contains("unexpected"), "{e}");
        assert!(parse("*** Begin Patch\n*** End Patch").unwrap_err().contains("no files"));
        assert!(parse("just some text").unwrap_err().contains("not a patch"));
        assert!(parse("*** Begin Patch\n*** Add File: \n*** End Patch").unwrap_err().contains("without a path"));
    }

    #[test]
    fn codex_hunks_split_on_markers_and_stack_anchors() {
        let ops = parse(
            "*** Begin Patch\n*** Update File: a\n@@ class A\n@@ def f():\n-x\n+y\n@@\n-p\n+q\n*** End of File\n*** End Patch",
        )
        .unwrap();
        let hunks = update(&ops);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].anchors, vec!["class A".to_owned(), "def f():".to_owned()]);
        assert!(!hunks[0].at_eof && hunks[1].at_eof);
        assert!(hunks[1].anchors.is_empty());
    }

    #[test]
    fn applies_codex_hunks_with_anchors() {
        let text = "class A:\n    def f():\n        return 1\nclass B:\n    def f():\n        return 1\n";
        let patch = "*** Begin Patch\n*** Update File: a.py\n@@ class B:\n     def f():\n-        return 1\n+        return 2\n*** End Patch";
        assert_eq!(
            apply_patch(text, patch).unwrap(),
            "class A:\n    def f():\n        return 1\nclass B:\n    def f():\n        return 2\n"
        );
    }

    #[test]
    fn applies_several_hunks_in_order() {
        let text = "a\nb\nc\nd\ne\nf\n";
        let patch = "*** Begin Patch\n*** Update File: x\n@@\n a\n-b\n+B\n@@\n e\n-f\n+F\n+G\n*** End Patch";
        assert_eq!(apply_patch(text, patch).unwrap(), "a\nB\nc\nd\ne\nF\nG\n");
    }

    #[test]
    fn same_lines_twice_match_in_order() {
        let text = "x\ny\nx\ny\n";
        let patch = "*** Begin Patch\n*** Update File: f\n@@\n-x\n+1\n@@\n-x\n+2\n*** End Patch";
        assert_eq!(apply_patch(text, patch).unwrap(), "1\ny\n2\ny\n");
    }

    #[test]
    fn end_of_file_prefers_the_last_occurrence() {
        let text = "end\nmid\nend\n";
        let patch = "*** Begin Patch\n*** Update File: f\n@@\n-end\n+END\n*** End of File\n*** End Patch";
        assert_eq!(apply_patch(text, patch).unwrap(), "end\nmid\nEND\n");
    }

    #[test]
    fn pure_additions_go_after_the_anchor_or_at_the_end() {
        let text = "fn a() {}\nfn b() {}\n";
        let after = "*** Begin Patch\n*** Update File: f\n@@ fn a() {}\n+fn a2() {}\n*** End Patch";
        assert_eq!(apply_patch(text, after).unwrap(), "fn a() {}\nfn a2() {}\nfn b() {}\n");
        let end = "*** Begin Patch\n*** Update File: f\n@@\n+fn c() {}\n*** End Patch";
        assert_eq!(apply_patch(text, end).unwrap(), "fn a() {}\nfn b() {}\nfn c() {}\n");
    }

    #[test]
    fn whitespace_tolerance_is_reported() {
        let text = "fn main() {   \n    let x = 1;\n}\n";
        let ops = parse(
            "*** Begin Patch\n*** Update File: f\n@@\n fn main() {\n-    let x = 1;\n+    let x = 2;\n*** End Patch",
        )
        .unwrap();
        let a = apply(text, update(&ops)).unwrap();
        assert_eq!(a.text, "fn main() {   \n    let x = 2;\n}\n");
        assert_eq!(a.fuzzy, vec![(1, Fuzz::TrailingWhitespace)]);
        let ops =
            parse("*** Begin Patch\n*** Update File: f\n@@\n-let x = 1;\n+    let y = 1;\n*** End Patch").unwrap();
        let a = apply(text, update(&ops)).unwrap();
        assert_eq!(a.text, "fn main() {   \n    let y = 1;\n}\n");
        assert_eq!(a.fuzzy, vec![(1, Fuzz::Whitespace)]);
    }

    #[test]
    fn a_trailing_blank_context_line_is_optional() {
        let text = "a\nb";
        let patch = "*** Begin Patch\n*** Update File: f\n@@\n-b\n+c\n \n*** End Patch";
        assert_eq!(apply_patch(text, patch).unwrap(), "a\nc");
    }

    #[test]
    fn keeps_a_missing_final_newline_and_handles_empty_files() {
        assert_eq!(apply_patch("a\nb", "*** Begin Patch\n*** Update File: f\n-b\n+c\n*** End Patch").unwrap(), "a\nc");
        assert_eq!(apply_patch("", "*** Begin Patch\n*** Update File: f\n+x\n*** End Patch").unwrap(), "x\n");
        assert_eq!(apply_patch("a\n", "*** Begin Patch\n*** Update File: f\n-a\n*** End Patch").unwrap(), "");
    }

    #[test]
    fn reports_where_a_hunk_went_wrong() {
        let text = "fn a() {\n    one();\n    two();\n}\n";
        let patch = "*** Begin Patch\n*** Update File: f\n@@\n fn a() {\n     one();\n-    three();\n+    four();\n*** End Patch";
        let e = apply_patch(text, patch).unwrap_err();
        assert!(e.starts_with("hunk 1 does not apply"), "{e}");
        assert!(e.contains("  fn a() {\n      one();\n      three();\n"), "{e}");
        assert!(
            e.contains("Closest match at line 1: line 3 is `    two();`, but the patch expects `    three();`"),
            "{e}"
        );
        let e = apply_patch(text, "*** Begin Patch\n*** Update File: f\n@@ fn zzz\n-x\n*** End Patch").unwrap_err();
        assert!(e.contains("hunk 1 (@@ fn zzz)") && e.contains("`fn zzz`"), "{e}");
        let e = apply_patch(text, "*** Begin Patch\n*** Update File: f\n-nothing\n*** End Patch").unwrap_err();
        assert!(e.contains("No line of them"), "{e}");
        let e = apply_patch(text, "*** Begin Patch\n*** Update File: f\n-two\n+three\n*** End Patch").unwrap_err();
        assert!(e.contains("Line 3 contains `two` but is `    two();`: patch lines must be whole lines"), "{e}");
        let e =
            apply_patch(text, "*** Begin Patch\n*** Update File: f\n@@\n-    two();\n@@\n-    one();\n*** End Patch")
                .unwrap_err();
        assert!(e.contains("hunk 2") && e.contains("file order"), "{e}");
    }

    // --- unified diffs ------------------------------------------------------

    const GIT: &str = "diff --git a/src/lib.rs b/src/lib.rs
index 3b18e51..a9e0c2f 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,3 +1,3 @@ mod x;
 fn a() {}
-fn b() {}
+fn b() { todo!() }
 fn c() {}
@@ -10,2 +10,3 @@
 fn j() {}
+fn k() {}
 fn l() {}
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
--- a/old name.txt
+++ b/new name.txt
@@ -1 +1 @@
-x
+y
";

    #[test]
    fn parses_git_diffs() {
        let ops = parse(GIT).unwrap();
        assert_eq!(ops.len(), 4);
        match &ops[0] {
            FileOp::Update { path, move_to: None, hunks } => {
                assert_eq!(path, "src/lib.rs");
                assert_eq!(hunks.len(), 2);
                assert_eq!(hunks[0].old_start, Some(1));
                assert_eq!(hunks[1].lines.len(), 3);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(ops[1], FileOp::Add { path: "new.txt".into(), text: "hello\nworld\n".into() });
        assert_eq!(ops[2], FileOp::Delete { path: "gone.txt".into() });
        assert!(matches!(&ops[3], FileOp::Update { path, move_to: Some(to), .. }
            if path == "old name.txt" && to == "new name.txt"));
    }

    #[test]
    fn parses_plain_unified_diffs_and_pure_renames() {
        let ops =
            parse("--- a.txt\t2024-01-01 10:00:00\n+++ a.txt\t2024-01-02 10:00:00\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n")
                .unwrap();
        assert!(
            matches!(&ops[0], FileOp::Update { path, move_to: None, hunks } if path == "a.txt" && hunks.len() == 1)
        );
        let ops =
            parse("diff --git a/x.rs b/y/x.rs\nsimilarity index 100%\nrename from x.rs\nrename to y/x.rs\n").unwrap();
        assert_eq!(ops[0], FileOp::Update { path: "x.rs".into(), move_to: Some("y/x.rs".into()), hunks: vec![] });
        let ops = parse("diff --git a/e b/e\nnew file mode 100644\nindex 0000000..e69de29\n").unwrap();
        assert_eq!(ops[0], FileOp::Add { path: "e".into(), text: String::new() });
        let ops = parse("diff --git \"a/sp ace\" \"b/sp ace\"\ndeleted file mode 100644\n").unwrap();
        assert_eq!(ops[0], FileOp::Delete { path: "sp ace".into() });
    }

    #[test]
    fn unified_counts_are_tolerated() {
        // Counts too large: the next header ends the hunk.
        let ops = parse("--- a/f\n+++ b/f\n@@ -1,9 +1,9 @@\n-a\n+b\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-c\n+d\n").unwrap();
        assert_eq!(ops.len(), 2);
        assert_eq!(update(&ops)[0].lines.len(), 2);
        // Counts too small: following hunk lines still belong to it.
        let ops = parse("--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+b\n c\n").unwrap();
        assert_eq!(update(&ops)[0].lines.len(), 3);
        // A bare `@@` reads to the next header; empty lines are empty context.
        let ops = parse("--- a/f\n+++ b/f\n@@\n x\n\n-y\n+z\n\n").unwrap();
        assert_eq!(
            update(&ops)[0].lines,
            vec![
                Line::Context("x".into()),
                Line::Context(String::new()),
                Line::Remove("y".into()),
                Line::Add("z".into())
            ]
        );
        // `git format-patch` signature.
        let ops = parse("Subject: x\n---\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n-- \n2.43.0\n").unwrap();
        assert_eq!(ops.len(), 1);
    }

    #[test]
    fn unified_errors() {
        assert!(parse("@@ -1 +1 @@\n-a\n+b\n").unwrap_err().contains("without a `--- a/path`"));
        assert!(parse("--- a/f\n+++ b/f\n@@ -x +y @@\n-a\n").unwrap_err().contains("cannot read"));
        assert!(parse("diff --git a/f b/f\nBinary files a/f and b/f differ\n").unwrap_err().contains("binary"));
        assert!(parse("diff --git a/f b/f\nindex 1..2\n").unwrap_err().contains("no changes"));
        assert!(parse("--- /dev/null\n+++ b/n\n@@ -1 +1 @@\n x\n").unwrap_err().contains("new file"));
    }

    #[test]
    fn applies_unified_hunks_near_their_line_numbers() {
        let text = "x\nsame\nx\nx\nx\nsame\nx\n";
        let ops = parse("--- a/f\n+++ b/f\n@@ -6,1 +6,1 @@\n-same\n+changed\n").unwrap();
        assert_eq!(apply(text, update(&ops)).unwrap().text, "x\nsame\nx\nx\nx\nchanged\nx\n");
        // Wrong line numbers still apply where the context is.
        let ops = parse("--- a/f\n+++ b/f\n@@ -40,2 +40,2 @@\n x\n-same\n+changed\n").unwrap();
        assert_eq!(apply(text, update(&ops)).unwrap().text, "x\nsame\nx\nx\nx\nchanged\nx\n");
        // Insertion after line 2 (`-2,0`).
        let ops = parse("--- a/f\n+++ b/f\n@@ -2,0 +3,1 @@\n+new\n").unwrap();
        assert_eq!(apply(text, update(&ops)).unwrap().text, "x\nsame\nnew\nx\nx\nx\nsame\nx\n");
    }

    #[test]
    fn applies_the_git_example() {
        let text = "fn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\nfn e() {}\nfn f() {}\nfn g() {}\nfn h() {}\nfn i() {}\nfn j() {}\nfn l() {}\n";
        let ops = parse(GIT).unwrap();
        let out = apply(text, update(&ops)).unwrap().text;
        assert_eq!(
            out,
            "fn a() {}\nfn b() { todo!() }\nfn c() {}\nfn d() {}\nfn e() {}\nfn f() {}\nfn g() {}\nfn h() {}\nfn i() {}\nfn j() {}\nfn k() {}\nfn l() {}\n"
        );
    }

    #[test]
    fn no_newline_markers() {
        let add = parse("--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n\\ No newline at end of file\n").unwrap();
        assert_eq!(add[0], FileOp::Add { path: "n".into(), text: "x".into() });
        // Adding the final newline.
        let ops = parse("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n").unwrap();
        assert_eq!(apply("a\nb", update(&ops)).unwrap().text, "a\nb\n");
        // Removing it.
        let ops = parse("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n").unwrap();
        assert_eq!(apply("a\nb\n", update(&ops)).unwrap().text, "a\nb");
    }

    #[test]
    fn splits_git_paths() {
        assert_eq!(split_git_paths("a/x y b/x y"), (Some("x y".into()), Some("x y".into())));
        assert_eq!(split_git_paths("a/x b/y"), (Some("x".into()), Some("y".into())));
        assert_eq!(parse_range_header("@@ -3 +4,0 @@"), Some((3, 1, 0)));
        assert_eq!(parse_range_header("@@ -1,2 +1,3 @@ fn x"), Some((1, 2, 3)));
        assert_eq!(unquote("\"a\\\"b\\\\c\""), "a\"b\\c");
    }
}
