//! Paths outside a project that a plugin watches (`events.watch-paths`, API 1.18).
//!
//! A watch set belongs to (plugin, project) and the window that asked for it. Every
//! directory is watched flat (its own entries): a watched file through its parent, a
//! watched directory through itself plus its parent (so its own removal is seen).
//! Watcher threads only queue changes here; [`super::PluginHost::flush_events_at`]
//! delivers them while the set, its window and its project are still current.
use ide_core::{NullSink, ipc_path::to_ipc};
use ide_plugin::{FilesChanged, HostError};
use ide_vfs::{FsBatch, WatchMode, Watcher};
use parking_lot::Mutex;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub(super) struct ExternalWatches {
    sets: Mutex<HashMap<(String, PathBuf), WatchSet>>,
    pending: Arc<Mutex<Vec<Change>>>,
    next: AtomicU64,
}

struct WatchSet {
    id: u64,
    client: String,
    _watchers: Vec<Watcher>,
}

/// Changes seen by one watch set, waiting for delivery.
pub(super) struct Change {
    pub plugin: String,
    pub client: String,
    pub project: PathBuf,
    set: u64,
    pub batch: FilesChanged,
}

/// What one flat directory watch reports: entries named exactly, or all of them.
#[derive(Default)]
struct Wanted {
    exact: BTreeSet<PathBuf>,
    entries: bool,
}

impl ExternalWatches {
    /// Replaces what `plugin` watches for `project` from window `client`.
    pub fn set(&self, plugin: &str, client: &str, project: &Path, paths: Vec<PathBuf>) -> Result<(), HostError> {
        let key = (plugin.to_owned(), project.to_path_buf());
        if paths.is_empty() {
            self.sets.lock().remove(&key);
            return Ok(());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut dirs: BTreeMap<PathBuf, Wanted> = BTreeMap::new();
        for path in &paths {
            if let Some(parent) = path.parent() {
                dirs.entry(parent.to_path_buf()).or_default().exact.insert(path.clone());
            }
            if path.is_dir() {
                dirs.entry(path.clone()).or_default().entries = true;
            }
        }
        let mut watchers = Vec::with_capacity(dirs.len());
        for (dir, wanted) in dirs {
            let pending = Arc::downgrade(&self.pending);
            let (plugin, client, project) = (plugin.to_owned(), client.to_owned(), project.to_path_buf());
            let watched = dir.clone();
            let on_change = Box::new(move |batch: &FsBatch| {
                let Some(pending) = pending.upgrade() else { return };
                let Some(batch) = select(&watched, &wanted, batch) else { return };
                // Drained on every event flush; bounded by the flat directories' entries.
                pending.lock().push(Change {
                    plugin: plugin.clone(),
                    client: client.clone(),
                    project: project.clone(),
                    set: id,
                    batch,
                });
            });
            let watcher = Watcher::start_with(&dir, Vec::new(), Arc::new(NullSink), on_change, WatchMode::Flat)
                .map_err(|e| HostError::Failed(format!("cannot watch {}: {}", dir.display(), e.message)))?;
            watchers.push(watcher);
        }
        let set = WatchSet { id, client: client.to_owned(), _watchers: watchers };
        self.sets.lock().insert(key, set);
        Ok(())
    }

    /// Changes of sets still in place, oldest first; others are dropped.
    pub fn take(&self) -> Vec<Change> {
        let changes = std::mem::take(&mut *self.pending.lock());
        if changes.is_empty() {
            return changes;
        }
        let sets = self.sets.lock();
        changes
            .into_iter()
            .filter(|c| {
                sets.get(&(c.plugin.clone(), c.project.clone())).is_some_and(|s| s.id == c.set && s.client == c.client)
            })
            .collect()
    }

    pub fn remove_plugin(&self, plugin: &str) {
        self.sets.lock().retain(|(p, _), _| p != plugin);
    }

    pub fn remove_project(&self, root: &Path) {
        self.sets.lock().retain(|(_, project), _| project != root);
    }

    pub fn remove_client(&self, client: &str) {
        self.sets.lock().retain(|_, set| set.client != client);
    }
}

/// The part of `batch` (from the flat watch on `dir`) the set asked for. Ignored
/// files are reported too: as modified while they exist, removed once they don't.
fn select(dir: &Path, wanted: &Wanted, batch: &FsBatch) -> Option<FilesChanged> {
    let keep = |path: &&PathBuf| wanted.exact.contains(*path) || (wanted.entries && path.parent() == Some(dir));
    let ipc = |paths: Vec<&PathBuf>| paths.into_iter().map(|p| to_ipc(p)).collect::<Vec<_>>();
    let mut modified: Vec<&PathBuf> = batch.modified.iter().filter(keep).collect();
    let mut removed: Vec<&PathBuf> = batch.removed.iter().filter(keep).collect();
    for path in batch.ignored.iter().filter(keep) {
        if path.symlink_metadata().is_ok() { modified.push(path) } else { removed.push(path) }
    }
    let changes = FilesChanged {
        project: None,
        generation: None,
        created: ipc(batch.created.iter().filter(keep).collect()),
        modified: ipc(modified),
        removed: ipc(removed),
    };
    (!changes.created.is_empty() || !changes.modified.is_empty() || !changes.removed.is_empty()).then_some(changes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(created: &[&Path], modified: &[&Path], removed: &[&Path], ignored: &[&Path]) -> FsBatch {
        let v = |p: &[&Path]| p.iter().map(|p| p.to_path_buf()).collect();
        FsBatch {
            created: v(created),
            modified: v(modified),
            removed: v(removed),
            ignored: v(ignored),
            ..Default::default()
        }
    }

    #[test]
    fn a_flat_watch_reports_only_what_the_set_names() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let (file, other, kept) = (dir.join("Taskfile.yml"), dir.join("other.yml"), dir.join("kept.yml"));
        std::fs::write(&kept, "").unwrap();
        let exact = Wanted { exact: [file.clone()].into(), entries: false };
        let got = select(dir, &exact, &batch(&[&file], &[&other], &[], &[&kept])).unwrap();
        assert_eq!(got.created, vec![to_ipc(&file)]);
        assert!(got.modified.is_empty() && got.removed.is_empty());
        assert!(select(dir, &exact, &batch(&[], &[&other], &[], &[])).is_none());

        let nested = dir.join("sub").join("deep.yml");
        let entries = Wanted { exact: BTreeSet::new(), entries: true };
        let gone = dir.join("gone.yml");
        let got = select(dir, &entries, &batch(&[&nested], &[&other], &[], &[&kept, &gone])).unwrap();
        assert!(got.created.is_empty(), "entries below the directory are not watched");
        assert_eq!(got.modified, vec![to_ipc(&other), to_ipc(&kept)]);
        assert_eq!(got.removed, vec![to_ipc(&gone)]);
    }
}
