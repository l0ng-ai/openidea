//! Node lookup, expressions, statements and syntax errors.

use crate::types::{ExpressionAt, NodeAt, StructuralRanges, SyntaxError, SyntaxErrorKind, SyntaxErrors};
use crate::{Ctx, MAX_SYNTAX_ERRORS, StructureResult};
use ide_core::{Pos, Range};
use tree_sitter::Node;

pub(crate) fn node_at(cx: &Ctx, range: Range) -> Option<NodeAt> {
    let (a, b) = cx.lines.bytes(range);
    let root = cx.tree.root_node();
    let node = root.named_descendant_for_byte_range(a, b)?;
    let mut ancestors = Vec::new();
    let mut cur = node.parent();
    while let Some(n) = cur {
        ancestors.push(cx.node(&n));
        cur = n.parent();
    }
    Some(NodeAt { node: cx.node(&node), ancestors })
}

/// Trims whitespace off a byte span (keeps an empty span where it is).
fn trim(text: &str, a: usize, b: usize) -> (usize, usize) {
    let s = &text[a..b];
    let lead = s.len() - s.trim_start().len();
    if lead == s.len() {
        return (a, a);
    }
    (a + lead, b - (s.len() - s.trim_end().len()))
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// The byte a caret query should probe: the char after the caret, or the one
/// before it when the caret sits right after a word (`foo|)`).
fn probe(text: &str, b: usize) -> usize {
    let after = text[b..].chars().next();
    let before = text[..b].chars().next_back();
    match (after, before) {
        (Some(c), Some(p)) if !is_word(c) && is_word(p) => b - p.len_utf8(),
        (None, Some(p)) => b - p.len_utf8(),
        _ => b,
    }
}

pub(crate) fn expression_at(cx: &Ctx, range: Range) -> ExpressionAt {
    let text = cx.text();
    let (a, b) = cx.lines.bytes(range);
    let (a, b) = trim(text, a, b);
    let root = cx.tree.root_node();
    let (expression, exact) = if a == b {
        let p = probe(text, a);
        let end = (p + text[p..].chars().next().map_or(0, char::len_utf8)).min(text.len());
        let node = root.named_descendant_for_byte_range(p, end.max(p));
        (node.and_then(|n| enclosing_expression(cx, n)), false)
    } else {
        match root.named_descendant_for_byte_range(a, b) {
            Some(node) => {
                // Outermost expression with exactly the selected span, else the innermost enclosing one.
                let mut exact = None;
                let mut cur = Some(node);
                while let Some(n) = cur {
                    if n.start_byte() != a || n.end_byte() != b {
                        break;
                    }
                    if cx.kinds.is_expression(&n) {
                        exact = Some(n);
                    }
                    cur = n.parent();
                }
                match exact {
                    Some(n) => (Some(n), true),
                    None => (enclosing_expression(cx, node), false),
                }
            }
            None => (None, false),
        }
    };
    let anchor = expression.or_else(|| root.named_descendant_for_byte_range(a, b));
    let statement = anchor.and_then(|n| statement_of(cx, n));
    let mut candidates = Vec::new();
    let mut function_boundary = None;
    if let Some(e) = expression {
        let mut cur = Some(e);
        while let Some(n) = cur {
            if Some(n) == statement || statement.is_some_and(|s| s.parent() == Some(n)) {
                break;
            }
            if function_boundary.is_none() && n != e && cx.kinds.is_function_like(&n) {
                function_boundary = Some(n);
            }
            if function_boundary.is_none() && cx.kinds.is_expression(&n) {
                candidates.push(cx.node(&n));
            }
            cur = n.parent();
        }
        // An expression statement's own expression (`foo(x)` in `foo(x);`) is a candidate too.
        if let Some(s) = statement
            && cx.kinds.is_expression(&s)
            && function_boundary.is_none()
            && !candidates.iter().any(|c| c.range == cx.range(&s))
        {
            candidates.push(cx.node(&s));
        }
    }
    let has_error = statement.or(expression).is_some_and(|n| n.has_error());
    ExpressionAt {
        expression: expression.map(|n| cx.node(&n)),
        exact,
        candidates,
        block: statement.and_then(|s| s.parent()).map(|n| cx.node(&n)),
        statement: statement.map(|n| cx.node(&n)),
        function_boundary: function_boundary.map(|n| cx.node(&n)),
        has_error,
    }
}

fn enclosing_expression<'t>(cx: &Ctx, node: Node<'t>) -> Option<Node<'t>> {
    let mut cur = Some(node);
    while let Some(n) = cur {
        if cx.kinds.is_expression(&n) {
            return Some(n);
        }
        // Do not climb out of the statement.
        if n.parent().is_some_and(|p| cx.kinds.is_block(&p)) {
            return None;
        }
        cur = n.parent();
    }
    None
}

/// Nearest ancestor-or-self that is a direct named child of a block.
fn statement_of<'t>(cx: &Ctx, node: Node<'t>) -> Option<Node<'t>> {
    statement_or_clause_of(cx, node, false)
}

/// Like [`statement_of`], but a `switch` / `when` branch reached from its header counts too.
fn statement_or_clause_of<'t>(cx: &Ctx, node: Node<'t>, clauses: bool) -> Option<Node<'t>> {
    let mut cur = Some(node);
    while let Some(n) = cur {
        let parent = n.parent()?;
        if n.is_named() && !n.is_extra() && (cx.kinds.is_block(&parent) || clauses && cx.kinds.is_clause(&n)) {
            return Some(n);
        }
        cur = Some(parent);
    }
    None
}

/// The neighbouring statement; a branch's neighbours are the other branches (not the `switch` subject).
fn statement_sibling<'t>(cx: &Ctx, node: Node<'t>, next: bool) -> Option<Node<'t>> {
    let s = sibling(node, next)?;
    (!cx.kinds.is_clause(&node) || cx.kinds.is_clause(&s)).then_some(s)
}

/// Nearest ancestor-or-self that is a direct named child of a class body or the file.
fn declaration_of<'t>(cx: &Ctx, node: Node<'t>) -> Option<Node<'t>> {
    let mut cur = Some(node);
    while let Some(n) = cur {
        let parent = n.parent()?;
        if n.is_named() && !n.is_extra() && cx.kinds.is_member_container(&parent) {
            return Some(n);
        }
        cur = Some(parent);
    }
    None
}

fn sibling<'t>(node: Node<'t>, next: bool) -> Option<Node<'t>> {
    let mut cur = if next { node.next_named_sibling() } else { node.prev_named_sibling() };
    while let Some(n) = cur {
        if !n.is_extra() {
            return Some(n);
        }
        cur = if next { n.next_named_sibling() } else { n.prev_named_sibling() };
    }
    None
}

/// The first code byte on the line at/after `b` (or before it at a line end).
fn code_probe(text: &str, b: usize) -> usize {
    let rest = &text[b..];
    let line = rest.split('\n').next().unwrap_or("");
    if let Some(i) = line.find(|c: char| !c.is_whitespace()) {
        return b + i;
    }
    let start = text[..b].rfind('\n').map_or(0, |i| i + 1);
    match text[start..b].char_indices().rev().find(|(_, c)| !c.is_whitespace()) {
        Some((i, _)) => start + i,
        None => b,
    }
}

pub(crate) fn structural_ranges(cx: &Ctx, pos: Pos) -> StructuralRanges {
    let text = cx.text();
    let b = code_probe(text, cx.lines.byte(pos));
    let root = cx.tree.root_node();
    let end = (b + text[b..].chars().next().map_or(0, char::len_utf8)).min(text.len());
    let Some(node) = root.descendant_for_byte_range(b, end) else { return StructuralRanges::default() };
    let statement = statement_or_clause_of(cx, node, true);
    let declaration = declaration_of(cx, node);
    StructuralRanges {
        selection: Vec::new(),
        prev_statement: statement.and_then(|s| statement_sibling(cx, s, false)).map(|n| cx.node(&n)),
        next_statement: statement.and_then(|s| statement_sibling(cx, s, true)).map(|n| cx.node(&n)),
        block: statement.and_then(|s| s.parent()).map(|n| cx.node(&n)),
        statement: statement.map(|n| cx.node(&n)),
        prev_declaration: declaration.and_then(|s| sibling(s, false)).map(|n| cx.node(&n)),
        next_declaration: declaration.and_then(|s| sibling(s, true)).map(|n| cx.node(&n)),
        declaration: declaration.map(|n| cx.node(&n)),
    }
}

pub(crate) fn syntax_errors(cx: &Ctx) -> StructureResult<SyntaxErrors> {
    let text = cx.text();
    let mut out = SyntaxErrors::default();
    let root = cx.tree.root_node();
    if !root.has_error() {
        return Ok(out);
    }
    let mut cursor = root.walk();
    let mut visited = 0usize;
    'walk: loop {
        let node = cursor.node();
        visited += 1;
        if visited.is_multiple_of(4096) {
            cx.check()?;
        }
        let mut descend = node.has_error();
        if node.is_missing() {
            let expected = node.kind().to_owned();
            let at = cx.lines.pos(node.start_byte());
            out.errors.push(SyntaxError {
                kind: SyntaxErrorKind::Missing,
                range: Range::point(at),
                message: format!("missing `{expected}`"),
                expected: Some(expected),
            });
            descend = false;
        } else if node.is_error() {
            let snippet: String = text[node.byte_range()].split_whitespace().collect::<Vec<_>>().join(" ");
            let snippet: String = snippet.chars().take(32).collect();
            out.errors.push(SyntaxError {
                kind: SyntaxErrorKind::Unexpected,
                range: cx.range(&node),
                message: if snippet.is_empty() { "syntax error".into() } else { format!("unexpected `{snippet}`") },
                expected: None,
            });
            descend = false;
        }
        if out.errors.len() > MAX_SYNTAX_ERRORS {
            out.errors.truncate(MAX_SYNTAX_ERRORS);
            out.truncated = true;
            break;
        }
        if descend && cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                continue 'walk;
            }
            if !cursor.goto_parent() {
                break 'walk;
            }
        }
    }
    Ok(out)
}
