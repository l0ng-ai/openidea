//! The parts of the Laravel project model read from single files
//! (roadmap phase 8.22): configuration keys per `config/*.php`, translations
//! per language file, routes per route file, and the view namespaces a
//! service provider registers. Each part is kept with the stamp of the text
//! it was read from:
//!
//! - an open buffer: the BLAKE3 hash of its text, the hash the index keys
//!   file summaries by;
//! - a file on disk: its size and modification time, checked without
//!   reading it. A watcher batch naming the file (or a folder above it)
//!   drops the part as well, so a rewrite within one tick of the clock is
//!   seen too.
//!
//! A build of the model asks for each file's part again. Only the files
//! whose stamp moved are read and parsed; the others hand back the `Arc`
//! they were read into, so the model shares them rather than copying them
//! (`crate::frameworks::laravel::Merged`, which also keeps its order when no
//! part changed).
//!
//! Folder listings (the views below a folder) have no stamp of their own:
//! they are kept for a [disk generation](super::PhpEngine::disk_generation),
//! which every watcher batch moves.
//!
//! Parts read from files on disk are also stored in the index database
//! (roadmap phase 9.4, [`crate::index::StoredPart`]), with the content hash
//! and the size and modification time of the text they were read from, so a
//! new session takes them from there instead of reading and parsing the
//! files again: a file whose size and modification time are unchanged isn't
//! read at all, and one whose content hash is unchanged isn't parsed. The
//! parts are queued here as they are built ([`FileParts::queue`]) and
//! written by the engine's worker thread in one transaction, off the
//! request that built them.

use std::any::Any;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use parking_lot::Mutex;

use crate::index::StoredPart;

/// What a part was read from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Stamp {
    /// An open buffer's text, hashed.
    Buffer([u8; 32]),
    /// A file on disk.
    Disk { len: u64, modified: Option<SystemTime> },
}

struct Entry {
    stamp: Stamp,
    /// What else the part was built from (a group prefix, a route file's
    /// prefix and middleware): a part read in another context is read again.
    context: String,
    part: Arc<dyn Any + Send + Sync>,
}

/// The parts read from files, by kind and path.
#[derive(Default)]
pub(crate) struct FileParts {
    entries: Mutex<HashMap<(&'static str, PathBuf), Entry>>,
    /// The files read into parts, ever: tests check that a build reads only
    /// what changed.
    reads: Mutex<Vec<(&'static str, PathBuf)>>,
    /// The parts taken from the index database rather than read, ever.
    loads: Mutex<Vec<(&'static str, PathBuf)>>,
    /// The parts to store in the index database.
    pending: Mutex<Vec<(&'static str, PathBuf, StoredPart)>>,
    /// Held while the pending parts are written and while the stored parts
    /// are dropped, so a write running late can't store parts after they
    /// were dropped.
    pub(crate) store_lock: Mutex<()>,
}

impl FileParts {
    /// The part of `kind` kept for `path`, when it was read from `stamp` in
    /// `context`.
    pub(crate) fn get<T: Send + Sync + 'static>(
        &self,
        kind: &'static str,
        path: &Path,
        stamp: &Stamp,
        context: &str,
    ) -> Option<Arc<T>> {
        let entries = self.entries.lock();
        let entry = entries.get(&(kind, path.to_path_buf()))?;
        if entry.stamp != *stamp || entry.context != context {
            return None;
        }
        entry.part.clone().downcast::<T>().ok()
    }

    pub(crate) fn insert<T: Send + Sync + 'static>(
        &self,
        kind: &'static str,
        path: &Path,
        stamp: Stamp,
        context: &str,
        part: Arc<T>,
    ) {
        self.reads.lock().push((kind, path.to_path_buf()));
        let entry = Entry { stamp, context: context.to_owned(), part };
        self.entries.lock().insert((kind, path.to_path_buf()), entry);
    }

    /// Keeps `part`, taken from the index database (an earlier session read
    /// it from the same text).
    pub(crate) fn insert_loaded<T: Send + Sync + 'static>(
        &self,
        kind: &'static str,
        path: &Path,
        stamp: Stamp,
        context: &str,
        part: Arc<T>,
    ) {
        self.loads.lock().push((kind, path.to_path_buf()));
        let entry = Entry { stamp, context: context.to_owned(), part };
        self.entries.lock().insert((kind, path.to_path_buf()), entry);
    }

    /// Queues a part to be stored in the index database.
    pub(crate) fn queue(&self, kind: &'static str, path: &Path, part: StoredPart) {
        self.pending.lock().push((kind, path.to_path_buf(), part));
    }

    /// The parts queued to be stored, taken.
    pub(crate) fn take_pending(&self) -> Vec<(&'static str, PathBuf, StoredPart)> {
        std::mem::take(&mut *self.pending.lock())
    }

    /// Drops the parts of `path`.
    pub(crate) fn remove(&self, path: &Path) {
        self.entries.lock().retain(|(_, known), _| known != path);
    }

    /// Drops the parts of the files below each of `paths` (or `paths`
    /// themselves): a watcher batch touched them.
    pub(crate) fn forget_below(&self, paths: &[PathBuf]) {
        if paths.is_empty() {
            return;
        }
        self.entries.lock().retain(|(_, known), _| !paths.iter().any(|path| known.starts_with(path)));
    }

    /// Drops every part kept in memory and every part queued to be stored.
    pub(crate) fn clear(&self) {
        self.entries.lock().clear();
        self.pending.lock().clear();
    }

    /// Every file read into a part so far, in order.
    pub(crate) fn reads(&self) -> Vec<(&'static str, PathBuf)> {
        self.reads.lock().clone()
    }

    /// Every part taken from the index database so far, in order.
    pub(crate) fn loads(&self) -> Vec<(&'static str, PathBuf)> {
        self.loads.lock().clone()
    }
}

/// Nanoseconds since the Unix epoch, as the index stores modification
/// times.
pub(crate) fn nanos(time: SystemTime) -> Option<u64> {
    let since = time.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since.as_nanos().min(u64::MAX as u128) as u64)
}

/// The views found below one folder, kept for a disk generation.
pub(crate) type FolderListings =
    HashMap<(PathBuf, Option<String>), (u64, Arc<Vec<crate::frameworks::laravel::ViewEntry>>)>;

/// Other named file listings of folders (language folders), kept for a
/// disk generation.
pub(crate) type FileListings = HashMap<(&'static str, PathBuf), (u64, Arc<Vec<(String, PathBuf)>>)>;
