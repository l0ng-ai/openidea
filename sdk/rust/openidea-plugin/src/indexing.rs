//! Background document indexing (`[[contributes.documentIndexers]]`): return
//! the keys a document defines and refers to; the host keeps the project-wide
//! graph and resolves Go to Declaration and gutter markers from it. Register
//! with `register_plugin!(Plugin, indexing)`.
use crate::Range;

/// A symbol the host's syntax support found in the document.
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

/// A range tied to a key the plugin chooses.
#[derive(Clone, Debug)]
pub struct Anchor {
    pub key: String,
    pub range: Range,
}

/// Keys starting with `prefix` also resolve under `target` (both end with `#`).
pub struct Alias {
    pub prefix: String,
    pub target: String,
}

#[derive(Default)]
pub struct Edges {
    pub definitions: Vec<Anchor>,
    pub references: Vec<Anchor>,
    pub aliases: Vec<Alias>,
    /// Gutter icons that go to the definitions of their key.
    pub markers: Vec<Anchor>,
}

pub trait DocumentIndexer {
    fn index(&mut self, doc: &Document) -> Edges;
}
