use openidea_plugin::hover::{Document, Hover, HoverProvider};
use openidea_plugin::{Error, Invocation, Plugin, Position, Range, register_plugin, text};

#[derive(Default)]
struct Fixture;

impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, _: &Invocation, _: Option<&str>) -> Result<Option<String>, Error> {
        Err(Error::NotFound(id.into()))
    }
}

impl HoverProvider for Fixture {
    fn hover(&mut self, doc: &Document, at: Position) -> Option<Hover> {
        let text = doc.text.as_str();
        let offset = text::offset(text, at)?;
        let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
        let start = text[..offset].rfind(|c: char| !word(c)).map_or(0, |i| i + 1);
        let end = text[offset..].find(|c: char| !word(c)).map_or(text.len(), |n| offset + n);
        let name = &text[start..end];
        if name.is_empty() {
            return None;
        }
        let declared = text.find(&format!("function {name}("))?;
        let line = text::position(text, declared).line + 1;
        let range = Range { start: text::position(text, start), end: text::position(text, end) };
        Some(Hover::new(format!("**{name}** · declared on line {line}")).range(range))
    }
}

register_plugin!(Fixture, hover);
