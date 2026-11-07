use super::ChainWarning;
use super::search::{Finder, object_of};
use crate::catalog::SourceCheck;
use tree_sitter::Node;

impl Finder<'_, '_> {
    /// `sources` starts with the chain's root; the rest are sources nested in
    /// its receiver, which evaluating the root runs again too.
    pub(super) fn warnings(&self, sources: &[(Node, SourceCheck)], ops: &[Node]) -> Vec<ChainWarning> {
        let mut warnings = Vec::new();
        for &(source, check) in sources {
            let call = self.text(source).to_string();
            match check {
                SourceCheck::Stateful => warnings.push(ChainWarning::StatefulSource { call }),
                SourceCheck::Rereads => warnings.push(ChainWarning::RereadsResource { call }),
                SourceCheck::Fresh if self.name(source) == "iterate" && self.iterate_has_state(source) => {
                    warnings.push(ChainWarning::StatefulSource { call })
                }
                SourceCheck::Fresh => {}
            }
        }
        let parallel = sources.first().is_some_and(|(root, _)| self.name(*root) == "parallelStream")
            || ops.iter().any(|op| self.name(*op) == "parallel");
        if parallel {
            warnings.push(ChainWarning::ParallelRemoved);
        }
        warnings
    }

    /// A seed function that is a method reference, or a lambda reading
    /// anything besides its own parameters and locals, may yield new
    /// elements when the chain is evaluated again.
    fn iterate_has_state(&self, root: Node) -> bool {
        let Some(args) = root.child_by_field_name("arguments") else { return false };
        let mut cursor = args.walk();
        args.named_children(&mut cursor).any(|arg| match arg.kind() {
            "method_reference" => true,
            "lambda_expression" => {
                let mut own = Vec::new();
                collect_declared(arg, &mut own);
                let mut used = Vec::new();
                if let Some(body) = arg.child_by_field_name("body") {
                    collect_uses(body, &mut used);
                }
                used.iter().any(|u| {
                    matches!(u.kind(), "this" | "super") || !own.iter().any(|d| self.text(*d) == self.text(*u))
                })
            }
            _ => false,
        })
    }
}

/// Names a lambda declares: its parameters and, in a block body, its
/// locals and nested lambdas' parameters.
fn collect_declared<'t>(n: Node<'t>, out: &mut Vec<Node<'t>>) {
    match n.kind() {
        "lambda_expression" => {
            if let Some(params) = n.child_by_field_name("parameters") {
                collect_parameter_names(params, out);
            }
        }
        "variable_declarator" | "formal_parameter" | "catch_formal_parameter" | "enhanced_for_statement" => {
            out.extend(n.child_by_field_name("name"));
        }
        _ => {}
    }
    let mut cursor = n.walk();
    for child in n.children(&mut cursor) {
        collect_declared(child, out);
    }
}

/// Untyped lambda parameters; typed ones are `formal_parameter`s, which the
/// walk in [`collect_declared`] reaches anyway.
fn collect_parameter_names<'t>(params: Node<'t>, out: &mut Vec<Node<'t>>) {
    match params.kind() {
        "identifier" => out.push(params),
        "inferred_parameters" => {
            let mut cursor = params.walk();
            out.extend(params.named_children(&mut cursor).filter(|p| p.kind() == "identifier"));
        }
        _ => {}
    }
}

/// Variable identifiers (not member names after a `.`), plus `this` / `super`.
fn collect_uses<'t>(n: Node<'t>, out: &mut Vec<Node<'t>>) {
    match n.kind() {
        "this" | "super" => out.push(n),
        "identifier" => {
            let member = n.parent().is_some_and(|p| {
                (p.kind() == "method_invocation" && p.child_by_field_name("name") == Some(n) && object_of(p).is_some())
                    || (p.kind() == "field_access" && p.child_by_field_name("field") == Some(n))
            });
            if !member {
                out.push(n);
            }
        }
        _ => {}
    }
    let mut cursor = n.walk();
    for child in n.children(&mut cursor) {
        collect_uses(child, out);
    }
}
