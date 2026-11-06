//! Table definitions and the write path shared by every update.

use redb::{
    MultimapTable, MultimapTableDefinition, ReadableTable, Table, TableDefinition, TableError, WriteTransaction,
};

use super::{Decl, DeclKind, FileRecord, fqn_key, namespace_of, short_name};
use crate::summary::FileSummary;

pub(super) type MultiDef = MultimapTableDefinition<'static, &'static str, &'static [u8]>;

pub(super) const META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");
/// path → postcard [`FileRecord`].
pub(super) const FILES: TableDefinition<&str, &[u8]> = TableDefinition::new("files");
/// content hash → postcard [`FileSummary`].
pub(super) const SUMMARIES: TableDefinition<[u8; 32], &[u8]> = TableDefinition::new("summaries");
/// content hash → number of files with that content.
pub(super) const REFS: TableDefinition<[u8; 32], u32> = TableDefinition::new("refs");
pub(super) const FQNS: MultiDef = MultimapTableDefinition::new("fqns");
pub(super) const SHORT_NAMES: MultiDef = MultimapTableDefinition::new("short_names");
pub(super) const SUBCLASSES: MultiDef = MultimapTableDefinition::new("subclasses");
pub(super) const NAMESPACES: MultiDef = MultimapTableDefinition::new("namespaces");
/// [`META_FILES_KEY`] → the files with `.phpstorm.meta.php` directives.
pub(super) const META_FILES: MultiDef = MultimapTableDefinition::new("meta_files");

/// The only key of [`META_FILES`].
pub const META_FILES_KEY: &str = "phpstorm_meta";

const MULTIMAPS: [MultiDef; 5] = [FQNS, SHORT_NAMES, SUBCLASSES, NAMESPACES, META_FILES];

type Result<T> = std::result::Result<T, redb::Error>;

/// Drops every table except `meta`.
pub(super) fn clear(txn: &WriteTransaction) -> Result<()> {
    fn ok(r: std::result::Result<bool, TableError>) -> Result<()> {
        match r {
            Ok(_) | Err(TableError::TableDoesNotExist(_)) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
    ok(txn.delete_table(FILES))?;
    ok(txn.delete_table(SUMMARIES))?;
    ok(txn.delete_table(REFS))?;
    for def in MULTIMAPS {
        ok(txn.delete_multimap_table(def))?;
    }
    Ok(())
}

pub(super) fn decode_record(bytes: &[u8]) -> Option<FileRecord> {
    postcard::from_bytes(bytes).ok()
}

/// One entry of a name table.
struct Entry {
    table: usize,
    key: String,
    decl: Decl,
}

/// The name-table entries of one file.
fn entries(file: &str, summary: &FileSummary) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut namespaces = Vec::new();
    let mut add = |kind: DeclKind, fqn: &str, index: usize, out: &mut Vec<Entry>| {
        let decl = Decl { kind, fqn: fqn.to_owned(), file: file.to_owned(), index: index as u32 };
        if let Some(key) = fqn_key(kind.name_kind(), fqn) {
            out.push(Entry { table: 0, key, decl: decl.clone() });
        }
        out.push(Entry { table: 1, key: short_name(fqn).to_ascii_lowercase(), decl: decl.clone() });
        let ns = namespace_of(fqn);
        out.push(Entry { table: 3, key: ns.to_ascii_lowercase(), decl });
        namespaces.push(ns.to_owned());
    };
    for (index, class) in summary.class_likes.iter().enumerate() {
        add(DeclKind::ClassLike(class.kind), &class.fqn, index, &mut out);
        let child = Decl {
            kind: DeclKind::ClassLike(class.kind),
            fqn: class.fqn.clone(),
            file: file.to_owned(),
            index: index as u32,
        };
        for parent in class.extends.iter().chain(&class.implements) {
            let parent = parent.strip_prefix('\\').unwrap_or(parent);
            out.push(Entry { table: 2, key: parent.to_ascii_lowercase(), decl: child.clone() });
        }
    }
    for (index, function) in summary.functions.iter().enumerate() {
        add(DeclKind::Function, &function.fqn, index, &mut out);
    }
    for (index, constant) in summary.constants.iter().enumerate() {
        add(DeclKind::Constant, &constant.fqn, index, &mut out);
    }
    if !summary.meta.is_empty() {
        let decl = Decl { kind: DeclKind::Namespace, fqn: "PHPSTORM_META".to_owned(), file: file.to_owned(), index: 0 };
        out.push(Entry { table: 4, key: META_FILES_KEY.to_owned(), decl });
    }
    // Every namespace that holds a declaration is a child of its parent,
    // up to the global namespace.
    namespaces.sort();
    namespaces.dedup();
    let mut linked = std::collections::HashSet::new();
    for ns in namespaces {
        let mut ns = ns.as_str();
        while !ns.is_empty() && linked.insert(ns.to_ascii_lowercase()) {
            let parent = namespace_of(ns);
            let decl = Decl { kind: DeclKind::Namespace, fqn: ns.to_owned(), file: file.to_owned(), index: 0 };
            out.push(Entry { table: 3, key: parent.to_ascii_lowercase(), decl });
            ns = parent;
        }
    }
    out
}

/// The open tables of one write transaction.
pub(super) struct Writer<'txn> {
    files: Table<'txn, &'static str, &'static [u8]>,
    summaries: Table<'txn, [u8; 32], &'static [u8]>,
    refs: Table<'txn, [u8; 32], u32>,
    names: [MultimapTable<'txn, &'static str, &'static [u8]>; 5],
}

impl<'txn> Writer<'txn> {
    pub(super) fn open(txn: &'txn WriteTransaction) -> Result<Self> {
        Ok(Self {
            files: txn.open_table(FILES)?,
            summaries: txn.open_table(SUMMARIES)?,
            refs: txn.open_table(REFS)?,
            names: [
                txn.open_multimap_table(FQNS)?,
                txn.open_multimap_table(SHORT_NAMES)?,
                txn.open_multimap_table(SUBCLASSES)?,
                txn.open_multimap_table(NAMESPACES)?,
                txn.open_multimap_table(META_FILES)?,
            ],
        })
    }

    fn record(&self, key: &str) -> Result<Option<FileRecord>> {
        Ok(self.files.get(key)?.and_then(|v| decode_record(v.value())))
    }

    fn summary(&self, hash: [u8; 32]) -> Result<Option<FileSummary>> {
        Ok(self.summaries.get(hash)?.and_then(|v| FileSummary::from_bytes(v.value()).ok()))
    }

    /// Stores a record whose content (hash) is unchanged.
    pub(super) fn put_record(&mut self, key: &str, record: &FileRecord) -> Result<()> {
        let bytes = postcard::to_allocvec(record).map_err(storage)?;
        self.files.insert(key, bytes.as_slice())?;
        Ok(())
    }

    /// Drops a file and its entries; `false` when it wasn't indexed.
    pub(super) fn remove_file(&mut self, key: &str) -> Result<bool> {
        let Some(record) = self.record(key)? else { return Ok(false) };
        self.unlink(key, record.hash)?;
        self.files.remove(key)?;
        Ok(true)
    }

    /// Indexes a file with new content. `summary` is `None` when the summary
    /// of `record.hash` is already stored.
    pub(super) fn set_file(&mut self, key: &str, record: FileRecord, summary: Option<&FileSummary>) -> Result<()> {
        if let Some(previous) = self.record(key)? {
            self.unlink(key, previous.hash)?;
        }
        let summary = match summary {
            Some(summary) => {
                if self.summaries.get(record.hash)?.is_none() {
                    self.summaries.insert(record.hash, summary.to_bytes().as_slice())?;
                }
                Some(summary.clone())
            }
            None => self.summary(record.hash)?,
        };
        let refs = self.refs.get(record.hash)?.map_or(0, |v| v.value());
        self.refs.insert(record.hash, refs + 1)?;
        if let Some(summary) = summary {
            for entry in entries(key, &summary) {
                let value = postcard::to_allocvec(&entry.decl).map_err(storage)?;
                self.names[entry.table].insert(entry.key.as_str(), value.as_slice())?;
            }
        }
        self.put_record(key, &record)
    }

    /// Removes a file's name entries and releases its summary.
    fn unlink(&mut self, key: &str, hash: [u8; 32]) -> Result<()> {
        if let Some(summary) = self.summary(hash)? {
            for entry in entries(key, &summary) {
                let value = postcard::to_allocvec(&entry.decl).map_err(storage)?;
                self.names[entry.table].remove(entry.key.as_str(), value.as_slice())?;
            }
        }
        let refs = self.refs.get(hash)?.map_or(0, |v| v.value());
        if refs <= 1 {
            self.refs.remove(hash)?;
            self.summaries.remove(hash)?;
        } else {
            self.refs.insert(hash, refs - 1)?;
        }
        Ok(())
    }
}

fn storage(e: postcard::Error) -> redb::Error {
    redb::Error::Io(std::io::Error::other(e))
}

#[cfg(test)]
pub(super) fn table_sizes(db: &redb::Database) -> [u64; 2] {
    use redb::ReadableDatabase;
    use redb::ReadableTableMetadata;
    let txn = db.begin_read().unwrap();
    [txn.open_table(SUMMARIES).unwrap().len().unwrap(), txn.open_table(REFS).unwrap().len().unwrap()]
}
