//! Folding ranges: bracketed nodes, language block nodes, indentation bodies,
//! comment runs, import runs and `region` / `endregion` marker comments.

use super::grammars::Spec;
use crate::{FoldKind, FoldRange, LanguageConfig};
use tree_sitter::{Language, Node, Tree, TreeCursor};

const PAIRS: &[(&str, &str)] = &[("{", "}"), ("[", "]"), ("(", ")"), ("#{", "}"), ("${", "}"), ("@{", "}")];

struct Comment {
    start_row: usize,
    end_row: usize,
    own_line: bool,
    marker: Option<bool>,
}

const COMMENT: u8 = 1;
const FOLD_BODY: u8 = 2;
const FOLD_NODE: u8 = 4;
const IMPORT: u8 = 8;

/// Per-grammar classification of node kind ids, so the folding walk (which
/// visits every node) compares integers instead of kind name strings.
pub(crate) struct KindTable {
    flags: Vec<u8>,
    /// `1 + index into PAIRS` for opening bracket tokens, else 0.
    open: Vec<u8>,
    /// Bit `i` set when the kind closes `PAIRS[i]`.
    close: Vec<u8>,
}

impl KindTable {
    pub(crate) fn new(spec: &Spec, language: &Language) -> Self {
        let n = language.node_kind_count();
        let (mut flags, mut open, mut close) = (vec![0u8; n], vec![0u8; n], vec![0u8; n]);
        for id in 0..n {
            let Some(kind) = language.node_kind_for_id(id as u16) else { continue };
            let mut f = 0;
            if is_comment(kind) {
                f |= COMMENT;
            }
            if spec.fold_bodies.contains(&kind) {
                f |= FOLD_BODY;
            }
            if spec.fold_nodes.contains(&kind) {
                f |= FOLD_NODE;
            }
            if spec.imports.contains(&kind) {
                f |= IMPORT;
            }
            flags[id] = f;
            for (i, (o, c)) in PAIRS.iter().enumerate() {
                if kind == *o {
                    open[id] = i as u8 + 1;
                }
                if kind == *c {
                    close[id] |= 1 << i;
                }
            }
        }
        Self { flags, open, close }
    }

    fn has(&self, node: &Node, flag: u8) -> bool {
        self.flags.get(node.kind_id() as usize).is_some_and(|f| f & flag != 0)
    }

    /// [`bracket_pair`] by kind id.
    fn bracket_close_row(&self, node: &Node) -> Option<usize> {
        let count = node.child_count();
        if count < 2 {
            return None;
        }
        let first = node.child(0)?;
        let open = *self.open.get(first.kind_id() as usize)?;
        if open == 0 || first.is_named() {
            return None;
        }
        let last = node.child(count - 1)?;
        if last.is_named() || last.is_missing() {
            return None;
        }
        let close = *self.close.get(last.kind_id() as usize)?;
        (close & (1 << (open - 1)) != 0).then(|| last.start_position().row)
    }
}

#[derive(Default)]
pub(super) struct CommentTokens {
    line: Option<String>,
    block: Option<(String, String)>,
}

impl From<&LanguageConfig> for CommentTokens {
    fn from(config: &LanguageConfig) -> Self {
        Self { line: config.line_comment.clone(), block: config.block_comment.clone() }
    }
}

pub(super) fn folding(
    spec: &Spec,
    kinds: &KindTable,
    tree: &Tree,
    text: &str,
    tokens: &CommentTokens,
) -> Vec<FoldRange> {
    let mut out: Vec<FoldRange> = Vec::new();
    let mut comments: Vec<Comment> = Vec::new();
    let mut cursor = tree.walk();
    visit(&mut cursor, |node| {
        let (start, end) = (node.start_position().row, node.end_position().row);
        if node.is_named() && kinds.has(&node, COMMENT) {
            comments.push(Comment {
                start_row: start,
                end_row: last_content_row(&node, text),
                own_line: own_line(text, node.start_byte(), node.start_position().column),
                marker: region_marker(text.get(node.start_byte()..node.end_byte()).unwrap_or_default(), tokens),
            });
            return true;
        }
        if start != end && !spec.imports.is_empty() && node.named_child_count() > 1 {
            import_runs(kinds, node, text, &mut out);
        }
        // A one-line body still folds from its parent's header line (Python `def f():` + `return x`).
        if node.is_named() && kinds.has(&node, FOLD_BODY) {
            let header = node.parent().map_or(start, |p| p.start_position().row);
            push(&mut out, header.min(start), last_content_row(&node, text), FoldKind::Region);
            return true;
        }
        if start == end {
            // Nothing else on a single line folds; only comments inside can (see `may_hold_fold_comment`).
            return may_hold_fold_comment(kinds, &node, text);
        }
        if !node.is_named() {
            return true;
        }
        if let Some(close_row) = kinds.bracket_close_row(&node) {
            push(&mut out, start, close_row, FoldKind::Region);
        } else if kinds.has(&node, FOLD_NODE) {
            push(&mut out, start, last_content_row(&node, text), FoldKind::Region);
        }
        true
    });
    comment_folds(&comments, &mut out);
    out.sort_by(|a, b| a.start_line.cmp(&b.start_line).then(b.end_line.cmp(&a.end_line)));
    out.dedup_by_key(|f| f.start_line);
    out
}

fn push(out: &mut Vec<FoldRange>, start: usize, end: usize, kind: FoldKind) {
    if end > start {
        out.push(FoldRange { start_line: start as u32, end_line: end as u32, kind });
    }
}

/// Whether a comment inside single-line `node` can affect comment folds: an
/// own-line comment (it must start where `node` starts) or a region marker
/// (which counts wherever it is). Lets the walk skip most of the tree: a 2 MB
/// file has ~800k nodes, nearly all of them on a single line.
fn may_hold_fold_comment(kinds: &KindTable, node: &Node, text: &str) -> bool {
    if node.child_count() == 0 {
        return false;
    }
    let bytes = text.as_bytes().get(node.start_byte()..node.end_byte()).unwrap_or_default();
    if contains_ignore_case(bytes, b"region") || contains_ignore_case(bytes, b"editor-fold") {
        return true;
    }
    if !own_line(text, node.start_byte(), node.start_position().column) {
        return false;
    }
    let mut first = node.child(0);
    while let Some(n) = first {
        if n.start_byte() != node.start_byte() {
            return false;
        }
        if kinds.has(&n, COMMENT) {
            return true;
        }
        first = n.child(0);
    }
    false
}

fn contains_ignore_case(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w.eq_ignore_ascii_case(needle))
}

/// Depth-first pre-order traversal; `f` returns whether to visit the node's children.
fn visit(cursor: &mut TreeCursor, mut f: impl FnMut(Node) -> bool) {
    loop {
        if f(cursor.node()) && cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

pub(crate) fn is_comment(kind: &str) -> bool {
    kind.contains("comment") || kind == "Comment"
}

/// Row of the closing token when `node` is delimited by a matching bracket pair.
pub(crate) fn bracket_pair<'t>(node: &Node<'t>) -> Option<(Node<'t>, Node<'t>)> {
    let count = node.child_count();
    if count < 2 {
        return None;
    }
    let first = node.child(0)?;
    let last = node.child(count - 1)?;
    if first.is_named() || last.is_named() || last.is_missing() {
        return None;
    }
    PAIRS.iter().any(|&(o, c)| first.kind() == o && last.kind() == c).then_some((first, last))
}

/// Last row with content; nodes ending at column 0 (trailing newline) end one row earlier.
/// Last row holding non-whitespace content of `node` (many nodes swallow trailing blank lines).
fn last_content_row(node: &Node, text: &str) -> usize {
    let (s, e) = (node.start_byte(), node.end_byte());
    let Some(t) = text.get(s..e) else { return node.end_position().row };
    let trailing = &t[t.trim_end().len()..];
    let newlines = trailing.bytes().filter(|&b| b == b'\n').count();
    node.end_position().row.saturating_sub(newlines).max(node.start_position().row)
}

/// `column` is the byte column of `byte` (from tree-sitter), so finding the
/// line start does not scan back through long lines.
fn own_line(text: &str, byte: usize, column: usize) -> bool {
    let line_start = byte.saturating_sub(column);
    text.as_bytes().get(line_start..byte).is_none_or(|s| s.iter().rev().all(u8::is_ascii_whitespace))
}

/// `Some(true)` for a region start marker, `Some(false)` for an end marker.
/// Strip whole configured delimiters, preserving the `<` in editor-fold tags.
pub(super) fn region_marker(comment: &str, tokens: &CommentTokens) -> Option<bool> {
    let comment = comment.trim();
    let body = if let Some((open, close)) = &tokens.block
        && let Some(body) = comment.strip_prefix(open.as_str())
    {
        let body = body.trim_end().strip_suffix(close.as_str())?;
        if open == "/*" { body.trim_start_matches('*') } else { body }
    } else if let Some(open) = &tokens.line
        && let Some(body) = comment.strip_prefix(open.as_str())
    {
        match open.as_str() {
            "//" => body.trim_start_matches('/'),
            ";" => body.trim_start_matches(';'),
            _ => body,
        }
    } else {
        return None;
    };
    let body = body.trim();
    if body.contains(['\n', '\r']) {
        return None;
    }
    let lower = body.to_ascii_lowercase();
    let region = lower.strip_prefix('#').unwrap_or(&lower);
    let boundary = |tail: &str| !tail.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_');
    if region.strip_prefix("endregion").is_some_and(boundary)
        || lower
            .strip_prefix("</editor-fold")
            .and_then(|tail| tail.strip_suffix('>'))
            .is_some_and(|tail| tail.trim().is_empty())
    {
        Some(false)
    } else if region.strip_prefix("region").is_some_and(boundary)
        || lower.strip_prefix("<editor-fold").is_some_and(|tail| boundary(tail) && tail.contains('>'))
    {
        Some(true)
    } else {
        None
    }
}

/// Languages without a bundled grammar still support own-line custom markers.
pub(super) fn custom_folding(text: &str, tokens: &CommentTokens) -> Vec<FoldRange> {
    let comments: Vec<_> = text
        .lines()
        .enumerate()
        .filter_map(|(row, line)| {
            let marker = region_marker(line, tokens)?;
            Some(Comment { start_row: row, end_row: row, own_line: true, marker: Some(marker) })
        })
        .collect();
    let mut out = Vec::new();
    comment_folds(&comments, &mut out);
    out.sort_by_key(|f| f.start_line);
    out
}

fn comment_folds(comments: &[Comment], out: &mut Vec<FoldRange>) {
    let mut regions: Vec<usize> = Vec::new();
    let mut run: Option<(usize, usize)> = None;
    let flush = |run: &mut Option<(usize, usize)>, out: &mut Vec<FoldRange>| {
        if let Some((s, e)) = run.take() {
            push(out, s, e, FoldKind::Comment);
        }
    };
    for c in comments {
        match c.marker {
            Some(true) => {
                flush(&mut run, out);
                regions.push(c.start_row);
                continue;
            }
            Some(false) => {
                flush(&mut run, out);
                if let Some(start) = regions.pop() {
                    push(out, start, c.end_row, FoldKind::Region);
                }
                continue;
            }
            None => {}
        }
        if c.start_row != c.end_row {
            flush(&mut run, out);
            push(out, c.start_row, c.end_row, FoldKind::Comment);
            continue;
        }
        if !c.own_line {
            flush(&mut run, out);
            continue;
        }
        match &mut run {
            Some((_, e)) if c.start_row == *e + 1 => *e = c.end_row,
            _ => {
                flush(&mut run, out);
                run = Some((c.start_row, c.end_row));
            }
        }
    }
    flush(&mut run, out);
}

fn import_runs(kinds: &KindTable, node: Node, text: &str, out: &mut Vec<FoldRange>) {
    let mut cursor = node.walk();
    let mut run: Option<(usize, usize)> = None;
    for child in node.named_children(&mut cursor) {
        if kinds.has(&child, IMPORT) {
            let (s, e) = (child.start_position().row, last_content_row(&child, text));
            run = Some(match run {
                Some((rs, _)) => (rs, e),
                None => (s, e),
            });
        } else if kinds.has(&child, COMMENT) {
            continue;
        } else if let Some((s, e)) = run.take() {
            push(out, s, e, FoldKind::Imports);
        }
    }
    if let Some((s, e)) = run {
        push(out, s, e, FoldKind::Imports);
    }
}
