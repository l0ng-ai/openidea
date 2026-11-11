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
///
/// On a thread with the default stack (2 MB, rayon's workers included) every
/// call maps a fresh [`PARSER_STACK`] segment and unmaps it afterwards, and
/// the engine parses often (each file, docblock and PHPDoc type). Those maps
/// serialize threads on the process's address space: batch Inspect Code
/// over Monica spent more than half its time there and scaled only 3× on 16
/// threads (roadmap phase 9.4.b). Work that parses a lot runs on threads of
/// [`PARSER_THREAD_STACK`] instead ([`on_parser_stacks`]), where this never
/// switches stacks.
pub fn parser_stack<R>(parse: impl FnOnce() -> R) -> R {
    stacker::maybe_grow(PARSER_RED_ZONE, PARSER_STACK, parse)
}

/// The stack of the engine's own threads (its worker, the background
/// inspections and [`on_parser_stacks`]'s pool): with this much, a parse
/// started anywhere but deep in a recursive walk stays on the thread's stack
/// ([`parser_stack`]). It is reserved address space; only the pages used are
/// committed.
pub const PARSER_THREAD_STACK: usize = PARSER_STACK + (8 << 20);

/// Whether the current thread has room for a parse without a new stack
/// segment ([`parser_stack`]).
pub fn has_parser_stack() -> bool {
    stacker::remaining_stack().is_some_and(|left| left >= PARSER_RED_ZONE)
}

/// Runs `work`, which parses in parallel (rayon), on threads with
/// [`PARSER_THREAD_STACK`]: in place when the current thread is a rayon
/// worker with that much stack left (its pool's threads are then assumed
/// alike), else on the engine's own pool of such threads, built on first
/// use with one thread per core.
pub fn on_parser_stacks<R: Send>(work: impl FnOnce() -> R + Send) -> R {
    if rayon::current_thread_index().is_some() && has_parser_stack() {
        return work();
    }
    parser_pool().install(work)
}

fn parser_pool() -> &'static rayon::ThreadPool {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .thread_name(|i| format!("openidea-php-analysis-{i}"))
            .stack_size(PARSER_THREAD_STACK)
            .build()
            .expect("a thread pool for PHP analysis")
    })
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

#[cfg(test)]
mod tests {
    use rayon::prelude::*;

    use super::*;

    #[test]
    fn parallel_work_runs_on_threads_with_room_for_a_parse() {
        // From a thread with a small stack, the work moves to the engine's
        // pool, whose threads parse without switching stacks.
        let small = std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(|| {
                assert!(!has_parser_stack());
                on_parser_stacks(|| {
                    let roomy: Vec<bool> = (0..64).into_par_iter().map(|_| has_parser_stack()).collect();
                    (rayon::current_thread_index().is_some(), roomy)
                })
            })
            .unwrap()
            .join()
            .unwrap();
        assert!(small.0, "on a pool thread");
        assert!(small.1.iter().all(|&roomy| roomy), "every worker has room for a parse");

        // Inside a rayon pool whose threads have the room, it stays there.
        let name = || std::thread::current().name().map(str::to_owned);
        let roomy = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .thread_name(|_| "roomy".to_owned())
            .stack_size(PARSER_THREAD_STACK)
            .build()
            .unwrap();
        assert_eq!(roomy.install(|| on_parser_stacks(name)).as_deref(), Some("roomy"));
        // A pool with rayon's default stacks hands it over.
        let small = rayon::ThreadPoolBuilder::new().num_threads(1).thread_name(|_| "small".to_owned()).build().unwrap();
        let ran = small.install(|| on_parser_stacks(name));
        assert!(ran.is_some_and(|name| name.starts_with("openidea-php-analysis-")), "on the engine's pool");

        // A deeply nested parse runs there.
        let deep = format!("<?php {}1{};", "(".repeat(400), ")".repeat(400));
        let parsed = on_parser_stacks(|| super::super::ParsedFile::parse("deep.php", deep.as_str()));
        assert!(!parsed.text().is_empty());
    }
}
