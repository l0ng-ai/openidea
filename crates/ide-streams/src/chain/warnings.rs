use super::ChainWarning;
use super::search::{Finder, object_of};
use crate::catalog::SourceCheck;
use tree_sitter::Node;

impl Finder<'_, '_> {
    pub(super) fn warnings(&self, root: Node, check: SourceCheck, ops: &[Node]) -> Vec<ChainWarning> {
        let call = self.text(root).to_string();
        let mut warnings = Vec::new();
        match check {
            SourceCheck::Stateful => warnings.push(ChainWarning::StatefulSource { call }),
            SourceCheck::Rereads => warnings.push(ChainWarning::RereadsResource { call }),
            SourceCheck::Fresh if self.name(root) == "iterate" && self.iterate_has_state(root) => {
                warnings.push(ChainWarning::StatefulSource { call })
            }
            SourceCheck::Fresh => {}
        }
        let parallel = self.name(root) == "parallelStream"
            || ops.iter().any(|op| matches!(self.name(*op), "parallel" | "sequential"));
        if parallel {
            warnings.push(ChainWarning::ParallelRemoved);
        }
        warnings
    }

    /// A seed function that is a method reference, or a lambda reading
    /// anything besides its own parameters, may yield new elements when the
    /// chain is evaluated again.
    fn iterate_has_state(&self, root: Node) -> bool {
        let Some(args) = root.child_by_field_name("arguments") else { return false };
        let mut cursor = args.walk();
        args.named_children(&mut cursor).any(|arg| match arg.kind() {
            "method_reference" => true,
            "lambda_expression" => {
                let mut params = Vec::new();
                if let Some(p) = arg.child_by_field_name("parameters") {
                    collect_identifiers(p, &mut params);
                }
                let mut used = Vec::new();
                if let Some(body) = arg.child_by_field_name("body") {
                    collect_identifiers(body, &mut used);
                }
                used.iter().any(|u| !params.iter().any(|p| self.text(*p) == self.text(*u)))
            }
            _ => false,
        })
    }
}

/// Identifiers naming variables, so not a member name after a `.`.
fn collect_identifiers<'t>(n: Node<'t>, out: &mut Vec<Node<'t>>) {
    if n.kind() == "identifier" {
        let member = n.parent().is_some_and(|p| {
            (p.kind() == "method_invocation" && p.child_by_field_name("name") == Some(n) && object_of(p).is_some())
                || (p.kind() == "field_access" && p.child_by_field_name("field") == Some(n))
        });
        if !member {
            out.push(n);
        }
    }
    let mut cursor = n.walk();
    for child in n.children(&mut cursor) {
        collect_identifiers(child, out);
    }
}
