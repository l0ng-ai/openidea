//! In-memory index: one slot per file, with compact query-time tables derived from it.
//!
//! Queries never walk the fat `FileEntry` structs: `HotFiles`, `HotDirs` and `SymTable` hold
//! only the fields a scan needs, packed in dense rows with interned strings, so a query
//! streams contiguous memory instead of chasing `Box<[Sym]>` / `Box<str>` pointers.
//! They are plain data, updated eagerly by `insert`/`remove` (every mutation needs `&mut
//! IndexData`), and all queries run under the `IndexData` read lock: a scan therefore sees
//! one consistent snapshot, and the only "invalidation" is the update itself. Space left
//! behind by replaced/removed entries is reclaimed by compaction inside `insert`/`remove`
//! once it dominates the table, and by `shrink`.

use ide_core::{Range, SymbolKind};
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

/// A substring of an interned text arena.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Span {
    pub start: u32,
    pub len: u32,
}

impl Span {
    /// A slice of nothing; used for optional fields (`None` containers).
    pub(crate) const NONE: Span = Span { start: u32::MAX, len: 0 };

    #[inline]
    fn of(arena: &str, s: &str) -> Self {
        Self { start: arena.len() as u32, len: s.len() as u32 }
    }

    #[inline]
    pub(crate) fn get(self, arena: &str) -> &str {
        &arena[self.start as usize..(self.start + self.len) as usize]
    }
}

/// Persisted per-file record (postcard in redb, keyed by the relative path).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct FileRecord {
    pub mtime: u64,
    pub size: u64,
    pub hash: [u8; 32],
    pub symbols: Vec<StoredSymbol>,
    /// Matched by an ignore file: listed by name only (no hash, no symbols).
    pub ignored: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct StoredSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub container: Option<String>,
    pub range: Range,
}

/// A symbol resolved out of [`SymTable`].
pub(crate) struct SymRef<'a> {
    pub name: &'a str,
    pub kind: SymbolKind,
    pub container: Option<&'a str>,
    pub range: Range,
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
    /// Range of this file's symbols in [`IndexData::syms`].
    pub sym_start: u32,
    pub sym_len: u32,
    pub ignored: bool,
}

impl FileEntry {
    /// Splits the record into the entry and its symbols; the symbols are flattened into
    /// the index-wide [`SymTable`] by [`IndexData::insert`].
    pub(crate) fn new(path: PathBuf, rel: String, record: FileRecord) -> (Self, Vec<StoredSymbol>) {
        let name_start = rel.rfind('/').map_or(0, |i| i + 1);
        let name = &rel[name_start..];
        let FileRecord { mtime, size, hash, symbols, ignored } = record;
        let entry = Self {
            name_start_chars: rel[..name_start].chars().count() as u32,
            name_mask: char_mask(name),
            rel_mask: char_mask(&rel),
            name_start: name_start as u32,
            path,
            rel: rel.into_boxed_str(),
            mtime,
            size,
            hash,
            sym_start: 0,
            sym_len: 0,
            ignored,
        };
        (entry, symbols)
    }

    pub(crate) fn name(&self) -> &str {
        &self.rel[self.name_start as usize..]
    }

    pub(crate) fn dir(&self) -> &str {
        &self.rel[..self.name_start as usize]
    }

    /// Whether the entry is out of date for `found` on disk.
    pub(crate) fn stale_for(&self, found: &crate::filter::Found) -> bool {
        self.mtime != found.mtime || self.size != found.size || self.ignored != found.ignored
    }
}

/// The hot fields of one file slot, packed for the query scan; no pointers.
pub(crate) struct FileRow {
    /// `rel` in [`HotFiles`]' arena.
    pub rel: Span,
    /// Byte offset of the file name inside `rel`.
    pub name_start: u32,
    pub sym_start: u32,
    pub sym_len: u32,
    /// Union of every symbol's [`char_mask`]: a selective symbol query can skip
    /// the whole file before touching its symbol range.
    pub sym_mask: u64,
    pub rel_mask: u64,
    pub name_mask: u64,
    /// Mask of the directory part (`rel[..name_start]`), precomputed for path queries.
    pub dir_mask: u64,
    /// `rel` is pure ASCII, so nucleo can match it without a UTF-32 conversion.
    pub ascii: bool,
    /// The slot holds a file; free slots keep a row so scans line up with `IndexData::files`.
    pub live: bool,
}

impl FileRow {
    #[inline]
    pub(crate) fn rel<'a>(&self, arena: &'a str) -> &'a str {
        self.rel.get(arena)
    }

    #[inline]
    pub(crate) fn name<'a>(&self, arena: &'a str) -> &'a str {
        &self.rel.get(arena)[self.name_start as usize..]
    }

    #[inline]
    pub(crate) fn dir<'a>(&self, arena: &'a str) -> &'a str {
        &self.rel.get(arena)[..self.name_start as usize]
    }
}

/// One dense row per file slot (same order and length as `IndexData::files`) plus the
/// text arena the rows point into.
#[derive(Default)]
pub(crate) struct HotFiles {
    pub rows: Vec<FileRow>,
    text: String,
    dead_text: usize,
}

impl HotFiles {
    #[inline]
    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    #[inline]
    pub(crate) fn row(&self, slot: usize) -> Option<&FileRow> {
        self.rows.get(slot).filter(|row| row.live)
    }

    #[inline]
    pub(crate) fn row_of_slot(&self, slot: u32) -> Option<&FileRow> {
        self.row(slot as usize)
    }

    /// `rel` of a live slot; candidate slots always are.
    #[inline]
    pub(crate) fn rel(&self, slot: u32) -> &str {
        self.rows[slot as usize].rel(&self.text)
    }

    fn set(&mut self, slot: u32, row: FileRow) {
        if self.rows.len() as u32 == slot {
            self.rows.push(row);
        } else {
            self.rows[slot as usize] = row;
        }
    }

    fn append(&mut self, rel: &str) -> Span {
        let span = Span::of(&self.text, rel);
        self.text.push_str(rel);
        span
    }

    /// Updates the row of an existing slot (replace) in place.
    fn update(&mut self, slot: u32, e: &FileEntry, sym_mask: u64) {
        let idx = slot as usize;
        if self.rows[idx].rel.get(&self.text) != &*e.rel {
            self.dead_text += self.rows[idx].rel.len as usize;
            let span = self.append(&e.rel);
            self.rows[idx].rel = span;
            self.rows[idx].ascii = e.rel.is_ascii();
            self.rows[idx].dir_mask = char_mask(e.dir());
        }
        let row = &mut self.rows[idx];
        row.name_start = e.name_start;
        row.name_mask = e.name_mask;
        row.rel_mask = e.rel_mask;
        row.sym_start = e.sym_start;
        row.sym_len = e.sym_len;
        row.sym_mask = sym_mask;
        row.live = true;
    }

    fn remove(&mut self, slot: u32) {
        let row = &mut self.rows[slot as usize];
        self.dead_text += row.rel.len as usize;
        row.rel = Span::NONE;
        row.sym_start = 0;
        row.sym_len = 0;
        row.sym_mask = 0;
        row.live = false;
    }

    fn compact(&mut self) {
        let mut text = String::with_capacity(self.text.len() - self.dead_text);
        for row in &mut self.rows {
            if !row.live {
                continue;
            }
            let rel = row.rel.get(&self.text);
            row.rel = Span::of(&text, rel);
            text.push_str(rel);
        }
        self.text = text;
        self.dead_text = 0;
    }

    fn shrink(&mut self) {
        self.compact();
        self.rows.shrink_to_fit();
        self.text.shrink_to_fit();
    }
}

/// One folder holding indexed files, packed for the query scan.
pub(crate) struct DirRow {
    /// `rel` in [`HotDirs`]' arena, including the trailing `/`.
    pub rel: Span,
    /// Byte offset of the last path segment inside the trimmed `rel`.
    pub name_start: u32,
    pub name_mask: u64,
    /// Mask of `rel` without the trailing `/`.
    pub rel_mask: u64,
    pub path: PathBuf,
}

impl DirRow {
    #[inline]
    pub(crate) fn rel<'a>(&self, arena: &'a str) -> &'a str {
        self.rel.get(arena)
    }
}

#[derive(Default)]
pub(crate) struct HotDirs {
    pub rows: Vec<DirRow>,
    text: String,
    dead: usize,
}

impl HotDirs {
    #[inline]
    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    fn push(&mut self, rel: &str, abs: &Path) -> u32 {
        let span = Span::of(&self.text, rel);
        self.text.push_str(rel);
        let trimmed = &rel[..rel.len() - 1];
        let name_start = trimmed.rfind('/').map_or(0, |i| i + 1);
        self.rows.push(DirRow {
            rel: span,
            name_start: name_start as u32,
            name_mask: char_mask(&trimmed[name_start..]),
            rel_mask: char_mask(trimmed),
            path: abs.to_owned(),
        });
        (self.rows.len() - 1) as u32
    }

    fn remove(&mut self, row: u32, dirs: &mut HashMap<Box<str>, (PathBuf, u32, u32)>) {
        let idx = row as usize;
        let last = self.rows.len() - 1;
        self.dead += self.rows[idx].rel.len as usize;
        self.rows.swap_remove(idx);
        if idx != last {
            let moved = self.rows[idx].rel.get(&self.text);
            if let Some(dir) = dirs.get_mut(moved) {
                dir.2 = idx as u32;
            }
        }
    }

    fn compact(&mut self) {
        let mut text = String::with_capacity(self.text.len() - self.dead);
        for row in &mut self.rows {
            let rel = row.rel.get(&self.text);
            row.rel = Span::of(&text, rel);
            text.push_str(rel);
        }
        self.text = text;
        self.dead = 0;
    }

    fn shrink(&mut self) {
        self.compact();
        self.rows.shrink_to_fit();
        self.text.shrink_to_fit();
    }
}

/// The scan-relevant fields of one symbol: its character mask and the name in the
/// arena. Interleaved so a scan touches one cache line per candidate instead of three
/// parallel arrays.
#[derive(Clone, Copy)]
pub(crate) struct SymHead {
    pub mask: u64,
    pub name: Span,
}

/// Index-wide symbol storage: one row per symbol in parallel arrays, with names and
/// containers interned in a single arena. Each file points at a contiguous range.
#[derive(Default)]
pub(crate) struct SymTable {
    head: Vec<SymHead>,
    container: Vec<Span>,
    kind: Vec<SymbolKind>,
    range: Vec<Range>,
    text: String,
    dead_rows: usize,
}

impl SymTable {
    #[inline]
    pub(crate) fn name(&self, i: u32) -> &str {
        self.head[i as usize].name.get(&self.text)
    }

    #[inline]
    pub(crate) fn mask(&self, i: u32) -> u64 {
        self.head[i as usize].mask
    }

    #[inline]
    pub(crate) fn container(&self, i: u32) -> Option<&str> {
        let span = self.container[i as usize];
        (span.start != u32::MAX).then(|| span.get(&self.text))
    }

    /// The mask + name rows of a file's contiguous symbol range.
    #[inline]
    pub(crate) fn heads(&self, start: u32, len: u32) -> &[SymHead] {
        let (start, end) = (start as usize, start as usize + len as usize);
        &self.head[start..end]
    }

    #[inline]
    pub(crate) fn kind(&self, i: u32) -> SymbolKind {
        self.kind[i as usize]
    }

    #[inline]
    pub(crate) fn range(&self, i: u32) -> Range {
        self.range[i as usize]
    }

    fn intern(&mut self, s: &str) -> Span {
        let span = Span::of(&self.text, s);
        self.text.push_str(s);
        span
    }

    /// Appends a file's symbols; they stay contiguous. Returns the start index
    /// and the union of their masks.
    fn push(&mut self, symbols: &[StoredSymbol]) -> (u32, u64) {
        let start = self.head.len() as u32;
        let mut agg_mask = 0u64;
        for s in symbols {
            let mask = char_mask(&s.name);
            agg_mask |= mask;
            let name = self.intern(&s.name);
            let container = match &s.container {
                Some(c) => self.intern(c),
                None => Span::NONE,
            };
            self.head.push(SymHead { mask, name });
            self.container.push(container);
            self.kind.push(s.kind);
            self.range.push(s.range);
        }
        (start, agg_mask)
    }

    /// Whether `symbols` would flatten to exactly the range at `start`.
    fn same(&self, start: u32, len: u32, symbols: &[StoredSymbol]) -> bool {
        len as usize == symbols.len()
            && symbols.iter().enumerate().all(|(k, s)| {
                let i = start + k as u32;
                self.name(i) == s.name
                    && self.container(i) == s.container.as_deref()
                    && self.kind(i) == s.kind
                    && self.range(i) == s.range
            })
    }

    fn free(&mut self, _start: u32, len: u32) {
        self.dead_rows += len as usize;
    }

    /// Rewrites the live rows in file order, reclaiming the space of replaced files.
    /// `files` entries keep their range in sync; queries read rows, but persistence
    /// and `FileEntry` accessors go through the entry.
    fn compact(&mut self, rows: &mut [FileRow], files: &mut [Option<FileEntry>]) {
        let mut text = String::with_capacity(self.text.len());
        let mut head = Vec::with_capacity(self.head.len() - self.dead_rows);
        let mut container = Vec::with_capacity(head.capacity());
        let mut kind = Vec::with_capacity(head.capacity());
        let mut range = Vec::with_capacity(head.capacity());
        let mut live = 0u32;
        for (slot, row) in rows.iter_mut().enumerate() {
            if !row.live {
                row.sym_start = 0;
                continue;
            }
            let (start, end) = (row.sym_start, row.sym_start + row.sym_len);
            row.sym_start = live;
            if let Some(e) = files.get_mut(slot).and_then(Option::as_mut) {
                e.sym_start = live;
            }
            for i in start..end {
                let name_span = self.head[i as usize].name;
                let name = name_span.get(&self.text);
                head.push(SymHead { mask: self.head[i as usize].mask, name: Span::of(&text, name) });
                text.push_str(name);
                let container_span = self.container[i as usize];
                if container_span.start == u32::MAX {
                    container.push(Span::NONE);
                } else {
                    let c = container_span.get(&self.text);
                    container.push(Span::of(&text, c));
                    text.push_str(c);
                }
                kind.push(self.kind[i as usize]);
                range.push(self.range[i as usize]);
                live += 1;
            }
        }
        self.head = head;
        self.container = container;
        self.kind = kind;
        self.range = range;
        self.text = text;
        self.dead_rows = 0;
    }

    fn shrink(&mut self) {
        self.head.shrink_to_fit();
        self.container.shrink_to_fit();
        self.kind.shrink_to_fit();
        self.range.shrink_to_fit();
        self.text.shrink_to_fit();
    }
}

#[derive(Default)]
pub(crate) struct IndexData {
    pub files: Vec<Option<FileEntry>>,
    by_path: HashMap<PathBuf, u32>,
    /// Every folder holding an indexed file at any depth, keyed by its `rel` with a
    /// trailing `/`: its absolute path, the number of files below it, and its row in
    /// [`HotDirs`].
    pub dirs: HashMap<Box<str>, (PathBuf, u32, u32)>,
    /// Compact query-time view of `files`, kept in sync by `insert`/`remove`.
    pub hot: HotFiles,
    /// Compact query-time view of `dirs`, kept in sync by `insert`/`remove`.
    pub dirs_hot: HotDirs,
    /// Flattened symbols of every file, kept in sync by `insert`/`remove`.
    pub syms: SymTable,
    free: Vec<u32>,
    pub file_count: u32,
    pub symbol_count: u32,
}

impl IndexData {
    pub(crate) fn get(&self, path: &Path) -> Option<&FileEntry> {
        self.by_path.get(path).and_then(|&i| self.files[i as usize].as_ref())
    }

    pub(crate) fn slot(&self, path: &Path) -> Option<u32> {
        self.by_path.get(path).copied()
    }

    /// The persisted form of a file, rebuilt from [`IndexData::syms`].
    pub(crate) fn record(&self, e: &FileEntry) -> FileRecord {
        FileRecord {
            mtime: e.mtime,
            size: e.size,
            hash: e.hash,
            symbols: self
                .symbols_of(e)
                .map(|s| StoredSymbol {
                    name: s.name.to_owned(),
                    kind: s.kind,
                    container: s.container.map(str::to_owned),
                    range: s.range,
                })
                .collect(),
            ignored: e.ignored,
        }
    }

    pub(crate) fn record_of(&self, path: &Path) -> Option<FileRecord> {
        self.get(path).map(|e| self.record(e))
    }

    /// The symbols of one file, in declaration order.
    pub(crate) fn symbols_of<'a>(&'a self, e: &'a FileEntry) -> impl Iterator<Item = SymRef<'a>> + 'a {
        let syms = &self.syms;
        (e.sym_start..e.sym_start + e.sym_len).map(move |i| SymRef {
            name: syms.name(i),
            kind: syms.kind(i),
            container: syms.container(i),
            range: syms.range(i),
        })
    }

    pub(crate) fn insert(&mut self, mut entry: FileEntry, symbols: Vec<StoredSymbol>) {
        let sym_len = symbols.len() as u32;
        if let Some(&slot) = self.by_path.get(&entry.path) {
            let old = self.files[slot as usize].as_ref().expect("indexed slots are live");
            let old_len = old.sym_len;
            // Rescans and saves that re-parse to the same symbols reuse the range; a
            // same-path replacement then costs nothing in the symbol table.
            let (sym_start, sym_mask) = if self.syms.same(old.sym_start, old_len, &symbols) {
                (old.sym_start, self.hot.rows[slot as usize].sym_mask)
            } else {
                self.syms.free(old.sym_start, old_len);
                self.syms.push(&symbols)
            };
            entry.sym_start = sym_start;
            entry.sym_len = sym_len;
            self.symbol_count = self.symbol_count - old_len + sym_len;
            self.hot.update(slot, &entry, sym_mask);
            self.files[slot as usize] = Some(entry);
            self.compact_if_needed();
            return;
        }
        let (sym_start, sym_mask) = self.syms.push(&symbols);
        entry.sym_start = sym_start;
        entry.sym_len = sym_len;
        let slot = match self.free.pop() {
            Some(slot) => slot,
            None => {
                self.files.push(None);
                (self.files.len() - 1) as u32
            }
        };
        let path = entry.path.clone();
        let (name_start, name_mask, rel_mask) = (entry.name_start, entry.name_mask, entry.rel_mask);
        let rel = self.hot.append(&entry.rel);
        self.hot.set(
            slot,
            FileRow {
                rel,
                name_start,
                sym_start: entry.sym_start,
                sym_len,
                sym_mask,
                rel_mask,
                name_mask,
                dir_mask: char_mask(&entry.rel[..name_start as usize]),
                ascii: entry.rel.is_ascii(),
                live: true,
            },
        );
        self.files[slot as usize] = Some(entry);
        if let Some(e) = &self.files[slot as usize] {
            for (rel, abs) in ancestors(e) {
                if let Some(dir) = self.dirs.get_mut(rel) {
                    dir.1 += 1;
                } else {
                    let row = self.dirs_hot.push(rel, abs);
                    self.dirs.insert(rel.into(), (abs.to_owned(), 1, row));
                }
            }
        }
        self.by_path.insert(path, slot);
        self.file_count += 1;
        self.symbol_count += sym_len;
        self.compact_if_needed();
    }

    pub(crate) fn remove(&mut self, path: &Path) -> Option<FileEntry> {
        let slot = self.by_path.remove(path)?;
        let old = self.files[slot as usize].take()?;
        self.free.push(slot);
        self.hot.remove(slot);
        self.syms.free(old.sym_start, old.sym_len);
        for (rel, _) in ancestors(&old) {
            let Some(dir) = self.dirs.get_mut(rel) else { continue };
            dir.1 -= 1;
            if dir.1 > 0 {
                continue;
            }
            let Some((_, _, row)) = self.dirs.remove(rel) else { continue };
            self.dirs_hot.remove(row, &mut self.dirs);
        }
        self.file_count -= 1;
        self.symbol_count -= old.sym_len;
        self.compact_if_needed();
        Some(old)
    }

    /// Removes every file at or below `dir`; returns their paths.
    pub(crate) fn remove_tree(&mut self, dir: &Path) -> Vec<PathBuf> {
        let doomed: Vec<PathBuf> = self.by_path.keys().filter(|p| p.starts_with(dir)).cloned().collect();
        doomed.into_iter().filter(|p| self.remove(p).is_some()).collect()
    }

    /// Reclaims the space of replaced/removed files once it dominates a table.
    fn compact_if_needed(&mut self) {
        if self.hot.dead_text > 1 << 16 && self.hot.dead_text * 2 > self.hot.text.len() {
            self.hot.compact();
        }
        if self.syms.dead_rows > 4096 && self.syms.dead_rows * 2 > self.syms.head.len() {
            self.syms.compact(&mut self.hot.rows, &mut self.files);
        }
        if self.dirs_hot.dead > 1 << 16 && self.dirs_hot.dead * 2 > self.dirs_hot.text.len() {
            self.dirs_hot.compact();
        }
    }

    /// Releases spare capacity (after large deletions).
    pub(crate) fn shrink(&mut self) {
        while matches!(self.files.last(), Some(None)) {
            self.files.pop();
            let last = self.files.len() as u32;
            self.free.retain(|&s| s != last);
        }
        self.files.shrink_to_fit();
        self.hot.rows.truncate(self.files.len());
        self.hot.shrink();
        self.dirs_hot.shrink();
        self.syms.compact(&mut self.hot.rows, &mut self.files);
        self.syms.shrink();
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

    fn entry(path: &str, symbols: usize) -> (FileEntry, Vec<StoredSymbol>) {
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

    fn insert(d: &mut IndexData, path: &str, symbols: usize) {
        let (e, s) = entry(path, symbols);
        d.insert(e, s);
    }

    /// The compact tables must always mirror the entries they were derived from.
    fn assert_consistent(d: &IndexData) {
        assert_eq!(d.hot.rows.len(), d.files.len(), "one hot row per slot");
        assert_eq!(d.hot.rows.iter().filter(|r| r.live).count(), d.file_count as usize, "live rows are files");
        for (slot, e) in d.files.iter().enumerate() {
            let Some(e) = e else {
                assert!(d.hot.row(slot).is_none(), "free slot {slot} has no row");
                continue;
            };
            let row = d.hot.row(slot).unwrap_or_else(|| panic!("slot {slot} has a row"));
            assert_eq!(row.rel(d.hot.text()), &*e.rel);
            assert_eq!(row.name(d.hot.text()), e.name());
            assert_eq!(row.dir(d.hot.text()), e.dir());
            assert_eq!(row.name_mask, char_mask(e.name()));
            assert_eq!(row.rel_mask, char_mask(&e.rel));
            assert_eq!(row.dir_mask, char_mask(e.dir()));
            assert_eq!(row.ascii, e.rel.is_ascii());
            assert_eq!(row.sym_start, e.sym_start);
            assert_eq!(row.sym_len, e.sym_len);
            assert_eq!(row.sym_mask, d.symbols_of(e).fold(0u64, |m, s| m | char_mask(s.name)));
            assert_eq!(d.syms.head.len(), d.syms.container.len());
            assert_eq!(d.syms.head.len(), d.syms.kind.len());
            assert_eq!(d.syms.head.len(), d.syms.range.len());
            assert!(e.sym_len == 0 || (e.sym_start as usize) < d.syms.head.len());
            assert!(e.sym_start + e.sym_len <= d.syms.head.len() as u32);
        }
        for (rel, (path, count, row)) in &d.dirs {
            let row = &d.dirs_hot.rows[*row as usize];
            assert_eq!(row.rel(d.dirs_hot.text()), &**rel);
            assert_eq!(&row.path, path);
            assert!(*count > 0);
            let trimmed = &rel[..rel.len() - 1];
            let name = &trimmed[row.name_start as usize..];
            assert_eq!(row.name_mask, char_mask(name));
            assert_eq!(row.rel_mask, char_mask(trimmed));
        }
        assert_eq!(d.dirs.len(), d.dirs_hot.rows.len());
        assert_eq!(d.symbol_count, d.files.iter().flatten().map(|e| e.sym_len).sum::<u32>());
    }

    #[test]
    fn dirs_follow_inserts_and_removals() {
        let mut d = IndexData::default();
        insert(&mut d, "a/b/c.rs", 0);
        insert(&mut d, "a/d.rs", 0);
        insert(&mut d, "a/d.rs", 0);
        insert(&mut d, "top.rs", 0);
        let mut dirs: Vec<_> = d.dirs.iter().map(|(k, v)| (k.to_string(), v.1)).collect();
        dirs.sort();
        assert_eq!(dirs, [("a/".into(), 2), ("a/b/".into(), 1)]);
        assert_eq!(d.dirs["a/b/"].0, PathBuf::from("/r/a/b"));
        assert_consistent(&d);
        d.remove(Path::new("/r/a/b/c.rs"));
        assert!(!d.dirs.contains_key("a/b/"));
        assert_consistent(&d);
        d.remove_tree(Path::new("/r/a"));
        assert!(d.dirs.is_empty());
        assert_consistent(&d);
    }

    #[test]
    fn insert_replace_remove_keep_counts() {
        let mut d = IndexData::default();
        insert(&mut d, "a/b.rs", 2);
        insert(&mut d, "c.rs", 1);
        assert_eq!((d.file_count, d.symbol_count), (2, 3));
        insert(&mut d, "a/b.rs", 5);
        assert_eq!((d.file_count, d.symbol_count), (2, 6));
        assert_consistent(&d);
        assert!(d.remove(Path::new("/r/c.rs")).is_some());
        assert_eq!((d.file_count, d.symbol_count), (1, 5));
        assert_consistent(&d);
        insert(&mut d, "d.rs", 0);
        assert_eq!(d.files.len(), 2, "slot reused");
        assert_consistent(&d);
        assert_eq!(d.remove_tree(Path::new("/r/a")), vec![PathBuf::from("/r/a/b.rs")]);
        assert_eq!((d.file_count, d.symbol_count), (1, 0));
        let e = d.get(Path::new("/r/d.rs")).unwrap();
        assert_eq!((e.name(), e.dir()), ("d.rs", ""));
        insert(&mut d, "e.rs", 1);
        insert(&mut d, "f.rs", 1);
        d.remove(Path::new("/r/e.rs"));
        d.remove(Path::new("/r/f.rs"));
        d.shrink();
        assert_consistent(&d);
        assert_eq!(d.files.len(), 2, "trailing free slot dropped");
        assert_eq!(d.free, vec![0]);
        insert(&mut d, "g.rs", 1);
        assert_eq!((d.file_count, d.files.len()), (2, 2));
        assert_consistent(&d);
    }

    #[test]
    fn masks() {
        assert_eq!(char_mask("ab") & char_mask("Bad"), char_mask("ab"));
        assert_ne!(char_mask("z") & char_mask("abc"), char_mask("z"));
    }

    fn insert_symbols(d: &mut IndexData, path: &str, symbols: Vec<StoredSymbol>) {
        let record = FileRecord { symbols, ..Default::default() };
        let (e, s) = FileEntry::new(PathBuf::from("/r").join(path), path.to_owned(), record);
        d.insert(e, s);
    }

    fn symbol(n: &str) -> StoredSymbol {
        StoredSymbol { name: n.to_owned(), kind: SymbolKind::Function, container: None, range: Range::default() }
    }

    #[test]
    fn compaction_keeps_entries_and_records_in_sync() {
        let mut d = IndexData::default();
        insert(&mut d, "a.rs", 3);
        insert(&mut d, "b/c.rs", 2);
        insert_symbols(&mut d, "a.rs", vec![symbol("fresh")]);
        d.shrink();
        assert_consistent(&d);
        assert_eq!(d.syms.head.len() as u32, d.symbol_count, "compaction drops dead symbol rows");
        let names = |d: &IndexData, p: &str| -> Vec<String> {
            let e = d.get(Path::new(p)).unwrap();
            d.record(e).symbols.into_iter().map(|s| s.name).collect()
        };
        assert_eq!(names(&d, "/r/a.rs"), ["fresh"]);
        assert_eq!(names(&d, "/r/b/c.rs"), ["s0", "s1"]);
        assert_eq!(d.symbol_count, 3);
    }

    #[test]
    fn large_replacements_reclaim_symbol_storage() {
        let mut d = IndexData::default();
        insert_symbols(&mut d, "a.rs", (0..5_000).map(|i| symbol(&format!("old{i}"))).collect());
        assert_eq!(d.syms.head.len(), 5_000);
        insert_symbols(&mut d, "a.rs", vec![symbol("fresh")]);
        assert_eq!(d.syms.head.len(), 1, "dead symbol rows are reclaimed");
        assert_eq!((d.symbol_count, d.file_count), (1, 1));
        assert_consistent(&d);
    }

    #[test]
    fn tree_removal_leaves_no_hot_rows_or_dirs() {
        let mut d = IndexData::default();
        insert(&mut d, "a/b/one.rs", 2);
        insert(&mut d, "a/b/two.rs", 3);
        insert(&mut d, "a/three.rs", 1);
        insert(&mut d, "elsewhere/four.rs", 1);
        assert_eq!(d.remove_tree(Path::new("/r/a")).len(), 3);
        assert_consistent(&d);
        assert_eq!(d.hot.rows.iter().filter(|r| r.live).count(), 1);
        assert!(d.hot.row(0).is_none(), "removed slots have no live row");
        assert_eq!(d.dirs.len(), 1, "elsewhere/ only");
        assert_eq!(d.dirs_hot.rows.len(), 1);
        assert_eq!(d.symbol_count, 1);
        d.shrink();
        assert_eq!(d.syms.head.len() as u32, d.symbol_count);
        // Slots are reusable and the new row replaces the tombstone.
        insert(&mut d, "a/five.rs", 2);
        assert_consistent(&d);
        assert_eq!(d.file_count, 2);
    }
}
