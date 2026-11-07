use ide_lsp::types::SemanticTokens;
use ide_plugin::SemanticToken;
use std::collections::HashMap;

pub(crate) fn merge(server: Option<SemanticTokens>, plugin: Vec<SemanticToken>) -> SemanticTokens {
    let mut out = server.unwrap_or_else(|| SemanticTokens {
        data: Vec::new(),
        token_types: Vec::new(),
        token_modifiers: Vec::new(),
    });
    let mut added: Vec<[u32; 5]> = Vec::with_capacity(plugin.len());
    let mut lines: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
    for token in plugin {
        let (start, end) = (token.range.start, token.range.end);
        if start.line != end.line || end.col <= start.col {
            continue;
        }
        let kind = camel_case(&token.kind);
        let kind = match out.token_types.iter().position(|t| *t == kind) {
            Some(i) => i,
            None => {
                out.token_types.push(kind);
                out.token_types.len() - 1
            }
        };
        let mut bits = 0u32;
        for modifier in &token.modifiers {
            let modifier = camel_case(modifier);
            let i = match out.token_modifiers.iter().position(|m| *m == modifier) {
                Some(i) => i,
                None if out.token_modifiers.len() < 32 => {
                    out.token_modifiers.push(modifier);
                    out.token_modifiers.len() - 1
                }
                None => continue,
            };
            bits |= 1 << i;
        }
        lines.entry(start.line).or_default().push((start.col, end.col));
        added.push([start.line, start.col, end.col - start.col, kind as u32, bits]);
    }
    let covered = |t: &[u32; 5]| {
        lines.get(&t[0]).is_some_and(|ranges| ranges.iter().any(|&(from, to)| t[1] < to && from < t[1] + t[2]))
    };
    let mut data: Vec<[u32; 5]> = out.data.as_chunks::<5>().0.iter().filter(|t| !covered(t)).copied().collect();
    data.extend(added);
    data.sort_by_key(|t| (t[0], t[1]));
    out.data = data.into_iter().flatten().collect();
    out
}

fn camel_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper = false;
    for c in name.chars() {
        if c == '-' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{Pos, Range};

    fn token(line: u32, from: u32, to: u32, kind: &str, modifiers: &[&str]) -> SemanticToken {
        SemanticToken {
            range: Range::new(Pos::new(line, from), Pos::new(line, to)),
            kind: kind.into(),
            modifiers: modifiers.iter().map(|m| (*m).into()).collect(),
        }
    }

    fn server() -> SemanticTokens {
        SemanticTokens {
            data: vec![0, 0, 6, 0, 0, 1, 4, 5, 1, 1, 1, 12, 3, 1, 0],
            token_types: vec!["variable".into(), "property".into()],
            token_modifiers: vec!["readonly".into()],
        }
    }

    #[test]
    fn plugin_tokens_replace_the_server_tokens_they_overlap() {
        let merged = merge(Some(server()), vec![token(1, 6, 10, "method", &[])]);
        assert_eq!(merged.token_types, ["variable", "property", "method"]);
        assert_eq!(merged.data, [0, 0, 6, 0, 0, 1, 6, 4, 2, 0, 1, 12, 3, 1, 0]);
    }

    #[test]
    fn kinds_and_modifiers_use_the_lsp_names() {
        let merged = merge(None, vec![token(2, 0, 3, "type-parameter", &["default-library", "readonly"])]);
        assert_eq!(merged.token_types, ["typeParameter"]);
        assert_eq!(merged.token_modifiers, ["defaultLibrary", "readonly"]);
        assert_eq!(merged.data, [2, 0, 3, 0, 0b11]);
    }

    #[test]
    fn known_names_reuse_the_server_legend() {
        let merged = merge(Some(server()), vec![token(3, 1, 2, "property", &["readonly"])]);
        assert_eq!(merged.token_types.len(), 2);
        assert_eq!(merged.token_modifiers.len(), 1);
        assert_eq!(merged.data[15..], [3, 1, 1, 1, 1]);
    }

    #[test]
    fn tokens_spanning_lines_or_empty_are_ignored() {
        let multi = SemanticToken {
            range: Range::new(Pos::new(0, 4), Pos::new(1, 2)),
            kind: "method".into(),
            modifiers: Vec::new(),
        };
        let merged = merge(Some(server()), vec![multi, token(0, 3, 3, "method", &[])]);
        assert_eq!(merged.data, server().data);
    }

    #[test]
    fn modifiers_past_thirty_two_are_dropped() {
        let names: Vec<String> = (0..40).map(|i| format!("m{i}")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let merged = merge(None, vec![token(0, 0, 1, "type", &refs)]);
        assert_eq!(merged.token_modifiers.len(), 32);
        assert_eq!(merged.data[4], u32::MAX);
    }
}
