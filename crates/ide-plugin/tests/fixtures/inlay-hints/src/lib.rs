use openidea_plugin::inlay_hints::{Document, InlayHint, InlayHints, InlayKind};
use openidea_plugin::{Error, Invocation, Plugin, Range, register_plugin, text};

#[derive(Default)]
struct Fixture;

impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, _: &Invocation, _: Option<&str>) -> Result<Option<String>, Error> {
        Err(Error::NotFound(id.into()))
    }
}

impl InlayHints for Fixture {
    fn inlay_hints(&mut self, doc: &Document, _range: Range) -> Vec<InlayHint> {
        let text = doc.text.as_str();
        let mut out = Vec::new();
        let mut rest = 0;
        while let Some(i) = text[rest..].find("->") {
            let start = rest + i + 2;
            let end = text[start..]
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .map_or(text.len(), |n| start + n);
            rest = end;
            if end == start || !text[end..].starts_with("()") {
                continue;
            }
            let name = &text[start..end];
            let declared = format!("function {name}(): ");
            let Some(at) = text.find(&declared) else { continue };
            let ty: String = text[at + declared.len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '\\' | '?'))
                .collect();
            if ty.is_empty() {
                continue;
            }
            out.push(
                InlayHint::new(text::position(text, end + 2), format!(": {ty}"))
                    .kind(InlayKind::Type)
                    .tooltip(format!("{name}() returns {ty}")),
            );
        }
        out
    }
}

register_plugin!(Fixture, inlay_hints);
