use crate::lines::Lines;
use crate::{CancellationToken, Ctx, Snapshot, StructureResult, StructureService};
use ide_core::{Pos, Range};

/// A parsed snapshot lent to a closure. Node offsets are bytes into `text`;
/// convert with [`SyntaxTree::range`] / [`SyntaxTree::pos`] before they leave
/// the closure, since IPC coordinates are UTF-16.
pub struct SyntaxTree<'a> {
    pub grammar: &'static str,
    pub tree: &'a tree_sitter::Tree,
    pub text: &'a str,
    // Borrowed from the service's `Ctx` so lending a tree does not re-index lines.
    lines: &'a Lines<'a>,
}

impl SyntaxTree<'_> {
    pub fn range(&self, node: &tree_sitter::Node) -> Range {
        self.lines.range(node.start_byte(), node.end_byte())
    }

    /// Byte offset of `pos`, clamped to its line and to the text.
    pub fn byte(&self, pos: Pos) -> usize {
        self.lines.byte(pos)
    }

    pub fn pos(&self, byte: usize) -> Pos {
        self.lines.pos(byte)
    }
}

impl StructureService {
    /// Lends the parsed tree to `f` so analysis crates (`ide-streams`) can walk nodes; positions come out via `range`/`pos` (UTF-16).
    pub fn with_tree<R>(
        &self,
        snap: &Snapshot,
        cancel: &CancellationToken,
        f: impl FnOnce(&SyntaxTree<'_>) -> R,
    ) -> StructureResult<R> {
        self.run(snap, cancel, |cx: &Ctx| {
            Ok(f(&SyntaxTree { grammar: cx.grammar, tree: cx.tree, text: cx.text(), lines: &cx.lines }))
        })
    }
}
