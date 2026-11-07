use super::search::{Finder, TYPE_BODIES, TYPE_DECLARATIONS};
use super::{FrameKind, FrameShape};
use tree_sitter::Node;

impl Finder<'_, '_> {
    /// Frame shape from the scope outwards; `Err` for frames the evaluator
    /// cannot compile lambdas in.
    pub(super) fn frame(&self, scope: Node) -> Result<FrameShape, FrameKind> {
        let mut shape = FrameShape::default();
        let mut past_method = false;
        // A static member or static nested type cannot see the type
        // parameters of the types around it.
        let mut sees_outer_params = true;
        let mut cur = Some(scope);
        while let Some(n) = cur {
            let kind = n.kind();
            if matches!(kind, "method_declaration" | "constructor_declaration") && !past_method {
                self.push_type_params(n, &mut shape.type_params);
                past_method = true;
                sees_outer_params = !self.is_static(n);
            } else if matches!(kind, "field_declaration" | "constant_declaration" | "static_initializer")
                && !past_method
            {
                past_method = true;
                sees_outer_params = kind == "field_declaration" && !self.is_static(n);
            } else if kind == "class_body"
                && n.parent().is_some_and(|p| matches!(p.kind(), "object_creation_expression" | "enum_constant"))
            {
                return Err(FrameKind::Anonymous);
            } else if TYPE_DECLARATIONS.contains(&kind) {
                let parent = n.parent().map_or("program", |p| p.kind());
                let name = n.child_by_field_name("name").map_or("", |c| self.text(c));
                if parent != "program" && !TYPE_BODIES.contains(&parent) {
                    return Err(FrameKind::Local);
                }
                if parent == "program" && name != self.file_stem {
                    return Err(FrameKind::SecondaryTopLevel);
                }
                if shape.class_path.is_empty() {
                    shape.record = kind == "record_declaration";
                }
                shape.class_path.push(name.into());
                if sees_outer_params {
                    self.push_type_params(n, &mut shape.type_params);
                }
                // Nested records, enums and interfaces, and types nested in an interface, are implicitly static.
                sees_outer_params &= kind == "class_declaration" && parent != "interface_body" && !self.is_static(n);
                past_method = true;
            } else if kind == "program" {
                let mut cursor = n.walk();
                shape.package =
                    n.named_children(&mut cursor).find(|c| c.kind() == "package_declaration").and_then(|p| {
                        let mut cursor = p.walk();
                        let name = p
                            .named_children(&mut cursor)
                            .find(|c| matches!(c.kind(), "scoped_identifier" | "identifier"));
                        name.map(|c| self.text(c).to_string())
                    });
            }
            cur = n.parent();
        }
        shape.class_path.reverse();
        Ok(shape)
    }

    fn push_type_params(&self, decl: Node, out: &mut Vec<(String, Option<String>)>) {
        let Some(params) = decl.child_by_field_name("type_parameters") else { return };
        let mut cursor = params.walk();
        for param in params.named_children(&mut cursor).filter(|p| p.kind() == "type_parameter") {
            let mut cursor = param.walk();
            let mut children = param.named_children(&mut cursor);
            let Some(name) = children.find(|c| c.kind() == "type_identifier") else { continue };
            let bound = children.find(|c| c.kind() == "type_bound").and_then(|b| {
                let mut cursor = b.walk();
                let first =
                    b.named_children(&mut cursor).find(|c| c.kind() != "annotation" && c.kind() != "marker_annotation");
                first.map(|ty| self.erasure(ty))
            });
            out.push((self.text(name).into(), bound));
        }
    }

    fn is_static(&self, decl: Node) -> bool {
        let mut cursor = decl.walk();
        let Some(mods) = decl.children(&mut cursor).find(|c| c.kind() == "modifiers") else { return false };
        let mut cursor = mods.walk();
        mods.children(&mut cursor).any(|c| self.text(c) == "static")
    }

    fn erasure(&self, ty: Node) -> String {
        let raw = if ty.kind() == "generic_type" { ty.named_child(0).unwrap_or(ty) } else { ty };
        self.text(raw).into()
    }
}
