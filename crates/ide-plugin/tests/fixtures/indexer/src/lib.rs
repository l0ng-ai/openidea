//! Deliberately tiny line-oriented fixture, not a language/framework plugin.
use openidea_plugin::indexing::{Alias, Anchor, Document, DocumentIndexer, Edges};
use openidea_plugin::{Error, Invocation, Plugin, Position, Range, register_plugin};

#[derive(Default)]
struct Indexer;
impl Plugin for Indexer {
    fn run_command(&mut self, id: &str, _: &Invocation, _: Option<&str>) -> Result<Option<String>, Error> {
        Err(Error::NotFound(id.into()))
    }
}
impl DocumentIndexer for Indexer {
    fn index(&mut self, doc: &Document) -> Edges {
        let mut out = Edges::default();
        for (line, text) in doc.text.lines().enumerate() {
            let Some((kind, value)) = text.split_once(' ') else { continue };
            let range = Range {
                start: Position { line: line as u32, character: kind.len() as u32 + 1 },
                end: Position { line: line as u32, character: text.encode_utf16().count() as u32 },
            };
            let anchor = Anchor { key: value.into(), range };
            match kind {
                "def" => out.definitions.push(anchor),
                "ref" => {
                    out.references.push(anchor.clone());
                    out.markers.push(anchor);
                }
                "alias" => {
                    if let Some((prefix, target)) = value.split_once(' ') {
                        out.aliases.push(Alias { prefix: prefix.into(), target: target.into() });
                    }
                }
                "symbols" => out.definitions.extend(
                    doc.symbols
                        .iter()
                        .map(|symbol| Anchor { key: format!("{value}{}", symbol.name), range: symbol.range }),
                ),
                "invalid" => out.references.push(Anchor {
                    key: value.into(),
                    range: Range {
                        start: Position { line: 999, character: 0 },
                        end: Position { line: 999, character: 1 },
                    },
                }),
                _ => {}
            }
        }
        out
    }
}
register_plugin!(Indexer, indexing);
