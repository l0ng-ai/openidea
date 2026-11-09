//! Inline TS/JS `<script>` regions located with the HTML grammar's
//! `script_element` nodes. The block's `lang` attribute selects the grammar.
//!
//! Blocks whose `type` attribute names anything but JavaScript are skipped
//! (`application/json`, `text/template`, `importmap`, …), as are unknown
//! `lang` values.

use super::web::walk;
use crate::ScriptRegion;
use ide_core::LanguageId;
use tree_sitter::{Node, Tree};

/// The TS/JS grammar a `lang` attribute value names; `None` skips the block.
fn lang_grammar(value: &str) -> Option<&'static str> {
    match value {
        "ts" | "typescript" => Some("typescript"),
        "tsx" => Some("tsx"),
        "" | "js" | "jsx" | "javascript" => Some("javascript"),
        _ => None,
    }
}

/// `true` when a `type` attribute value names JavaScript (or is absent).
fn is_js_type(value: &str) -> bool {
    matches!(value, "" | "module" | "text/javascript" | "application/javascript")
}

/// The `<script>` regions of a document parsed with the HTML grammar,
/// in document order. `base` is each block's byte offset into the document.
pub(crate) fn script_regions(tree: &Tree, text: &str) -> Vec<ScriptRegion> {
    let mut out = Vec::new();
    walk(tree.root_node(), &mut |n| {
        if n.kind() != "script_element" {
            return true;
        }
        let mut lang = "javascript";
        let mut skip = false;
        let mut c = n.walk();
        for ch in n.children(&mut c) {
            match ch.kind() {
                // The start tag precedes the raw text, so the attributes are
                // known before the region is taken.
                "start_tag" => {
                    let mut c2 = ch.walk();
                    for attr in ch.children(&mut c2) {
                        if attr.kind() != "attribute" {
                            continue;
                        }
                        let (name, value) = attribute(attr, text);
                        match name.to_ascii_lowercase().as_str() {
                            "lang" => match lang_grammar(&value.to_ascii_lowercase()) {
                                Some(g) => lang = g,
                                None => skip = true,
                            },
                            "type" if !is_js_type(&value.trim().to_ascii_lowercase()) => skip = true,
                            "src" => skip = true,
                            _ => {}
                        }
                    }
                }
                "raw_text" if !skip => {
                    out.push(ScriptRegion {
                        base: ch.start_byte(),
                        language: LanguageId::new(lang),
                        text: text[ch.start_byte()..ch.end_byte()].to_string(),
                    });
                }
                _ => {}
            }
        }
        false // the raw text is not markup
    });
    out
}

/// An attribute's `(name, value)`; a bare attribute (`setup`) has an empty value.
fn attribute<'t>(attr: Node<'t>, text: &'t str) -> (&'t str, &'t str) {
    let mut c = attr.walk();
    let mut name = "";
    let mut value = "";
    for ch in attr.children(&mut c) {
        match ch.kind() {
            "attribute_name" => name = ch.utf8_text(text.as_bytes()).unwrap_or(""),
            "quoted_attribute_value" => {
                value = ch.named_child(0).and_then(|v| v.utf8_text(text.as_bytes()).ok()).unwrap_or("");
            }
            "attribute_value" => value = ch.utf8_text(text.as_bytes()).unwrap_or(""),
            _ => {}
        }
    }
    (name, value)
}
