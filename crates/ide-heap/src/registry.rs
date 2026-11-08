//! The heap snapshots that are open in this process.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use ide_core::process::process_alive;
use ide_core::{DebugSessionId, IpcPath};
use serde::{Deserialize, Serialize};

use crate::disk::remove_stale;
use crate::index::{HeapIndex, HeapSummary};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(transparent)]
pub struct HeapSnapshotId(pub u32);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HeapOrigin {
    /// Dumped from a live debug session.
    Captured { session: DebugSessionId, pid: u32, java_version: String, taken_while_suspended: bool, dump_ms: u32 },
    /// An `.hprof` the user opened; it is never deleted.
    File { path: IpcPath },
}

impl HeapOrigin {
    /// Text identifying the snapshot in the UI: the process id of a capture, the file name of a
    /// file. The capture time is `created_ms`, which the UI formats in local time.
    pub fn label(&self) -> String {
        match self {
            HeapOrigin::Captured { pid, .. } => pid.to_string(),
            HeapOrigin::File { path } => path.file_name().unwrap_or(path.as_os_str()).to_string_lossy().into_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeapSnapshotInfo {
    pub id: HeapSnapshotId,
    pub label: String,
    pub origin: HeapOrigin,
    pub summary: HeapSummary,
    /// Unix time in milliseconds when the snapshot was opened.
    pub created_ms: u64,
}

/// An analyzed snapshot together with the directory that holds its files. Dropping it unmaps the
/// index and then removes the directory, dump included for a capture; a dump opened from a file
/// is outside the directory and stays.
pub struct OpenSnapshot {
    pub info: HeapSnapshotInfo,
    /// `None` only while dropping, so the mappings are gone before the directory is deleted
    /// (Windows cannot delete a mapped file).
    index: Option<HeapIndex>,
    /// Holds the index files and the dump of a capture.
    pub dir: PathBuf,
    pub dump: PathBuf,
    /// Set by [`HeapRegistry::insert`] once `dir` is known to be one of the registry's own.
    remove_dir: bool,
}

impl OpenSnapshot {
    /// The directory is not removed on drop until the snapshot is in a [`HeapRegistry`] whose
    /// root holds it.
    pub fn new(info: HeapSnapshotInfo, index: HeapIndex, dir: PathBuf, dump: PathBuf) -> Self {
        Self { info, index: Some(index), dir, dump, remove_dir: false }
    }

    pub fn index(&self) -> &HeapIndex {
        self.index.as_ref().expect("the index is only taken while dropping")
    }
}

impl Drop for OpenSnapshot {
    fn drop(&mut self) {
        drop(self.index.take());
        if !self.remove_dir {
            return;
        }
        // The user's own dump that happens to sit inside `dir`.
        if matches!(self.info.origin, HeapOrigin::File { .. }) && self.dump.starts_with(&self.dir) {
            return;
        }
        // A link is not followed: only a real directory is deleted.
        if std::fs::symlink_metadata(&self.dir).is_ok_and(|meta| meta.file_type().is_dir())
            && let Err(err) = std::fs::remove_dir_all(&self.dir)
        {
            tracing::warn!(dir = %self.dir.display(), %err, "could not remove a heap snapshot directory");
        }
    }
}

struct State {
    next_id: u32,
    open: BTreeMap<u32, Arc<OpenSnapshot>>,
}

/// The open snapshots, shared between threads. Ids are never reused within a process.
pub struct HeapRegistry {
    root: PathBuf,
    state: Mutex<State>,
}

impl HeapRegistry {
    /// Registry for snapshot directories under `root`; first removes the directories there that
    /// belong to processes that no longer exist.
    pub fn new(root: PathBuf) -> Self {
        remove_stale(&root, process_alive);
        Self { root, state: Mutex::new(State { next_id: 1, open: BTreeMap::new() }) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers the snapshot that `make` builds for a fresh id. `make` runs outside the lock.
    pub fn insert(&self, make: impl FnOnce(HeapSnapshotId) -> OpenSnapshot) -> HeapSnapshotInfo {
        let id = {
            let mut state = self.state();
            let id = state.next_id;
            state.next_id = id.saturating_add(1);
            HeapSnapshotId(id)
        };
        let mut snapshot = make(id);
        snapshot.info.id = id;
        snapshot.remove_dir = snapshot.dir.file_name().is_some() && snapshot.dir.parent() == Some(self.root.as_path());
        if !snapshot.remove_dir {
            tracing::warn!(dir = %snapshot.dir.display(), "heap snapshot directory is outside the registry root; keeping it");
        }
        let info = snapshot.info.clone();
        self.state().open.insert(id.0, Arc::new(snapshot));
        info
    }

    pub fn get(&self, id: HeapSnapshotId) -> Option<Arc<OpenSnapshot>> {
        self.state().open.get(&id.0).cloned()
    }

    /// Forgets the snapshot; its directory goes once the last query using it lets go. `false` for
    /// an id that is not open.
    pub fn close(&self, id: HeapSnapshotId) -> bool {
        // Bound first so the lock is released before the snapshot may be dropped: that deletes files.
        let removed = self.state().open.remove(&id.0);
        removed.is_some()
    }

    /// In the order the snapshots were opened.
    pub fn list(&self) -> Vec<HeapSnapshotInfo> {
        self.state().open.values().map(|snapshot| snapshot.info.clone()).collect()
    }
}

#[cfg(test)]
mod tests;
