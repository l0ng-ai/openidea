//! Parse cache for open documents, keyed by `(DocId, version)`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use ide_core::DocId;

use super::ParsedFile;

/// Keeps the newest parse of each open document.
///
/// Only one version per document is kept: an edit makes the previous parse
/// useless. Parsing happens outside the lock, so concurrent requests for
/// different documents don't wait on each other; two requests for the same
/// new version may both parse, and the first one stored wins. A parse never
/// replaces a newer version that is already cached.
#[derive(Default)]
pub struct ParseCache {
    entries: Mutex<HashMap<DocId, (u32, Arc<ParsedFile>)>>,
}

impl ParseCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<DocId, (u32, Arc<ParsedFile>)>> {
        // A panic while holding the lock can't leave the map inconsistent.
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The cached parse of exactly `version`, if any.
    pub fn get(&self, doc: DocId, version: u32) -> Option<Arc<ParsedFile>> {
        self.lock().get(&doc).filter(|(v, _)| *v == version).map(|(_, file)| file.clone())
    }

    /// The cached parse of `version`, parsing `text()` on a miss.
    pub fn get_or_parse(&self, doc: DocId, version: u32, text: impl FnOnce() -> Arc<str>) -> Arc<ParsedFile> {
        if let Some(file) = self.get(doc, version) {
            return file;
        }
        let parsed = Arc::new(ParsedFile::parse(&format!("doc:{}", doc.0), text()));
        let mut entries = self.lock();
        match entries.get(&doc) {
            Some((v, file)) if *v == version => file.clone(),
            Some((v, _)) if *v > version => parsed,
            _ => {
                entries.insert(doc, (version, parsed.clone()));
                parsed
            }
        }
    }

    /// Forgets a document, e.g. when it is closed.
    pub fn remove(&self, doc: DocId) {
        self.lock().remove(&doc);
    }

    /// The cached version of `doc`.
    pub fn version(&self, doc: DocId) -> Option<u32> {
        self.lock().get(&doc).map(|(v, _)| *v)
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    pub fn clear(&self) {
        self.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn text(s: &str) -> impl FnOnce() -> Arc<str> + '_ {
        move || Arc::from(s)
    }

    #[test]
    fn hits_reuse_the_same_parse() {
        let cache = ParseCache::new();
        let doc = DocId(1);
        let a = cache.get_or_parse(doc, 1, text("<?php echo 1;"));
        let parses = Cell::new(0);
        let b = cache.get_or_parse(doc, 1, || {
            parses.set(parses.get() + 1);
            Arc::from("<?php echo 2;")
        });
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(parses.get(), 0);
        assert_eq!(cache.get(doc, 1).map(|f| f.text().to_owned()).as_deref(), Some("<?php echo 1;"));
    }

    #[test]
    fn a_new_version_replaces_the_old_one() {
        let cache = ParseCache::new();
        let doc = DocId(1);
        cache.get_or_parse(doc, 1, text("<?php a();"));
        let v2 = cache.get_or_parse(doc, 2, text("<?php b();"));
        assert_eq!(v2.text(), "<?php b();");
        assert_eq!(cache.version(doc), Some(2));
        assert!(cache.get(doc, 1).is_none());
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn an_older_version_never_replaces_a_newer_one() {
        let cache = ParseCache::new();
        let doc = DocId(1);
        cache.get_or_parse(doc, 5, text("<?php new_();"));
        let old = cache.get_or_parse(doc, 4, text("<?php old();"));
        assert_eq!(old.text(), "<?php old();");
        assert_eq!(cache.version(doc), Some(5));
    }

    #[test]
    fn documents_are_independent_and_removable() {
        let cache = ParseCache::new();
        cache.get_or_parse(DocId(1), 1, text("<?php 1;"));
        cache.get_or_parse(DocId(2), 1, text("<?php 2;"));
        assert_eq!(cache.len(), 2);
        cache.remove(DocId(1));
        assert!(cache.get(DocId(1), 1).is_none());
        assert!(cache.get(DocId(2), 1).is_some());
        cache.clear();
        assert!(cache.is_empty());
    }

    #[test]
    fn shared_across_threads() {
        let cache = Arc::new(ParseCache::new());
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let cache = cache.clone();
                std::thread::spawn(move || {
                    let file = cache.get_or_parse(DocId(i % 2), 1, || Arc::from(format!("<?php f{};", i % 2)));
                    assert!(!file.has_errors());
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(cache.len(), 2);
    }
}
