//! `@noinspection` suppression comments.
//!
//! A docblock (or `/* */` comment) holding `@noinspection Id[, Id2 …]`
//! suppresses those inspections in the statement or class member that
//! follows it (comments in between are skipped). One that comes right after
//! the opening tag and is followed by a blank line, a `declare` or a
//! `namespace` (or by nothing) suppresses them in the whole file. `ALL`
//! suppresses every inspection, and an id matches with or without the
//! `Inspection` suffix PhpStorm writes (`PhpUnusedInspection` and
//! `PhpUnused` are the same), so existing suppressions keep working.
//!
//! The "Suppress for statement" fix adds the tag to the docblock in front of
//! the innermost statement or member around the problem, or puts a new
//! `/** @noinspection Id */` line in front of it.

use std::path::Path;

use ide_core::TextEdit;
use mago_span::HasSpan;
use mago_syntax::cst::{ClassLikeMember, Statement, TriviaKind};
use mago_syntax::walker::Walker;

use super::QuickFix;
use crate::imports::file_edit;
use crate::syntax::ParsedFile;

/// The start of every suppress fix's title.
pub const SUPPRESS_TITLE: &str = "Suppress ";

const TAG: &str = "@noinspection";

/// A statement or class member: where suppressions apply and fixes go.
#[derive(Clone, Copy, Debug)]
struct Node {
    start: u32,
    end: u32,
    /// `declare` or `namespace`: a file-level suppression may precede it,
    /// and the fix doesn't pick it.
    file_level: bool,
}

/// One suppression: the ids and the bytes they hold for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Suppression {
    pub ids: Vec<String>,
    pub start: u32,
    pub end: u32,
}

/// The suppressions of a file, and what the suppress fix needs.
#[derive(Clone, Debug, Default)]
pub struct Suppressions {
    pub list: Vec<Suppression>,
    nodes: Vec<Node>,
    /// Comment spans, in order: `(start, end, docblock)`.
    comments: Vec<(u32, u32, bool)>,
}

impl Suppressions {
    pub fn scan(parsed: &ParsedFile) -> Self {
        let program = parsed.program();
        let text = parsed.text();
        let len = text.len() as u32;
        let mut nodes = Vec::new();
        NodeWalker.walk_program(program, &mut nodes);
        nodes.sort_by_key(|n: &Node| (n.start, std::cmp::Reverse(n.end)));
        let comments: Vec<(u32, u32, bool)> = program
            .trivia
            .iter()
            .filter(|t| t.kind.is_comment())
            .map(|t| (t.span.start.offset, t.span.end.offset.min(len), t.kind == TriviaKind::DocBlockComment))
            .collect();
        let mut list = Vec::new();
        for trivia in program.trivia.iter() {
            if !matches!(trivia.kind, TriviaKind::DocBlockComment | TriviaKind::MultiLineComment) {
                continue;
            }
            let value = String::from_utf8_lossy(trivia.value);
            let ids = tag_ids(&value);
            if ids.is_empty() {
                continue;
            }
            let (start, end) = (trivia.span.start.offset, trivia.span.end.offset.min(len));
            let next = next_significant(text, &comments, end);
            let follows: Option<Node> = nodes.iter().filter(|n| n.start == next).max_by_key(|n| n.end).copied();
            let after_tag = is_opening_tag(&text[..start as usize]);
            let blank_after = text[end as usize..next as usize].matches('\n').count() >= 2;
            let scope_end = if after_tag && (blank_after || follows.is_none_or(|n| n.file_level)) {
                len
            } else if let Some(node) = follows {
                node.end
            } else {
                line_end(text, next)
            };
            list.push(Suppression { ids, start, end: scope_end });
        }
        Self { list, nodes, comments }
    }

    /// Whether inspection `id` is suppressed at byte `offset`.
    pub fn suppresses(&self, id: &str, offset: u32) -> bool {
        self.list.iter().any(|s| s.start <= offset && offset <= s.end && s.ids.iter().any(|tag| id_matches(tag, id)))
    }

    /// "Suppress 'Id' for statement" for a problem at byte `offset`. `None`
    /// when no statement or member is around it.
    pub fn suppress_fix(&self, parsed: &ParsedFile, path: &Path, id: &str, offset: u32) -> Option<QuickFix> {
        let text = parsed.text();
        let node = self
            .nodes
            .iter()
            .filter(|n| !n.file_level && n.start <= offset && offset <= n.end)
            .min_by_key(|n| n.end - n.start)?;
        let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
        let line_start = text[..node.start as usize].rfind('\n').map_or(0, |i| i + 1) as u32;
        let indent = &text[line_start as usize..node.start as usize];
        let own_line = indent.chars().all(|c| c == ' ' || c == '\t');
        let index = parsed.line_index();
        let edit = match self.docblock_before(text, node.start) {
            Some((start, end)) => add_to_docblock(text, start, end, id, newline),
            None if own_line => (node.start, node.start, format!("/** {TAG} {id} */{newline}{indent}")),
            None => (node.start, node.start, format!("/** {TAG} {id} */ ")),
        };
        let (start, end, new_text) = edit;
        Some(QuickFix {
            title: format!("{SUPPRESS_TITLE}'{id}' for statement"),
            edit: file_edit(path, vec![TextEdit { range: index.range(start, end), new_text }]),
            preferred: false,
        })
    }

    /// The docblock right in front of byte `at` (only blank space between).
    fn docblock_before(&self, text: &str, at: u32) -> Option<(u32, u32)> {
        self.comments
            .iter()
            .rev()
            .find(|(_, end, _)| *end <= at)
            .filter(|(_, end, doc)| *doc && text[*end as usize..at as usize].trim().is_empty())
            .map(|(start, end, _)| (*start, *end))
    }
}

/// The edit adding `@noinspection id` to the docblock at `start..end`.
fn add_to_docblock(text: &str, start: u32, end: u32, id: &str, newline: &str) -> (u32, u32, String) {
    let comment = &text[start as usize..end as usize];
    let line_start = text[..start as usize].rfind('\n').map_or(0, |i| i + 1);
    let indent: String = text[line_start..start as usize].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
    if let Some(last_newline) = comment.rfind('\n') {
        let closing = &comment[last_newline + 1..];
        let before_close = closing.strip_suffix("*/").filter(|ws| ws.trim().is_empty());
        if let Some(ws) = before_close {
            let at = start + last_newline as u32 + 1;
            return (at, at, format!("{ws}* {TAG} {id}{newline}"));
        }
        // `… text */` on the last line: the tag goes on a line of its own.
        let at = end - 2;
        return (at, at, format!("{newline}{indent} * {TAG} {id}{newline}{indent} "));
    }
    let inner = comment.trim_start_matches("/**").trim_end_matches("*/").trim();
    let mut out = format!("/**{newline}");
    if !inner.is_empty() {
        out.push_str(&format!("{indent} * {inner}{newline}"));
    }
    out.push_str(&format!("{indent} * {TAG} {id}{newline}{indent} */"));
    (start, end, out)
}

/// The ids after every `@noinspection` of a comment.
fn tag_ids(comment: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut rest = comment;
    while let Some(at) = rest.find(TAG) {
        let after = &rest[at + TAG.len()..];
        if after.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
            rest = after;
            continue;
        }
        let line = after.split(['\n', '\r']).next().unwrap_or("");
        let line = line.split("*/").next().unwrap_or("");
        for word in line.split(|c: char| c == ',' || c.is_whitespace()).filter(|w| !w.is_empty()) {
            if !word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                break;
            }
            ids.push(word.to_owned());
        }
        rest = after;
    }
    ids
}

/// Whether a tag written in a comment names inspection `id`.
fn id_matches(tag: &str, id: &str) -> bool {
    let bare = |s: &'_ str| s.strip_suffix("Inspection").unwrap_or(s).to_ascii_lowercase();
    tag.eq_ignore_ascii_case("ALL") || bare(tag) == bare(id)
}

/// The first byte at or after `from` that isn't blank space or a comment.
fn next_significant(text: &str, comments: &[(u32, u32, bool)], from: u32) -> u32 {
    let bytes = text.as_bytes();
    let mut at = from as usize;
    loop {
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        match comments.iter().find(|(start, _, _)| *start as usize == at) {
            Some((_, end, _)) if *end as usize > at => at = *end as usize,
            _ => return at as u32,
        }
    }
}

fn line_end(text: &str, from: u32) -> u32 {
    text[from as usize..].find('\n').map_or(text.len(), |i| from as usize + i) as u32
}

/// Whether `before` is only an opening tag (and blank space).
fn is_opening_tag(before: &str) -> bool {
    let trimmed = before.trim();
    trimmed.eq_ignore_ascii_case("<?php") || trimmed == "<?"
}

struct NodeWalker;

impl<'ast, 'arena> Walker<'ast, 'arena, Vec<Node>> for NodeWalker {
    fn walk_in_statement(&self, statement: &'ast Statement<'arena>, nodes: &mut Vec<Node>) {
        let file_level = match statement {
            Statement::OpeningTag(_)
            | Statement::ClosingTag(_)
            | Statement::Inline(_)
            | Statement::Noop(_)
            | Statement::Block(_) => return,
            Statement::Namespace(_) | Statement::Declare(_) => true,
            _ => false,
        };
        let span = statement.span();
        nodes.push(Node { start: span.start.offset, end: span.end.offset, file_level });
    }

    fn walk_in_class_like_member(&self, member: &'ast ClassLikeMember<'arena>, nodes: &mut Vec<Node>) {
        let span = member.span();
        nodes.push(Node { start: span.start.offset, end: span.end.offset, file_level: false });
    }
}
