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

use std::any::Any;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use parking_lot::Mutex;

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

    pub(crate) fn clear(&self) {
        self.entries.lock().clear();
    }

    /// Every file read into a part so far, in order.
    pub(crate) fn reads(&self) -> Vec<(&'static str, PathBuf)> {
        self.reads.lock().clone()
    }
}

/// The views found below one folder, kept for a disk generation.
pub(crate) type FolderListings =
    HashMap<(PathBuf, Option<String>), (u64, Arc<Vec<crate::frameworks::laravel::ViewEntry>>)>;
