//! Web references that no language server resolves: HTML `class` / `id`
//! attributes to the CSS selectors that style them, `href="#id"` to the element
//! with that id, and `var(--x)` to the custom property's declarations.
//!
//! Definitions (`.card`, `#main`, `--accent`) come from stylesheets and the
//! `<style>` elements of HTML documents and feed the symbol index (see
//! [`super::Syntax::tags`]), so a lookup is an exact index query.

use super::lines::{LineIndex, byte_at};
use super::{Grammar, parse};
use crate::SymbolTag;
use ide_core::{Pos, Range, SymbolKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use tree_sitter::{Node, Tree};

/// Index symbol kinds of web definitions; names carry the CSS sigil.
pub const CSS_CLASS: SymbolKind = SymbolKind::Class;
pub const CSS_ID: SymbolKind = SymbolKind::Field;
pub const CSS_VARIABLE: SymbolKind = SymbolKind::Variable;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WebReferenceKind {
    /// A class in a `class` / `className` attribute: `.name` selectors.
    Class,
    /// An `id` attribute value: `#name` selectors.
    Id,
    /// `href="#name"`: the element with that id in the same document.
    Anchor,
    /// `var(--name)`: the custom property's declarations.
    CssVariable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebReference {
    pub kind: WebReferenceKind,
    /// Without sigil: `card`, `main`, `--accent`.
    pub name: String,
    pub range: Range,
}

impl WebReference {
    /// The index symbol a reference resolves to: `.card`, `#main`, `--accent`.
    pub fn symbol(&self) -> Option<(String, SymbolKind)> {
        match self.kind {
            WebReferenceKind::Class => Some((format!(".{}", self.name), CSS_CLASS)),
            WebReferenceKind::Id => Some((format!("#{}", self.name), CSS_ID)),
            WebReferenceKind::CssVariable => Some((self.name.clone(), CSS_VARIABLE)),
            WebReferenceKind::Anchor => None,
        }
    }
}

/// Grammars whose documents carry web definitions and references.
pub(crate) fn is_web_grammar(name: &str) -> bool {
    matches!(name, "css" | "html")
}

/// Stylesheet text embedded in a document: `(byte offset, text)`.
fn css_regions<'t>(grammar: &str, tree: &Tree, text: &'t str) -> Vec<(usize, &'t str)> {
    match grammar {
        "css" => vec![(0, text)],
        "html" => {
            let mut out = Vec::new();
            walk(tree.root_node(), &mut |n| {
                if n.kind() == "style_element" {
                    let mut c = n.walk();
                    for raw in n.children(&mut c).filter(|c| c.kind() == "raw_text") {
                        out.push((raw.start_byte(), &text[raw.start_byte()..raw.end_byte()]));
                    }
                    return false;
                }
                true
            });
            out
        }
        _ => Vec::new(),
    }
}

/// Pre-order walk; `f` returns whether to descend.
pub(crate) fn walk<'t>(n: Node<'t>, f: &mut dyn FnMut(Node<'t>) -> bool) {
    let mut cursor = n.walk();
    loop {
        if f(cursor.node()) && cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

fn text_of<'t>(n: Node, text: &'t str) -> &'t str {
    text.get(n.start_byte()..n.end_byte()).unwrap_or_default()
}

/// `.name`, `#name` and `--name` definitions in `text` (a stylesheet, or a document with `<style>`).
pub(crate) fn definitions(g: &Grammar, css: Option<&Grammar>, tree: &Tree, text: &str) -> Vec<SymbolTag> {
    let idx = LineIndex::new(text);
    let mut out = Vec::new();
    for (base, css_text) in css_regions(g.spec.name, tree, text) {
        let parsed;
        let css_tree = if base == 0 && g.spec.name == "css" {
            tree
        } else {
            let Some(css) = css else { continue };
            let Some(t) = parse(&css.language, css_text, None) else { continue };
            parsed = t;
            &parsed
        };
        walk(css_tree.root_node(), &mut |n| {
            let def = match n.kind() {
                "class_name" if n.parent().is_some_and(|p| p.kind() == "class_selector") => {
                    Some((format!(".{}", text_of(n, css_text)), CSS_CLASS))
                }
                "id_name" => Some((format!("#{}", text_of(n, css_text)), CSS_ID)),
                "property_name" if text_of(n, css_text).starts_with("--") => {
                    Some((text_of(n, css_text).to_owned(), CSS_VARIABLE))
                }
                _ => None,
            };
            if let Some((name, kind)) = def {
                let range = idx.range(base + n.start_byte(), base + n.end_byte());
                out.push(SymbolTag { name, kind, container: None, range });
            }
            true
        });
    }
    out
}

/// The whitespace-separated token of `value` (starting at byte `base`) around byte `at`.
fn token_at(value: &str, base: usize, at: usize) -> Option<(usize, &str)> {
    let rel = at.checked_sub(base)?;
    let start = value[..rel.min(value.len())].rfind(char::is_whitespace).map_or(0, |i| i + 1);
    let end = value[rel.min(value.len())..].find(char::is_whitespace).map_or(value.len(), |i| rel + i);
    (start < end).then(|| (base + start, &value[start..end]))
}

/// `var(--name)` around byte `at` of a stylesheet tree.
fn css_variable_at(tree: &Tree, css_text: &str, at: usize) -> Option<(usize, usize, String)> {
    let mut n = tree.root_node().descendant_for_byte_range(at, at)?;
    if n.kind() != "plain_value" {
        // The caret right after `--x` in `var(--x)`.
        n = tree.root_node().descendant_for_byte_range(at.saturating_sub(1), at.saturating_sub(1))?;
    }
    let name = text_of(n, css_text);
    let call = n.parent()?.parent()?;
    let is_var = call.kind() == "call_expression"
        && call
            .child_by_field_name("function_name")
            .or_else(|| call.child(0))
            .is_some_and(|f| text_of(f, css_text) == "var");
    (n.kind() == "plain_value" && name.starts_with("--") && is_var)
        .then(|| (n.start_byte(), n.end_byte(), name.to_owned()))
}

/// The web reference at `pos` of a document parsed as `tree`.
pub(crate) fn reference_at(
    g: &Grammar,
    css: Option<&Grammar>,
    tree: &Tree,
    text: &str,
    pos: Pos,
) -> Option<WebReference> {
    let at = byte_at(text, pos)?;
    let idx = LineIndex::new(text);
    let make = |kind, from: usize, to: usize, name: String| WebReference { kind, name, range: idx.range(from, to) };

    // Stylesheet regions: `var(--x)`.
    for (base, css_text) in css_regions(g.spec.name, tree, text) {
        if at < base || at > base + css_text.len() {
            continue;
        }
        let parsed;
        let css_tree = if g.spec.name == "css" {
            tree
        } else {
            parsed = parse(&css?.language, css_text, None)?;
            &parsed
        };
        let (from, to, name) = css_variable_at(css_tree, css_text, at - base)?;
        return Some(make(WebReferenceKind::CssVariable, base + from, base + to, name));
    }
    if g.spec.name != "html" {
        return None;
    }

    // HTML attribute values.
    let node = tree.root_node().descendant_for_byte_range(at, at)?;
    let value = std::iter::successors(Some(node), |n| n.parent()).find(|n| n.kind() == "attribute_value")?;
    let attribute = std::iter::successors(value.parent(), |n| n.parent()).find(|n| n.kind() == "attribute")?;
    let attr_name = attribute.child(0).map(|n| text_of(n, text).to_ascii_lowercase())?;
    let (vs, vtext) = (value.start_byte(), text_of(value, text));
    match attr_name.as_str() {
        "class" | "classname" | "class:list" => {
            let (from, token) = token_at(vtext, vs, at)?;
            Some(make(WebReferenceKind::Class, from, from + token.len(), token.to_owned()))
        }
        "id" => {
            let (from, token) = token_at(vtext, vs, at)?;
            Some(make(WebReferenceKind::Id, from, from + token.len(), token.to_owned()))
        }
        "href" | "xlink:href" if vtext.len() > 1 && vtext.starts_with('#') => {
            Some(make(WebReferenceKind::Anchor, vs, vs + vtext.len(), vtext[1..].to_owned()))
        }
        "style" => {
            // An inline declaration list: parse it as the block of a rule.
            let wrapped = format!("x{{{vtext}}}");
            let t = parse(&css?.language, &wrapped, None)?;
            let (from, to, name) = css_variable_at(&t, &wrapped, at - vs + 2)?;
            Some(make(WebReferenceKind::CssVariable, vs + from - 2, vs + to - 2, name))
        }
        _ => None,
    }
}

/// Elements whose `id` (or `<a name>`) is `name`: the targets of `href="#name"`.
pub(crate) fn anchors(tree: &Tree, text: &str, name: &str) -> Vec<Range> {
    let idx = LineIndex::new(text);
    let mut out = Vec::new();
    walk(tree.root_node(), &mut |n| {
        if n.kind() == "attribute" {
            let attr = n.child(0).map(|a| text_of(a, text).to_ascii_lowercase());
            if matches!(attr.as_deref(), Some("id" | "name")) {
                let mut found = None;
                walk(n, &mut |v| {
                    if v.kind() == "attribute_value" && text_of(v, text) == name {
                        found = Some(v);
                    }
                    found.is_none()
                });
                if let Some(v) = found {
                    out.push(idx.range(v.start_byte(), v.end_byte()));
                }
            }
            return false;
        }
        true
    });
    out
}

/// A path written in a document: an HTML URL attribute, a CSS `url()` / `@import`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileReference {
    pub range: Range,
    pub value: String,
}

/// HTML attributes whose value is a URL.
const URL_ATTRIBUTES: &[&str] = &[
    "href",
    "src",
    "srcset",
    "action",
    "formaction",
    "poster",
    "data",
    "cite",
    "background",
    "manifest",
    "xlink:href",
    "longdesc",
    "icon",
];

/// `url(…)` arguments and `@import` targets of a stylesheet: `(start, end)` byte ranges.
fn css_paths(tree: &Tree, css_text: &str, out: &mut Vec<(usize, usize)>) {
    let target = |n: Node| -> Option<(usize, usize)> {
        let n =
            if n.kind() == "string_value" { n.named_child(0).filter(|c| c.kind() == "string_content")? } else { n };
        matches!(n.kind(), "plain_value" | "string_content").then(|| (n.start_byte(), n.end_byte()))
    };
    walk(tree.root_node(), &mut |n| {
        match n.kind() {
            "import_statement" => {
                if let Some(first) = n.named_child(0)
                    && first.kind() == "string_value"
                {
                    out.extend(target(first));
                }
            }
            "call_expression" => {
                let is_url =
                    n.named_child(0).is_some_and(|f| f.kind() == "function_name" && text_of(f, css_text) == "url");
                if is_url
                    && let Some(args) = n.child_by_field_name("arguments").or_else(|| n.named_child(1))
                    && let Some(arg) = args.named_child(0)
                {
                    out.extend(target(arg));
                }
            }
            _ => {}
        }
        true
    });
}

/// File paths written in an HTML document or a stylesheet.
pub(crate) fn file_references(g: &Grammar, css: Option<&Grammar>, tree: &Tree, text: &str) -> Vec<FileReference> {
    let idx = LineIndex::new(text);
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for (base, css_text) in css_regions(g.spec.name, tree, text) {
        let parsed;
        let css_tree = if g.spec.name == "css" {
            tree
        } else {
            let Some(t) = css.and_then(|c| parse(&c.language, css_text, None)) else { continue };
            parsed = t;
            &parsed
        };
        let mut found = Vec::new();
        css_paths(css_tree, css_text, &mut found);
        spans.extend(found.into_iter().map(|(s, e)| (base + s, base + e)));
    }
    if g.spec.name == "html" {
        walk(tree.root_node(), &mut |n| {
            if n.kind() != "attribute" {
                return true;
            }
            let name = n.child(0).map(|a| text_of(a, text).to_ascii_lowercase()).unwrap_or_default();
            let mut value = None;
            walk(n, &mut |v| {
                if v.kind() == "attribute_value" {
                    value = Some(v);
                }
                value.is_none()
            });
            let Some(v) = value else { return false };
            let (vs, vtext) = (v.start_byte(), text_of(v, text));
            match name.as_str() {
                "srcset" => {
                    // `a.png 1x, b.png 2x`: the URL of each candidate.
                    let mut at = 0;
                    for part in vtext.split(',') {
                        let lead = part.len() - part.trim_start().len();
                        let url = part.split_whitespace().next().unwrap_or_default();
                        if !url.is_empty() {
                            spans.push((vs + at + lead, vs + at + lead + url.len()));
                        }
                        at += part.len() + 1;
                    }
                }
                "style" => {
                    let wrapped = format!("x{{{vtext}}}");
                    if let Some(t) = css.and_then(|c| parse(&c.language, &wrapped, None)) {
                        let mut found = Vec::new();
                        css_paths(&t, &wrapped, &mut found);
                        spans.extend(found.into_iter().map(|(s, e)| (vs + s - 2, vs + e - 2)));
                    }
                }
                _ if URL_ATTRIBUTES.contains(&name.as_str()) && !vtext.trim().is_empty() => {
                    spans.push((vs, vs + vtext.len()));
                }
                _ => {}
            }
            false
        });
    }
    spans.sort_unstable();
    spans.into_iter().map(|(s, e)| FileReference { range: idx.range(s, e), value: text[s..e].to_owned() }).collect()
}
