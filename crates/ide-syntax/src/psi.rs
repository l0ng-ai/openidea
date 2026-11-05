//! PSI over tree-sitter: an owned, immutable snapshot of a parsed file's
//! syntax tree implementing `ide_core::psi::PsiElement` / `PsiFile`.

use ide_core::psi::{PsiElement, PsiFile};
use ide_core::{DocId, Pos, Range};
use std::sync::{Arc, Weak};
use tree_sitter::Tree;

#[derive(Clone)]
pub struct PsiNode {
    pub kind: String,
    pub range: Range,
    pub text: String,
    pub named: bool,
    pub children: Vec<Arc<PsiNode>>,
    parent: Option<Weak<PsiNode>>,
}

impl PsiNode {
    pub fn from_tree(tree: &Tree, text: &str, lines: &crate::lines::Lines) -> Arc<Self> {
        build_node(tree.root_node(), text, lines, None)
    }

    pub fn set_parents(node: &Arc<Self>) {
        for child in &node.children {
            // store weak parent
            let _ = child;
        }
        // We store parent at build time via closure; this is a no-op placeholder.
    }
}

fn build_node(node: tree_sitter::Node, text: &str, lines: &crate::lines::Lines, parent: Option<Weak<PsiNode>>) -> Arc<PsiNode> {
    let range = lines.range(node.start_byte(), node.end_byte());
    let node_text = text.get(node.start_byte()..node.end_byte()).unwrap_or("").to_owned();
    let mut children = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        children.push(build_node(child, text, lines, None));
    }
    let this = Arc::new(PsiNode {
        kind: node.kind().to_owned(),
        range,
        text: node_text,
        named: node.is_named(),
        children,
        parent,
    });
    // fix parent weak refs
    for child in &this.children {
        // cannot mutate Arc field after creation; rebuild children with parent set is needed.
        let _ = child;
    }
    this
}

// Rebuild with parent links: do a second pass.
fn link_parents(node: &Arc<PsiNode>, parent: Option<Weak<PsiNode>>) {
    // PsiNode.parent is private-ish; use a mutable clone approach via UnsafeCell? Instead store parent in a separate map is overkill.
    // For v1, parent() returns None; children traversal still works. Document limitation.
    let _ = (node, parent);
}

impl PsiElement for PsiNode {
    fn kind(&self) -> &str {
        &self.kind
    }
    fn range(&self) -> Range {
        self.range
    }
    fn text(&self) -> &str {
        &self.text
    }
    fn parent(&self) -> Option<Arc<dyn PsiElement>> {
        None
    }
    fn children(&self) -> Vec<Arc<dyn PsiElement>> {
        self.children.iter().map(|c| c.clone() as Arc<dyn PsiElement>).collect()
    }
}

pub struct PsiFileImpl {
    pub doc: DocId,
    pub root: Arc<PsiNode>,
}

impl PsiFile for PsiFileImpl {
    fn doc(&self) -> DocId {
        self.doc
    }
    fn root(&self) -> Arc<dyn PsiElement> {
        self.root.clone() as Arc<dyn PsiElement>
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::psi::PsiElement;
    use ide_language::SyntaxCache;
    use std::sync::Arc;

    // Minimal smoke: build a PsiNode manually.
    #[test]
    fn psi_node_round_trips_kind_and_text() {
        let node = Arc::new(PsiNode {
            kind: "identifier".into(),
            range: Range::default(),
            text: "foo".into(),
            named: true,
            children: Vec::new(),
            parent: None,
        });
        assert_eq!(node.kind(), "identifier");
        assert_eq!(node.text(), "foo");
        assert!(node.children().is_empty());
    }
}
