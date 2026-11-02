//! Source ranges for Spring-style configuration keys. This is a syntax index,
//! not a YAML evaluator: aliases, merge keys and runtime profile precedence are
//! intentionally left to the YAML server / application.
use super::lines::LineIndex;
use super::{ParsedTree, Syntax, TreeError};
use ide_core::{LanguageId, Range};
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
