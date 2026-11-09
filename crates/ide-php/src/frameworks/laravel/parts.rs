//! How the readers of the Laravel project model get what they read from
//! single files (roadmap phase 8.22).
//!
//! A reader asks a [`PartReader`] for each file's part (the configuration
//! keys of one `config/*.php`, the translations of one language file, the
//! routes of one route file) rather than reading the file itself. The
//! engine's reader keeps the parts with the stamp of the text they were read
//! from (`crate::engine::parts`), so a build after an edit reads only the
//! files the edit touched; [`TextParts`] reads every file every time, for
//! callers without an engine.
//!
//! The large tables ([`super::ConfigKeys`], [`super::Translations`]) keep
//! the parts as they come, one `Arc` per file, in [`Merged`]: the model
//! shares them with the cache instead of copying them, and only the order
//! of their entries is its own (and is reused when no part changed).

use std::cmp::Ordering;
use std::path::Path;
use std::sync::Arc;

use super::ViewEntry;

/// Where a reader gets the parts of single files.
pub trait PartReader {
    /// The part of `kind` for `path`: `build` applied to its text (an open
    /// buffer first), or what it built before from the same text in the
    /// same `context`. `None` when the file can't be read.
    fn part<T: Send + Sync + 'static>(
        &self,
        kind: &'static str,
        path: &Path,
        context: &str,
        build: &dyn Fn(&str) -> T,
    ) -> Option<Arc<T>>;

    /// The views below the folder `base` (named in `namespace`): `list`, or
    /// what it listed before when no file was created or removed since.
    fn views_below(
        &self,
        base: &Path,
        namespace: Option<&str>,
        list: &dyn Fn() -> Vec<ViewEntry>,
    ) -> Arc<Vec<ViewEntry>>;
}

/// A [`PartReader`] that keeps nothing: every part is built again from the
/// text `text_of` reads.
pub struct TextParts<F>(pub F);

impl<F: Fn(&Path) -> Option<String>> PartReader for TextParts<F> {
    fn part<T: Send + Sync + 'static>(
        &self,
        _kind: &'static str,
        path: &Path,
        _context: &str,
        build: &dyn Fn(&str) -> T,
    ) -> Option<Arc<T>> {
        (self.0)(path).map(|text| Arc::new(build(&text)))
    }

    fn views_below(
        &self,
        _base: &Path,
        _namespace: Option<&str>,
        list: &dyn Fn() -> Vec<ViewEntry>,
    ) -> Arc<Vec<ViewEntry>> {
        Arc::new(list())
    }
}

/// Entries kept per file, as the files' parts came, and read in one sorted
/// order through an index of their own.
#[derive(Clone, Debug)]
pub struct Merged<E> {
    files: Vec<Arc<Vec<E>>>,
    /// `(file, entry)`, sorted; of entries comparing equal, the first in
    /// file order is kept.
    order: Arc<[(u32, u32)]>,
}

impl<E> Default for Merged<E> {
    fn default() -> Self {
        Self { files: Vec::new(), order: Arc::from([]) }
    }
}

impl<E: PartialEq> PartialEq for Merged<E> {
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().eq(other.iter())
    }
}

impl<E: Eq> Eq for Merged<E> {}

impl<E> Merged<E> {
    /// The entries of `files` sorted by `cmp`, keeping the first of entries
    /// that compare equal. When `previous` was built from the very same
    /// parts, its order is reused rather than sorted again.
    pub fn new(files: Vec<Arc<Vec<E>>>, cmp: impl Fn(&E, &E) -> Ordering, previous: Option<&Self>) -> Self {
        if let Some(previous) = previous
            && previous.files.len() == files.len()
            && previous.files.iter().zip(&files).all(|(a, b)| Arc::ptr_eq(a, b))
        {
            return Self { files, order: previous.order.clone() };
        }
        let mut order: Vec<(u32, u32)> = files
            .iter()
            .enumerate()
            .flat_map(|(file, entries)| (0..entries.len()).map(move |entry| (file as u32, entry as u32)))
            .collect();
        let at = |(file, entry): (u32, u32)| &files[file as usize][entry as usize];
        // Stable: entries comparing equal stay in file order.
        order.sort_by(|a, b| cmp(at(*a), at(*b)));
        order.dedup_by(|later, earlier| cmp(at(*later), at(*earlier)) == Ordering::Equal);
        Self { files, order: order.into() }
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// The `n`th entry in order.
    pub fn get(&self, n: usize) -> Option<&E> {
        let (file, entry) = *self.order.get(n)?;
        Some(&self.files[file as usize][entry as usize])
    }

    /// The entries in order.
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &E> + ExactSizeIterator + Clone + '_ {
        self.order.iter().map(|(file, entry)| &self.files[*file as usize][*entry as usize])
    }

    /// The index of the first entry for which `pred` is false (the entries
    /// are partitioned by it, as by `slice::partition_point`).
    pub fn partition_point(&self, pred: impl Fn(&E) -> bool) -> usize {
        self.order.partition_point(|(file, entry)| pred(&self.files[*file as usize][*entry as usize]))
    }

    /// The entries in order from the `n`th.
    pub fn iter_from(&self, n: usize) -> impl Iterator<Item = &E> + '_ {
        self.order[n.min(self.order.len())..].iter().map(|(file, entry)| &self.files[*file as usize][*entry as usize])
    }

    /// The parts, in file order.
    pub fn files(&self) -> &[Arc<Vec<E>>] {
        &self.files
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merged_sorts_keeps_the_first_and_reuses_the_order() {
        let a = Arc::new(vec![("b", 1), ("a", 1)]);
        let b = Arc::new(vec![("a", 2), ("c", 2)]);
        let merged = Merged::new(vec![a.clone(), b.clone()], |x, y| x.0.cmp(y.0), None);
        assert_eq!(merged.iter().copied().collect::<Vec<_>>(), [("a", 1), ("b", 1), ("c", 2)]);
        assert_eq!(merged.partition_point(|e| e.0 < "b"), 1);
        assert_eq!(merged.get(2), Some(&("c", 2)));

        let again = Merged::new(vec![a.clone(), b.clone()], |_, _| unreachable!("not sorted again"), Some(&merged));
        assert!(Arc::ptr_eq(&again.order, &merged.order));
        assert!(Arc::ptr_eq(&again.files()[0], &a), "the parts are shared, not copied");

        let changed = Arc::new(vec![("d", 3)]);
        let other = Merged::new(vec![a, changed], |x, y| x.0.cmp(y.0), Some(&merged));
        assert_eq!(other.iter().map(|e| e.0).collect::<Vec<_>>(), ["a", "b", "d"]);
    }
}
