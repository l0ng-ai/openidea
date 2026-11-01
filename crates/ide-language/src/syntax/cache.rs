//! Syntax trees of open documents, kept up to date incrementally.
//!
//! Edits are applied to the cached tree as they happen (`Tree::edit`, cheap);
//! the re-parse is deferred to the next query and reuses the edited tree, so
//! Structure / folding / Extend Selection on a large file cost an incremental
//! parse instead of a full one.

use super::{
    Grammar, MAX_PARSE_BYTES, ParsedTree, Syntax, SyntaxHighlights, TreeError, folding, highlight, outline,
    parse_cancellable, selection,
};
use crate::FoldRange;
use ide_core::{DocId, LanguageId, OutlineItem, Range};
use ide_text::ByteEdit;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use tree_sitter::{InputEdit, Point, Tree};

/// At most this many trees are kept; the least recently used are dropped.
pub const MAX_CACHED_TREES: usize = 24;

/// Counters for diagnostics (`app_metrics`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxCacheStats {
    /// Documents tracked (open and observed).
    pub documents: u32,
    /// Documents with a cached tree.
    pub trees: u32,
    /// Total text size of the documents with a cached tree.
    pub tree_text_bytes: u64,
    /// Queries answered from an up-to-date tree.
    pub hits: u64,
    /// Queries that re-parsed incrementally from an edited tree.
    pub incremental_parses: u64,
    /// Queries that parsed from scratch.
    pub full_parses: u64,
}

struct Entry {
    lang: LanguageId,
    /// Version of the document the tree (after `edit`s) describes.
    version: u32,
    tree: Option<Tree>,
    /// `tree` was edited since its last parse and must be re-parsed before use.
    stale: bool,
    text_bytes: usize,
    last_used: Instant,
    memo: Memo,
}

/// Outline / folding computed from the tree at `version`. Several views ask
/// for the same version (Structure, breadcrumbs, code lens, folding gutter);
/// on a large file each answer is a walk over ~10⁶ nodes.
#[derive(Default)]
struct Memo {
    key: Option<(u32, LanguageId)>,
    outline: Option<Arc<Vec<OutlineItem>>>,
    folding: Option<Arc<Vec<FoldRange>>>,
    highlights: Option<Arc<Vec<u32>>>,
}

impl Memo {
    fn is_for(&self, version: u32, lang: &LanguageId) -> bool {
        self.key.as_ref().is_some_and(|(v, l)| *v == version && l == lang)
    }

    /// Slot for results of `version`, dropping results of other versions.
    fn at(&mut self, version: u32, lang: &LanguageId) -> &mut Self {
        if !self.is_for(version, lang) {
            *self = Self { key: Some((version, lang.clone())), ..Self::default() };
        }
        self
    }
}

/// Per-document tree cache. Feed it from a document observer (`open` / `edit`
/// / `close`) and query it with the document's current text and version.
pub struct SyntaxCache {
    syntax: Arc<Syntax>,
    entries: Mutex<HashMap<DocId, Arc<Mutex<Entry>>>>,
    hits: AtomicU64,
    incremental: AtomicU64,
    full: AtomicU64,
}

fn point(p: ide_text::BytePoint) -> Point {
    Point { row: p.row, column: p.col }
}

fn input_edit(e: &ByteEdit) -> InputEdit {
    InputEdit {
        start_byte: e.start_byte,
        old_end_byte: e.old_end_byte,
        new_end_byte: e.new_end_byte,
        start_position: point(e.start),
        old_end_position: point(e.old_end),
        new_end_position: point(e.new_end),
    }
}

impl SyntaxCache {
    pub fn new(syntax: Arc<Syntax>) -> Self {
        Self {
            syntax,
            entries: Mutex::default(),
            hits: AtomicU64::new(0),
            incremental: AtomicU64::new(0),
            full: AtomicU64::new(0),
        }
    }

    pub fn syntax(&self) -> &Arc<Syntax> {
        &self.syntax
    }

    /// Starts tracking a document. Nothing is parsed until the first query.
    pub fn open(&self, doc: DocId, lang: &LanguageId, version: u32) {
        let entry = Entry {
            lang: lang.clone(),
            version,
            tree: None,
            stale: false,
            text_bytes: 0,
            last_used: Instant::now(),
            memo: Memo::default(),
        };
        self.entries.lock().insert(doc, Arc::new(Mutex::new(entry)));
    }

    /// Applies the byte edits that took the document to `version`.
    pub fn edit(&self, doc: DocId, version: u32, edits: &[ByteEdit]) {
        let Some(slot) = self.entries.lock().get(&doc).cloned() else { return };
        let mut e = slot.lock();
        if e.version.wrapping_add(1) != version {
            // Missed an edit: the tree cannot be trusted any more.
            e.tree = None;
        } else if let Some(tree) = e.tree.as_mut() {
            for edit in edits {
                tree.edit(&input_edit(edit));
            }
            e.stale |= !edits.is_empty();
        }
        e.version = version;
    }

    pub fn close(&self, doc: DocId) {
        self.entries.lock().remove(&doc);
    }

    /// Drops every cached tree (documents stay tracked). Returns how many were dropped.
    pub fn clear(&self) -> usize {
        let slots: Vec<_> = self.entries.lock().values().cloned().collect();
        slots
            .iter()
            .filter(|s| {
                let mut e = s.lock();
                e.text_bytes = 0;
                e.memo = Memo::default();
                e.tree.take().is_some()
            })
            .count()
    }

    pub fn stats(&self) -> SyntaxCacheStats {
        let slots: Vec<_> = self.entries.lock().values().cloned().collect();
        let mut stats = SyntaxCacheStats {
            documents: slots.len() as u32,
            hits: self.hits.load(Ordering::Relaxed),
            incremental_parses: self.incremental.load(Ordering::Relaxed),
            full_parses: self.full.load(Ordering::Relaxed),
            ..Default::default()
        };
        for s in &slots {
            let e = s.lock();
            if e.tree.is_some() {
                stats.trees += 1;
                stats.tree_text_bytes += e.text_bytes as u64;
            }
        }
        stats
    }

    pub fn outline(&self, doc: DocId, lang: &LanguageId, version: u32, text: &str) -> Vec<OutlineItem> {
        self.memoized(
            doc,
            lang,
            version,
            |m| &mut m.outline,
            || {
                self.with_tree(doc, lang, version, text, |g, tree, text| {
                    let query = g.outline_query()?;
                    Some(outline::outline(g, query, tree, text))
                })
            },
        )
    }

    pub fn folding(&self, doc: DocId, lang: &LanguageId, version: u32, text: &str) -> Vec<FoldRange> {
        self.memoized(
            doc,
            lang,
            version,
            |m| &mut m.folding,
            || {
                self.with_tree(doc, lang, version, text, |g, tree, text| {
                    Some(folding::folding(g.spec, g.kinds(), tree, text, self.syntax.comment_tokens(lang)))
                })
                .or_else(|| Some(self.syntax.custom_folding(lang, text)))
            },
        )
    }

    /// Highlighting from the grammar's own query; empty without one.
    pub fn highlights(&self, doc: DocId, lang: &LanguageId, version: u32, text: &str) -> SyntaxHighlights {
        SyntaxHighlights::new(self.memoized(
            doc,
            lang,
            version,
            |m| &mut m.highlights,
            || {
                self.with_tree(doc, lang, version, text, |g, tree, text| {
                    Some(highlight::highlights(g.highlight_query()?, tree, text))
                })
            },
        ))
    }

    /// `compute()` once per document version; `None` (no grammar / query) is not memoized.
    fn memoized<T: Clone>(
        &self,
        doc: DocId,
        lang: &LanguageId,
        version: u32,
        slot: impl Fn(&mut Memo) -> &mut Option<Arc<Vec<T>>>,
        compute: impl FnOnce() -> Option<Vec<T>>,
    ) -> Vec<T> {
        let entry = self.entries.lock().get(&doc).cloned();
        if let Some(e) = &entry {
            let mut e = e.lock();
            if e.memo.is_for(version, lang)
                && let Some(hit) = slot(&mut e.memo).clone()
            {
                self.hits.fetch_add(1, Ordering::Relaxed);
                return (*hit).clone();
            }
        }
        let Some(result) = compute() else { return Vec::new() };
        if let Some(e) = &entry {
            let mut e = e.lock();
            // Not if the document moved on (or its tree was dropped) meanwhile.
            if e.version == version && e.tree.is_some() {
                *slot(e.memo.at(version, lang)) = Some(Arc::new(result.clone()));
            }
        }
        result
    }

    pub fn selection_ranges(
        &self,
        doc: DocId,
        lang: &LanguageId,
        version: u32,
        text: &str,
        offset_utf16: u32,
    ) -> Vec<Range> {
        self.with_tree(doc, lang, version, text, |_, tree, text| {
            Some(selection::selection_ranges(tree, text, offset_utf16))
        })
        .unwrap_or_else(|| selection::plain_selection_ranges(text, offset_utf16))
    }

    /// Lends an up-to-date tree for `text` (the document at `version`) to `f`;
    /// the parse (incremental when possible) gives up once `cancelled` returns
    /// true. Analysis crates (`ide-syntax`) build on this.
    pub fn with_parsed<R>(
        &self,
        doc: DocId,
        lang: &LanguageId,
        version: u32,
        text: &str,
        cancelled: &dyn Fn() -> bool,
        f: impl FnOnce(ParsedTree<'_>) -> R,
    ) -> Result<R, TreeError> {
        let (g, tree) = self.tree_for(doc, lang, version, text, cancelled)?;
        Ok(f(ParsedTree { grammar: g.spec.name, language: &g.language, tree: &tree, text }))
    }

    /// Runs `f` on an up-to-date tree for `text` (the document at `version`).
    fn with_tree<R>(
        &self,
        doc: DocId,
        lang: &LanguageId,
        version: u32,
        text: &str,
        f: impl FnOnce(&Grammar, &Tree, &str) -> Option<R>,
    ) -> Option<R> {
        let (g, tree) = self.tree_for(doc, lang, version, text, &|| false).ok()?;
        f(g, &tree, text)
    }

    /// An up-to-date tree for `text` (the document at `version`).
    ///
    /// The entry lock is never held while parsing, so edits (which arrive on
    /// the typing path) never wait for a parse. A tree parsed for a version
    /// that was superseded meanwhile is used for this answer but not stored.
    fn tree_for(
        &self,
        doc: DocId,
        lang: &LanguageId,
        version: u32,
        text: &str,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(&Grammar, Tree), TreeError> {
        let g = self.syntax.grammar(lang).ok_or(TreeError::Unsupported)?;
        if text.len() > MAX_PARSE_BYTES {
            return Err(TreeError::TooLarge);
        }
        let slot = self.entries.lock().get(&doc).cloned();
        let (old, fresh) = match &slot {
            Some(slot) => {
                let mut e = slot.lock();
                e.last_used = Instant::now();
                if e.version == version && e.lang == *lang { (e.tree.clone(), !e.stale) } else { (None, false) }
            }
            None => (None, false),
        };
        let tree = match old {
            Some(tree) if fresh => {
                self.hits.fetch_add(1, Ordering::Relaxed);
                tree
            }
            old => {
                let counter = if old.is_some() { &self.incremental } else { &self.full };
                let tree = parse_cancellable(&g.language, text, old.as_ref(), cancelled)?;
                counter.fetch_add(1, Ordering::Relaxed);
                if let Some(slot) = &slot {
                    let mut e = slot.lock();
                    if e.version == version {
                        e.tree = Some(tree.clone());
                        e.stale = false;
                        e.lang = lang.clone();
                        e.text_bytes = text.len();
                    }
                }
                self.evict(doc);
                tree
            }
        };
        Ok((g, tree))
    }

    /// Keeps at most [`MAX_CACHED_TREES`] trees, never evicting `keep`.
    fn evict(&self, keep: DocId) {
        let slots: Vec<(DocId, Arc<Mutex<Entry>>)> =
            self.entries.lock().iter().map(|(id, s)| (*id, s.clone())).collect();
        let mut with_tree: Vec<(Instant, DocId, &Arc<Mutex<Entry>>)> = slots
            .iter()
            .filter(|(id, _)| *id != keep)
            .filter_map(|(id, s)| {
                let e = s.lock();
                e.tree.is_some().then_some((e.last_used, *id, s))
            })
            .collect();
        let limit = MAX_CACHED_TREES.saturating_sub(1);
        if with_tree.len() <= limit {
            return;
        }
        with_tree.sort_by_key(|(t, _, _)| *t);
        let excess = with_tree.len() - limit;
        for (_, _, s) in with_tree.into_iter().take(excess) {
            let mut e = s.lock();
            e.tree = None;
            e.text_bytes = 0;
            e.memo = Memo::default();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{ChangeSet, TextChange};
    use ide_text::Document;

    fn cache() -> SyntaxCache {
        SyntaxCache::new(Arc::new(Syntax::new()))
    }

    fn rust() -> LanguageId {
        LanguageId::new("rust")
    }

    const SRC: &str = "struct A { x: u32 }\n\nimpl A {\n    fn one(&self) -> u32 {\n        self.x\n    }\n}\n\n// a\n// b\nfn main() {\n    let v = vec![1, 2, 3];\n}\n";

    fn edit(doc: &mut Document, from: u32, to: u32, insert: &str) -> Vec<ByteEdit> {
        let cs = ChangeSet { changes: vec![TextChange { from, to, insert: insert.into() }] };
        doc.apply_detailed(doc.version(), &cs).unwrap().1
    }

    #[test]
    fn incremental_results_match_full_parse() {
        let cache = cache();
        let id = DocId::next();
        let mut doc = Document::new(SRC);
        cache.open(id, &rust(), doc.version());
        let first = cache.outline(id, &rust(), 0, &doc.text());
        assert_eq!(first, cache.syntax().outline(&rust(), SRC));
        assert_eq!(cache.stats().full_parses, 1);
        cache.folding(id, &rust(), 0, &doc.text());
        assert_eq!(cache.stats().hits, 1);

        // A pseudo-random sequence of edits, compared against from-scratch parses.
        let inserts = ["fn two() {}\n", "x", "\n", "}", "impl B { fn b(&self) {} }\n", "/* c */", "é😀"];
        let mut seed = 17u32;
        for round in 0..60 {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let len = doc.len_utf16();
            let at = doc.pos_to_offset(doc.offset_to_pos(seed % (len + 1)));
            let del = if round % 3 == 0 { (seed >> 8) % 4 } else { 0 };
            let to = doc.pos_to_offset(doc.offset_to_pos((at + del).min(len)));
            let edits = edit(&mut doc, at, to, inserts[(seed >> 16) as usize % inserts.len()]);
            cache.edit(id, doc.version(), &edits);
            let text = doc.text();
            let v = doc.version();
            assert_eq!(cache.outline(id, &rust(), v, &text), cache.syntax().outline(&rust(), &text), "round {round}");
            assert_eq!(cache.folding(id, &rust(), v, &text), cache.syntax().folding(&rust(), &text), "round {round}");
            let off = seed % (doc.len_utf16() + 1);
            assert_eq!(
                cache.selection_ranges(id, &rust(), v, &text, off),
                cache.syntax().selection_ranges(&rust(), &text, off),
                "round {round}"
            );
        }
        let stats = cache.stats();
        assert_eq!(stats.full_parses, 1, "{stats:?}");
        assert_eq!(stats.incremental_parses, 60);
        assert!(stats.hits >= 120);
        assert_eq!((stats.documents, stats.trees), (1, 1));
    }

    #[test]
    fn repeated_queries_for_a_version_reuse_the_result() {
        let cache = cache();
        let id = DocId::next();
        let mut doc = Document::new(SRC);
        cache.open(id, &rust(), 0);
        let text = doc.text();
        let outline = cache.outline(id, &rust(), 0, &text);
        let folds = cache.folding(id, &rust(), 0, &text);
        let before = cache.stats();
        assert_eq!(cache.outline(id, &rust(), 0, &text), outline);
        assert_eq!(cache.folding(id, &rust(), 0, &text), folds);
        let after = cache.stats();
        assert_eq!(after.hits, before.hits + 2);
        assert_eq!((after.full_parses, after.incremental_parses), (before.full_parses, before.incremental_parses));

        // After an edit the answer describes the new text.
        let edits = edit(&mut doc, 0, 0, "fn added() {}\n");
        cache.edit(id, doc.version(), &edits);
        let text = doc.text();
        let edited = cache.outline(id, &rust(), 1, &text);
        assert_eq!(edited, cache.syntax().outline(&rust(), &text));
        assert_ne!(edited, outline);
        // Another language at the same version is not answered from the memo.
        assert!(cache.outline(id, &LanguageId::new("plaintext"), 1, &text).is_empty());
    }

    #[test]
    fn version_mismatch_and_lifecycle() {
        let cache = cache();
        let id = DocId::next();
        let mut doc = Document::new(SRC);
        cache.open(id, &rust(), 0);
        cache.outline(id, &rust(), 0, &doc.text());
        // An edit the cache never saw: next edit notification is out of order.
        edit(&mut doc, 0, 0, "// x\n");
        let edits = edit(&mut doc, 0, 0, "// y\n");
        cache.edit(id, doc.version(), &edits);
        let text = doc.text();
        assert_eq!(cache.outline(id, &rust(), 2, &text), cache.syntax().outline(&rust(), &text));
        assert_eq!(cache.stats().full_parses, 2, "dropped tree re-parses from scratch");

        // A query for a version the cache has not reached is answered but not stored.
        let before = cache.stats();
        cache.outline(id, &rust(), 7, &text);
        cache.outline(id, &rust(), 2, &text);
        let after = cache.stats();
        assert_eq!(after.full_parses, before.full_parses + 1);
        assert_eq!(after.hits, before.hits + 1);

        assert_eq!(cache.clear(), 1);
        assert_eq!(cache.stats().trees, 0);
        cache.close(id);
        assert_eq!(cache.stats().documents, 0);
        // Untracked documents and unsupported languages still work.
        assert!(!cache.outline(id, &rust(), 2, &text).is_empty());
        assert!(cache.outline(id, &LanguageId::new("plaintext"), 0, "x").is_empty());
        assert!(!cache.selection_ranges(id, &LanguageId::new("plaintext"), 0, "ab cd", 1).is_empty());
    }

    #[test]
    fn evicts_least_recently_used() {
        let cache = cache();
        let ids: Vec<DocId> = (0..MAX_CACHED_TREES + 4).map(|_| DocId::next()).collect();
        for id in &ids {
            cache.open(*id, &rust(), 0);
            cache.outline(*id, &rust(), 0, SRC);
        }
        let stats = cache.stats();
        assert_eq!(stats.trees as usize, MAX_CACHED_TREES);
        assert_eq!(stats.documents as usize, ids.len());
        // The most recent one is still cached.
        let hits = stats.hits;
        cache.outline(*ids.last().unwrap(), &rust(), 0, SRC);
        assert_eq!(cache.stats().hits, hits + 1);
    }
}
