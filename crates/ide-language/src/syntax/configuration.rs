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
        self.with_parsed(language, text, cancelled, |tree| tree.configuration_keys(cancelled))
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
}
