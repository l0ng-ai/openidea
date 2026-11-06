//! In-memory index: one slot per file, symbols stored with their file.

use ide_core::{Range, SymbolKind};
use ide_language::Facts;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Bit set of the (lower-cased) ASCII letters/digits/punctuation present in a
/// string; a cheap pre-filter before fuzzy matching (query mask ⊆ haystack mask).
pub(crate) fn char_mask(s: &str) -> u64 {
    let mut m = 0u64;
    for b in s.bytes() {
        m |= mask_bit(b);
    }
    m
}

#[inline]
pub(crate) fn mask_bit(b: u8) -> u64 {
    match b.to_ascii_lowercase() {
        c @ b'a'..=b'z' => 1 << (c - b'a'),
        c @ b'0'..=b'9' => 1 << (26 + c - b'0'),
        b'_' => 1 << 36,
        b'-' => 1 << 37,
        b'.' => 1 << 38,
        b'/' => 1 << 39,
        b'$' => 1 << 40,
        b':' => 1 << 41,
        b'~' => 1 << 42,
        b'#' => 1 << 43,
        b if b >= 0x80 => 1 << 63,
        _ => 0,
    }
}

/// Persisted per-file record (postcard in redb, keyed by the relative path).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct FileRecord {
    pub mtime: u64,
    pub size: u64,
    pub hash: [u8; 32],
    pub symbols: Vec<StoredSymbol>,
    /// Import/export/declaration facts of TS/JS sources and the `<script>`
    /// regions of Vue SFCs / HTML documents; empty for other languages.
    pub facts: Facts,
    /// Identifier and component-tag occurrences (find-usages index input);
    /// empty for other languages.
    pub occurrences: Vec<StoredOccurrence>,
    /// Matched by an ignore file: listed by name only (no hash, no symbols).
    pub ignored: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredOccurrence {
    pub name: String,
    pub range: Range,
    pub qualified: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub container: Option<String>,
    pub range: Range,
}

pub(crate) struct Sym {
    pub name: Box<str>,
    pub kind: SymbolKind,
    pub container: Option<Box<str>>,
    pub range: Range,
    pub mask: u64,
}

pub(crate) struct FileEntry {
    pub path: PathBuf,
    /// `/`-separated path relative to the root, as displayed.
    pub rel: Box<str>,
    /// Byte offset of the file name inside `rel`.
    pub name_start: u32,
    /// Char offset of the file name inside `rel`.
    pub name_start_chars: u32,
    pub rel_mask: u64,
    pub name_mask: u64,
    pub mtime: u64,
    pub size: u64,
    pub hash: [u8; 32],
    pub symbols: Box<[Sym]>,
    pub facts: Facts,
    /// The file's own occurrences (names + ranges), for inverted-map removal.
    pub occurrences: Box<[(Box<str>, Range, bool)]>,
    pub ignored: bool,
}

impl FileEntry {
    pub(crate) fn new(path: PathBuf, rel: String, record: FileRecord) -> Self {
        let name_start = rel.rfind('/').map_or(0, |i| i + 1);
        let name = &rel[name_start..];
        let symbols = record
            .symbols
            .into_iter()
            .map(|s| Sym {
                mask: char_mask(&s.name),
                name: s.name.into_boxed_str(),
                kind: s.kind,
                container: s.container.map(String::into_boxed_str),
                range: s.range,
            })
            .collect();
        Self {
            name_start_chars: rel[..name_start].chars().count() as u32,
            name_mask: char_mask(name),
            rel_mask: char_mask(&rel),
            name_start: name_start as u32,
            path,
            rel: rel.into_boxed_str(),
            mtime: record.mtime,
            size: record.size,
            hash: record.hash,
            symbols,
            facts: record.facts,
            occurrences: record
                .occurrences
                .into_iter()
                .map(|o| (o.name.into_boxed_str(), o.range, o.qualified))
                .collect(),
            ignored: record.ignored,
        }
    }

    pub(crate) fn name(&self) -> &str {
        &self.rel[self.name_start as usize..]
    }

    pub(crate) fn dir(&self) -> &str {
        &self.rel[..self.name_start as usize]
    }

    pub(crate) fn record(&self) -> FileRecord {
        FileRecord {
            mtime: self.mtime,
            size: self.size,
            hash: self.hash,
            facts: self.facts.clone(),
            occurrences: self
                .occurrences
                .iter()
                .map(|(name, range, qualified)| StoredOccurrence {
                    name: name.to_string(),
                    range: *range,
                    qualified: *qualified,
                })
                .collect(),
            symbols: self
                .symbols
                .iter()
                .map(|s| StoredSymbol {
                    name: s.name.to_string(),
                    kind: s.kind,
                    container: s.container.as_deref().map(str::to_owned),
                    range: s.range,
                })
                .collect(),
            ignored: self.ignored,
        }
    }

    /// Whether the entry is out of date for `found` on disk.
    pub(crate) fn stale_for(&self, found: &crate::filter::Found) -> bool {
        self.mtime != found.mtime || self.size != found.size || self.ignored != found.ignored
    }
}

/// One occurrence entry in the inverted map: the file's slot in `files`.
#[derive(Clone, Debug)]
pub(crate) struct OccSlot {
    pub slot: u32,
    pub range: Range,
    pub qualified: bool,
}

#[derive(Default)]
pub(crate) struct IndexData {
    pub files: Vec<Option<FileEntry>>,
    by_path: HashMap<PathBuf, u32>,
    /// Identifier/component occurrences by name: inverted find-usages index.
    /// Entries reference files by their slot; removal re-filters each name's
    /// list from the entry's own occurrence list.
    occ_by_name: HashMap<Box<str>, Vec<OccSlot>>,
    occ_total: u32,
    /// Every folder holding an indexed file at any depth, keyed by its `rel` with a
    /// trailing `/`: its absolute path and the number of files below it.
    pub dirs: HashMap<Box<str>, (PathBuf, u32)>,
    free: Vec<u32>,
    pub file_count: u32,
    pub symbol_count: u32,
}

impl IndexData {
    pub(crate) fn get(&self, path: &Path) -> Option<&FileEntry> {
        self.by_path.get(path).and_then(|&i| self.files[i as usize].as_ref())
    }

    /// Files and ranges where `name` occurs (identifiers, component tags).
    pub(crate) fn occurrences_of(&self, name: &str) -> Vec<(PathBuf, Range)> {
        self.occ_by_name
            .get(name)
            .map(|list| {
                list.iter()
                    .filter_map(|o| Some((self.files.get(o.slot as usize)?.as_ref()?.path.clone(), o.range)))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn occ_add(&mut self, slot: u32, entry: &FileEntry) {
        for (name, range, qualified) in &entry.occurrences {
            self.occ_by_name.entry(name.clone()).or_default().push(OccSlot {
                slot,
                range: *range,
                qualified: *qualified,
            });
            self.occ_total += 1;
        }
    }

    fn occ_remove(&mut self, slot: u32, entry: &FileEntry) {
        for (name, ..) in &entry.occurrences {
            if let Some(list) = self.occ_by_name.get_mut(name.as_ref()) {
                list.retain(|o| o.slot != slot);
                if list.is_empty() {
                    self.occ_by_name.remove(name.as_ref());
                }
            }
        }
        self.occ_total -= entry.occurrences.len() as u32;
    }

    pub(crate) fn slot(&self, path: &Path) -> Option<u32> {
        self.by_path.get(path).copied()
    }

    pub(crate) fn insert(&mut self, entry: FileEntry) {
        let symbols = entry.symbols.len() as u32;
        // The entry's occurrences, staged so the move into `files` (which
        // borrows self mutably) and the map insert (also self) don't collide.
        let mut occs_staging: Vec<(Box<str>, Range, bool)> =
            entry.occurrences.iter().map(|(name, range, qualified)| (name.clone(), *range, *qualified)).collect();
        if let Some(&slot) = self.by_path.get(&entry.path) {
            if let Some(old) = self.files[slot as usize].take() {
                self.occ_remove(slot, &old);
                self.symbol_count -= old.symbols.len() as u32;
            }
            self.occ_add(slot, &entry);
            self.symbol_count += symbols;
            self.files[slot as usize] = Some(entry);
            return;
        }
        let slot = match self.free.pop() {
            Some(slot) => {
                self.files[slot as usize] = Some(entry);
                slot
            }
            None => {
                self.files.push(Some(entry));
                (self.files.len() - 1) as u32
            }
        };
        let path = self.files[slot as usize].as_ref().map(|e| e.path.clone()).unwrap_or_default();
        if let Some(e) = &self.files[slot as usize] {
            for (rel, abs) in ancestors(e) {
                self.dirs.entry(rel.into()).or_insert_with(|| (abs.to_owned(), 0)).1 += 1;
            }
        }
        self.by_path.insert(path, slot);
        self.file_count += 1;
        self.symbol_count += symbols;
        // The entry was moved into the slot above; take the data occ_add
        // needs before it, since both borrow `self`.
        let occs = std::mem::take(&mut occs_staging);
        for (name, range, qualified) in &occs {
            self.occ_by_name.entry(name.clone()).or_default().push(OccSlot {
                slot,
                range: *range,
                qualified: *qualified,
            });
            self.occ_total += 1;
        }
    }

    pub(crate) fn remove(&mut self, path: &Path) -> Option<FileEntry> {
        let slot = self.by_path.remove(path)?;
        let old = self.files[slot as usize].take()?;
        self.occ_remove(slot, &old);
        self.free.push(slot);
        for (rel, _) in ancestors(&old) {
            if let Some(d) = self.dirs.get_mut(rel) {
                d.1 -= 1;
                if d.1 == 0 {
                    self.dirs.remove(rel);
                }
            }
        }
        self.file_count -= 1;
        self.symbol_count -= old.symbols.len() as u32;
        Some(old)
    }

    /// Removes every file at or below `dir`; returns their paths.
    pub(crate) fn remove_tree(&mut self, dir: &Path) -> Vec<PathBuf> {
        let doomed: Vec<PathBuf> = self.by_path.keys().filter(|p| p.starts_with(dir)).cloned().collect();
        doomed.into_iter().filter(|p| self.remove(p).is_some()).collect()
    }

    /// Releases spare capacity (after large deletions).
    pub(crate) fn shrink(&mut self) {
        while matches!(self.files.last(), Some(None)) {
            self.files.pop();
            let last = self.files.len() as u32;
            self.free.retain(|&s| s != last);
        }
        self.files.shrink_to_fit();
        self.free.shrink_to_fit();
        self.by_path.shrink_to_fit();
        self.dirs.shrink_to_fit();
    }

    pub(crate) fn paths(&self) -> impl Iterator<Item = &PathBuf> {
        self.by_path.keys()
    }
}

/// The folders holding `e` (`rel` with a trailing `/`, absolute path), innermost first.
fn ancestors(e: &FileEntry) -> impl Iterator<Item = (&str, &Path)> {
    let mut rel = e.dir();
    let mut abs = e.path.parent();
    std::iter::from_fn(move || {
        let path = abs.filter(|_| !rel.is_empty())?;
        let here = rel;
        rel = rel[..rel.len() - 1].rfind('/').map_or("", |i| &rel[..=i]);
        abs = path.parent();
        Some((here, path))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, symbols: usize) -> FileEntry {
        let record = FileRecord {
            symbols: (0..symbols)
                .map(|i| StoredSymbol {
                    name: format!("s{i}"),
                    kind: SymbolKind::Function,
                    container: None,
                    range: Range::default(),
                })
                .collect(),
            ..Default::default()
        };
        FileEntry::new(PathBuf::from("/r").join(path), path.to_owned(), record)
    }

    #[test]
    fn dirs_follow_inserts_and_removals() {
        let mut d = IndexData::default();
        d.insert(entry("a/b/c.rs", 0));
        d.insert(entry("a/d.rs", 0));
        d.insert(entry("a/d.rs", 0));
        d.insert(entry("top.rs", 0));
        let mut dirs: Vec<_> = d.dirs.iter().map(|(k, v)| (k.to_string(), v.1)).collect();
        dirs.sort();
        assert_eq!(dirs, [("a/".into(), 2), ("a/b/".into(), 1)]);
        assert_eq!(d.dirs["a/b/"].0, PathBuf::from("/r/a/b"));
        d.remove(Path::new("/r/a/b/c.rs"));
        assert!(!d.dirs.contains_key("a/b/"));
        d.remove_tree(Path::new("/r/a"));
        assert!(d.dirs.is_empty());
    }

    #[test]
    fn insert_replace_remove_keep_counts() {
        let mut d = IndexData::default();
        d.insert(entry("a/b.rs", 2));
        d.insert(entry("c.rs", 1));
        assert_eq!((d.file_count, d.symbol_count), (2, 3));
        d.insert(entry("a/b.rs", 5));
        assert_eq!((d.file_count, d.symbol_count), (2, 6));
        assert!(d.remove(Path::new("/r/c.rs")).is_some());
        assert_eq!((d.file_count, d.symbol_count), (1, 5));
        d.insert(entry("d.rs", 0));
        assert_eq!(d.files.len(), 2, "slot reused");
        assert_eq!(d.remove_tree(Path::new("/r/a")), vec![PathBuf::from("/r/a/b.rs")]);
        assert_eq!((d.file_count, d.symbol_count), (1, 0));
        let e = d.get(Path::new("/r/d.rs")).unwrap();
        assert_eq!((e.name(), e.dir()), ("d.rs", ""));
        d.insert(entry("e.rs", 1));
        d.insert(entry("f.rs", 1));
        d.remove(Path::new("/r/e.rs"));
        d.remove(Path::new("/r/f.rs"));
        d.shrink();
        assert_eq!(d.files.len(), 2, "trailing free slot dropped");
        assert_eq!(d.free, vec![0]);
        d.insert(entry("g.rs", 1));
        assert_eq!((d.file_count, d.files.len()), (2, 2));
    }

    #[test]
    fn masks() {
        assert_eq!(char_mask("ab") & char_mask("Bad"), char_mask("ab"));
        assert_ne!(char_mask("z") & char_mask("abc"), char_mask("z"));
    }
}
