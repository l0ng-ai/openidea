//! Vue Options API `this.$refs`: Vue 2.7 types `$refs` as an index signature, so the
//! TypeScript service resolves `this.$refs.child` to that signature and `.child.focusIt`
//! to nothing. The template names each ref (`ref="child"`) and the element it is on,
//! which is all navigation needs.

use super::lines::{LineIndex, byte_at};
use super::web::walk;
use super::{Syntax, parse};
use crate::ScriptRegion;
use ide_core::{LanguageId, Pos, Range};
use tree_sitter::Node;

/// The `$refs.<name>` (or `$refs.<name>.<member>`) expression a position is on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VueRefAccess {
    pub name: String,
    /// The member read from the referenced element, when the position is on it.
    pub member: Option<String>,
}

/// The template element that carries `ref="<name>"`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VueRefElement {
    /// The attribute value: the ref's declaration.
    pub value: Range,
    pub tag: String,
}

/// A default import in a component's `<script>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VueComponentImport {
    pub specifier: String,
    /// The imported name, where the language service resolves the module.
    pub binding: Range,
}

/// Options whose members are on the component instance.
const INSTANCE_OPTIONS: [&str; 5] = ["methods", "computed", "props", "data", "setup"];

impl Syntax {
    /// The `$refs` access at `pos` in a Vue SFC's `<script>`.
    pub fn vue_ref_access(&self, text: &str, pos: Pos) -> Option<VueRefAccess> {
        let at = byte_at(text, pos)?;
        let region = self.script_regions(&LanguageId::new("vue"), text).into_iter().find(|r| contains(r, at))?;
        let g = self.grammar(&region.language)?;
        let tree = parse(&g.language, &region.text, None)?;
        let rel = at - region.base;
        let root = tree.root_node();
        let node = [rel, rel.saturating_sub(1)]
            .into_iter()
            .filter_map(|b| root.descendant_for_byte_range(b, b))
            .find(|n| n.kind() == "property_identifier")?;
        let src = region.text.as_str();
        let read = node.parent().filter(|p| p.kind() == "member_expression")?;
        let object = read.child_by_field_name("object")?;
        if is_refs(object, src) {
            return Some(VueRefAccess { name: text_of(node, src).to_owned(), member: None });
        }
        if object.kind() == "member_expression"
            && let Some(refs) = object.child_by_field_name("object")
            && is_refs(refs, src)
            && let Some(name) = object.child_by_field_name("property")
        {
            return Some(VueRefAccess {
                name: text_of(name, src).to_owned(),
                member: Some(text_of(node, src).to_owned()),
            });
        }
        None
    }

    /// The element with `ref="<name>"` in a Vue SFC's template; the last one when several
    /// share the name, as Vue keeps the last.
    pub fn vue_ref_element(&self, text: &str, name: &str) -> Option<VueRefElement> {
        let g = self.web_grammar(&LanguageId::new("vue"))?;
        let tree = parse(&g.language, text, None)?;
        let idx = LineIndex::new(text);
        let mut found = None;
        walk(tree.root_node(), &mut |n| {
            if n.kind() != "attribute" {
                return !matches!(n.kind(), "script_element" | "style_element");
            }
            if n.child(0).is_some_and(|a| text_of(a, text) == "ref")
                && let Some(value) = attribute_value(n)
                && text_of(value, text) == name
                && let Some(tag) = n.parent().and_then(|t| t.child(1)).filter(|t| t.kind() == "tag_name")
            {
                found = Some(VueRefElement {
                    value: idx.range(value.start_byte(), value.end_byte()),
                    tag: text_of(tag, text).to_owned(),
                });
            }
            false
        });
        found
    }

    /// The default import in a Vue SFC's `<script>` that a template tag names
    /// (`<child-button>` / `<ChildButton>` → `import ChildButton from …`).
    pub fn vue_component_import(&self, text: &str, tag: &str) -> Option<VueComponentImport> {
        let wanted = component_key(tag);
        let idx = LineIndex::new(text);
        self.script_regions(&LanguageId::new("vue"), text).into_iter().find_map(|region| {
            let g = self.grammar(&region.language)?;
            let tree = parse(&g.language, &region.text, None)?;
            let src = region.text.as_str();
            let mut c = tree.root_node().walk();
            tree.root_node().children(&mut c).filter(|n| n.kind() == "import_statement").find_map(|n| {
                let clause = n.children(&mut n.walk()).find(|ch| ch.kind() == "import_clause")?;
                let binding = clause.children(&mut clause.walk()).find(|ch| ch.kind() == "identifier")?;
                if component_key(text_of(binding, src)) != wanted {
                    return None;
                }
                let source = n.child_by_field_name("source")?;
                let specifier = source.named_child(0).map(|f| text_of(f, src)).unwrap_or_default();
                Some(VueComponentImport {
                    specifier: specifier.to_owned(),
                    binding: idx.range(region.base + binding.start_byte(), region.base + binding.end_byte()),
                })
            })
        })
    }

    /// Where a component declares the instance member `name` in its options object
    /// (`methods`, `computed`, `props`, `data()` / `setup()` return). `lang` is `vue` for an
    /// SFC, or the script language of a component written as a plain module.
    pub fn vue_component_member(&self, lang: &LanguageId, text: &str, name: &str) -> Option<Range> {
        let regions = if lang.as_str() == "vue" {
            self.script_regions(lang, text)
        } else {
            vec![ScriptRegion { base: 0, language: lang.clone(), text: text.to_owned() }]
        };
        let idx = LineIndex::new(text);
        regions.into_iter().find_map(|region| {
            let g = self.grammar(&region.language)?;
            let tree = parse(&g.language, &region.text, None)?;
            let src = region.text.as_str();
            let options = default_options(tree.root_node(), src)?;
            let key = instance_member(options, src, name)?;
            Some(idx.range(region.base + key.start_byte(), region.base + key.end_byte()))
        })
    }
}

fn contains(region: &ScriptRegion, at: usize) -> bool {
    region.base <= at && at <= region.base + region.text.len()
}

fn text_of<'t>(n: Node, text: &'t str) -> &'t str {
    n.utf8_text(text.as_bytes()).unwrap_or("")
}

/// `<anything>.$refs`.
fn is_refs(n: Node, src: &str) -> bool {
    n.kind() == "member_expression" && n.child_by_field_name("property").is_some_and(|p| text_of(p, src) == "$refs")
}

fn attribute_value(attr: Node) -> Option<Node> {
    let value =
        attr.children(&mut attr.walk()).find(|ch| matches!(ch.kind(), "quoted_attribute_value" | "attribute_value"))?;
    if value.kind() == "attribute_value" { Some(value) } else { value.named_child(0) }
}

/// Vue matches a tag to a registered component in kebab-case or PascalCase.
fn component_key(name: &str) -> String {
    name.chars().filter(|c| *c != '-').flat_map(char::to_lowercase).collect()
}

/// The options object of `export default { … }`, `export default defineComponent({ … })`
/// or `export default Vue.extend({ … })`.
fn default_options<'t>(root: Node<'t>, src: &str) -> Option<Node<'t>> {
    let mut c = root.walk();
    let export = root.children(&mut c).find(|n| {
        n.kind() == "export_statement" && n.children(&mut n.walk()).any(|ch| text_of(ch, src) == "default")
    })?;
    let value = export.child_by_field_name("value").or_else(|| export.child_by_field_name("declaration"))?;
    object_of(value)
}

fn object_of(n: Node) -> Option<Node> {
    match n.kind() {
        "object" => Some(n),
        "parenthesized_expression" | "as_expression" | "satisfies_expression" => object_of(n.named_child(0)?),
        "call_expression" => object_of(n.child_by_field_name("arguments")?.named_child(0)?),
        _ => None,
    }
}

fn instance_member<'t>(options: Node<'t>, src: &str, name: &str) -> Option<Node<'t>> {
    for option in INSTANCE_OPTIONS {
        let Some(entry) = entry(options, src, option) else { continue };
        let found = match option {
            "data" | "setup" => returned_objects(entry).into_iter().find_map(|o| key(o, src, name)),
            "props" => match entry.child_by_field_name("value") {
                Some(array) if array.kind() == "array" => array
                    .named_children(&mut array.walk())
                    .find(|s| s.kind() == "string" && string_value(*s, src) == name),
                value => value.and_then(object_of).and_then(|o| key(o, src, name)),
            },
            _ => entry.child_by_field_name("value").and_then(object_of).and_then(|o| key(o, src, name)),
        };
        if found.is_some() {
            return found;
        }
    }
    None
}

/// The `pair` or `method_definition` of `object` named `name`.
fn entry<'t>(object: Node<'t>, src: &str, name: &str) -> Option<Node<'t>> {
    object.named_children(&mut object.walk()).find(|n| {
        matches!(n.kind(), "pair" | "method_definition")
            && n.child_by_field_name(if n.kind() == "pair" { "key" } else { "name" })
                .is_some_and(|k| property_name(k, src) == name)
    })
}

/// The key node of `object`'s member `name`, shorthand properties included.
fn key<'t>(object: Node<'t>, src: &str, name: &str) -> Option<Node<'t>> {
    object.named_children(&mut object.walk()).find_map(|n| match n.kind() {
        "pair" => n.child_by_field_name("key").filter(|k| property_name(*k, src) == name),
        "method_definition" => n.child_by_field_name("name").filter(|k| property_name(*k, src) == name),
        "shorthand_property_identifier" => (text_of(n, src) == name).then_some(n),
        _ => None,
    })
}

fn property_name<'t>(key: Node, src: &'t str) -> &'t str {
    if key.kind() == "string" { string_value(key, src) } else { text_of(key, src) }
}

fn string_value<'t>(s: Node, src: &'t str) -> &'t str {
    s.named_child(0).map(|f| text_of(f, src)).unwrap_or("")
}

/// The objects a `data()` / `setup()` option returns (`data: () => ({ … })` included).
fn returned_objects(entry: Node) -> Vec<Node> {
    let function = if entry.kind() == "method_definition" { Some(entry) } else { entry.child_by_field_name("value") };
    let Some(function) = function else { return Vec::new() };
    let Some(body) = function.child_by_field_name("body") else { return Vec::new() };
    if let Some(object) = object_of(body) {
        return vec![object];
    }
    let mut out = Vec::new();
    walk(body, &mut |n| match n.kind() {
        "return_statement" => {
            out.extend(n.named_child(0).and_then(object_of));
            false
        }
        // A nested function's `return` is not the option's.
        "function_expression" | "arrow_function" | "function_declaration" | "method_definition" | "class_body" => false,
        _ => true,
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = r#"<template>
  <div>
    <child-button ref="child" @my-event="handler" />
    <input ref='field'>
    <span>{{ $refs.child }}</span>
  </div>
</template>

<script>
import ChildButton from './components/ChildButton.vue'

export default {
  name: 'App',
  components: { ChildButton },
  methods: {
    handler() {
      this.$refs.child
      this.$refs.child.focusIt()
      this.$refs.field?.focus()
    }
  }
}
</script>
"#;

    fn pos_of(text: &str, needle: &str, nth: usize, offset: usize) -> Pos {
        let byte = text.match_indices(needle).nth(nth).unwrap().0 + offset;
        LineIndex::new(text).pos(byte)
    }

    #[test]
    fn finds_the_ref_and_the_member_read_from_it() {
        let s = Syntax::new();
        let child = s.vue_ref_access(APP, pos_of(APP, "this.$refs.child", 0, 12)).unwrap();
        assert_eq!(child, VueRefAccess { name: "child".into(), member: None });
        // At the end of the name too.
        let end = s.vue_ref_access(APP, pos_of(APP, "this.$refs.child", 0, 16)).unwrap();
        assert_eq!(end.name, "child");
        let member = s.vue_ref_access(APP, pos_of(APP, "focusIt", 0, 2)).unwrap();
        assert_eq!(member, VueRefAccess { name: "child".into(), member: Some("focusIt".into()) });
        let optional = s.vue_ref_access(APP, pos_of(APP, "field?.focus", 0, 1)).unwrap();
        assert_eq!(optional.name, "field");
        assert!(s.vue_ref_access(APP, pos_of(APP, "$refs.child", 1, 2)).is_none(), "$refs itself");
        assert!(s.vue_ref_access(APP, pos_of(APP, "handler", 1, 1)).is_none());
        assert!(s.vue_ref_access(APP, pos_of(APP, "$refs.child }}", 0, 7)).is_none(), "template is the server's");
    }

    #[test]
    fn finds_the_element_with_the_ref() {
        let s = Syntax::new();
        let child = s.vue_ref_element(APP, "child").unwrap();
        assert_eq!(child.tag, "child-button");
        assert_eq!(child.value.start, pos_of(APP, "\"child\"", 0, 1));
        let field = s.vue_ref_element(APP, "field").unwrap();
        assert_eq!(field.tag, "input");
        assert!(s.vue_ref_element(APP, "missing").is_none());
        let last = "<template><a ref=\"x\"/><b ref=\"x\"></b></template>";
        assert_eq!(s.vue_ref_element(last, "x").unwrap().tag, "b");
        assert!(s.vue_ref_element("<template><a :ref=\"x\"/></template>", "x").is_none());
    }

    #[test]
    fn finds_the_import_a_tag_names() {
        let s = Syntax::new();
        let import = s.vue_component_import(APP, "child-button").unwrap();
        assert_eq!(import.specifier, "./components/ChildButton.vue");
        assert_eq!(import.binding.start, pos_of(APP, "ChildButton from", 0, 0));
        assert_eq!(s.vue_component_import(APP, "ChildButton").unwrap().specifier, import.specifier);
        assert!(s.vue_component_import(APP, "input").is_none());
    }

    #[test]
    fn finds_instance_members_in_the_options() {
        let s = Syntax::new();
        let child = r#"<template><button /></template>
<script>
export default {
  name: 'ChildButton',
  props: ['label', 'size'],
  data() {
    const helper = () => { return { nope: 1 } }
    return { count: 0, helper }
  },
  computed: { double() { return this.count * 2 }, 'quoted': function () {} },
  methods: {
    focusIt() { this.$el.focus() },
    reset: function () {},
  }
}
</script>
"#;
        let vue = LanguageId::new("vue");
        let at = |name: &str| s.vue_component_member(&vue, child, name);
        assert_eq!(at("focusIt").unwrap().start, pos_of(child, "focusIt", 0, 0));
        assert_eq!(at("reset").unwrap().start, pos_of(child, "reset", 0, 0));
        assert_eq!(at("double").unwrap().start, pos_of(child, "double", 0, 0));
        assert_eq!(at("quoted").unwrap().start, pos_of(child, "'quoted'", 0, 0));
        assert_eq!(at("size").unwrap().start, pos_of(child, "'size'", 0, 0));
        assert_eq!(at("count").unwrap().start, pos_of(child, "count: 0", 0, 0));
        assert_eq!(at("helper").unwrap().start, pos_of(child, "helper }", 0, 0));
        assert!(at("nope").is_none());
        assert!(at("name").is_none());

        let ts = "import { defineComponent } from 'vue'\nexport default defineComponent({ methods: { go() {} } })\n";
        let at = s.vue_component_member(&LanguageId::new("typescript"), ts, "go").unwrap();
        assert_eq!(at.start, pos_of(ts, "go()", 0, 0));
        let props = "export default { props: { value: String } }";
        assert!(s.vue_component_member(&LanguageId::new("javascript"), props, "value").is_some());
    }
}
