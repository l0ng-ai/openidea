use super::ChainWarning;
use super::search::Finder;
use tree_sitter::Node;

impl Finder<'_, '_> {
    pub(super) fn warnings(&self, root: Node, ops: &[Node]) -> Vec<ChainWarning> {
        let parallel = self.name(root) == "parallelStream" || ops.iter().any(|op| self.name(*op) == "parallel");
        if parallel { vec![ChainWarning::Sequentialized] } else { Vec::new() }
    }
}
