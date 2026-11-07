//! Source ranges for Spring-style configuration keys. This is a syntax index,
//! not a YAML evaluator: aliases, merge keys and runtime profile precedence are
//! intentionally left to the YAML server / application.
use super::lines::{LineIndex, byte_at};
use super::{ParsedTree, Syntax, TreeError};
use ide_core::{LanguageId, Pos, Range};
use tree_sitter::Node;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigurationKey {
    pub name: String,
    pub range: Range,
}

impl Syntax {
    pub fn configuration_keys(
        &self,
        language: &LanguageId,
        text: &str,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<ConfigurationKey>, TreeError> {
        if language.as_str() == "properties" {
            return Ok(properties(text));
        }
        if language.as_str() == "xml" {
            // Only Spring wiring that mentions property placeholders can declare
            // a configuration key; skip parsing unrelated XML (POMs, mappers,
            // manifests) during project scans.
            if !text.contains("<prop") && !text.contains("placeholder") && !text.contains("Placeholder") {
                return Ok(Vec::new());
            }
            return self.with_parsed(language, text, cancelled, |tree| tree.spring_xml_keys(cancelled));
        }
        self.with_parsed(language, text, cancelled, |tree| tree.configuration_keys(cancelled))
    }

    /// Name of the Spring `${name[:default]}` placeholder covering `pos` in
    /// `text`, if the position lies anywhere inside its braces. The name stops
    /// at the first `:` or `}`; inside a nested default (`${a:${b}}`) the inner
    /// braces name `b`. Empty names (`${}`) name nothing.
    pub fn configuration_placeholder(&self, text: &str, pos: Pos) -> Option<String> {
        let at = byte_at(text, pos)?;
        // The innermost `${` at or before `at` that is not closed before it
        // wins, so a click inside a nested default picks the inner name.
        let mut best: Option<(usize, usize)> = None;
        let mut from = 0;
        while let Some(open) = text[from..].find("${") {
            let open = from + open;
            if open > at {
                break;
            }
            let Some(close) = text[open..].find('}').map(|close| open + close) else { break };
            if at <= close {
                best = Some((open, close));
            }
            from = open + 2;
        }
        let (open, close) = best?;
        let end = open + text[open..close].find([':', '}']).unwrap_or(close - open);
        let name = text[open + 2..end].trim();
        (!name.is_empty()).then(|| name.to_owned())
    }
}

/// Spring's property lookups whose first argument names a configuration key.
const PROPERTY_LOOKUPS: [&str; 2] = ["getProperty", "getRequiredProperty"];

impl Syntax {
    /// Whether `pos` in Java `text` lies where a configuration key can be written:
    /// inside the arguments of a `@Value` annotation or of a `getProperty` /
    /// `getRequiredProperty` call. Everywhere else Go to Definition is ordinary
    /// Java navigation and need not consult the configuration index. A file the
    /// grammar cannot parse answers false.
    pub fn java_configuration_site(&self, text: &str, pos: Pos, cancelled: &dyn Fn() -> bool) -> bool {
        let Some(at) = byte_at(text, pos) else { return false };
        self.with_parsed(&LanguageId::new("java"), text, cancelled, |tree| {
            let mut node = tree.tree.root_node().descendant_for_byte_range(at, at);
            while let Some(n) = node {
                let Some(parent) = n.parent() else { break };
                let callee = parent.child_by_field_name("name").map(|name| &text[name.byte_range()]);
                match (n.kind(), parent.kind(), callee) {
                    ("annotation_argument_list", "annotation", Some(name)) => {
                        return name.rsplit('.').next() == Some("Value");
                    }
                    ("argument_list", "method_invocation", Some(name)) if PROPERTY_LOOKUPS.contains(&name) => {
                        return true;
                    }
                    // Keys are expressions; nothing above a body or declaration can hold one.
                    (_, "block" | "class_body" | "interface_body" | "program", _) => return false,
                    _ => node = Some(parent),
                }
            }
            false
        })
        .unwrap_or(false)
    }
}

impl ParsedTree<'_> {
    pub fn configuration_keys(&self, cancelled: &dyn Fn() -> bool) -> Vec<ConfigurationKey> {
        let mut out = Vec::new();
        if self.grammar == "yaml" {
            yaml(self.tree.root_node(), "", self.text, &LineIndex::new(self.text), &mut out, cancelled, 0);
        }
        out
    }

    /// Spring property declarations in XML wiring: `<prop key="name">` values
    /// (util:properties, configurer `<props>`) and `<property name="name"
    /// value="...">` entries under a placeholder configurer bean. Elements that
    /// only reference a property file (`<context:property-placeholder>`,
    /// `<util:properties location="...">`) declare no key of their own; the
    /// configuration scan finds the keys inside the referenced files.
    pub fn spring_xml_keys(&self, cancelled: &dyn Fn() -> bool) -> Vec<ConfigurationKey> {
        let mut out = Vec::new();
        spring_xml(self.tree.root_node(), self.text, &LineIndex::new(self.text), &mut out, cancelled, 0, false);
        out
    }
}

/// Bean classes whose `<property name="key" value="...">` entries feed
/// placeholder resolution (the placeholder configurers).
fn placeholder_bean(class: &str) -> bool {
    class.to_ascii_lowercase().contains("placeholder")
}

fn local_name(tag: &str) -> &str {
    tag.rsplit(':').next().unwrap_or(tag)
}

fn spring_xml(
    node: Node<'_>,
    text: &str,
    lines: &LineIndex<'_>,
    out: &mut Vec<ConfigurationKey>,
    cancelled: &dyn Fn() -> bool,
    depth: usize,
    configurer: bool,
) {
    if depth > 64 || cancelled() || out.len() >= 20_000 {
        return;
    }
    if node.kind() != "element" {
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            spring_xml(child, text, lines, out, cancelled, depth + 1, configurer);
        }
        return;
    }
    let mut cursor = node.walk();
    let children: Vec<_> = node.named_children(&mut cursor).collect();
    let mut tag = "";
    let mut inside = configurer;
    let mut content: Vec<Node<'_>> = Vec::new();
    for child in children {
        match child.kind() {
            "STag" | "EmptyElemTag" => {
                let mut attrs_cursor = child.walk();
                let attrs: Vec<_> = child.named_children(&mut attrs_cursor).collect();
                let mut attributes: Vec<(&str, String, Range)> = Vec::new();
                for (i, attr) in attrs.iter().enumerate() {
                    if i == 0 && attr.kind() == "Name" {
                        tag = local_name(&text[attr.byte_range()]);
                        continue;
                    }
                    if attr.kind() != "Attribute" {
                        continue;
                    }
                    let mut parts_cursor = attr.walk();
                    let mut name = "";
                    let mut value = None;
                    for part in attr.named_children(&mut parts_cursor) {
                        match part.kind() {
                            "Name" => name = &text[part.byte_range()],
                            "AttValue" => value = Some(quoted_value(part, text, lines)),
                            _ => {}
                        }
                    }
                    if let Some((value, range)) = value {
                        attributes.push((name, value, range));
                    }
                }
                let attribute = |wanted: &str| attributes.iter().find(|(name, _, _)| *name == wanted);
                if tag == "prop"
                    && let Some((_, key, range)) = attribute("key")
                    && !key.is_empty()
                    && key.len() <= 1024
                {
                    out.push(ConfigurationKey { name: key.clone(), range: *range });
                }
                if tag == "property"
                    && configurer
                    && let (Some((_, name, range)), Some(_)) = (attribute("name"), attribute("value"))
                    && !name.is_empty()
                    && name.len() <= 1024
                {
                    out.push(ConfigurationKey { name: name.clone(), range: *range });
                }
                if tag == "bean"
                    && let Some((_, class, _)) = attribute("class")
                {
                    inside = placeholder_bean(class);
                }
            }
            "content" => content.extend(child.named_children(&mut cursor).filter(|n| n.kind() == "element")),
            // Error recovery can nest elements without a `content` node.
            "element" => content.push(child),
            _ => {}
        }
    }
    for element in content {
        spring_xml(element, text, lines, out, cancelled, depth + 1, inside);
    }
}

/// The decoded text of an `AttValue` and the range of its quoted contents.
fn quoted_value(node: Node<'_>, text: &str, lines: &LineIndex<'_>) -> (String, Range) {
    let raw = &text[node.byte_range()];
    let quoted = raw.len() >= 2
        && ((raw.starts_with('"') && raw.ends_with('"')) || (raw.starts_with('\'') && raw.ends_with('\'')));
    let (value, range) = if quoted {
        (&raw[1..raw.len() - 1], lines.range(node.start_byte() + 1, node.end_byte() - 1))
    } else {
        (raw, lines.range(node.start_byte(), node.end_byte()))
    };
    (unescape_xml(value), range)
}

/// XML's five predefined entities; unknown references keep their text.
fn unescape_xml(value: &str) -> String {
    if !value.contains('&') {
        return value.to_owned();
    }
    value.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn yaml(
    node: Node<'_>,
    prefix: &str,
    text: &str,
    lines: &LineIndex<'_>,
    out: &mut Vec<ConfigurationKey>,
    cancelled: &dyn Fn() -> bool,
    depth: usize,
) {
    if depth > 64 || cancelled() || out.len() >= 20_000 {
        return;
    }
    match node.kind() {
        "block_mapping_pair" | "flow_pair" => {
            let Some(key) = node.child_by_field_name("key") else { return };
            let raw = &text[key.byte_range()];
            if raw.contains('\n') {
                return;
            }
            let name = if raw.starts_with('\'') && raw.ends_with('\'') {
                raw[1..raw.len() - 1].replace("''", "'")
            } else if raw.starts_with('"') {
                // JSON escapes cover ordinary quoted configuration keys. Unsupported
                // YAML-only escapes are skipped rather than indexed under a wrong key.
                let Ok(name) = serde_json::from_str::<String>(raw) else { return };
                name
            } else {
                if raw.contains(['\n', '{', '[', '*', '&', '!']) || raw == "<<" {
                    return;
                }
                raw.to_owned()
            };
            if name.is_empty() {
                return;
            }
            let name = if prefix.is_empty() {
                name
            } else if name.starts_with('[') {
                format!("{prefix}{name}")
            } else {
                format!("{prefix}.{name}")
            };
            if name.len() > 1024 {
                return;
            }
            out.push(ConfigurationKey { name: name.clone(), range: lines.range(key.start_byte(), key.end_byte()) });
            if let Some(value) = node.child_by_field_name("value") {
                yaml(value, &name, text, lines, out, cancelled, depth + 1);
            }
        }
        "block_sequence" | "flow_sequence" => {
            let mut cursor = node.walk();
            for (i, child) in node.named_children(&mut cursor).filter(|n| n.kind() != "comment").enumerate() {
                yaml(child, &format!("{prefix}[{i}]"), text, lines, out, cancelled, depth + 1);
            }
        }
        // Do not descend into scalars, anchors or aliases.
        "stream"
        | "document"
        | "block_node"
        | "flow_node"
        | "block_mapping"
        | "flow_mapping"
        | "block_sequence_item" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                yaml(child, prefix, text, lines, out, cancelled, depth + 1);
            }
        }
        _ => {}
    }
}

fn properties(text: &str) -> Vec<ConfigurationKey> {
    let lines = LineIndex::new(text);
    let mut out = Vec::new();
    let mut logical = String::new();
    let mut offsets = Vec::new();
    let mut base = 0;
    for line in text.split_inclusive('\n') {
        let physical = line.trim_end_matches(['\r', '\n']);
        let start = physical.len() - physical.trim_start_matches([' ', '\t', '\u{c}']).len();
        let slice = &physical[start..];
        if logical.is_empty() && (slice.is_empty() || slice.starts_with(['#', '!'])) {
            base += line.len();
            continue;
        }
        let continued = slice.bytes().rev().take_while(|b| *b == b'\\').count() % 2 == 1;
        let end = physical.len() - usize::from(continued);
        for (i, ch) in physical[start..end].char_indices() {
            offsets.extend((0..ch.len_utf8()).map(|byte| base + start + i + byte));
            logical.push(ch);
        }
        if !continued || base + line.len() == text.len() {
            let mut escaped = false;
            let key_end = logical
                .char_indices()
                .find_map(|(i, ch)| {
                    if escaped {
                        escaped = false;
                        return None;
                    }
                    if ch == '\\' {
                        escaped = true;
                        return None;
                    }
                    matches!(ch, '=' | ':' | ' ' | '\t' | '\u{c}').then_some(i)
                })
                .unwrap_or(logical.len());
            if key_end > 0
                && key_end <= 1024
                && let Some(name) = unescape_property(&logical[..key_end])
            {
                out.push(ConfigurationKey { name, range: lines.range(offsets[0], offsets[key_end - 1] + 1) });
            }
            logical.clear();
            offsets.clear();
        }
        base += line.len();
    }
    out
}

fn unescape_property(raw: &str) -> Option<String> {
    let mut chars = raw.chars();
    let mut out = String::new();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next()? {
            'u' => {
                let hex: String = chars.by_ref().take(4).collect();
                if hex.len() != 4 {
                    return None;
                }
                out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
            }
            't' => out.push('\t'),
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            'f' => out.push('\u{c}'),
            ch => out.push(ch),
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn java_configuration_sites() {
        let text = r#"package a;
import org.springframework.beans.factory.annotation.Value;
class A {
    @Value("${app.port:80}") int port;
    @org.springframework.beans.factory.annotation.Value(value = Keys.NAME) String name;
    @Values("x") int other;
    @Override public String toString() {
        String v = env.getProperty("app.host", "h") + env.getRequiredProperty(Keys.USER);
        return helper.getValue("😀 app.port") + String.valueOf(port) + env.getProperty("k").trim();
    }
}
"#;
        let syntax = Syntax::new();
        let at = |needle: &str, offset: u32| {
            let line = text.lines().position(|l| l.contains(needle)).unwrap();
            let byte = text.lines().nth(line).unwrap().find(needle).unwrap();
            let col = text.lines().nth(line).unwrap()[..byte].encode_utf16().count() as u32 + offset;
            syntax.java_configuration_site(text, Pos::new(line as u32, col), &|| false)
        };
        // @Value arguments (literal, qualified annotation, constant key).
        assert!(at("${app.port", 2));
        assert!(at("Keys.NAME", 6));
        // Lookup arguments, including a constant and the default value.
        assert!(at("\"app.host\"", 3));
        assert!(at("\"h\"", 1));
        assert!(at("Keys.USER", 1));
        assert!(at("\"k\"", 1));
        // Ordinary Java: names, other annotations, other calls, the lookup's own name and receiver.
        assert!(!at("@Value(\"$", 2));
        assert!(!at("int port", 4));
        assert!(!at("@Values", 9));
        assert!(!at("@Override", 2));
        assert!(!at("getProperty(\"app", 3));
        assert!(!at("env.getProperty(\"app", 1));
        assert!(!at("app.port\")", 1));
        assert!(!at("valueOf", 2));
        assert!(!at(".trim", 2));
        // Out of range and non-Java input.
        assert!(!syntax.java_configuration_site(text, Pos::new(99, 0), &|| false));
        assert!(!syntax.java_configuration_site("", Pos::new(0, 0), &|| false));
    }
    #[test]
    fn yaml_structures_and_utf16() {
        let text = "app:\n  'time-out': 1\n  hosts:\n    - url: a\n    - {url: b}\n  map: {east: {size: 2}}\n---\n\"app.name\": ok\n'😀': {port: 3}\n";
        let keys = Syntax::new().configuration_keys(&LanguageId::new("yaml"), text, &|| false).unwrap();
        let names: Vec<_> = keys.iter().map(|k| k.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "app",
                "app.time-out",
                "app.hosts",
                "app.hosts[0].url",
                "app.hosts[1].url",
                "app.map",
                "app.map.east",
                "app.map.east.size",
                "app.name",
                "😀",
                "😀.port"
            ]
        );
        assert_eq!(keys.last().unwrap().range.start.col, 7);
    }
    #[test]
    fn aliases_and_values_are_not_configuration_keys() {
        let keys = Syntax::new()
            .configuration_keys(
                &LanguageId::new("yaml"),
                "base: &base {size: 1}\napp:\n  <<: *base\n  text: |\n    fake: key\n",
                &|| false,
            )
            .unwrap();
        assert_eq!(keys.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(), ["base", "base.size", "app", "app.text"]);
    }
    #[test]
    fn properties_unicode_ranges_and_eof_continuation() {
        let keys = properties("app.中文=1\nlast\\\n");
        assert_eq!(keys[0].range.end.col, 6);
        assert_eq!(keys[1].name, "last");
    }
    #[test]
    fn properties_escapes_continuations_and_comments() {
        let keys = properties(
            "# comment\r\napp.time\\\n  -out : 1\napp\\.name=ok\napp.\\u0061=2\nspace\\ key value\n!ignored=x\n",
        );
        assert_eq!(
            keys.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(),
            ["app.time-out", "app.name", "app.a", "space key"]
        );
        assert_eq!(keys[0].range.end.line, 2);
    }
    #[test]
    fn placeholder_names_cover_the_whole_reference() {
        let text = "name: ${db.url:8080}\nplain: value\nempty: ${}\nnested: ${a:${b.c}}\nspaced: ${ db.h }\n";
        let syntax = Syntax::new();
        let at = |needle: &str, offset: u32| {
            let line = text.lines().position(|l| l.contains(needle)).unwrap();
            let line_text = text.lines().nth(line).unwrap();
            let byte = line_text.find(needle).unwrap();
            let col = line_text[..byte].encode_utf16().count() as u32 + offset;
            syntax.configuration_placeholder(text, Pos::new(line as u32, col))
        };
        // On the `$`, inside the name and on the default all name `db.url`.
        assert_eq!(at("${db.url", 0), Some("db.url".into()));
        assert_eq!(at("db.url", 1), Some("db.url".into()));
        assert_eq!(at("8080", 1), Some("db.url".into()));
        assert_eq!(at("plain", 1), None);
        assert_eq!(at("empty", 3), None);
        // A nested default names its own property; the outer braces name `a`.
        assert_eq!(at("${b.c", 2), Some("b.c".into()));
        assert_eq!(at("${a:", 2), Some("a".into()));
        assert_eq!(at("db.h", 1), Some("db.h".into()));
        assert_eq!(syntax.configuration_placeholder("no placeholder", Pos::new(0, 3)), None);
        assert_eq!(syntax.configuration_placeholder("trailing ${open", Pos::new(0, 12)), None);
    }
    #[test]
    fn spring_xml_declares_prop_and_configurer_property_keys() {
        let text = r#"<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans">
  <context:property-placeholder location="classpath:db.properties"/>
  <util:properties id="db">
    <prop key="db.url">jdbc:h2:mem:test</prop>
  </util:properties>
  <bean class="org.springframework.beans.factory.config.PropertyPlaceholderConfigurer">
    <property name="properties">
      <props>
        <prop key="db.user">sa</prop>
      </props>
    </property>
  </bean>
  <bean class="org.springframework.jdbc.datasource.DriverManagerDataSource">
    <property name="url" value="jdbc:h2:mem"/>
  </bean>
  <bean class="org.springframework.beans.factory.config.PropertySourcesPlaceholderConfigurer">
    <property name="system.mode" value="test"/>
  </bean>
</beans>
"#;
        let keys = Syntax::new().configuration_keys(&LanguageId::new("xml"), text, &|| false).unwrap();
        let names: Vec<_> = keys.iter().map(|k| k.name.as_str()).collect();
        // The configurer's own `properties` injection names no property, and a
        // plain bean's `<property name="url">` is not an environment property.
        assert_eq!(names, ["db.url", "db.user", "system.mode"]);
        // The range covers the quoted key attribute's value.
        let line = text.lines().position(|l| l.contains("db.url")).unwrap() as u32;
        let start = keys[0].range.start;
        assert_eq!((start.line, keys[0].range.end.line), (line, line));
        assert_eq!(
            &text.lines().nth(line as usize).unwrap()[start.col as usize..keys[0].range.end.col as usize],
            "db.url"
        );
    }
    #[test]
    fn xml_without_property_markers_is_not_parsed() {
        let text = "<mappers><mapper resource='a.xml'/><select id='x'>select 1</select></mappers>";
        let keys = Syntax::new().configuration_keys(&LanguageId::new("xml"), text, &|| false).unwrap();
        assert!(keys.is_empty());
    }
}
