use super::locals::visible_local;
use super::rules::Collector;
use super::{Capture, TypeQuery};
use crate::qualify::erasure;
use tree_sitter::Node;

impl<'t> Collector<'_, 't> {
    /// Rule 3: a read in a lambda body of a frame variable declared with
    /// type arguments or `var`. The alias is chosen in `normalize`, once
    /// jdtls has answered for `var`.
    pub(super) fn capture_use(&mut self, n: Node<'t>) {
        let name = self.text(n);
        let Some(local) = visible_local(self.t, n, self.member, name) else { return };
        // Declared inside the chain: it exists only while the chain runs.
        if self.chain.byte_range().contains(&local.name.start_byte()) {
            return;
        }
        let Some(ty) = local.ty else { return };
        let is_var = self.text(ty) == "var";
        if !is_var && !self.text(ty).contains('<') {
            return;
        }
        let index = match self.facts.captures.iter().position(|c| c.name == name) {
            Some(i) => i,
            None => {
                let capture =
                    if is_var { self.var_capture(name, local.name, local.value) } else { self.typed_capture(name, ty) };
                let Some(capture) = capture else { return };
                self.facts.captures.push(capture);
                self.facts.captures.len() - 1
            }
        };
        let base = self.chain.start_byte();
        self.facts.captures[index].uses.push((n.start_byte() - base, n.end_byte() - base));
    }

    fn typed_capture(&mut self, name: &str, ty: Node<'t>) -> Option<Capture> {
        let declared = self.type_text(ty)?;
        let erasure = Some(erasure(&declared));
        Some(Capture { name: name.into(), declared: Some(declared), erasure, uses: vec![], query: None })
    }

    fn var_capture(&mut self, name: &str, decl: Node<'t>, value: Option<Node<'t>>) -> Option<Capture> {
        let class =
            value.filter(|v| v.kind() == "object_creation_expression").and_then(|v| v.child_by_field_name("type"));
        let erasure = match class {
            Some(class) => Some(erasure(&self.type_text(class)?)),
            None => None,
        };
        // jdtls hover spells types by simple name, which a record frame cannot use.
        let query = (!self.frame.record).then(|| {
            let id = self.facts.queries.len() as u32;
            self.facts.queries.push(TypeQuery { id, name: name.into(), pos: self.t.pos(decl.start_byte()) });
            id
        });
        Some(Capture { name: name.into(), declared: None, erasure, uses: vec![], query })
    }
}
