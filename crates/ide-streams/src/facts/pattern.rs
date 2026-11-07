use super::Adjustment;
use super::rules::{Collector, Ctx, is_variable_use};
use crate::Rejection;
use tree_sitter::Node;

impl<'t> Collector<'_, 't> {
    /// Rule 6: `o instanceof T q` becomes `o instanceof T`, and each use of
    /// `q` in the same lambda (or the whole chain outside lambdas) `((T) o)`.
    pub(super) fn pattern(&mut self, test: Node<'t>, ctx: Ctx) {
        if test.child_by_field_name("pattern").is_some() {
            return self.block(Rejection::PatternNotRewritable);
        }
        let (Some(name), Some(ty)) = (test.child_by_field_name("name"), test.child_by_field_name("right")) else {
            return;
        };
        let Some(left) = test.child_by_field_name("left").filter(|l| l.kind() == "identifier") else {
            return self.block(Rejection::PatternNotRewritable);
        };
        let (var, ty) = (self.text(name), self.text(ty));
        let subject = match ctx {
            Ctx::Lambda => self.static_field(self.text(left)),
            Ctx::Chain | Ctx::Nested => None,
        };
        let subject = subject.unwrap_or_else(|| self.text(left).into());
        let adjustment = Adjustment::PatternRewritten { name: var.into() };
        self.edit_range(left.end_byte(), name.end_byte(), format!(" instanceof {ty}"), adjustment.clone());
        let mut uses = Vec::new();
        self.uses_of(self.pattern_region(test), var, name, &mut uses);
        for u in uses {
            self.edit_range(u.start_byte(), u.end_byte(), format!("(({ty}) {subject})"), adjustment.clone());
        }
    }

    /// The innermost lambda of the chain around `n`, or the chain itself.
    fn pattern_region(&self, n: Node<'t>) -> Node<'t> {
        let mut cur = n;
        while let Some(p) = cur.parent().filter(|_| cur != self.chain) {
            if p.kind() == "lambda_expression" {
                return p;
            }
            cur = p;
        }
        self.chain
    }

    fn uses_of(&self, n: Node<'t>, var: &str, decl: Node<'t>, out: &mut Vec<Node<'t>>) {
        if n.kind() == "identifier" && n != decl && self.text(n) == var && is_variable_use(n) {
            out.push(n);
        }
        let mut cursor = n.walk();
        for child in n.children(&mut cursor) {
            self.uses_of(child, var, decl, out);
        }
    }
}
