//! Background symbolic indexing. The host supplies cached syntax symbols and
//! resolves published references without running a provider on every click.
use crate::Range;
#[derive(Clone, Debug)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub container: Option<String>,
    pub range: Range,
}
pub struct Document {
    pub path: String,
    pub text: String,
    pub symbols: Vec<Symbol>,
}
#[derive(Clone, Debug)]
pub struct Anchor {
    pub key: String,
    pub range: Range,
}
pub struct Alias {
    pub prefix: String,
    pub target: String,
}
pub struct Region {
    pub language: String,
    pub range: Range,
}
#[derive(Default)]
pub struct Presentation {
    pub icon: Option<String>,
    pub linked_only: bool,
    pub markers: Vec<Anchor>,
    pub regions: Vec<Region>,
}
#[derive(Default)]
pub struct Edges {
    pub definitions: Vec<Anchor>,
    pub references: Vec<Anchor>,
    pub aliases: Vec<Alias>,
    pub presentation: Presentation,
}
pub trait DocumentIndexer {
    fn index(&mut self, doc: &Document) -> Edges;
}
