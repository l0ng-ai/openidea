// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.toolsets/src/general/PatchApplyEngine.kt), Apache-2.0.
//! Patches as AI agents write them: the Codex `apply_patch` format (with the
//! strict `@@` pair blocks some models write) and unified (git) diffs, bare or
//! inside `*** Begin Patch`. Parsing and applying hunks to a text are pure, so
//! they are tested here; the tool in `edit.rs` resolves paths and writes through
//! the documents.
//!
//! Beyond JetBrains: stacked `@@` anchors, unified hunk line numbers as hints,
//! `\ No newline at end of file`, plain `diff -u` / `diff -ru` names, and errors
//! that show where a hunk went wrong.

use std::fmt::Write as _;

/// One file of a patch, paths as written in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileOp {
    Add {
        path: String,
        text: String,
    },
    Delete {
        path: String,
    },
    /// `or` lists other paths the file may have, tried in order when `path` does
    /// not exist (a plain diff's `---` name, or its names without their first
    /// directory, as `patch -p1` reads `diff -ru old/ new/`).
    Update {
        path: String,
        move_to: Option<String>,
        hunks: Vec<Hunk>,
        or: Vec<String>,
    },
    /// A git section the tool does not apply (a copy): skipped with `note`, the others go on.
    Skip {
        path: String,
        note: String,
    },
}

impl FileOp {
    pub fn path(&self) -> &str {
        match self {
            FileOp::Add { path, .. }
            | FileOp::Delete { path }
            | FileOp::Update { path, .. }
            | FileOp::Skip { path, .. } => path,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Hunk {
    /// `@@ <line>` anchors: found in order before the hunk's lines.
    pub anchors: Vec<String>,
    /// `@@ -a,b +c,d @@`: the 1-based start in the old file, a hint where to look.
    pub old_start: Option<usize>,
    pub lines: Vec<Line>,
    /// `*** End of File`: the lines end the file.
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

const BEGIN_PATCH: &str = "*** Begin Patch";
const END_PATCH: &str = "*** End Patch";
const ADD: &str = "*** Add File: ";
const DELETE: &str = "*** Delete File: ";
const UPDATE: &str = "*** Update File: ";
const MOVE: &str = "*** Move to: ";
const END_OF_FILE: &str = "*** End of File";
const DIFF_GIT: &str = "diff --git ";

/// Parses either format: `*** Begin Patch` … `*** End Patch` (holding the Codex
/// format or a git diff), else a bare unified diff.
pub fn parse(input: &str) -> Result<Vec<FileOp>, String> {
    let lines: Vec<&str> = input.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let ops = match lines.iter().position(|l| l.trim() == BEGIN_PATCH) {
        Some(begin) => {
            let end = lines[begin + 1..]
                .iter()
                .position(|l| l.trim() == END_PATCH)
                .map(|e| begin + 1 + e)
                .ok_or("patch must include *** End Patch (the patch looks truncated)")?;
            let body = &lines[begin + 1..end];
            // `--- x` also removes a `-- x` line (SQL, Lua comments): only a body without
            // Codex headers is read as a diff.
            let codex = body.iter().any(|l| {
                let t = l.trim_start();
                t.starts_with(ADD) || t.starts_with(DELETE) || t.starts_with(UPDATE)
            });
            if !codex && looks_like_git_diff(body) {
                parse_unified(body, begin + 1)?
            } else {
                parse_codex(body, begin + 1)?
            }
        }
        None if looks_like_git_diff(&lines) => parse_unified(&lines, 0)?,
        None => {
            return Err("patch must include *** Begin Patch (or be a unified diff with `--- a/path` and \
`+++ b/path` headers)"
                .into());
        }
    };
    if ops.is_empty() {
        return Err("patch did not contain any operations".into());
    }
    Ok(ops)
}

fn looks_like_git_diff(lines: &[&str]) -> bool {
    let mut markers = false;
    for line in lines {
        let t = line.trim_start();
        if t.starts_with(DIFF_GIT) || t.starts_with("rename from ") || t.starts_with("rename to ") {
            return true;
        }
        markers |= line.starts_with("--- ") || line.starts_with("+++ ");
    }
    markers
}

/// Refuses paths with control characters, or with `\n`-style escapes a model wrote
/// instead of a real path.
fn ensure_safe_path(path: &str, label: &str) -> Result<(), String> {
    let control = path.chars().any(|c| c.is_ascii_control());
    let escaped = ["\\n", "\\r", "\\t"].iter().any(|e| path.contains(e));
    if control || escaped {
        Err(format!("{label} path contains control characters or escape sequences"))
    } else {
        Ok(())
    }
}

// --- the Codex format -----------------------------------------------------------

fn is_diff_prefix(c: char) -> bool {
    matches!(c, ' ' | '+' | '-')
}

/// `*** Add File:` and the like (not `*** End of File`, which belongs to a hunk).
fn is_patch_header(line: &str) -> bool {
    match line.chars().next() {
        None => false,
        Some(c) if is_diff_prefix(c) => false,
        Some(_) => {
            let t = line.trim_start();
            t.starts_with("*** ") && t.trim_end() != END_OF_FILE
        }
    }
}

fn is_hunk_header(line: &str) -> bool {
    line.chars().next().is_some_and(|c| !is_diff_prefix(c)) && line.trim_start().starts_with("@@")
}

fn op_path(rest: &str, label: &str) -> Result<String, String> {
    let path = rest.trim();
    if path.is_empty() {
        return Err(format!("{label} requires a path"));
    }
    ensure_safe_path(path, label)?;
    Ok(path.to_owned())
}

/// `lines[start..]` is the body after `*** Begin Patch`; `offset` numbers lines in errors.
fn parse_codex(body: &[&str], offset: usize) -> Result<Vec<FileOp>, String> {
    let mut ops = Vec::new();
    let mut i = 0;
    let n = |i: usize| i + offset + 1;
    while i < body.len() {
        let line = body[i];
        let header = line.trim_start();
        if let Some(rest) = header.strip_prefix(ADD) {
            let path = op_path(rest, "Add File")?;
            i += 1;
            // (text, written with `+`): blank separator lines before the next header are dropped.
            let mut content: Vec<(&str, bool)> = Vec::new();
            while let Some(&l) = body.get(i).filter(|l| !is_patch_header(l)) {
                match l.strip_prefix('+') {
                    Some(text) => content.push((text, true)),
                    None if l.trim().is_empty() => content.push(("", false)),
                    None => return Err(format!("Add File lines must start with + (line {}: `{l}`)", n(i))),
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
        } else if let Some(rest) = header.strip_prefix(DELETE) {
            ops.push(FileOp::Delete { path: op_path(rest, "Delete File")? });
            i += 1;
        } else if let Some(rest) = header.strip_prefix(UPDATE) {
            let path = op_path(rest, "Update File")?;
            i += 1;
            let mut move_to = None;
            if let Some(rest) =
                body.get(i).filter(|l| is_patch_header(l)).and_then(|l| l.trim_start().strip_prefix(MOVE))
            {
                move_to = Some(op_path(rest, "Move to")?);
                i += 1;
            }
            let mut hunks = Vec::new();
            while i < body.len() && !is_patch_header(body[i]) {
                if body[i].trim().is_empty() {
                    i += 1;
                    continue;
                }
                hunks.push(parse_codex_hunk(body, &mut i, hunks.is_empty(), offset)?);
            }
            // A move alone needs no hunk (JetBrains requires one).
            if hunks.is_empty() && move_to.is_none() {
                return Err("Update File requires at least one hunk".into());
            }
            ops.push(FileOp::Update { path, move_to, hunks, or: Vec::new() });
        } else if line.trim().is_empty() {
            i += 1;
        } else {
            return Err(format!("Unexpected patch line: {line}"));
        }
    }
    Ok(ops)
}

fn parse_codex_hunk(body: &[&str], i: &mut usize, first: bool, offset: usize) -> Result<Hunk, String> {
    let mut hunk = Hunk::default();
    let mut bare = false;
    let mut headed = false;
    // Several `@@` lines narrow the place down, as in Codex.
    while let Some(&line) = body.get(*i).filter(|l| is_hunk_header(l)) {
        let trimmed = line.trim();
        match parse_range_header(trimmed) {
            Some((start, ..)) => hunk.old_start = Some(start),
            None => {
                let text = trimmed.trim_start_matches('@').trim();
                // `@@ fn main() @@` repeats the marker at the end sometimes.
                let text = text.trim_end_matches('@').trim_end();
                if !text.is_empty() {
                    hunk.anchors.push(text.to_owned());
                }
            }
        }
        bare = trimmed == "@@";
        headed = true;
        *i += 1;
    }
    let n = |i: usize| i + offset + 1;
    if !headed {
        let line = body[*i];
        if !first || !line.chars().next().is_none_or(is_diff_prefix) {
            return Err(format!("Expected @@ hunk header (line {}: `{line}`)", n(*i)));
        }
    }
    let is_strict_start =
        |l: &str| !l.is_empty() && !is_patch_header(l) && !is_hunk_header(l) && !l.starts_with(is_diff_prefix);
    if bare && body.get(*i).is_some_and(|l| is_strict_start(l)) {
        return parse_strict_pair(body, i);
    }
    // Blank lines at the end of a hunk are usually separators, not context.
    let mut implicit_blanks = 0usize;
    while let Some(&line) = body.get(*i).filter(|l| !is_hunk_header(l) && !is_patch_header(l)) {
        if line.trim_end() == END_OF_FILE {
            hunk.at_eof = true;
            *i += 1;
            break;
        }
        let parsed = match line.chars().next() {
            None => Line::Context(String::new()),
            Some(' ') => Line::Context(line[1..].to_owned()),
            Some('-') => Line::Remove(line[1..].to_owned()),
            Some('+') => Line::Add(line[1..].to_owned()),
            Some(_) if hunk.lines.is_empty() => {
                return Err(format!("Hunk lines must start with space, +, or - (line {}: `{line}`)", n(*i)));
            }
            Some(_) => break,
        };
        implicit_blanks = if line.is_empty() { implicit_blanks + 1 } else { 0 };
        hunk.lines.push(parsed);
        *i += 1;
    }
    hunk.lines.truncate(hunk.lines.len() - implicit_blanks);
    if hunk.lines.is_empty() {
        return Err("Empty hunk in Update File".into());
    }
    Ok(hunk)
}

/// `@@`, the old lines, `@@`, the new lines: whole lines without `-` / `+` prefixes.
fn parse_strict_pair(body: &[&str], i: &mut usize) -> Result<Hunk, String> {
    let mut old = Vec::new();
    let mut closed = false;
    while let Some(&line) = body.get(*i).filter(|l| !is_patch_header(l)) {
        *i += 1;
        if line.trim() == "@@" {
            closed = true;
            break;
        }
        old.push(line);
    }
    if !closed {
        return Err("Strict @@ pair hunk requires second @@ delimiter".into());
    }
    let mut new = Vec::new();
    while let Some(&line) = body.get(*i).filter(|l| !is_patch_header(l) && !is_hunk_header(l)) {
        new.push(line);
        *i += 1;
    }
    while new.last().is_some_and(|l| l.trim().is_empty()) {
        new.pop();
    }
    if old.is_empty() && new.is_empty() {
        return Err("Empty hunk in Update File".into());
    }
    let lines = old
        .into_iter()
        .map(|l| Line::Remove(l.to_owned()))
        .chain(new.into_iter().map(|l| Line::Add(l.to_owned())))
        .collect();
    Ok(Hunk { lines, ..Hunk::default() })
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
    /// `old mode` / `new mode`: a permission change, which the tool leaves alone.
    mode_change: bool,
    /// `copy from` / `copy to`.
    copy_from: Option<String>,
    copy_to: Option<String>,
    hunks: Vec<Hunk>,
    line: usize,
}

fn is_file_start(lines: &[&str], i: usize) -> bool {
    let l = lines[i];
    l.starts_with(DIFF_GIT)
        || (l.starts_with("--- ") && lines.get(i + 1).is_some_and(|n| n.starts_with("+++ ")) && l != "--- ")
}

/// `offset` numbers lines in errors (the diff may sit inside `*** Begin Patch`).
fn parse_unified(lines: &[&str], offset: usize) -> Result<Vec<FileOp>, String> {
    let mut ops = Vec::new();
    let mut i = 0;
    let mut section: Option<Section> = None;
    while i < lines.len() {
        let line = lines[i];
        let n = i + offset + 1;
        if is_file_start(lines, i) && (line.starts_with(DIFF_GIT) || section.as_ref().is_none_or(|s| s.old.is_some())) {
            if let Some(s) = section.take() {
                ops.push(finish_section(s)?);
            }
            let mut s = Section { line: n, ..Section::default() };
            if let Some(rest) = line.strip_prefix(DIFF_GIT) {
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
        let trimmed = line.trim_start();
        if let Some(p) = line.strip_prefix("--- ") {
            s.old = Some(diff_path(p, "a/"));
        } else if let Some(p) = line.strip_prefix("+++ ") {
            s.new = Some(diff_path(p, "b/"));
        } else if trimmed.starts_with("new file mode") {
            s.new_file = true;
        } else if trimmed.starts_with("deleted file mode") {
            s.deleted = true;
        } else if let Some(p) = trimmed.strip_prefix("rename from ") {
            s.rename_from = Some(rename_path(p)?);
        } else if let Some(p) = trimmed.strip_prefix("rename to ") {
            s.rename_to = Some(rename_path(p)?);
        } else if trimmed.starts_with("Binary files ") || trimmed == "GIT binary patch" {
            return Err(format!("Binary git patch is not supported (line {n})"));
        } else if let Some(p) = trimmed.strip_prefix("copy from ") {
            s.copy_from = Some(rename_path(p)?);
        } else if let Some(p) = trimmed.strip_prefix("copy to ") {
            s.copy_to = Some(rename_path(p)?);
        } else if trimmed.starts_with("old mode ") || trimmed.starts_with("new mode ") {
            s.mode_change = true;
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
    let first = *i;
    while let Some(&line) = lines.get(*i) {
        let done = old_left == 0 && new_left == 0;
        if line.starts_with("@@") || is_file_start(lines, *i) {
            break;
        }
        if line.trim_end() == END_OF_FILE {
            hunk.at_eof = true;
            *i += 1;
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
            Some(_) if hunk.lines.is_empty() => {
                return Err(format!(
                    "Hunk lines must start with space, +, or - (line {}: `{line}`)",
                    n + 1 + *i - first
                ));
            }
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
        return Err(format!("Empty hunk in Update File (line {n}: `{header}`)"));
    }
    Ok(hunk)
}

/// (old start, old count, new count) of `@@ -a[,b] +c[,d] @@`; extra `@`s (`@@@`) are accepted.
fn parse_range_header(header: &str) -> Option<(usize, usize, usize)> {
    let rest = header.trim_start_matches('@').trim_start().strip_prefix('-')?;
    let (ranges, _) = rest.split_once(" @@").unwrap_or((rest.trim_end_matches('@'), ""));
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

fn rename_path(raw: &str) -> Result<String, String> {
    let path = unquote(raw.trim());
    if path.is_empty() { Err("Could not determine file path from git diff".into()) } else { Ok(path) }
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
    const NO_PATH: &str = "Could not determine file path from git diff";
    let n = s.line;
    let old = match &s.old {
        Some(p) => p.clone(),
        None => s.rename_from.clone().or_else(|| s.git_old.clone()),
    };
    let new = match &s.new {
        Some(p) => p.clone(),
        None => s.rename_to.clone().or_else(|| s.git_new.clone()),
    };
    if s.copy_from.is_some() || s.copy_to.is_some() {
        // Git writes a copy only with `-C`; JetBrains reads it as a change of the source.
        let to = s.copy_to.clone().or(new).ok_or_else(|| format!("{NO_PATH} (line {n})"))?;
        let from = s.copy_from.clone().or(old).unwrap_or_default();
        let note = format!(
            "the copy of {from} to {to} was skipped: copies are not supported; add the new file with `*** Add File` \
instead"
        );
        return Ok(FileOp::Skip { path: to, note });
    }
    if s.new_file || (s.old.as_ref().is_some_and(|o| o.is_none())) {
        let path = new.ok_or_else(|| format!("{NO_PATH} (line {n})"))?;
        ensure_safe_path(&path, "Add File")?;
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
        let path = old.ok_or_else(|| format!("{NO_PATH} (line {n})"))?;
        ensure_safe_path(&path, "Delete File")?;
        return Ok(FileOp::Delete { path });
    }
    // Only git's rename headers say a file moves: plain diffs often name the sides
    // differently (`--- a.txt.orig` / `+++ a.txt`, `diff -ru old/ new/`).
    if s.rename_from.is_some() || s.rename_to.is_some() {
        let path = old.or(new.clone()).ok_or_else(|| format!("{NO_PATH} (line {n})"))?;
        ensure_safe_path(&path, "Update File")?;
        let move_to = new.filter(|p| *p != path);
        if let Some(m) = &move_to {
            ensure_safe_path(m, "Move to")?;
        }
        if s.hunks.is_empty() && move_to.is_none() && !s.mode_change {
            return Err(format!("line {n}: `{path}` has no changes"));
        }
        return Ok(FileOp::Update { path, move_to, hunks: s.hunks, or: Vec::new() });
    }
    let path = new.clone().or(old.clone()).ok_or_else(|| format!("{NO_PATH} (line {n})"))?;
    ensure_safe_path(&path, "Update File")?;
    if s.hunks.is_empty() {
        // Only the file mode changes: nothing to do to the text, as in JetBrains.
        if s.mode_change {
            return Ok(FileOp::Update { path, move_to: None, hunks: Vec::new(), or: Vec::new() });
        }
        return Err(format!("line {n}: `{path}` has no changes"));
    }
    let below_first_dir = |p: &Option<String>| p.as_ref().and_then(|p| p.split_once('/')).map(|(_, r)| r.to_owned());
    let mut or: Vec<String> = Vec::new();
    let others =
        if old == new { [None, None, None] } else { [old.clone(), below_first_dir(&new), below_first_dir(&old)] };
    for p in others.into_iter().flatten() {
        if !p.is_empty() && p != path && !or.contains(&p) {
            or.push(p);
        }
    }
    Ok(FileOp::Update { path, move_to: None, hunks: s.hunks, or })
}

// --- applying -------------------------------------------------------------------

/// How exactly a hunk's lines matched the file, tried in this order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Fuzz {
    Exact,
    TrailingWhitespace,
    Whitespace,
    /// Whitespace, and typographic dashes, quotes and spaces as their ASCII forms.
    Punctuation,
}

impl Fuzz {
    fn same(self, a: &str, b: &str) -> bool {
        match self {
            Fuzz::Exact => a == b,
            Fuzz::TrailingWhitespace => a.trim_end() == b.trim_end(),
            Fuzz::Whitespace => a.trim() == b.trim(),
            Fuzz::Punctuation => a.trim().chars().map(normalize_char).eq(b.trim().chars().map(normalize_char)),
        }
    }

    pub fn describe(self) -> &'static str {
        match self {
            Fuzz::Exact => "exactly",
            Fuzz::TrailingWhitespace => "ignoring trailing whitespace",
            Fuzz::Whitespace => "ignoring indentation and whitespace",
            Fuzz::Punctuation => "ignoring whitespace and typographic punctuation (dashes, quotes, spaces)",
        }
    }
}

fn normalize_char(c: char) -> char {
    match c {
        '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
        '\u{2018}'..='\u{201B}' => '\'',
        '\u{201C}'..='\u{201F}' => '"',
        '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
        c => c,
    }
}

const LEVELS: [Fuzz; 4] = [Fuzz::Exact, Fuzz::TrailingWhitespace, Fuzz::Whitespace, Fuzz::Punctuation];

/// The result of [`apply`]: the new text and the hunks that matched only loosely.
#[derive(Debug, PartialEq, Eq)]
pub struct Applied {
    pub text: String,
    /// (1-based hunk, how it matched) for hunks that did not match exactly.
    pub fuzzy: Vec<(usize, Fuzz)>,
}

/// Applies `hunks` in order to `text` (`\n` line endings). A hunk is searched
/// after the previous one, then (unless it ends the file) from the top. Errors
/// name the hunk and the lines that were not found.
pub fn apply(text: &str, hunks: &[Hunk]) -> Result<Applied, String> {
    let trailing_newline = text.ends_with('\n');
    let mut lines: Vec<String> = if text.is_empty() {
        Vec::new()
    } else {
        let mut l: Vec<String> = text.split('\n').map(str::to_owned).collect();
        if trailing_newline {
            l.pop();
        }
        l
    };
    let original_len = lines.len();
    let mut cursor = 0usize;
    let mut fuzzy = Vec::new();
    let mut ends_without_newline = None;
    for (index, hunk) in hunks.iter().enumerate() {
        let n = index + 1;
        let file: Vec<&str> = lines.iter().map(String::as_str).collect();
        let mut anchor_line = None;
        for anchor in &hunk.anchors {
            let find =
                |from: usize| LEVELS.iter().find_map(|level| (from..file.len()).find(|&i| level.same(file[i], anchor)));
            let found = find(cursor).or_else(|| find(0)).ok_or_else(|| {
                format!(
                    "Hunk context not found: {}: cannot find the line `{anchor}` its `@@` header names",
                    hunk.label(n)
                )
            })?;
            anchor_line = Some(found);
            cursor = found + 1;
        }
        // Line numbers of a diff count the original file: shift them by what earlier hunks added.
        let shift = |s: usize| (s as isize + lines.len() as isize - original_len as isize).max(0) as usize;
        let mut old = hunk.old_lines();
        if old.is_empty() {
            let at = if !hunk.anchors.is_empty() {
                cursor
            } else if hunk.at_eof {
                file.len()
            } else {
                // `@@ -5,0 +6,2 @@` inserts after line 5; without a position, at the end.
                hunk.old_start.map_or(file.len(), |s| shift(s).min(file.len()))
            };
            let new: Vec<String> = hunk.new_lines().into_iter().map(str::to_owned).collect();
            cursor = at + new.len();
            lines.splice(at..at, new);
            continue;
        }
        let hint = hunk.old_start.map(|s| shift(s.saturating_sub(1)));
        // Models often repeat the `@@` line as the hunk's first context line: then the
        // block starts at the anchor rather than after it.
        let find = |old: &[&str]| {
            find_block(&file, old, cursor, hint, hunk.at_eof)
                .or_else(|| anchor_line.and_then(|a| find_block(&file, old, a, hint, hunk.at_eof)))
                .or_else(|| (cursor > 0 && !hunk.at_eof).then(|| find_block(&file, old, 0, hint, false)).flatten())
        };
        let mut found = find(&old);
        // A blank last line in the patch that the file does not have (Codex does the same).
        if found.is_none() && old.last() == Some(&"") {
            old.pop();
            if !old.is_empty() {
                found = find(&old);
            }
        }
        let Some((at, level)) = found else {
            return Err(mismatch(&file, &old, hint, &hunk.label(n), hunk.at_eof));
        };
        if level != Fuzz::Exact {
            fuzzy.push((n, level));
        }
        if at + old.len() == file.len() {
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
                    new.push(file[at + matched].to_owned());
                    matched += 1;
                }
                Line::Remove(_) => matched += 1,
                Line::Add(s) => new.push(s.clone()),
            }
        }
        let removed = old.len();
        cursor = at + new.len();
        lines.splice(at..at + removed, new);
    }
    let mut result = lines.join("\n");
    let newline = match ends_without_newline {
        Some(no) => !no,
        None => trailing_newline || text.is_empty(),
    };
    if newline && !lines.is_empty() {
        result.push('\n');
    }
    Ok(Applied { text: result, fuzzy })
}

/// Where `old` occurs at or after `from`, as exactly as possible; with a hint,
/// the occurrence nearest to it. A hunk that ends the file must match its end.
fn find_block(lines: &[&str], old: &[&str], from: usize, hint: Option<usize>, at_eof: bool) -> Option<(usize, Fuzz)> {
    if old.len() > lines.len() {
        return None;
    }
    let last = lines.len() - old.len();
    let matches = |at: usize, level: Fuzz| old.iter().zip(&lines[at..]).all(|(o, l)| level.same(l, o));
    for level in LEVELS {
        if at_eof {
            if last >= from && matches(last, level) {
                return Some((last, level));
            }
            continue;
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
fn mismatch(lines: &[&str], old: &[&str], hint: Option<usize>, label: &str, at_eof: bool) -> String {
    let mut msg = format!("Hunk context not found: {label} does not apply: these lines were not found:\n");
    for l in old {
        let _ = writeln!(msg, "  {l}");
    }
    // The start with the longest run of matching lines (ignoring whitespace).
    let mut best: Option<(usize, usize)> = None;
    for at in 0..lines.len() {
        let run = old.iter().zip(&lines[at..]).take_while(|(o, l)| Fuzz::Punctuation.same(o, l)).count();
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
        Some((at, _)) if at_eof => {
            let _ = write!(
                msg,
                "They occur at line {}, but the hunk is marked `*** End of File` and they do not end the file.",
                at + 1
            );
        }
        Some((at, _)) => {
            let _ = write!(msg, "They occur at line {}.", at + 1);
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
mod tests;
