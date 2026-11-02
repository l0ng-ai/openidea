//! Syntactic presentation of the primary top-level JVM declaration.
use crate::{Snapshot, StructureResult, StructureService};
use ide_core::CancellationToken;
use serde::{Deserialize, Serialize};
use specta::Type;
use tree_sitter::Node;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JvmTypeKind {
    Class,
    AbstractClass,
    Interface,
    Enum,
    Record,
    Annotation,
    Exception,
    Object,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JvmPresentation {
    pub kind: Option<JvmTypeKind>,
    pub spring_boot: bool,
    pub runnable: bool,
}

fn text<'a>(node: Node, source: &'a str) -> &'a str {
    source.get(node.byte_range()).unwrap_or_default()
}

fn children(node: Node) -> Vec<Node> {
    node.children(&mut node.walk()).collect()
}

fn descendant(node: Node<'_>, predicate: &impl Fn(Node<'_>) -> bool) -> bool {
    predicate(node) || node.children(&mut node.walk()).any(|n| descendant(n, predicate))
}

fn keyword(node: Node, source: &str, word: &str) -> bool {
    descendant(node, &|n| {
        n.child_count() == 0 && (n.kind() == word || n.kind().ends_with("_modifier") && text(n, source) == word)
    })
}

fn annotation(node: Node, source: &str, name: &str) -> bool {
    node.named_children(&mut node.walk()).any(|n| {
        if !matches!(n.kind(), "annotation" | "marker_annotation") {
            return false;
        }
        if let Some(id) = n.child_by_field_name("name") {
            return text(id, source).rsplit('.').next() == Some(name);
        }
        // Kotlin: @ -> constructor_invocation -> user_type (or type -> user_type).
        let mut current = n;
        while let Some(first) = current.named_children(&mut current.walk()).next() {
            if matches!(first.kind(), "use_site_target") {
                return false;
            }
            if first.kind() == "user_type" {
                let ids: Vec<_> =
                    first.named_children(&mut first.walk()).filter(|c| c.kind() == "identifier").collect();
                return ids.last().is_some_and(|id| text(*id, source) == name);
            }
            current = first;
        }
        false
    })
}

fn exception_base(node: Node, source: &str) -> bool {
    if matches!(node.kind(), "type_arguments" | "value_arguments" | "explicit_delegation") {
        return false;
    }
    if matches!(node.kind(), "type_identifier" | "user_type" | "scoped_type_identifier") {
        let name = if node.kind() == "user_type" || node.kind() == "scoped_type_identifier" {
            node.named_children(&mut node.walk())
                .filter(|n| matches!(n.kind(), "identifier" | "type_identifier"))
                .last()
                .map(|n| text(n, source))
                .unwrap_or_default()
        } else {
            text(node, source)
        };
        return name.ends_with("Exception") || name.ends_with("Error") || name == "Throwable";
    }
    node.named_children(&mut node.walk()).any(|n| exception_base(n, source))
}

fn members(node: Node<'_>) -> Vec<Node<'_>> {
    let mut out = Vec::new();
    for child in node.named_children(&mut node.walk()) {
        if matches!(child.kind(), "method_declaration" | "function_declaration") {
            out.push(child);
        }
        if matches!(child.kind(), "companion_object" | "class_body" | "enum_body_declarations") {
            out.extend(members(child));
        }
    }
    out
}

fn is_type(node: Node) -> bool {
    matches!(
        node.kind(),
        "class_declaration"
            | "interface_declaration"
            | "enum_declaration"
            | "record_declaration"
            | "annotation_type_declaration"
            | "object_declaration"
    )
}

impl StructureService {
    /// Only top-level declarations participate; the filename-matching declaration
    /// wins, otherwise the first type does. Strings/comments never supply evidence.
    pub fn jvm_presentation(
        &self,
        snap: &Snapshot,
        stem: &str,
        cancel: &CancellationToken,
    ) -> StructureResult<JvmPresentation> {
        self.run(snap, cancel, |cx| {
            if !matches!(cx.grammar, "java" | "kotlin") {
                return Ok(JvmPresentation::default());
            }
            let top = cx.tree.root_node();
            let types: Vec<_> = top.named_children(&mut top.walk()).filter(|n| is_type(*n)).collect();
            let Some(node) = types
                .iter()
                .find(|n| n.child_by_field_name("name").is_some_and(|id| text(id, snap.text) == stem))
                .or(types.first())
                .copied()
            else {
                return Ok(JvmPresentation::default());
            };
            let parts = children(node);
            let modifiers = parts.iter().find(|n| n.kind() == "modifiers").copied();
            let has = |word| modifiers.is_some_and(|m| keyword(m, snap.text, word));
            let supertype = parts.iter().find(|n| matches!(n.kind(), "superclass" | "delegation_specifiers"));
            let exception = supertype.is_some_and(|s| exception_base(*s, snap.text));
            let kind = match node.kind() {
                "annotation_type_declaration" => JvmTypeKind::Annotation,
                "interface_declaration" => JvmTypeKind::Interface,
                "enum_declaration" => JvmTypeKind::Enum,
                "record_declaration" => JvmTypeKind::Record,
                "object_declaration" => JvmTypeKind::Object,
                _ if has("annotation") => JvmTypeKind::Annotation,
                _ if has("enum") => JvmTypeKind::Enum,
                _ if parts.iter().any(|n| n.kind() == "interface") => JvmTypeKind::Interface,
                _ if exception => JvmTypeKind::Exception,
                _ if has("abstract") => JvmTypeKind::AbstractClass,
                _ => JvmTypeKind::Class,
            };
            let spring_boot = modifiers.is_some_and(|m| annotation(m, snap.text, "SpringBootApplication"));
            let body = parts.iter().find(|n| n.kind() == "class_body");
            let runnable = body.is_some_and(|b| {
                members(*b).into_iter().any(|n| {
                    if !matches!(n.kind(), "method_declaration" | "function_declaration")
                        || !n.child_by_field_name("name").is_some_and(|id| text(id, snap.text) == "main")
                    {
                        return false;
                    }
                    if cx.grammar == "kotlin" {
                        return children(n)
                            .iter()
                            .any(|m| m.kind() == "modifiers" && annotation(*m, snap.text, "JvmStatic"));
                    }
                    let modifiers = children(n).into_iter().find(|m| m.kind() == "modifiers");
                    let params = n.child_by_field_name("parameters");
                    modifiers.is_some_and(|m| keyword(m, snap.text, "static") && keyword(m, snap.text, "public"))
                        && n.child_by_field_name("type").is_some_and(|t| text(t, snap.text) == "void")
                        && params.is_some_and(|p| {
                            let args: Vec<_> = p.named_children(&mut p.walk()).collect();
                            args.len() == 1
                                && descendant(args[0], &|t| {
                                    t.kind() == "type_identifier"
                                        && matches!(text(t, snap.text), "String" | "java.lang.String")
                                })
                                && (keyword(args[0], snap.text, "[") || keyword(args[0], snap.text, "..."))
                        })
                })
            });
            Ok(JvmPresentation { kind: Some(kind), spring_boot, runnable })
        })
    }
}
