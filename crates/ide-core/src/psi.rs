//! PSI (Program Structure Interface) contract (spec 06).
//!
//! A language-agnostic view of a parsed file: a tree of [`PsiElement`]s with
//! stable kinds, ranges and parent links, plus a [`StubIndex`] for fast
//! declaration lookups without re-parsing. Concrete implementations live in
//! `ide-syntax` (tree-sitter) and the language servers; this module only fixes
//! the vocabulary so consumers depend on `ide-core`, not on a parser.

use crate::{DocId, Range};
use std::sync::Arc;

/// A node in a PSI tree. Elements are immutable snapshots tied to one file
/// version; a new parse yields a new tree.
pub trait PsiElement: Send + Sync {
    /// Stable kind, e.g. `function_item`, `class_declaration`.
    fn kind(&self) -> &'static str;
    fn range(&self) -> Range;
    fn text(&self) -> &str;
    fn parent(&self) -> Option<Arc<dyn PsiElement>>;
    fn children(&self) -> Vec<Arc<dyn PsiElement>>;
    /// Depth-first search for the first element whose range contains `offset`
    /// (0-based UTF-16 column of `pos`). Default: none (override in impls).
    fn find_at(&self, _offset: (u32, u32)) -> Option<Arc<dyn PsiElement>> {
        None
    }
}

/// A parsed file's PSI root.
pub trait PsiFile: Send + Sync {
    fn doc(&self) -> DocId;
    fn root(&self) -> Arc<dyn PsiElement>;
}

/// A lightweight declaration record used by the stub index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stub {
    pub key: String,
    pub kind: &'static str,
    pub file: DocId,
    pub range: Range,
}

/// Fast declaration lookup without re-parsing. Implementations persist stubs
/// across sessions (see `jdk-shared-indexes`).
pub trait StubIndex: Send + Sync {
    fn index(&self, file: DocId, stubs: Vec<Stub>);
    fn lookup(&self, key: &str) -> Vec<Stub>;
    fn remove_file(&self, file: DocId);
}

/// In-memory stub index, suitable for tests and dumb mode.
#[derive(Default)]
pub struct InMemoryStubIndex {
    entries: std::sync::Mutex<std::collections::BTreeMap<String, Vec<Stub>>>,
    by_file: std::sync::Mutex<std::collections::BTreeMap<DocId, Vec<String>>>,
}

impl StubIndex for InMemoryStubIndex {
    fn index(&self, file: DocId, stubs: Vec<Stub>) {
        let mut entries = self.entries.lock().unwrap();
        let mut by_file = self.by_file.lock().unwrap();
        if let Some(keys) = by_file.remove(&file) {
            for k in keys {
                if let Some(v) = entries.get_mut(&k) {
                    v.retain(|s| s.file != file);
                }
            }
        }
        let mut keys = Vec::new();
        for stub in stubs {
            keys.push(stub.key.clone());
            entries.entry(stub.key.clone()).or_default().push(stub);
        }
        by_file.insert(file, keys);
    }

    fn lookup(&self, key: &str) -> Vec<Stub> {
        self.entries.lock().unwrap().get(key).cloned().unwrap_or_default()
    }

    fn remove_file(&self, file: DocId) {
        self.index(file, Vec::new());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Clone)]
    struct FakeEl {
        kind: &'static str,
        range: Range,
        text: String,
    }
    impl PsiElement for FakeEl {
        fn kind(&self) -> &'static str {
            self.kind
        }
        fn range(&self) -> Range {
            self.range
        }
        fn text(&self) -> &str {
            &self.text
        }
        fn parent(&self) -> Option<Arc<dyn PsiElement>> {
            None
        }
        fn children(&self) -> Vec<Arc<dyn PsiElement>> {
            Vec::new()
        }
    }

    #[test]
    fn stub_index_round_trips_and_removes() {
        let idx = InMemoryStubIndex::default();
        let doc = DocId::next();
        idx.index(
            doc,
            vec![Stub { key: "Foo".into(), kind: "class", file: doc, range: Range::default() }],
        );
        assert_eq!(idx.lookup("Foo").len(), 1);
        idx.remove_file(doc);
        assert!(idx.lookup("Foo").is_empty());
    }

    #[test]
    fn stub_index_replaces_on_reindex() {
        let idx = InMemoryStubIndex::default();
        let doc = DocId::next();
        idx.index(doc, vec![Stub { key: "Foo".into(), kind: "class", file: doc, range: Range::default() }]);
        idx.index(doc, vec![Stub { key: "Bar".into(), kind: "class", file: doc, range: Range::default() }]);
        assert!(idx.lookup("Foo").is_empty());
        assert_eq!(idx.lookup("Bar").len(), 1);
    }
}
