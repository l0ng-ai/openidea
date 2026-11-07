use crate::FrameShape;
use crate::chain::{TYPE_BODIES, TYPE_DECLARATIONS};
use ide_syntax::SyntaxTree;
use std::collections::HashSet;
use tree_sitter::Node;

/// What one enclosing class declares itself; inherited members are unknown.
pub(super) struct ClassMembers<'t> {
    /// The class path down to this class (`Sample.Inner`).
    pub(super) path: String,
    /// Field name and whether it is static.
    pub(super) fields: Vec<(&'t str, bool)>,
    pub(super) methods: Vec<Method<'t>>,
}

pub(super) struct Method<'t> {
    pub(super) name: &'t str,
    pub(super) is_static: bool,
    pub(super) private: bool,
}

/// The enclosing classes of `from`, innermost first.
pub(super) fn enclosing_classes<'t>(t: &SyntaxTree<'t>, from: Node<'t>, frame: &FrameShape) -> Vec<ClassMembers<'t>> {
    let mut decls = Vec::new();
    let mut cur = from.parent();
    while let Some(n) = cur {
        if TYPE_DECLARATIONS.contains(&n.kind()) {
            decls.push(n);
        }
        cur = n.parent();
    }
    debug_assert_eq!(decls.len(), frame.class_path.len(), "frame shape built from the same ancestors");
    decls
        .into_iter()
        .enumerate()
        .map(|(depth, decl)| {
            let end = frame.class_path.len().saturating_sub(depth);
            let mut class = ClassMembers { path: frame.class_path[..end].join("."), fields: vec![], methods: vec![] };
            if let Some(body) = decl.child_by_field_name("body") {
                collect_members(t, decl.kind() == "interface_declaration", body, &mut class);
            }
            if let Some(components) = decl.child_by_field_name("parameters") {
                let mut cursor = components.walk();
                for c in components.named_children(&mut cursor) {
                    class.fields.extend(c.child_by_field_name("name").map(|n| (&t.text[n.byte_range()], false)));
                }
            }
            class
        })
        .collect()
}

fn collect_members<'t>(t: &SyntaxTree<'t>, interface: bool, body: Node<'t>, class: &mut ClassMembers<'t>) {
    let mut cursor = body.walk();
    for member in body.named_children(&mut cursor) {
        let (is_static, private) = modifiers(t, member);
        match member.kind() {
            "field_declaration" | "constant_declaration" => {
                let mut cursor = member.walk();
                for d in member.children_by_field_name("declarator", &mut cursor) {
                    let name = d.child_by_field_name("name").map(|n| &t.text[n.byte_range()]);
                    class.fields.extend(name.map(|n| (n, is_static || interface)));
                }
            }
            "enum_constant" => {
                class.fields.extend(member.child_by_field_name("name").map(|n| (&t.text[n.byte_range()], true)));
            }
            "method_declaration" => {
                if let Some(name) = member.child_by_field_name("name") {
                    class.methods.push(Method { name: &t.text[name.byte_range()], is_static, private });
                }
            }
            "enum_body_declarations" => collect_members(t, interface, member, class),
            _ => {}
        }
    }
}

/// `(static, private)` from a member's modifiers.
fn modifiers(t: &SyntaxTree, member: Node) -> (bool, bool) {
    let mut cursor = member.walk();
    let Some(mods) = member.children(&mut cursor).find(|c| c.kind() == "modifiers") else { return (false, false) };
    let mut cursor = mods.walk();
    let words: Vec<_> = mods.children(&mut cursor).map(|c| &t.text[c.byte_range()]).collect();
    (words.contains(&"static"), words.contains(&"private"))
}

/// The class member (method, initializer, field) that `scope` lies in.
pub(super) fn member_of(scope: Node) -> Node {
    let mut cur = scope;
    while let Some(p) = cur.parent().filter(|p| !TYPE_BODIES.contains(&p.kind())) {
        cur = p;
    }
    cur
}

/// Every name `member` declares anywhere, whatever its scope: a name that
/// may be a local is never qualified as a static, which could change its value.
pub(super) fn declared_names<'t>(t: &SyntaxTree<'t>, member: Node<'t>) -> HashSet<&'t str> {
    let mut names = Vec::new();
    declarations(member, &mut names);
    names.into_iter().map(|n| &t.text[n.byte_range()]).collect()
}

/// The name nodes of every variable declared in `n`, nested scopes included.
pub(super) fn declarations<'t>(n: Node<'t>, out: &mut Vec<Node<'t>>) {
    match n.kind() {
        "variable_declarator"
        | "formal_parameter"
        | "catch_formal_parameter"
        | "enhanced_for_statement"
        | "resource"
        | "instanceof_expression" => out.extend(n.child_by_field_name("name")),
        "lambda_expression" => match n.child_by_field_name("parameters") {
            Some(p) if p.kind() == "identifier" => out.push(p),
            Some(p) if p.kind() == "inferred_parameters" => {
                let mut cursor = p.walk();
                out.extend(p.named_children(&mut cursor).filter(|c| c.kind() == "identifier"));
            }
            _ => {}
        },
        "type_pattern" | "record_pattern_component" => {
            let mut cursor = n.walk();
            out.extend(n.named_children(&mut cursor).filter(|c| c.kind() == "identifier"));
        }
        _ => {}
    }
    let mut cursor = n.walk();
    for child in n.children(&mut cursor) {
        declarations(child, out);
    }
}
