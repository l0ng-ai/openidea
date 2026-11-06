//! License Header for OpenIDEA: a copyright and SPDX license header at the top
//! of source files, in the file's own comment syntax.
//!
//! - A file without one is reported (an info diagnostic on its first line)
//!   when it opens, and again when it is saved, so adding the header clears it.
//! - The quick fix and *License Header: Add to Current File* insert it (after a
//!   `#!` line or a Python encoding line, which must stay first).
//! - *Find Files Without a Header* scans the project in a background task and
//!   reports every source file that needs one in the Problems view.

use openidea_plugin::host;
use openidea_plugin::providers::{CodeAction, Document, Providers};
use openidea_plugin::{
    Diagnostic, Error, Event, Invocation, NotificationLevel, Plugin, Position, Project, Range, Severity, TextEdit,
    register_plugin,
};

/// Lines looked at for an existing header.
const HEADER_LINES: usize = 15;
/// Files a scan reads at most.
const MAX_SCAN: u32 = 5000;
/// Files larger than this are skipped by a scan.
const MAX_FILE: usize = 1 << 20;
const CODE: &str = "missing-license-header";

/// How a file writes a header: line comments, or one block comment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Comment {
    Line(&'static str),
    Block(&'static str, &'static str),
}

/// The comment syntax for `path`, `None` for files that don't get a header.
pub fn comment_for(path: &str) -> Option<Comment> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    if matches!(lower.as_str(), "dockerfile" | "makefile" | "justfile") {
        return Some(Comment::Line("#"));
    }
    let ext = lower.rsplit_once('.').map(|(_, e)| e)?;
    Some(match ext {
        "rs" | "java" | "kt" | "kts" | "scala" | "groovy" | "gradle" | "go" | "js" | "jsx" | "mjs" | "cjs" | "ts"
        | "tsx" | "mts" | "cts" | "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "m" | "mm" | "cs" | "swift"
        | "dart" | "proto" | "sol" | "zig" | "v" => Comment::Line("//"),
        "css" | "scss" | "less" => Comment::Block("/*", " */"),
        "py" | "sh" | "bash" | "zsh" | "fish" | "rb" | "pl" | "r" | "ps1" | "yaml" | "yml" | "toml" | "cmake"
        | "tf" | "nix" | "ex" | "exs" | "jl" => Comment::Line("#"),
        "sql" | "lua" | "hs" | "elm" => Comment::Line("--"),
        _ => return None,
    })
}

/// Whether `text` already starts with a header (copyright or license notice).
pub fn has_header(text: &str) -> bool {
    text.lines().take(HEADER_LINES).any(|l| {
        let l = l.to_ascii_lowercase();
        l.contains("copyright") || l.contains("spdx-license-identifier") || l.contains("licensed under")
    })
}

/// The header's lines, without comment markers.
pub fn header_lines(year: i64, owner: &str, license: &str) -> Vec<String> {
    let owner = owner.trim();
    let mut lines =
        vec![if owner.is_empty() { format!("Copyright (c) {year}") } else { format!("Copyright (c) {year} {owner}") }];
    if !license.trim().is_empty() {
        lines.push(format!("SPDX-License-Identifier: {}", license.trim()));
    }
    lines
}

/// The header as `comment` writes it, with a blank line after it.
pub fn render(comment: Comment, lines: &[String]) -> String {
    let mut out = String::new();
    match comment {
        Comment::Line(prefix) => {
            for l in lines {
                out.push_str(&format!("{prefix} {l}\n"));
            }
        }
        Comment::Block(open, close) => {
            out.push_str(open);
            out.push('\n');
            for l in lines {
                out.push_str(&format!(" * {l}\n"));
            }
            out.push_str(close);
            out.push('\n');
        }
    }
    out.push('\n');
    out
}

/// The line the header goes on: after a `#!` line and a Python encoding line.
pub fn insert_line(text: &str) -> u32 {
    let mut line = 0;
    let mut lines = text.lines();
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
    l.starts_with('#') && (l.contains("coding:") || l.contains("coding="))
}

/// The edit that adds the header to `path`'s `text`, `None` when it has one or takes none.
pub fn header_edit(path: &str, text: &str, year: i64, owner: &str, license: &str) -> Option<TextEdit> {
    let comment = comment_for(path)?;
    if has_header(text) {
        return None;
    }
    let at = Position::new(insert_line(text), 0);
    let mut insert = render(comment, &header_lines(year, owner, license));
    // After a first line without a newline (a lone shebang).
    if at.line > 0 && text.lines().count() == at.line as usize && !text.ends_with('\n') {
        insert.insert(0, '\n');
    }
    Some(TextEdit { range: Range::new(at, at), text: insert })
}

fn missing(text: &str) -> Diagnostic {
    let line = insert_line(text);
    let len = text.lines().nth(line as usize).map_or(0, |l| l.encode_utf16().count() as u32);
    Diagnostic::new(Range::new(Position::new(line, 0), Position::new(line, len)), Severity::Info, "No license header")
        .code(CODE)
}

/// Reports `path` when it takes a header and has none, clears it otherwise.
pub fn report(path: &str, text: &str) -> Result<bool, Error> {
    let lacking = comment_for(path).is_some() && !has_header(text);
    host::publish_diagnostics(path, &if lacking { vec![missing(text)] } else { Vec::new() })?;
    Ok(lacking)
}

/// The current year (WASI wall clock), from days since the epoch.
fn this_year() -> i64 {
    let secs =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    year_of_day(secs.div_euclid(86_400))
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

fn settings() -> (String, String) {
    (
        host::setting_string("owner").unwrap_or_default(),
        host::setting_string("license").unwrap_or_else(|| "Apache-2.0".into()),
    )
}

fn project_of(path: &str) -> Option<Project> {
    host::projects()
        .ok()?
        .into_iter()
        .filter(|p| p.root().is_ok_and(|r| path.starts_with(&r)))
        .max_by_key(|p| p.root().map(|r| r.len()).unwrap_or(0))
}

#[derive(Default)]
pub struct LicenseHeader;

impl LicenseHeader {
    fn add_to_editor(&self, ctx: &Invocation) -> Result<Option<String>, Error> {
        let editor = ctx.editor().ok_or_else(|| Error::Invalid("focus an editor first".into()))?;
        let (path, doc) = (editor.path(), editor.document()?);
        if comment_for(&path).is_none() {
            return Err(Error::Invalid("this kind of file takes no license header".into()));
        }
        let (owner, license) = settings();
        let Some(edit) = header_edit(&path, &doc.text, this_year(), &owner, &license) else {
            return Ok(Some("The file already has a license header.".into()));
        };
        editor.apply_edits(doc.version, &[edit])?;
        Ok(None)
    }

    /// Reports every source file of the project without a header; returns (checked, lacking).
    fn scan(&self, project: &Project) -> Result<(u32, u32), Error> {
        let files: Vec<String> = project
            .find_files("**/*", MAX_SCAN * 4)?
            .into_iter()
            .filter(|f| comment_for(f).is_some())
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
            if report(path, &text)? {
                lacking += 1;
            }
        }
        Ok((checked, lacking))
    }
}

impl Plugin for LicenseHeader {
    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "add" => self.add_to_editor(ctx),
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
        for e in events {
            let (path, opened) = match e {
                Event::FileOpened(p) => (p, true),
                Event::FileSaved(p) => (p, false),
                _ => continue,
            };
            if comment_for(path).is_none() || (opened && !host::setting_bool("reportOnOpen").unwrap_or(true)) {
                continue;
            }
            let Some(project) = project_of(path) else { continue };
            if let Ok(text) = project.read_file(path) {
                let _ = report(path, &text);
            }
        }
    }
}

impl Providers for LicenseHeader {
    fn code_actions(&mut self, doc: &Document, _selection: Range) -> Vec<CodeAction> {
        let (owner, license) = settings();
        let Some(edit) = header_edit(&doc.path, &doc.text, this_year(), &owner, &license) else { return Vec::new() };
        vec![CodeAction {
            title: "Add license header".into(),
            kind: Some("quickfix".into()),
            preferred: true,
            edits: vec![(doc.path.clone(), vec![edit])],
            ..Default::default()
        }]
    }
}

register_plugin!(LicenseHeader, providers);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    fn doc(path: &str, text: &str) -> Document {
        Document { path: path.into(), language: String::new(), version: 1, text: text.into() }
    }

    #[test]
    fn writes_the_header_in_each_files_comment_syntax() {
        let lines = header_lines(2026, "ACME Inc.", "MIT");
        assert_eq!(
            render(comment_for("a/b.rs").unwrap(), &lines),
            "// Copyright (c) 2026 ACME Inc.\n// SPDX-License-Identifier: MIT\n\n"
        );
        assert_eq!(render(comment_for("x.py").unwrap(), &lines[..1]), "# Copyright (c) 2026 ACME Inc.\n\n");
        assert_eq!(
            render(comment_for("s.css").unwrap(), &lines),
            "/*\n * Copyright (c) 2026 ACME Inc.\n * SPDX-License-Identifier: MIT\n */\n\n"
        );
        assert_eq!(comment_for("q.SQL"), Some(Comment::Line("--")));
        assert_eq!(comment_for("Dockerfile"), Some(Comment::Line("#")));
        assert_eq!(comment_for("README.md"), None);
        assert_eq!(comment_for("noext"), None);
        assert_eq!(header_lines(2026, " ", ""), ["Copyright (c) 2026"]);
    }

    #[test]
    fn keeps_shebang_and_encoding_lines_first() {
        assert_eq!(insert_line("fn main() {}\n"), 0);
        assert_eq!(insert_line("#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nprint()\n"), 2);
        assert_eq!(insert_line("#!/bin/sh\necho\n"), 1);
        assert_eq!(insert_line("# coding=latin-1\nx = 1\n"), 1);
        let e = header_edit("run.sh", "#!/bin/sh", 2026, "", "").unwrap();
        assert_eq!((e.range.start, e.text.as_str()), (Position::new(1, 0), "\n# Copyright (c) 2026\n\n"));
    }

    #[test]
    fn an_existing_header_is_left_alone() {
        assert!(has_header("// SPDX-License-Identifier: Apache-2.0\nfn x() {}"));
        assert!(has_header("/*\n * Licensed under the MIT license\n */"));
        assert!(has_header(&format!("{}// Copyright 2020\n", "\n".repeat(10))));
        assert!(!has_header(&format!("{}// Copyright 2020\n", "\n".repeat(20))), "only the top of the file counts");
        assert!(header_edit("a.rs", "// Copyright (c) 2020 X\n", 2026, "", "").is_none());
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
        let mut p = LicenseHeader;
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
        let mut p = LicenseHeader;
        p.run_command("scan", &host.invocation(), None).unwrap();
        let d = host.diagnostics();
        assert_eq!(d["/project/src/a.rs"].len(), 1);
        assert!(d.get("/project/src/b.py").is_none_or(Vec::is_empty));
        assert!(!d.contains_key("/project/notes.md"));
        assert_eq!(host.tasks().len(), 1);
        assert!(host.notifications()[0].body.contains("1 of 2"), "{:?}", host.notifications());
    }
}
