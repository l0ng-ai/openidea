//! `<script>` regions of Vue SFCs and HTML documents (see
//! `docs/vue-ts-semantic-index.md`): located with the HTML grammar's
//! `script_element` nodes, then parsed with the TS/JS grammar the block's
//! `lang` attribute picks. Mirrors `web.rs`'s `css_regions` for `<style>`.
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
        "" | "js" | "javascript" => Some("javascript"),
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
                        match name {
                            "lang" => match lang_grammar(&value) {
                                Some(g) => lang = g,
                                None => skip = true,
                            },
                            "type" if !is_js_type(&value) => skip = true,
                            _ => {}
                        }
                    }
                }
                "raw_text" if !skip => {
                    let base = ch.start_byte();
                    let before = &text[..base];
                    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
                    out.push(ScriptRegion {
                        base,
                        base_line: before.matches('\n').count() as u32,
                        base_col: text[line_start..base].encode_utf16().count() as u32,
                        language: LanguageId::new(lang),
                        text: text[base..ch.end_byte()].to_string(),
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
fn attribute<'t>(attr: Node<'t>, text: &'t str) -> (&'t str, String) {
    let mut c = attr.walk();
    let mut name = "";
    let mut value = String::new();
    for ch in attr.children(&mut c) {
        match ch.kind() {
            "attribute_name" => name = ch.utf8_text(text.as_bytes()).unwrap_or(""),
            // The quoted value includes the quotes; strip them.
            "quoted_attribute_value" => {
                let v = ch.utf8_text(text.as_bytes()).unwrap_or("");
                value = v.trim_matches(|q| q == '"' || q == '\'').to_string();
            }
            _ => {}
        }
    }
    (name, value)
}
