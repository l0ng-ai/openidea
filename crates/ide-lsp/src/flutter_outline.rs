//! The Dart analysis server's Flutter outline (`dart/textDocument/publishFlutterOutline`):
//! a file's declarations with the widgets built inside them, in source order.

use crate::convert::Conv;
use ide_core::{OutlineItem, SymbolKind};
use lsp_types as lsp;
use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize)]
pub(crate) struct Params {
    pub uri: String,
    pub outline: Node,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Node {
    kind: String,
    label: Option<String>,
    class_name: Option<String>,
    variable_name: Option<String>,
    attributes: Option<Vec<Attribute>>,
    dart_element: Option<Element>,
    range: lsp::Range,
    children: Option<Vec<Node>>,
}

#[derive(Deserialize)]
struct Attribute {
    name: String,
    label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Element {
    name: String,
    kind: String,
    range: Option<lsp::Range>,
    parameters: Option<String>,
    type_parameters: Option<String>,
    return_type: Option<String>,
}

/// The items below the compilation unit; `None` when no widget is built in the file, whose
/// structure is then the ordinary one.
pub(crate) fn items(conv: &Conv, path: &Path, root: Node) -> Option<Vec<OutlineItem>> {
    let children = root.children?;
    children.iter().any(has_widget).then(|| children.into_iter().map(|n| item(conv, path, n)).collect())
}

fn has_widget(node: &Node) -> bool {
    node.dart_element.is_none() || node.children.iter().flatten().any(has_widget)
}

fn item(conv: &Conv, path: &Path, node: Node) -> OutlineItem {
    let range = conv.range(path, node.range);
    let detail = widget_detail(&node);
    let children = node.children.unwrap_or_default().into_iter().map(|n| item(conv, path, n)).collect();
    let (name, detail, kind, selection_range) = match node.dart_element {
        Some(e) => (
            format!("{}{}{}", e.name, e.type_parameters.unwrap_or_default(), e.parameters.unwrap_or_default()),
            e.return_type.filter(|t| !t.is_empty()).map(|t| format!("→ {t}")),
            element_kind(&e.kind),
            e.range.map_or(range, |r| conv.range(path, r)),
        ),
        None => (node.class_name.or(node.label).unwrap_or(node.kind), detail, SymbolKind::Widget, range),
    };
    OutlineItem { name, detail, kind, range, selection_range, children, visibility: None }
}

/// What follows a widget's class, as the Flutter plugin's outline shows it: the variable holding
/// it, a generic node's expression, then its attributes (`Text 'Hi'`, `Icon icon: add, size: 24`).
fn widget_detail(node: &Node) -> Option<String> {
    let mut parts: Vec<String> = node.variable_name.iter().cloned().collect();
    if node.kind == "GENERIC" {
        parts.extend(node.label.iter().cloned());
    }
    match node.attributes.as_deref().unwrap_or_default() {
        [only] if matches!(only.name.as_str(), "text" | "icon") => parts.push(only.label.clone()),
        attributes if !attributes.is_empty() => parts.push(
            attributes
                .iter()
                .map(|a| if a.name == "data" { a.label.clone() } else { format!("{}: {}", a.name, a.label) })
                .collect::<Vec<_>>()
                .join(", "),
        ),
        _ => {}
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

fn element_kind(kind: &str) -> SymbolKind {
    match kind {
        "CLASS" | "CLASS_TYPE_ALIAS" | "EXTENSION" | "EXTENSION_TYPE" => SymbolKind::Class,
        "MIXIN" => SymbolKind::Interface,
        "ENUM" => SymbolKind::Enum,
        "ENUM_CONSTANT" => SymbolKind::EnumMember,
        "CONSTRUCTOR" => SymbolKind::Constructor,
        "METHOD" => SymbolKind::Method,
        "FUNCTION" => SymbolKind::Function,
        "FIELD" => SymbolKind::Field,
        "GETTER" | "SETTER" => SymbolKind::Property,
        "TOP_LEVEL_VARIABLE" => SymbolKind::Variable,
        "FUNCTION_TYPE_ALIAS" | "TYPE_ALIAS" => SymbolKind::TypeAlias,
        _ => SymbolKind::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::{DocText, Encoding};
    use ide_core::{Pos, Range};
    use serde_json::{Value, json};
    use std::sync::Arc;

    fn range(line: u32, from: u32, to: u32) -> Value {
        json!({ "start": { "line": line, "character": from }, "end": { "line": line, "character": to } })
    }

    fn element(kind: &str, name: &str, extra: Value, children: Value) -> Value {
        let mut e = json!({ "kind": kind, "name": name, "range": range(1, 9, 14) });
        e.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        json!({ "kind": "DART_ELEMENT", "dartElement": e, "range": range(0, 0, 40), "codeRange": range(0, 0, 40), "children": children })
    }

    fn widget(kind: &str, class: &str, extra: Value) -> Value {
        let mut w = json!({ "kind": kind, "className": class, "range": range(3, 4, 12), "codeRange": range(3, 4, 12) });
        w.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        w
    }

    fn convert(conv: &Conv, children: Value) -> Option<Vec<OutlineItem>> {
        let root: Node = serde_json::from_value(element("COMPILATION_UNIT", "<unit>", json!({}), children)).unwrap();
        items(conv, Path::new("/p/a.dart"), root)
    }

    fn utf16() -> Conv<'static> {
        Conv::new(Encoding::Utf16, |_: &Path| None)
    }

    #[test]
    fn declarations_keep_their_widgets_in_source_order() {
        let outline = json!([element(
            "METHOD",
            "build",
            json!({ "parameters": "(BuildContext context)", "returnType": "Widget" }),
            json!([widget("NEW_INSTANCE", "Scaffold", json!({})), widget("NEW_INSTANCE", "Align", json!({}))]),
        )]);
        let items = convert(&utf16(), outline).unwrap();
        let build = &items[0];
        assert_eq!(build.name, "build(BuildContext context)");
        assert_eq!(build.detail.as_deref(), Some("→ Widget"));
        assert_eq!(build.kind, SymbolKind::Method);
        assert_eq!(build.selection_range, Range::new(Pos::new(1, 9), Pos::new(1, 14)));
        let names: Vec<_> = build.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Scaffold", "Align"]);
        assert_eq!(build.children[0].kind, SymbolKind::Widget);
        assert_eq!(build.children[0].selection_range, build.children[0].range);
    }

    #[test]
    fn widget_details_read_like_the_flutter_plugin() {
        let attr = |name: &str, label: &str| json!({ "name": name, "label": label });
        let detail = |w: Value| convert(&utf16(), json!([w])).unwrap().remove(0).detail;
        let w = widget("NEW_INSTANCE", "Text", json!({ "attributes": [attr("data", "'Hi'")] }));
        assert_eq!(detail(w).as_deref(), Some("'Hi'"));
        let w = widget("NEW_INSTANCE", "Icon", json!({ "attributes": [attr("icon", "Icons.add")] }));
        assert_eq!(detail(w).as_deref(), Some("Icons.add"));
        let w =
            widget("NEW_INSTANCE", "Icon", json!({ "attributes": [attr("icon", "Icons.add"), attr("size", "24")] }));
        assert_eq!(detail(w).as_deref(), Some("icon: Icons.add, size: 24"));
        assert_eq!(detail(widget("VARIABLE", "Text", json!({ "variableName": "title" }))).as_deref(), Some("title"));
        assert_eq!(detail(widget("GENERIC", "Widget", json!({ "label": "_footer()" }))).as_deref(), Some("_footer()"));
        assert_eq!(detail(widget("NEW_INSTANCE", "Column", json!({}))), None);
    }

    #[test]
    fn a_file_without_widgets_has_no_flutter_outline() {
        let plain =
            json!([element("CLASS", "Plain", json!({}), json!([element("METHOD", "run", json!({}), json!([]))]))]);
        assert!(convert(&utf16(), plain).is_none());
        assert!(convert(&utf16(), json!([])).is_none());
    }

    #[test]
    fn positions_become_utf16_columns() {
        let text = Arc::new(DocText::new("\n\n\n🙂🙂 Text('x')\n"));
        let conv = Conv::new(Encoding::Utf8, move |_: &Path| Some(text.clone()));
        let w = json!({ "kind": "NEW_INSTANCE", "className": "Text", "range": range(3, 9, 13), "codeRange": range(3, 9, 13) });
        let item = convert(&conv, json!([w])).unwrap().remove(0);
        assert_eq!(item.range, Range::new(Pos::new(3, 5), Pos::new(3, 9)));
    }
}
