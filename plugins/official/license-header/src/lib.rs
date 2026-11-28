//! License Header for OpenIDEA: a copyright notice at the top of source files,
//! in the file's own comment syntax, written from a template (a copyright profile).
//!
//! - A file without one is reported (an info diagnostic on its first line)
//!   when it opens, and again when it is saved, so adding the header clears it.
//! - The quick fix and *License Header: Add to Current File* insert it (after a
//!   `#!` line or a Python encoding line, which must stay first).
//! - *Update Copyright* (the current file, or the files and folders selected in
//!   the Project view) replaces an existing header with the active profile's
//!   text, keeping its first year (`2020-2026`), or adds one where there is none.
//! - Profiles are named templates with `$year`, `$author`, `$license`,
//!   `$project` and `$file`; the active one can differ per project. Without
//!   one, the copyright holder and license settings make the header.
//! - Comment styles per file extension override the built-in table.
//! - Optionally, a file created in the IDE gets the header when it opens.
//! - *Find Files Without a Header* scans the project in a background task and
//!   reports every source file that needs one in the Problems view.

use openidea_plugin::host;
use openidea_plugin::providers::{CodeAction, Document, Providers};
use openidea_plugin::{
    Context, Diagnostic, Error, Event, EventKind, FileKind, Invocation, NotificationLevel, Plugin, Position, Project,
    Range, Severity, TextEdit, register_plugin,
};
use serde_json::Value;
use std::collections::HashMap;

/// Lines looked at for an existing header.
const HEADER_LINES: usize = 15;
/// Files a scan or an update reads at most.
const MAX_SCAN: u32 = 5000;
/// Files larger than this are skipped by a scan.
const MAX_FILE: usize = 1 << 20;
const CODE: &str = "missing-license-header";
/// A file that opens this many seconds after it was created counts as new.
const NEW_FILE_SECS: u64 = 30;

/// How a file writes a header: line comments, or one block comment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Comment {
    Line(String),
    Block(String, String),
}

fn extension(path: &str) -> Option<String> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_ascii_lowercase();
    name.rsplit_once('.').map(|(_, e)| e.to_owned())
}

/// The built-in comment syntax for `path`, `None` for files that don't get a header.
pub fn builtin_comment(path: &str) -> Option<Comment> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    let line = |p: &str| Some(Comment::Line(p.into()));
    if matches!(lower.as_str(), "dockerfile" | "makefile" | "justfile") {
        return line("#");
    }
    match extension(path)?.as_str() {
        "rs" | "java" | "kt" | "kts" | "scala" | "groovy" | "gradle" | "go" | "js" | "jsx" | "mjs" | "cjs" | "ts"
        | "tsx" | "mts" | "cts" | "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "m" | "mm" | "cs" | "swift"
        | "dart" | "proto" | "sol" | "zig" | "v" => line("//"),
        "css" | "scss" | "less" => Some(Comment::Block("/*".into(), " */".into())),
        "py" | "sh" | "bash" | "zsh" | "fish" | "rb" | "pl" | "r" | "ps1" | "yaml" | "yml" | "toml" | "cmake"
        | "tf" | "nix" | "ex" | "exs" | "jl" => line("#"),
        "sql" | "lua" | "hs" | "elm" => line("--"),
        _ => None,
    }
}

/// A *Comment styles* row: extensions (`kt, kts`) and how they comment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Style {
    pub extensions: String,
    /// `line` or `block`.
    pub style: String,
    /// The line comment prefix, or the block's opening.
    pub prefix: String,
    /// The block's closing.
    pub suffix: String,
}

/// The comment syntax for `path`: a matching style row first, then the built-in table.
pub fn comment_for(path: &str, styles: &[Style]) -> Option<Comment> {
    let ext = extension(path);
    let row = styles.iter().find(|s| {
        s.extensions
            .split([',', ' '])
            .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
            .any(|e| !e.is_empty() && Some(&e) == ext.as_ref())
    });
    match row {
        Some(s) if !s.prefix.trim().is_empty() => Some(if s.style == "block" {
            Comment::Block(one_line(s.prefix.trim()), format!(" {}", one_line(s.suffix.trim())))
        } else {
            Comment::Line(one_line(s.prefix.trim()))
        }),
        _ => builtin_comment(path),
    }
}

fn is_header_line(l: &str) -> bool {
    let l = l.to_ascii_lowercase();
    l.contains("copyright") || l.contains("spdx-license-identifier") || l.contains("licensed under")
}

/// Whether `text` already starts with a header (copyright or license notice).
pub fn has_header(text: &str) -> bool {
    text.lines().take(HEADER_LINES).any(is_header_line)
}

/// `value` on one line: a line break (or any control character, or the
/// Unicode line separators JavaScript ends a comment at) would put the rest of
/// the setting into the file as code.
fn one_line(value: &str) -> String {
    value.chars().map(|c| if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') { ' ' } else { c }).collect()
}

/// The template the holder and license settings make (the default profile).
pub fn default_template(owner: &str, license: &str) -> String {
    let mut t =
        if owner.trim().is_empty() { "Copyright (c) $year".to_owned() } else { "Copyright (c) $year $author".into() };
    if !license.trim().is_empty() {
        t.push_str("\nSPDX-License-Identifier: $license");
    }
    t
}

/// What a template's variables stand for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Vars {
    /// This year, or `first-this` when the existing header starts earlier.
    pub year: String,
    pub author: String,
    pub license: String,
    pub project: String,
    pub file: String,
}

/// The header's lines, without comment markers: `template` with its
/// variables replaced, each line kept on one line.
pub fn expand(template: &str, vars: &Vars) -> Vec<String> {
    let lines: Vec<String> = template
        .lines()
        .map(|l| {
            let l = l
                .replace("$year", &one_line(&vars.year))
                .replace("$author", one_line(&vars.author).trim())
                .replace("$license", one_line(&vars.license).trim())
                .replace("$project", &one_line(&vars.project))
                .replace("$file", &one_line(&vars.file));
            one_line(l.trim_end())
        })
        .collect();
    let start = lines.iter().position(|l| !l.trim().is_empty()).unwrap_or(lines.len());
    let end = lines.iter().rposition(|l| !l.trim().is_empty()).map_or(start, |i| i + 1);
    lines[start..end].to_vec()
}

/// The header's lines for the holder and license settings (the default profile).
pub fn header_lines(year: i64, owner: &str, license: &str) -> Vec<String> {
    let vars = Vars { year: year.to_string(), author: owner.into(), license: license.into(), ..Default::default() };
    expand(&default_template(owner, license), &vars)
}

/// The header as `comment` writes it, with a blank line after it.
pub fn render(comment: &Comment, lines: &[String]) -> String {
    let mut out = String::new();
    match comment {
        Comment::Line(prefix) => {
            for l in lines {
                out.push_str(format!("{prefix} {l}").trim_end());
                out.push('\n');
            }
        }
        Comment::Block(open, close) => {
            out.push_str(open);
            out.push('\n');
            for l in lines {
                // The block's closing would end the comment early.
                let close = close.trim();
                let spaced: Vec<String> = close.chars().map(String::from).collect();
                let l = if close.is_empty() { l.clone() } else { l.replace(close, &spaced.join(" ")) };
                let lead = if open.starts_with("/*") { " * " } else { "  " };
                out.push_str(format!("{lead}{l}").trim_end());
                out.push('\n');
            }
            out.push_str(close);
            out.push('\n');
        }
    }
    out.push('\n');
    out
}

/// The line the header goes on: after a `#!` line and a Python encoding
/// line, an XML declaration or a PHP opening tag, which must stay first.
pub fn insert_line(text: &str) -> u32 {
    let mut line = 0;
    let mut lines = text.lines();
    let first = text.lines().next().unwrap_or("").trim_start_matches('\u{feff}');
    if first.starts_with("<?xml") || first.starts_with("<?php") {
        return 1;
    }
    if lines.next().is_some_and(|l| l.starts_with("#!")) {
        line = 1;
        if lines.next().is_some_and(is_encoding_line) {
            line = 2;
        }
    } else if text.lines().next().is_some_and(is_encoding_line) {
        line = 1;
    }
    line
}

fn is_encoding_line(l: &str) -> bool {
    l.starts_with('#') && (l.contains("coding:") || l.contains("coding=")) && !is_header_line(l)
}

/// Whether a header comment line mentions a copyright or a license: the
/// header ends with the last such line.
fn mentions_license(l: &str) -> bool {
    let l = l.to_ascii_lowercase();
    l.contains("copyright") || l.contains("spdx-license-identifier") || l.contains("license")
}

/// The comment forms a header in `comment`'s files may have been written in:
/// C-like languages write it with `//` lines or one `/* */` block.
fn header_forms(comment: &Comment) -> Vec<Comment> {
    let mut forms = vec![comment.clone()];
    match comment {
        Comment::Line(p) if p == "//" => forms.push(Comment::Block("/*".into(), " */".into())),
        Comment::Block(o, _) if o == "/*" => forms.push(Comment::Line("//".into())),
        _ => {}
    }
    forms
}

/// The lines `[start, end)` of the comment at the header position that holds
/// a copyright or license notice, with the blank lines after it. Line comments
/// stop at a doc comment (`///`, `//!`) and end at the last line that mentions
/// a copyright or a license, or after `lines` lines (the profile's header), so
/// the comments after the notice stay.
pub fn existing_header(text: &str, comment: &Comment, lines: usize) -> Option<(u32, u32)> {
    header_forms(comment).iter().find_map(|form| header_in_form(text, form, lines))
}

fn header_in_form(text: &str, comment: &Comment, header_lines: usize) -> Option<(u32, u32)> {
    let lines: Vec<&str> = text.lines().collect();
    let start = insert_line(text) as usize;
    let first = lines.get(start)?.trim_start();
    let mut end = start;
    match comment {
        Comment::Line(prefix) => {
            let doc = |rest: &str| rest.starts_with('!') || prefix.ends_with('/') && rest.starts_with('/');
            while lines.get(end).is_some_and(|l| l.trim_start().strip_prefix(prefix.as_str()).is_some_and(|r| !doc(r)))
            {
                end += 1;
            }
            if !lines[start..end].iter().any(|l| is_header_line(l)) {
                return None;
            }
            let notice = start + lines[start..end].iter().rposition(|l| mentions_license(l))? + 1;
            end = notice.max((start + header_lines).min(end));
        }
        Comment::Block(open, close) => {
            if !first.starts_with(open.as_str()) {
                return None;
            }
            let close = close.trim();
            while end < lines.len() {
                let done = lines[end]
                    [if end == start { lines[end].find(open.as_str()).unwrap_or(0) + open.len() } else { 0 }..]
                    .contains(close);
                end += 1;
                if done {
                    break;
                }
            }
            if !lines[start..end].iter().any(|l| is_header_line(l)) {
                return None;
            }
        }
    }
    while lines.get(end).is_some_and(|l| l.trim().is_empty()) {
        end += 1;
    }
    Some((start as u32, end as u32))
}

/// The earliest year (1970 or later, not after `now`) in `header`.
pub fn first_year(header: &str, now: i64) -> Option<i64> {
    let bytes = header.as_bytes();
    (0..bytes.len().saturating_sub(3))
        .filter(|&i| {
            bytes[i..i + 4].iter().all(u8::is_ascii_digit)
                && (i == 0 || !bytes[i - 1].is_ascii_digit())
                && bytes.get(i + 4).is_none_or(|b| !b.is_ascii_digit())
        })
        .filter_map(|i| header[i..i + 4].parse::<i64>().ok())
        .filter(|y| (1970..=now).contains(y))
        .min()
}

/// `$year` for a file: this year, or `first-now` when its header starts earlier.
pub fn year_text(header: Option<&str>, now: i64) -> String {
    match header.and_then(|h| first_year(h, now)) {
        Some(first) if first < now => format!("{first}-{now}"),
        _ => now.to_string(),
    }
}

/// The settings a header is made from.
#[derive(Clone, Debug, Default)]
pub struct Profile {
    pub template: String,
    pub author: String,
    pub license: String,
    pub styles: Vec<Style>,
}

/// The edit that writes `profile`'s header into `text`: replacing the existing
/// header (`update`) or adding one where there is none. `None` when the file
/// takes no header, or already has this one (or any, when not `update`).
pub fn header_edit(
    path: &str,
    text: &str,
    profile: &Profile,
    project: &str,
    now: i64,
    update: bool,
) -> Option<TextEdit> {
    let comment = comment_for(path, &profile.styles)?;
    let template_lines = expand(&profile.template, &Vars::default()).len();
    let existing = existing_header(text, &comment, template_lines);
    if has_header(text) && (!update || existing.is_none()) {
        return None;
    }
    let lines: Vec<&str> = text.lines().collect();
    let old = existing.map(|(s, e)| lines[s as usize..e as usize].join("\n"));
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let vars = Vars {
        year: year_text(old.as_deref(), now),
        author: profile.author.clone(),
        license: profile.license.clone(),
        project: project.into(),
        file: file.into(),
    };
    let header = expand(&profile.template, &vars);
    if header.is_empty() {
        return None;
    }
    let mut insert = render(&comment, &header);
    let range = match existing {
        Some((s, e)) => {
            if old.as_deref().map(str::trim_end) == Some(insert.trim_end()) {
                return None;
            }
            // The blank lines after the old header are replaced, so the new one keeps one.
            let end = if (e as usize) < lines.len() { Position::new(e, 0) } else { end_of(text) };
            if (e as usize) >= lines.len() {
                insert.pop();
            }
            Range::new(Position::new(s, 0), end)
        }
        None => {
            let at = Position::new(insert_line(text), 0);
            // After a first line without a newline (a lone shebang).
            if at.line > 0 && lines.len() == at.line as usize && !text.ends_with('\n') {
                insert.insert(0, '\n');
            }
            Range::new(at, at)
        }
    };
    // The file's own line breaks.
    if text.contains("\r\n") {
        insert = insert.replace('\n', "\r\n");
    }
    Some(TextEdit { range, text: insert })
}

/// The position after the last character of `text`.
fn end_of(text: &str) -> Position {
    let line = text.matches('\n').count() as u32;
    let last = text.rsplit('\n').next().unwrap_or("");
    Position::new(line, last.encode_utf16().count() as u32)
}

/// `text` with `edit` applied (line/UTF-16 positions).
pub fn apply(text: &str, edit: &TextEdit) -> String {
    let offset = |p: Position| {
        let mut at = 0;
        for (i, line) in text.split_inclusive('\n').enumerate() {
            if i as u32 == p.line {
                let mut units = 0;
                for (b, c) in line.char_indices() {
                    if units >= p.character {
                        return at + b;
                    }
                    units += c.len_utf16() as u32;
                }
                return at + line.trim_end_matches('\n').len();
            }
            at += line.len();
        }
        text.len()
    };
    let (s, e) = (offset(edit.range.start), offset(edit.range.end));
    format!("{}{}{}", &text[..s], edit.text, &text[e..])
}

fn missing(text: &str) -> Diagnostic {
    let line = insert_line(text);
    let len = text.lines().nth(line as usize).map_or(0, |l| l.encode_utf16().count() as u32);
    Diagnostic::new(Range::new(Position::new(line, 0), Position::new(line, len)), Severity::Info, "No license header")
        .code(CODE)
}

/// Reports `path` when it takes a header and has none, clears it otherwise.
pub fn report(path: &str, text: &str, styles: &[Style]) -> Result<bool, Error> {
    let lacking = comment_for(path, styles).is_some() && !has_header(text);
    host::publish_diagnostics(path, &if lacking { vec![missing(text)] } else { Vec::new() })?;
    Ok(lacking)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The current year (WASI wall clock), from days since the epoch.
fn this_year() -> i64 {
    year_of_day((now_secs() / 86_400) as i64)
}

/// The proleptic Gregorian year of `day` days since 1970-01-01.
pub fn year_of_day(day: i64) -> i64 {
    let z = day + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    yoe + era * 400 + i64::from(month <= 2)
}

fn json_setting(key: &str) -> Vec<Value> {
    host::setting(key).and_then(|v| serde_json::from_str::<Vec<Value>>(&v).ok()).unwrap_or_default()
}

fn field(row: &Value, key: &str) -> String {
    row.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// The comment style rows of the settings.
fn styles() -> Vec<Style> {
    json_setting("commentStyles")
        .iter()
        .map(|r| Style {
            extensions: field(r, "extensions"),
            style: field(r, "style"),
            prefix: field(r, "prefix"),
            suffix: field(r, "suffix"),
        })
        .collect()
}

/// The active profile: the *Profiles* row named by *Active profile*, else the
/// header the holder and license settings make.
pub fn profile() -> Profile {
    let author = host::setting_string("owner").unwrap_or_default();
    let license = host::setting_string("license").unwrap_or_else(|| "Apache-2.0".into());
    let active = host::setting_string("profile").unwrap_or_default();
    let named = json_setting("profiles")
        .into_iter()
        .find(|r| !active.trim().is_empty() && field(r, "name").trim() == active.trim())
        .map(|r| field(&r, "notice"))
        .filter(|t| !t.trim().is_empty());
    Profile {
        template: named.unwrap_or_else(|| default_template(&author, &license)),
        author,
        license,
        styles: styles(),
    }
}

fn project_of(path: &str) -> Option<Project> {
    host::projects()
        .ok()?
        .into_iter()
        .filter(|p| p.root().is_ok_and(|r| is_under(path, &r)))
        .max_by_key(|p| p.root().map(|r| r.len()).unwrap_or(0))
}

fn project_name(project: &Project) -> String {
    project
        .root()
        .ok()
        .map(|r| r.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").to_owned())
        .unwrap_or_default()
}

/// `path` relative to the project root, as background document edits take it.
fn relative(project: &Project, path: &str) -> String {
    let root = project.root().unwrap_or_default();
    path.strip_prefix(root.as_str()).map_or(path, |rest| rest.trim_start_matches(['/', '\\'])).to_owned()
}

/// Whether `path` is `root` or inside it (`/proj-x/a` is not inside `/proj`).
fn is_under(path: &str, root: &str) -> bool {
    path.strip_prefix(root)
        .is_some_and(|rest| rest.is_empty() || root.ends_with(['/', '\\']) || rest.starts_with(['/', '\\']))
}

/// What an update did to the files it went through.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Updated {
    pub changed: u32,
    pub unchanged: u32,
    pub failed: u32,
    /// More files than [`MAX_SCAN`]: the rest were not looked at.
    pub truncated: bool,
}

/// The *Excluded folders* setting: folder names a folder run skips (vendored code).
fn excluded_folders() -> Vec<String> {
    host::setting_string("excludedFolders")
        .unwrap_or_else(|| "vendor, third_party, third-party, external".into())
        .split([',', ' '])
        .map(|f| f.trim().trim_matches(['/', '\\']).to_owned())
        .filter(|f| !f.is_empty())
        .collect()
}

/// Whether `file`, under the selected folder `dir`, sits in an excluded folder
/// below it (selecting `vendor` itself still takes its files).
pub fn in_excluded(file: &str, dir: &str, excluded: &[String]) -> bool {
    let rest = file.strip_prefix(dir).unwrap_or(file);
    let mut parts: Vec<&str> = rest.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    parts.pop();
    parts.iter().any(|p| excluded.iter().any(|e| e == p))
}

#[derive(Default)]
pub struct LicenseHeader {
    /// Files created lately and not open yet, with when (seconds): one that
    /// opens soon after gets the header.
    created: HashMap<String, u64>,
}

impl LicenseHeader {
    fn edit_editor(&self, ctx: &Invocation, update: bool) -> Result<Option<String>, Error> {
        let editor = ctx.editor().ok_or_else(|| Error::Invalid("focus an editor first".into()))?;
        let (path, doc) = (editor.path(), editor.document()?);
        let profile = profile();
        if comment_for(&path, &profile.styles).is_none() {
            return Err(Error::Invalid("this kind of file takes no license header".into()));
        }
        let project = project_of(&path).map(|p| project_name(&p)).unwrap_or_default();
        let Some(edit) = header_edit(&path, &doc.text, &profile, &project, this_year(), update) else {
            return Ok(Some(
                if update { "The copyright notice is up to date." } else { "The file already has a license header." }
                    .into(),
            ));
        };
        editor.apply_edits(doc.version, &[edit])?;
        Ok(None)
    }

    /// Updates the header of every file in `paths` (files, or folders whose files are taken).
    fn update_paths(&self, project: &Project, paths: &[String]) -> Result<Updated, Error> {
        let root = project.root()?;
        let profile = profile();
        let name = project_name(project);
        let mut files: Vec<String> = Vec::new();
        let excluded = excluded_folders();
        let all = if paths.iter().any(|p| project.stat(p).is_ok_and(|s| s.kind == FileKind::Directory)) {
            project.find_files("**/*", MAX_SCAN * 4)?
        } else {
            Vec::new()
        };
        let mut out = Updated { truncated: all.len() >= (MAX_SCAN * 4) as usize, ..Updated::default() };
        for p in paths {
            if !is_under(p, &root) {
                continue;
            }
            if project.stat(p).is_ok_and(|s| s.kind == FileKind::Directory) {
                files.extend(all.iter().filter(|f| is_under(f, p) && !in_excluded(f, p, &excluded)).cloned());
            } else {
                files.push(p.clone());
            }
        }
        files.retain(|f| comment_for(f, &profile.styles).is_some());
        files.sort();
        files.dedup();
        out.truncated |= files.len() > MAX_SCAN as usize;
        files.truncate(MAX_SCAN as usize);
        let total = files.len() as u32;
        let task = host::begin_task("License Header: updating copyright", true);
        let now = this_year();
        for (i, path) in files.iter().enumerate() {
            if task.is_cancelled() {
                break;
            }
            if i % 20 == 0 {
                task.report(i as u32, Some(total), Some(path.rsplit('/').next().unwrap_or(path)));
            }
            // An open document is edited in its editor (undoable, unsaved changes kept).
            let done = match project.document(path) {
                Ok(doc) => match header_edit(path, &doc.text, &profile, &name, now, true) {
                    Some(edit) => {
                        project.apply_document_edits(&relative(project, path), doc.version, &[edit]).map(|_| true)
                    }
                    None => Ok(false),
                },
                Err(_) => match project.read_file(path) {
                    Ok(text) if text.len() <= MAX_FILE => match header_edit(path, &text, &profile, &name, now, true) {
                        Some(edit) => project.write_file(path, &apply(&text, &edit)).map(|_| true),
                        None => Ok(false),
                    },
                    Ok(_) => Ok(false),
                    Err(e) => Err(e),
                },
            };
            match done {
                Ok(true) => {
                    out.changed += 1;
                    let _ = host::publish_diagnostics(path, &[]);
                }
                Ok(false) => out.unchanged += 1,
                Err(_) => out.failed += 1,
            }
        }
        Ok(out)
    }

    /// Reports every source file of the project without a header; returns (checked, lacking).
    fn scan(&self, project: &Project) -> Result<(u32, u32), Error> {
        let styles = styles();
        let (root, excluded) = (project.root()?, excluded_folders());
        let files: Vec<String> = project
            .find_files("**/*", MAX_SCAN * 4)?
            .into_iter()
            .filter(|f| comment_for(f, &styles).is_some() && !in_excluded(f, &root, &excluded))
            .take(MAX_SCAN as usize)
            .collect();
        let total = files.len() as u32;
        let task = host::begin_task("License Header: checking files", true);
        let (mut checked, mut lacking) = (0, 0);
        for (i, path) in files.iter().enumerate() {
            if task.is_cancelled() {
                break;
            }
            if i % 20 == 0 {
                let name = path.rsplit('/').next().unwrap_or(path);
                task.report(i as u32, Some(total), Some(name));
            }
            let Ok(text) = project.read_file(path) else { continue };
            if text.len() > MAX_FILE {
                continue;
            }
            checked += 1;
            if report(path, &text, &styles)? {
                lacking += 1;
            }
        }
        Ok((checked, lacking))
    }

    /// Adds the header to `path`, an empty file created moments ago (what New
    /// File makes), when it is open; returns whether it was open. A file with
    /// text (renamed, checked out) is left alone. Without a created event,
    /// `fresh` asks for a file written within [`NEW_FILE_SECS`].
    fn add_to_new_file(&self, path: &str, fresh: bool) -> bool {
        let Some(project) = project_of(path) else { return false };
        let Ok(doc) = project.document(path) else { return false };
        let modified = project.stat(path).ok().and_then(|s| s.modified).unwrap_or(0);
        if !doc.text.trim().is_empty() || fresh && now_secs().saturating_sub(modified) > NEW_FILE_SECS {
            return true;
        }
        let profile = profile();
        if let Some(edit) = header_edit(path, &doc.text, &profile, &project_name(&project), this_year(), false) {
            let _ = project.apply_document_edits(&relative(&project, path), doc.version, &[edit]);
            let _ = host::publish_diagnostics(path, &[]);
        }
        true
    }
}

impl Plugin for LicenseHeader {
    fn activate(&mut self, _ctx: &Context) -> Result<(), Error> {
        // File creations matter only while Add the header to new files is on.
        let _ = host::subscribe(EventKind::SettingsChanged);
        if host::setting_bool("addToNewFiles").unwrap_or(false) {
            let _ = host::subscribe(EventKind::FilesChanged);
        }
        Ok(())
    }

    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "add" => self.edit_editor(ctx, false),
            "update" => self.edit_editor(ctx, true),
            "update-selected" => {
                let project = ctx.project().ok_or_else(|| Error::Invalid("open a project first".into()))?;
                let mut paths = ctx.selected_paths();
                if paths.is_empty() {
                    paths.push(project.root()?);
                }
                let u = self.update_paths(&project, &paths)?;
                let mut body = match u.changed {
                    1 => "Updated 1 file".to_owned(),
                    n => format!("Updated {n} files"),
                };
                if u.unchanged > 0 {
                    body.push_str(&format!("; {} already up to date", u.unchanged));
                }
                if u.failed > 0 {
                    body.push_str(&format!("; {} could not be written", u.failed));
                }
                if u.truncated {
                    body.push_str(&format!("; stopped after {MAX_SCAN} files, select a smaller folder for the rest"));
                }
                body.push('.');
                let level =
                    if u.failed > 0 || u.truncated { NotificationLevel::Warning } else { NotificationLevel::Info };
                host::notify(level, "Copyright", &body);
                Ok(None)
            }
            "scan" => {
                let project = ctx.project().ok_or_else(|| Error::Invalid("open a project first".into()))?;
                let (checked, lacking) = self.scan(&project)?;
                let body = match lacking {
                    0 => format!("All {checked} source files have one."),
                    1 => format!("1 of {checked} source files has none; see the Problems view."),
                    n => format!("{n} of {checked} source files have none; see the Problems view."),
                };
                host::notify(NotificationLevel::Info, "License headers", &body);
                Ok(None)
            }
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }

    fn handle_events(&mut self, events: &[Event], _ctx: &Invocation) {
        let now = now_secs();
        self.created.retain(|_, at| now.saturating_sub(*at) <= NEW_FILE_SECS);
        let new_files = host::setting_bool("addToNewFiles").unwrap_or(false);
        for e in events {
            let (path, opened) = match e {
                Event::FileOpened(p) => (p, true),
                Event::FileSaved(p) => (p, false),
                // The created file may already be open (the event comes after a
                // short quiet period), or open later.
                Event::Other { kind, data } if kind == "settings-changed" && data.contains("addToNewFiles") => {
                    if new_files {
                        let _ = host::subscribe(EventKind::FilesChanged);
                    }
                    continue;
                }
                Event::FilesChanged(batch) if new_files => {
                    for p in &batch.created {
                        if comment_for(p, &styles()).is_some() && !self.add_to_new_file(p, false) {
                            self.created.insert(p.clone(), now);
                        }
                    }
                    continue;
                }
                _ => continue,
            };
            let styles = styles();
            if comment_for(path, &styles).is_none() {
                continue;
            }
            // Remembered creations are lost when an idle plugin is reclaimed: an
            // empty file written moments ago counts as new too.
            if opened && new_files {
                let created = self.created.remove(path).is_some();
                self.add_to_new_file(path, !created);
            }
            if opened && !host::setting_bool("reportOnOpen").unwrap_or(true) {
                continue;
            }
            let Some(project) = project_of(path) else { continue };
            if let Ok(text) = project.read_file(path) {
                let _ = report(path, &text, &styles);
            }
        }
    }
}

impl Providers for LicenseHeader {
    fn code_actions(&mut self, doc: &Document, _selection: Range) -> Vec<CodeAction> {
        let profile = profile();
        let project = project_of(&doc.path).map(|p| project_name(&p)).unwrap_or_default();
        let has = has_header(&doc.text);
        let Some(edit) = header_edit(&doc.path, &doc.text, &profile, &project, this_year(), has) else {
            return Vec::new();
        };
        vec![CodeAction {
            title: if has { "Update copyright notice" } else { "Add license header" }.into(),
            kind: Some(if has { "refactor" } else { "quickfix" }.into()),
            preferred: !has,
            edits: vec![(doc.path.clone(), vec![edit])],
            data: None,
        }]
    }
}

register_plugin!(LicenseHeader, providers);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    fn defaults(owner: &str, license: &str) -> Profile {
        Profile {
            template: default_template(owner, license),
            author: owner.into(),
            license: license.into(),
            styles: Vec::new(),
        }
    }

    fn doc(path: &str, text: &str) -> Document {
        Document { path: path.into(), language: String::new(), version: 1, text: text.into() }
    }

    #[test]
    fn writes_the_header_in_each_files_comment_syntax() {
        let lines = header_lines(2026, "ACME Inc.", "MIT");
        assert_eq!(
            render(&comment_for("a/b.rs", &[]).unwrap(), &lines),
            "// Copyright (c) 2026 ACME Inc.\n// SPDX-License-Identifier: MIT\n\n"
        );
        assert_eq!(render(&comment_for("x.py", &[]).unwrap(), &lines[..1]), "# Copyright (c) 2026 ACME Inc.\n\n");
        assert_eq!(
            render(&comment_for("s.css", &[]).unwrap(), &lines),
            "/*\n * Copyright (c) 2026 ACME Inc.\n * SPDX-License-Identifier: MIT\n */\n\n"
        );
        assert_eq!(comment_for("q.SQL", &[]), Some(Comment::Line("--".into())));
        assert_eq!(comment_for("Dockerfile", &[]), Some(Comment::Line("#".into())));
        assert_eq!(comment_for("README.md", &[]), None);
        assert_eq!(comment_for("noext", &[]), None);
        assert_eq!(header_lines(2026, " ", ""), ["Copyright (c) 2026"]);
    }

    #[test]
    fn settings_cannot_add_code_to_the_file() {
        let lines = header_lines(2026, "ACME\nimport os\r\u{2028}x", "MIT\nrm -rf");
        assert_eq!(lines, ["Copyright (c) 2026 ACME import os  x", "SPDX-License-Identifier: MIT rm -rf"]);
        assert_eq!(
            render(&comment_for("a.py", &[]).unwrap(), &lines).lines().filter(|l| !l.starts_with('#')).count(),
            1
        );
        let css = render(&comment_for("s.css", &[]).unwrap(), &header_lines(2026, "X */ body { }", ""));
        assert_eq!(css.matches("*/").count(), 1, "{css}");
    }

    #[test]
    fn keeps_shebang_and_encoding_lines_first() {
        assert_eq!(insert_line("fn main() {}\n"), 0);
        assert_eq!(insert_line("#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nprint()\n"), 2);
        assert_eq!(insert_line("#!/bin/sh\necho\n"), 1);
        assert_eq!(insert_line("# coding=latin-1\nx = 1\n"), 1);
        let e = header_edit("run.sh", "#!/bin/sh", &defaults("", ""), "p", 2026, false).unwrap();
        assert_eq!((e.range.start, e.text.as_str()), (Position::new(1, 0), "\n# Copyright (c) 2026\n\n"));
    }

    #[test]
    fn an_existing_header_is_left_alone() {
        assert!(has_header("// SPDX-License-Identifier: Apache-2.0\nfn x() {}"));
        assert!(has_header("/*\n * Licensed under the MIT license\n */"));
        assert!(has_header(&format!("{}// Copyright 2020\n", "\n".repeat(10))));
        assert!(!has_header(&format!("{}// Copyright 2020\n", "\n".repeat(20))), "only the top of the file counts");
        assert!(header_edit("a.rs", "// Copyright (c) 2020 X\n", &defaults("", ""), "p", 2026, false).is_none());
    }

    #[test]
    fn a_project_contains_only_its_own_paths() {
        assert!(is_under("/proj/a.rs", "/proj"));
        assert!(!is_under("/proj-x/a.rs", "/proj"));
    }

    #[test]
    fn years() {
        assert_eq!(year_of_day(0), 1970);
        assert_eq!(year_of_day(19_722), 2023); // 2023-12-31
        assert_eq!(year_of_day(19_723), 2024); // 2024-01-01
        assert_eq!(year_of_day(20_759), 2026);
    }

    #[test]
    fn reports_on_open_and_save_and_fixes() {
        let host = MockHost::install().with_capabilities(&["events", "project.read", "editor.read", "editor.write"]);
        host.add_file("src/a.rs", "fn a() {}\n");
        host.add_file("src/b.rs", "// Copyright (c) 2020 X\nfn b() {}\n");
        let mut p = LicenseHeader::default();
        p.handle_events(
            &[Event::FileOpened("/project/src/a.rs".into()), Event::FileOpened("/project/src/b.rs".into())],
            &host.invocation(),
        );
        let d = host.diagnostics();
        assert_eq!(d["/project/src/a.rs"][0].code.as_deref(), Some(CODE));
        assert!(d.get("/project/src/b.rs").is_none_or(Vec::is_empty));

        // Off when opening, still on saving.
        host.set_setting("reportOnOpen", "false");
        host.add_file("src/c.rs", "fn c() {}\n");
        p.handle_events(&[Event::FileOpened("/project/src/c.rs".into())], &host.invocation());
        assert!(host.diagnostics().get("/project/src/c.rs").is_none_or(Vec::is_empty));
        p.handle_events(&[Event::FileSaved("/project/src/c.rs".into())], &host.invocation());
        assert_eq!(host.diagnostics()["/project/src/c.rs"].len(), 1);

        host.set_setting("owner", "\"ACME\"");
        let actions = p.code_actions(&doc("/project/src/a.rs", "fn a() {}\n"), Range::default());
        assert_eq!(actions[0].title, "Add license header");
        let (path, edits) = &actions[0].edits[0];
        assert_eq!(path, "/project/src/a.rs");
        assert!(
            edits[0].text.starts_with(&format!(
                "// Copyright (c) {} ACME\n// SPDX-License-Identifier: Apache-2.0\n",
                this_year()
            ))
        );
        assert!(p.code_actions(&doc("/project/README.md", "x"), Range::default()).is_empty());

        // The command edits the focused editor once.
        host.open_editor("/project/src/a.rs", "rust", "fn a() {}\n", &[(0, 0, 0, 0)]);
        assert_eq!(p.run_command("add", &host.invocation(), None).unwrap(), None);
        assert!(has_header(&host.editor_text()));
        assert!(p.run_command("add", &host.invocation(), None).unwrap().unwrap().contains("already"));
    }

    #[test]
    fn scans_the_project_in_a_task() {
        let host = MockHost::install().with_capabilities(&["events", "project.read"]);
        host.add_file("src/a.rs", "fn a() {}\n");
        host.add_file("src/b.py", "# Copyright 2024 X\n");
        host.add_file("notes.md", "no header needed\n");
        let mut p = LicenseHeader::default();
        p.run_command("scan", &host.invocation(), None).unwrap();
        let d = host.diagnostics();
        assert_eq!(d["/project/src/a.rs"].len(), 1);
        assert!(d.get("/project/src/b.py").is_none_or(Vec::is_empty));
        assert!(!d.contains_key("/project/notes.md"));
        assert_eq!(host.tasks().len(), 1);
        assert!(host.notifications()[0].body.contains("1 of 2"), "{:?}", host.notifications());
    }

    #[test]
    fn templates_expand_their_variables() {
        let vars = Vars {
            year: "2020-2026".into(),
            author: "ACME".into(),
            license: "MIT".into(),
            project: "shapes".into(),
            file: "area.py".into(),
        };
        assert_eq!(
            expand("\nCopyright $year $author\n\nPart of $project ($file), $license.\n\n", &vars),
            ["Copyright 2020-2026 ACME", "", "Part of shapes (area.py), MIT."]
        );
        // A value cannot add lines (code) to the file.
        let vars = Vars { author: "A\nimport os".into(), ..vars };
        assert_eq!(expand("(c) $author", &vars), ["(c) A import os"]);
        assert_eq!(header_lines(2026, "", "Apache-2.0"), ["Copyright (c) 2026", "SPDX-License-Identifier: Apache-2.0"]);
    }

    #[test]
    fn comment_styles_override_the_builtin_table() {
        let styles = [
            Style { extensions: "kt, .KTS".into(), style: "block".into(), prefix: "/*".into(), suffix: "*/".into() },
            Style { extensions: "vue".into(), style: "line".into(), prefix: "//".into(), suffix: String::new() },
        ];
        assert_eq!(comment_for("a/B.kts", &styles), Some(Comment::Block("/*".into(), " */".into())));
        assert_eq!(comment_for("App.vue", &styles), Some(Comment::Line("//".into())));
        assert_eq!(comment_for("a.rs", &styles), Some(Comment::Line("//".into())));
        assert_eq!(comment_for("App.vue", &[]), None);
        let html = Comment::Block("<!--".into(), " -->".into());
        assert_eq!(render(&html, &["(c) A --> B".into()]), "<!--\n  (c) A - - > B\n -->\n\n");
    }

    #[test]
    fn finds_the_existing_header() {
        let line = Comment::Line("//".into());
        assert_eq!(
            existing_header("// Copyright 2020 X\n// SPDX-License-Identifier: MIT\n\nfn a() {}\n", &line, 1),
            Some((0, 3))
        );
        assert_eq!(existing_header("// just a note\nfn a() {}\n", &line, 1), None);
        let py = Comment::Line("#".into());
        assert_eq!(existing_header("#!/usr/bin/env python\n# Copyright 2021 X\nx = 1\n", &py, 1), Some((1, 2)));
        let block = Comment::Block("/*".into(), " */".into());
        assert_eq!(existing_header("/*\n * Copyright 2019 X\n */\n\n.a {}\n", &block, 1), Some((0, 4)));
        assert_eq!(existing_header("/* Copyright 2019 X */\n.a {}\n", &block, 1), Some((0, 1)));
        assert_eq!(first_year("Copyright (c) 2019-2024 ACME, 1999 and 3000", 2026), Some(1999));
        assert_eq!(first_year("Apache-2.0, 12345", 2026), None);
        assert_eq!(year_text(Some("// Copyright 2020"), 2026), "2020-2026");
        assert_eq!(year_text(Some("// Copyright 2026"), 2026), "2026");
        assert_eq!(year_text(None, 2026), "2026");
    }

    #[test]
    fn update_replaces_the_header_and_keeps_its_first_year() {
        let profile = Profile {
            template: "Copyright $year $author\nPart of $project.".into(),
            author: "ACME".into(),
            ..Profile::default()
        };
        let text = "// Copyright (c) 2020 Old Name\n// SPDX-License-Identifier: MIT\n\n\nfn a() {}\n";
        let e = header_edit("src/a.rs", text, &profile, "shapes", 2026, true).unwrap();
        assert_eq!(apply(text, &e), "// Copyright 2020-2026 ACME\n// Part of shapes.\n\nfn a() {}\n");
        // Up to date: nothing to do, again or for Add.
        let updated = apply(text, &e);
        assert!(header_edit("src/a.rs", &updated, &profile, "shapes", 2026, true).is_none());
        assert!(header_edit("src/a.rs", text, &profile, "shapes", 2026, false).is_none());
        // No header yet: Update adds one, after the shebang.
        let e = header_edit("run.sh", "#!/bin/sh\necho\n", &profile, "shapes", 2026, true).unwrap();
        assert_eq!(apply("#!/bin/sh\necho\n", &e), "#!/bin/sh\n# Copyright 2026 ACME\n# Part of shapes.\n\necho\n");
        // A file that is only a header.
        let e = header_edit("a.rs", "// Copyright 2024 X", &profile, "p", 2026, true).unwrap();
        assert_eq!(apply("// Copyright 2024 X", &e), "// Copyright 2024-2026 ACME\n// Part of p.\n");
        // A block header.
        let css = "/*\n * Copyright 2019 X\n */\n\n.a {}\n";
        let e = header_edit("s.css", css, &profile, "p", 2026, true).unwrap();
        assert_eq!(apply(css, &e), "/*\n * Copyright 2019-2026 ACME\n * Part of p.\n */\n\n.a {}\n");
        // An empty template writes nothing.
        assert!(header_edit("a.rs", "fn a() {}", &Profile::default(), "p", 2026, true).is_none());
    }

    #[test]
    fn profiles_come_from_the_settings() {
        let host = MockHost::install().with_capabilities(&["project.read"]);
        assert_eq!(profile().template, "Copyright (c) $year\nSPDX-License-Identifier: $license");
        host.set_setting("owner", "\"ACME\"");
        host.set_setting(
            "profiles",
            r#"[{"name":"Short","notice":"(c) $year $author"},{"name":"Empty","notice":" "}]"#,
        );
        host.set_setting("profile", "\"Short\"");
        assert_eq!(profile().template, "(c) $year $author");
        // An unknown or empty profile falls back to the default one.
        host.set_setting("profile", "\"Empty\"");
        assert!(profile().template.starts_with("Copyright (c) $year $author"));
        host.set_setting("commentStyles", r#"[{"extensions":"vue","style":"line","prefix":"//","suffix":""}]"#);
        assert_eq!(profile().styles[0].extensions, "vue");
    }

    #[test]
    fn updates_selected_files_and_folders() {
        let host = MockHost::install().with_capabilities(&[
            "events",
            "project.read",
            "project.write",
            "editor.read",
            "editor.write",
        ]);
        host.add_file("src/a.rs", "// Copyright 2020 Old\nfn a() {}\n");
        host.add_file("src/b.py", "x = 1\n");
        host.add_file("src/notes.md", "no header\n");
        host.add_file("other/c.rs", "fn c() {}\n");
        host.set_setting("owner", "\"ACME\"");
        host.set_setting("license", "\"\"");
        host.add_dir("src");
        host.select_paths(&["/project/src"]);
        // The mock answers `Project::document` only while some editor is open.
        host.open_editor("/project/other/c.rs", "rust", "fn c() {}\n", &[(0, 0, 0, 0)]);
        let mut p = LicenseHeader::default();
        p.run_command("update-selected", &host.invocation(), None).unwrap();
        let project = host.invocation().project().unwrap();
        let year = this_year();
        assert_eq!(
            project.read_file("src/a.rs").unwrap(),
            format!("// Copyright (c) 2020-{year} ACME\n\nfn a() {{}}\n")
        );
        assert_eq!(project.read_file("src/b.py").unwrap(), format!("# Copyright (c) {year} ACME\n\nx = 1\n"));
        assert_eq!(project.read_file("src/notes.md").unwrap(), "no header\n");
        assert_eq!(project.read_file("other/c.rs").unwrap(), "fn c() {}\n", "outside the selected folder");
        assert!(host.notifications()[0].body.contains("Updated 2 files"), "{:?}", host.notifications());
        // Again: everything is up to date.
        p.run_command("update-selected", &host.invocation(), None).unwrap();
        assert!(
            host.notifications()[1].body.contains("Updated 0 files; 2 already up to date"),
            "{:?}",
            host.notifications()
        );
    }

    #[test]
    fn a_file_created_and_opened_gets_the_header_when_enabled() {
        let host = MockHost::install().with_capabilities(&["events", "project.read", "editor.read", "editor.write"]);
        host.set_setting("license", "\"\"");
        let created = |path: &str| {
            Event::FilesChanged(openidea_plugin::FilesChanged { created: vec![path.into()], ..Default::default() })
        };
        let mut p = LicenseHeader::default();
        // Off by default.
        host.add_file("src/new.rs", "");
        host.open_editor("/project/src/new.rs", "rust", "", &[(0, 0, 0, 0)]);
        p.handle_events(
            &[created("/project/src/new.rs"), Event::FileOpened("/project/src/new.rs".into())],
            &host.invocation(),
        );
        assert_eq!(host.editor_text(), "");
        host.set_setting("addToNewFiles", "true");
        p.handle_events(
            &[created("/project/src/new.rs"), Event::FileOpened("/project/src/new.rs".into())],
            &host.invocation(),
        );
        assert_eq!(host.editor_text(), format!("// Copyright (c) {}\n\n", this_year()));
        // The created event can also come after the file opened.
        host.add_file("src/later.rs", "");
        host.open_editor("/project/src/later.rs", "rust", "", &[(0, 0, 0, 0)]);
        p.handle_events(&[Event::FileOpened("/project/src/later.rs".into())], &host.invocation());
        p.handle_events(&[created("/project/src/later.rs")], &host.invocation());
        assert_eq!(host.editor_text(), format!("// Copyright (c) {}\n\n", this_year()));
        // An existing file that opens is left alone.
        host.add_file("src/old.rs", "fn old() {}\n");
        host.open_editor("/project/src/old.rs", "rust", "fn old() {}\n", &[(0, 0, 0, 0)]);
        p.handle_events(&[Event::FileOpened("/project/src/old.rs".into())], &host.invocation());
        assert_eq!(host.editor_text(), "fn old() {}\n");
    }

    #[test]
    fn block_headers_doc_comments_and_trailing_comments() {
        let profile = Profile { template: "Copyright $year ACME".into(), ..Profile::default() };
        // A C-like file may carry a /* */ header: it is recognised and updated.
        let java = "/*\n * Copyright 2020 ACME\n */\nclass A {}\n";
        let e = header_edit("A.java", java, &profile, "p", 2026, true).unwrap();
        assert_eq!(apply(java, &e), "// Copyright 2020-2026 ACME\n\nclass A {}\n");
        // A doc comment right after the notice stays.
        let rs = "// Copyright 2020 ACME\n//! Crate docs.\nfn a() {}\n";
        let e = header_edit("a.rs", rs, &profile, "p", 2026, true).unwrap();
        assert_eq!(apply(rs, &e), "// Copyright 2020-2026 ACME\n\n//! Crate docs.\nfn a() {}\n");
        // So does a comment after the notice that is not part of it.
        let py = "# Copyright 2021 ACME\n# Helpers for shapes.\nx = 1\n";
        let e = header_edit("a.py", py, &profile, "p", 2026, true).unwrap();
        assert_eq!(apply(py, &e), "# Copyright 2021-2026 ACME\n\n# Helpers for shapes.\nx = 1\n");
        // A multi-paragraph license notice is replaced whole.
        let apache = "// Copyright 2019 X\n//\n// Licensed under the Apache License, Version 2.0;\n// you may not use this file except in compliance with the License.\nfn a() {}\n";
        let e = header_edit("a.rs", apache, &profile, "p", 2026, true).unwrap();
        assert_eq!(apply(apache, &e), "// Copyright 2019-2026 ACME\n\nfn a() {}\n");
    }

    #[test]
    fn xml_php_first_lines_and_crlf() {
        let styles = vec![Style {
            extensions: "xml, php".into(),
            style: "block".into(),
            prefix: "<!--".into(),
            suffix: "-->".into(),
        }];
        let profile = Profile { template: "Copyright $year ACME".into(), styles, ..Profile::default() };
        let xml = "<?xml version=\"1.0\"?>\n<a/>\n";
        let e = header_edit("a.xml", xml, &profile, "p", 2026, true).unwrap();
        assert_eq!(apply(xml, &e), "<?xml version=\"1.0\"?>\n<!--\n  Copyright 2026 ACME\n -->\n\n<a/>\n");
        assert_eq!(insert_line("<?php\necho 1;\n"), 1);
        // A CRLF file gets a CRLF header.
        let crlf = "fn a() {}\r\n";
        let e = header_edit("a.rs", crlf, &profile, "p", 2026, true).unwrap();
        assert_eq!(apply(crlf, &e), "// Copyright 2026 ACME\r\n\r\nfn a() {}\r\n");
        let updated = apply(crlf, &e);
        assert!(header_edit("a.rs", &updated, &profile, "p", 2026, true).is_none(), "up to date");
    }

    #[test]
    fn vendored_folders_are_skipped() {
        let ex = ["vendor".to_string(), "third_party".to_string()];
        assert!(in_excluded("/p/src/vendor/x/a.rs", "/p/src", &ex));
        assert!(in_excluded("/p/third_party/a.rs", "/p", &ex));
        assert!(!in_excluded("/p/vendor/a.rs", "/p/vendor", &ex), "the selected folder itself");
        assert!(!in_excluded("/p/src/vendor.rs", "/p/src", &ex), "a file named like one");
        let host = MockHost::install().with_capabilities(&["events", "project.read", "project.write", "editor.read"]);
        host.add_file("src/a.rs", "fn a() {}\n");
        host.add_file("src/vendor/lib.rs", "// Copyright 2015 Someone Else\nfn v() {}\n");
        host.add_dir("src");
        host.select_paths(&["/project/src"]);
        host.open_editor("/project/other.rs", "rust", "", &[(0, 0, 0, 0)]);
        LicenseHeader::default().run_command("update-selected", &host.invocation(), None).unwrap();
        let project = host.invocation().project().unwrap();
        assert!(project.read_file("src/a.rs").unwrap().starts_with("// Copyright"));
        assert_eq!(project.read_file("src/vendor/lib.rs").unwrap(), "// Copyright 2015 Someone Else\nfn v() {}\n");
    }

    #[test]
    fn a_created_file_with_text_is_left_alone() {
        let host = MockHost::install().with_capabilities(&["events", "project.read", "editor.read", "editor.write"]);
        host.set_setting("addToNewFiles", "true");
        // A renamed (or checked out) file arrives created, with its text.
        host.add_file("src/moved.rs", "fn moved() {}\n");
        host.open_editor("/project/src/moved.rs", "rust", "fn moved() {}\n", &[(0, 0, 0, 0)]);
        let created = Event::FilesChanged(openidea_plugin::FilesChanged {
            created: vec!["/project/src/moved.rs".into()],
            ..Default::default()
        });
        LicenseHeader::default()
            .handle_events(&[created, Event::FileOpened("/project/src/moved.rs".into())], &host.invocation());
        assert_eq!(host.editor_text(), "fn moved() {}\n");
    }
}
