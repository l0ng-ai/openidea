//! Comments and string literals of a text, for Find in Files' search context
//! filter ("In comments", "Except string literals", …).

use super::folding::is_comment;
use tree_sitter::{Node, Tree, TreeCursor};

/// What a [`Literal`] range is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiteralKind {
    Comment,
    String,
}

/// A comment or string literal: byte range of the outermost node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Literal {
    pub start: usize,
    pub end: usize,
    pub kind: LiteralKind,
}

fn kind_of(node: &Node<'_>) -> Option<LiteralKind> {
    if !node.is_named() {
        return None;
    }
    let kind = node.kind();
    if is_comment(kind) {
        Some(LiteralKind::Comment)
    } else if kind.contains("string") || matches!(kind, "char_literal" | "character_literal" | "rune_literal") {
        Some(LiteralKind::String)
    } else {
        None
    }
}

/// Comments and string literals in document order; nested ones (a string in a
/// comment, interpolations) are covered by the outermost.
pub(crate) fn literals(tree: &Tree) -> Vec<Literal> {
    let mut out = Vec::new();
    let mut cursor = tree.walk();
    loop {
        let node = cursor.node();
        let kind = kind_of(&node);
        if let Some(kind) = kind {
            out.push(Literal { start: node.start_byte(), end: node.end_byte(), kind });
        }
        if kind.is_none() && cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return out;
            }
        }
    }
}

/// What a [`SpellingRegion`] covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpellingKind {
    Comment,
    String,
    /// The name a declaration introduces (not its uses).
    Name,
}

/// Text the Typo inspection checks: byte range in document order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpellingRegion {
    pub start: usize,
    pub end: usize,
    pub kind: SpellingKind,
}

fn is_name_leaf(kind: &str) -> bool {
    kind.contains("identifier") || kind == "name"
}

/// Whether the identifier leaf under `cursor` is the name a declaration
/// introduces (`fn name`, `let pattern`, `int *declarator`, parameters,
/// `name = …` assignments) rather than a use of one.
fn declares(cursor: &TreeCursor<'_>, node: &Node<'_>) -> bool {
    let parent = node.parent().map(|p| p.kind()).unwrap_or_default();
    // Paths and calls name what is declared elsewhere (`use a::b::name`, `a.name()`).
    let reference = ["scoped", "qualified", "invocation", "member_access", "use_", "import", "call"]
        .iter()
        .any(|k| parent.contains(k));
    match cursor.field_name() {
        Some("name") => !reference,
        Some("pattern" | "declarator") => true,
        Some("left") => parent.contains("assignment") || parent.contains("declarator"),
        _ => parent.contains("parameter"),
    }
}

/// Comments, string literals and declared names, for spell checking.
pub(crate) fn spelling_regions(tree: &Tree) -> Vec<SpellingRegion> {
    let mut out = Vec::new();
    let mut cursor = tree.walk();
    loop {
        let node = cursor.node();
        let literal = kind_of(&node);
        let region = |kind| SpellingRegion { start: node.start_byte(), end: node.end_byte(), kind };
        match literal {
            Some(LiteralKind::Comment) => out.push(region(SpellingKind::Comment)),
            Some(LiteralKind::String) => out.push(region(SpellingKind::String)),
            None if node.is_named()
                && node.child_count() == 0
                && is_name_leaf(node.kind())
                && declares(&cursor, &node) =>
            {
                out.push(region(SpellingKind::Name))
            }
            None => {}
        }
        if literal.is_none() && cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return out;
            }
        }
    }
}
