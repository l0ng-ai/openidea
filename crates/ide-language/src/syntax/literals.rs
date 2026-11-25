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
    /// A raw / verbatim string: backslashes are literal text, not escapes
    /// (`r"\user"`, `r#"…"#`, `` `…` ``, `@"…"`). The spelling layer must not
    /// skip the character after a `\` in one of these.
    pub raw: bool,
}

/// Whether `node` is a string literal whose backslashes are not escapes.
fn is_raw_string(node: &Node<'_>, text: &str) -> bool {
    let kind = node.kind();
    // Rust/C++/C# grammars name the node directly.
    if kind == "raw_string_literal" || kind == "verbatim_string_literal" || kind.contains("raw_string") {
        return true;
    }
    // Go backtick strings and Python `r`/`fr`/`rb` prefixes: the grammar uses
    // the generic `string` node, so inspect the literal's own prefix.
    if kind == "string" || kind == "string_literal" {
        let literal = &text[node.start_byte()..node.end_byte()];
        if literal.starts_with('`') {
            return true;
        }
        let quote = literal.find(['"', '\'']);
        let prefix = quote.map_or("", |i| &literal[..i]);
        return !prefix.is_empty()
            && prefix.chars().any(|c| c == 'r' || c == 'R')
            && prefix.chars().all(|c| matches!(c, 'r' | 'R' | 'b' | 'B' | 'f' | 'F' | 'u' | 'U'));
    }
    false
}

fn is_name_leaf(kind: &str) -> bool {
    kind.contains("identifier") || kind == "name"
}

/// Node kinds whose `name` field is a use, not a declaration.
const USE_PARENTS: &[&str] =
    &["invocation", "call", "access", "scoped", "reference", "expression", "selector", "qualified", "use_", "import"];

/// Whether the identifier leaf under `cursor` is the name a declaration
/// introduces (`fn name`, `let pattern`, `int *declarator`, parameters,
/// `name = …` assignments) rather than a use of one.
fn declares(cursor: &TreeCursor<'_>, node: &Node<'_>) -> bool {
    let parent = node.parent().map(|p| p.kind()).unwrap_or_default();
    match cursor.field_name() {
        // Uses name their target with a `name` field too: Java `s.substring()`,
        // C# `a.Name`, Rust `use a::b::name`.
        Some("name") => !USE_PARENTS.iter().any(|p| parent.contains(p)),
        Some("pattern" | "declarator") => true,
        Some("left") => parent.contains("assignment") || parent.contains("declarator"),
        // A parameter's name, not its type (`String text`).
        Some("type") => false,
        _ => parent.contains("parameter") && !node.kind().contains("type"),
    }
}

/// Comments, string literals and declared names, for spell checking.
pub(crate) fn spelling_regions(tree: &Tree, text: &str) -> Vec<SpellingRegion> {
    let mut out = Vec::new();
    let mut cursor = tree.walk();
    loop {
        let node = cursor.node();
        let literal = kind_of(&node);
        let region = |kind| SpellingRegion { start: node.start_byte(), end: node.end_byte(), kind, raw: false };
        match literal {
            Some(LiteralKind::Comment) => out.push(region(SpellingKind::Comment)),
            Some(LiteralKind::String) => {
                let mut r = region(SpellingKind::String);
                r.raw = is_raw_string(&node, text);
                out.push(r);
            }
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
