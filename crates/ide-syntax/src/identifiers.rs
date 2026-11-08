//! Identifier occurrences by name (find-usages filtering, text-based rename preview).

use crate::kinds::in_comment_or_string;
use crate::types::IdentifierOccurrence;
use crate::{Ctx, StructureResult};
use ide_core::Range;
use tree_sitter::TreeCursor;

/// Leaf kinds that never name anything.
fn is_non_name_leaf(kind: &str) -> bool {
    ["comment", "string", "literal", "number", "integer", "float", "char", "escape", "content", "fragment", "text"]
        .iter()
        .any(|k| kind.contains(k))
}

/// Ancestors of the cursor's node, parent first (cursor moves are O(1),
/// unlike `Node::parent`).
fn ancestors<'t>(cursor: &TreeCursor<'t>) -> impl Iterator<Item = tree_sitter::Node<'t>> {
    let mut up = cursor.clone();
    std::iter::from_fn(move || up.goto_parent().then(|| up.node()))
}

/// Moves `cursor` (forward only, occurrences come in document order) to the
/// smallest node containing byte `s`; returns false when `s` is in no node.
fn seek(cursor: &mut TreeCursor, s: usize) -> bool {
    // Climb / step right until the current node reaches past `s`.
    loop {
        let n = cursor.node();
        if n.end_byte() > s {
            if n.start_byte() > s {
                return false;
            }
            break;
        }
        if cursor.goto_next_sibling() {
            continue;
        }
        if !cursor.goto_parent() {
            return false;
        }
    }
    // Descend to the innermost child containing `s`.
    while cursor.goto_first_child() {
        while cursor.node().end_byte() <= s {
            if !cursor.goto_next_sibling() {
                break;
            }
        }
        let n = cursor.node();
        if !(n.start_byte() <= s && s < n.end_byte()) {
            cursor.goto_parent();
            break;
        }
    }
    true
}

/// Whether `range` lands on a code token — not inside a comment or string
/// content (interpolations count as code), and a word-like leaf. Rename of an
/// indexed anchor uses this to keep its plugin-only fallback off identifiers
/// the language owns.
pub(crate) fn in_code(cx: &Ctx, range: Range) -> bool {
    let (a, b) = cx.lines.bytes(range);
    let root = cx.tree.root_node();
    let Some(node) = root.descendant_for_byte_range(a, b.max(a)) else { return false };
    if node.start_byte() != a || node.end_byte() != b || node.child_count() != 0 {
        return false;
    }
    let kind = node.kind();
    let word_like = kind.contains("identifier") || node.is_named();
    if !word_like || is_non_name_leaf(kind) || node.is_missing() {
        return false;
    }
    let mut ancestors = Vec::new();
    let mut up = node.parent();
    while let Some(n) = up {
        ancestors.push(n);
        up = n.parent();
    }
    !in_comment_or_string(&node, ancestors.into_iter())
}

pub(crate) fn identifiers_named(cx: &Ctx, name: &str) -> StructureResult<Vec<IdentifierOccurrence>> {
    let text = cx.text();
    let mut cursor = cx.tree.root_node().walk();
    let mut out = Vec::new();
    for (i, start) in memchr::memmem::find_iter(text.as_bytes(), name.as_bytes()).enumerate() {
        if i % 1024 == 1023 {
            cx.check()?;
        }
        let end = start + name.len();
        // Two word characters are never split between tokens: skip `counter` for `count`.
        let word = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
        let bytes = text.as_bytes();
        if (name.as_bytes()[0].is_ascii_alphanumeric() && word(start.checked_sub(1).and_then(|i| bytes.get(i))))
            || (name.as_bytes()[name.len() - 1].is_ascii_alphanumeric() && word(bytes.get(end)))
        {
            continue;
        }
        if !seek(&mut cursor, start) {
            continue;
        }
        let node = cursor.node();
        if node.start_byte() != start || node.end_byte() != end || node.child_count() != 0 {
            continue;
        }
        let kind = node.kind();
        let word_like = kind.contains("identifier") || node.is_named();
        if !word_like || is_non_name_leaf(kind) || node.is_missing() || in_comment_or_string(&node, ancestors(&cursor))
        {
            continue;
        }
        let mut up = ancestors(&cursor);
        let (parent, grandparent) = (up.next(), up.next());
        out.push(IdentifierOccurrence {
            range: cx.lines.range(start, end),
            kind: kind.to_owned(),
            qualified: cx.kinds.is_qualified_in(&node, parent, grandparent),
        });
    }
    Ok(out)
}
