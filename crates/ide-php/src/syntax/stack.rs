//! Stack depth guards for parsing.
//!
//! Mago's parsers (PHP, PHPDoc, Twig) are recursive descent. They stop at
//! their own limit of 512 nested levels and report a parse error past it, but
//! reaching that limit takes far more than the 1–2 MB a thread gets by default:
//! about 32 MB in a debug build (measured in phase 8.29 on thousands of nested
//! closures, `if` blocks and anonymous classes). A stack overflow aborts the
//! whole editor, so every Mago parse runs through [`parser_stack`], which
//! switches to a stack segment large enough for that limit when the current
//! one has less room left.
//!
//! Binary operators and member chains are parsed in a loop with no limit, so
//! the tree can be deeper than Mago's own limit (`'a' . 'b' . …` ten thousand
//! times). [`too_deep`] measures it without recursing, and
//! [`ParsedFile::parse`](super::ParsedFile::parse) drops a tree deeper than
//! [`MAX_TREE_DEPTH`] with a diagnostic, so the engine's recursive walks never
//! see one.

use mago_span::{HasSpan, Span};
use mago_syntax::cst::{Node, Program};

/// The stack a Mago parse may need at its 512-level limit, with headroom.
/// It is reserved address space; only the pages a parse touches are committed.
const PARSER_STACK: usize = 64 << 20;

/// Below this much free stack, a parse moves to a fresh [`PARSER_STACK`]
/// segment.
const PARSER_RED_ZONE: usize = 40 << 20;

/// The deepest syntax tree the engine analyses, in nodes below the program.
/// Real code stays below it, though not far: across the 39,624 PHP files
/// and compiled Blade templates of Monica and Bagisto (`vendor/` included)
/// the deepest tree has 334 nodes, and 99.9% have fewer than 90; Laravel's
/// deepest has 91 and WordPress's 346, but Symfony's FrameworkBundle
/// configuration tree (one fluent chain, three nodes per call) has 818. Only
/// generated code goes past the bound (a compiled URL matcher fixture of
/// Symfony's, 1,769). The engine's walks handle this depth on a 2 MB
/// debug-build stack (`deep_nesting_tests`); the recursive ones that need
/// more run through [`deep`].
pub const MAX_TREE_DEPTH: usize = 1500;

/// Below this much free stack, a recursive walk through [`deep`] moves to a
/// fresh [`DEEP_STACK`] segment. It covers what one level of the walk uses
/// before it reaches [`deep`] again, class-model building included.
const DEEP_RED_ZONE: usize = 256 << 10;

/// The stack segment [`deep`] adds.
const DEEP_STACK: usize = 4 << 20;

/// Runs `parse` (a call into one of Mago's parsers) with enough stack for
/// Mago's recursion limit.
pub fn parser_stack<R>(parse: impl FnOnce() -> R) -> R {
    stacker::maybe_grow(PARSER_RED_ZONE, PARSER_STACK, parse)
}

/// Runs one level of a recursive walk over the syntax tree, on a new stack
/// segment when the current one is nearly used up (rustc's
/// `ensure_sufficient_stack`, MIT/Apache-2.0). The tree is at most
/// [`MAX_TREE_DEPTH`] deep, so the segments it adds are bounded too.
#[inline]
pub fn deep<R>(level: impl FnOnce() -> R) -> R {
    stacker::maybe_grow(DEEP_RED_ZONE, DEEP_STACK, level)
}

/// The span of a node of `program` more than `limit` nodes below the program,
/// or `None` when the tree is no deeper. Iterative: it never recurses,
/// whatever the depth.
pub fn too_deep(program: &Program<'_>, limit: usize) -> Option<Span> {
    let mut stack: Vec<(Node<'_, '_>, usize)> = Vec::new();
    Node::Program(program).visit_children(|child| stack.push((child, 1)));
    while let Some((node, depth)) = stack.pop() {
        if depth > limit {
            return Some(node.span());
        }
        node.visit_children(|child| stack.push((child, depth + 1)));
    }
    None
}
