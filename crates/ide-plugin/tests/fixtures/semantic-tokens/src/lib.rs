use openidea_plugin::semantic_tokens::{Document, SemanticToken, SemanticTokens, TokenKind};
use openidea_plugin::{Error, Invocation, Plugin, Range, register_plugin, text};

#[derive(Default)]
struct Fixture;

impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, _: &Invocation, _: Option<&str>) -> Result<Option<String>, Error> {
        Err(Error::NotFound(id.into()))
    }
}

impl SemanticTokens for Fixture {
    fn semantic_tokens(&mut self, doc: &Document) -> Vec<SemanticToken> {
        let text = doc.text.as_str();
        let mut out = Vec::new();
        let mut rest = 0;
        while let Some(i) = text[rest..].find("->") {
            let start = rest + i + 2;
            let end = text[start..]
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .map_or(text.len(), |n| start + n);
            rest = end;
            if end == start || text[end..].starts_with('(') {
                continue;
            }
            let name = &text[start..end];
            let kind =
                if text.contains(&format!("function {name}(")) { TokenKind::Method } else { TokenKind::Property };
            let range = Range { start: text::position(text, start), end: text::position(text, end) };
            out.push(SemanticToken::new(range, kind));
        }
        out
    }
}

register_plugin!(Fixture, semantic_tokens);
