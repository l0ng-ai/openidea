use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HistoryKind {
    /// A stored revision of `path`.
    #[default]
    Snapshot,
    /// A user label ("Put Label…") or system event ("Before Git checkout")
    /// for everything under `path` (the project root); has no content.
    Label,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// Content hash (blake3 hex); identifies the stored blob. Empty for labels.
    pub id: String,
    pub path: ide_core::IpcPath,
    pub timestamp_ms: f64,
    /// e.g. "Saved", "External change", "Deleted", "Before refactoring: Move".
    pub label: String,
    pub size: u64,
    #[serde(default)]
    pub kind: HistoryKind,
    /// Exact on-disk bytes for Undo when document text omits a BOM or line endings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(skip)]
    undo_blob: Option<UndoBlob>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct UndoBlob {
    id: String,
    size: u64,
}

impl HistoryEntry {
    fn snapshot(path: &Path, text: &str, label: &str, timestamp_ms: f64) -> Self {
        Self {
            id: blake3::hash(text.as_bytes()).to_hex().to_string(),
            path: path.into(),
            timestamp_ms,
            label: label.to_owned(),
            size: text.len() as u64,
            kind: HistoryKind::Snapshot,
            undo_blob: None,
        }
    }

    fn blobs(&self) -> impl Iterator<Item = (&str, u64)> {
        std::iter::once((self.id.as_str(), self.size))
            .chain(self.undo_blob.iter().map(|blob| (blob.id.as_str(), blob.size)))
    }
}

/// Changes under a folder (Show History on a directory).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryHistory {
    /// Snapshots of files under the folder and labels, newest first.
    pub entries: Vec<HistoryEntry>,
    /// Files with history that no longer exist on disk.
    pub deleted: Vec<ide_core::IpcPath>,
}

/// Paths and contents captured for one delete operation. Directory history is
/// intentionally broader and can contain paths deleted in an earlier operation.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletionUndo {
    directories: Vec<ide_core::IpcPath>,
    files: Vec<DeletedFile>,
    skipped: Vec<ide_core::IpcPath>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeletedFile {
    path: ide_core::IpcPath,
    id: String,
}

/// How much history is kept (Settings › Advanced › Local History).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Retention {
    /// IDEA keeps history for N *working* days: days on which something was recorded.
    pub working_days: u32,
    /// Upper bound for the stored blobs; the oldest snapshots go first.
    pub max_bytes: u64,
}

impl Default for Retention {
    fn default() -> Self {
        Self { working_days: DEFAULT_MAX_AGE_DAYS, max_bytes: DEFAULT_MAX_BYTES }
    }
}

/// IDEA-style Local History: content-addressed snapshots under
/// `<app-data>/history/<project-hash>/`, pruned by [`Retention`].
///
/// Layout: `blobs/<2 hex>/<64 hex>` holds contents, `index.jsonl` is an
/// append-only log of [`HistoryEntry`] lines (rewritten only by [`prune`](Self::prune)).
pub struct LocalHistory {
    dir: PathBuf,
    state: Mutex<HistoryState>,
}

#[derive(Default)]
struct HistoryState {
    entries: Vec<HistoryEntry>,
    /// Latest recorded content hash per path, for deduplication (absent after a deletion).
    last: HashMap<PathBuf, String>,
}

impl HistoryState {
    fn from_entries(entries: Vec<HistoryEntry>) -> Self {
        let mut last = HashMap::new();
        for e in entries.iter().filter(|e| e.kind == HistoryKind::Snapshot) {
            if e.label == DELETED {
                last.remove(&*e.path);
            } else {
                last.insert(e.path.to_path_buf(), e.id.clone());
            }
        }
        Self { entries, last }
    }
}

pub const DEFAULT_MAX_AGE_DAYS: u32 = 5;
pub const DEFAULT_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// Label of the snapshot taken before a file is deleted.
pub const DELETED: &str = "Deleted";
/// The label of a file's content from before its first edit ([`LocalHistory::record_original`]).
pub const ORIGINAL: &str = "Original";
/// Files larger than this are not snapshotted automatically (watcher, deletes, VCS).
const AUTO_SNAPSHOT_LIMIT: u64 = 2 * 1024 * 1024;
const DAY_MS: f64 = 86_400_000.0;

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_entry(e: &HistoryEntry) -> bool {
    match e.kind {
        HistoryKind::Snapshot => valid_id(&e.id) && e.undo_blob.as_ref().is_none_or(|blob| valid_id(&blob.id)),
        HistoryKind::Label => e.id.is_empty(),
    }
}

/// Text of a file for an automatic snapshot: small, non-binary files only.
fn read_snapshot_text(path: &Path) -> Option<String> {
    read_snapshot_disk_text(path).map(|text| document_text(&text).into_owned())
}

fn read_snapshot_disk_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > AUTO_SNAPSHOT_LIMIT {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path).ok()?.take(AUTO_SNAPSHOT_LIMIT + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > AUTO_SNAPSHOT_LIMIT || bytes.iter().take(8192).any(|b| *b == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Directory junctions and similar reparse points must not be traversed.
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn restore_deleted_bytes(path: &Path, bytes: &[u8]) -> IdeResult<()> {
    let parent = path.parent().ok_or_else(|| IdeError::invalid("missing parent for deleted file"))?;
    // Publish only a complete file, and never replace a new file at that path.
    let mut builder = tempfile::Builder::new();
    builder.prefix(".undo.openidea-tmp-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let mut pending = builder.tempfile_in(parent)?;
    pending.write_all(bytes)?;
    pending.persist_noclobber(path).map_err(|error| error.error)?;
    Ok(())
}

/// `text` as a document holds it: without the UTF-8 BOM and with `\n` line endings. Saves
/// record the document's text, so a file read from disk must match it to dedupe, and
/// Revert writes it back through the document, which adds the file's BOM and line endings.
fn document_text(text: &str) -> std::borrow::Cow<'_, str> {
    ide_text::normalize_line_endings(text.strip_prefix('\u{feff}').unwrap_or(text))
}

impl LocalHistory {
    pub fn open(store_dir: &Path, project_root: &Path) -> IdeResult<Self> {
        let key = blake3::hash(project_root.to_string_lossy().as_bytes()).to_hex();
        let dir = store_dir.join(&key.as_str()[..16]);
        fs::create_dir_all(dir.join("blobs"))?;
        let root_file = dir.join("project-root");
        if !root_file.exists() {
            let _ = fs::write(&root_file, project_root.to_string_lossy().as_bytes());
        }
        let history = Self { dir, state: Mutex::default() };
        *history.state.lock() = HistoryState::from_entries(history.read_index()?);
        Ok(history)
    }

    fn index_path(&self) -> PathBuf {
        self.dir.join("index.jsonl")
    }

    fn blob_path(&self, id: &str) -> PathBuf {
        self.dir.join("blobs").join(&id[..2]).join(id)
    }

    fn read_index(&self) -> IdeResult<Vec<HistoryEntry>> {
        let text = match fs::read_to_string(self.index_path()) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        Ok(text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| match serde_json::from_str::<HistoryEntry>(l) {
                Ok(e) if valid_entry(&e) => Some(e),
                Ok(_) => None,
                Err(e) => {
                    tracing::debug!("local history: skipping corrupt index line: {e}");
                    None
                }
            })
            .collect())
    }

    fn append(&self, state: &mut HistoryState, entry: HistoryEntry) -> IdeResult<()> {
        let mut line = serde_json::to_string(&entry).map_err(|e| IdeError::internal(e.to_string()))?;
        line.push('\n');
        let mut index = fs::OpenOptions::new().create(true).append(true).open(self.index_path())?;
        index.write_all(line.as_bytes())?;
        if entry.kind == HistoryKind::Snapshot {
            if entry.label == DELETED {
                state.last.remove(&*entry.path);
            } else {
                state.last.insert(entry.path.to_path_buf(), entry.id.clone());
            }
        }
        state.entries.push(entry);
        Ok(())
    }

    /// Called with the history lock held, so prune cannot remove a blob before its entry exists.
    fn store_blob(&self, id: &str, bytes: &[u8]) -> IdeResult<()> {
        let blob = self.blob_path(id);
        if !blob.exists() {
            fs::create_dir_all(blob.parent().expect("blob has a parent"))?;
            ide_vfs::write_atomic(&blob, bytes)?;
        }
        Ok(())
    }

    fn store(&self, path: &Path, content: &str, label: &str, force: bool, original: Option<&str>) -> IdeResult<String> {
        let mut state = self.state.lock();
        let entry = HistoryEntry::snapshot(path, content, label, now_ms());
        if !force && state.last.get(path) == Some(&entry.id) {
            return Ok(entry.id);
        }
        self.store_locked(&mut state, entry, content, original)
    }

    fn store_locked(
        &self,
        state: &mut HistoryState,
        mut entry: HistoryEntry,
        content: &str,
        original: Option<&str>,
    ) -> IdeResult<String> {
        self.store_blob(&entry.id, content.as_bytes())?;
        entry.undo_blob = if let Some(original) = original.filter(|text| *text != content) {
            let id = blake3::hash(original.as_bytes()).to_hex().to_string();
            self.store_blob(&id, original.as_bytes())?;
            Some(UndoBlob { id, size: original.len() as u64 })
        } else {
            None
        };
        let undo_id = entry.undo_blob.as_ref().map_or_else(|| entry.id.clone(), |blob| blob.id.clone());
        self.append(state, entry)?;
        Ok(undo_id)
    }

    /// Records a snapshot unless it equals the latest one recorded for `path`.
    pub fn record(&self, path: &Path, content: &str, label: &str) -> IdeResult<()> {
        self.store(path, content, label, false, None).map(|_| ())
    }

    /// Records a snapshot even when the content did not change, so the event
    /// ("Deleted", "Before refactoring: Move") shows in the history.
    pub fn record_event(&self, path: &Path, content: &str, label: &str) -> IdeResult<()> {
        self.store(path, content, label, true, None).map(|_| ())
    }

    /// Snapshots the file on disk (small text files only); `force` as in [`record_event`](Self::record_event).
    pub fn record_file(&self, path: &Path, label: &str, force: bool) -> IdeResult<bool> {
        match read_snapshot_text(path) {
            Some(text) => self.store(path, &text, label, force, None).map(|_| true),
            None => Ok(false),
        }
    }

    /// Before the first edit of a file with no history: its content on disk, so a label put
    /// before the edit can be reverted to. Dated by the file's modification time, since it
    /// has had that content from then on, but not before the oldest entry kept, so it neither
    /// adds a working day of its own nor falls to retention first. Returns whether one was recorded.
    pub fn record_original(&self, path: &Path) -> IdeResult<bool> {
        let Some(text) = read_snapshot_text(path) else { return Ok(false) };
        let modified = fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0);
        let mut state = self.state.lock();
        if state.entries.iter().any(|e| e.kind == HistoryKind::Snapshot && e.path == path) {
            return Ok(false);
        }
        let now = now_ms();
        let oldest = state.entries.iter().map(|e| e.timestamp_ms).reduce(f64::min);
        let timestamp = match (modified, oldest) {
            (Some(modified), Some(oldest)) => modified.max(oldest - 1.0).min(now),
            _ => now,
        };
        let entry = HistoryEntry::snapshot(path, &text, ORIGINAL, timestamp);
        self.store_locked(&mut state, entry, &text, None).map(|_| true)
    }

    /// Snapshots `path`, or every file below it when it is a folder (at most `limit`
    /// files), before it is deleted. Returns how many files were recorded.
    pub fn record_deletion(&self, path: &Path, limit: usize) -> usize {
        let mut files = Vec::new();
        if path.is_dir() {
            collect_files(path, limit, &mut files);
        } else {
            files.push(path.to_path_buf());
        }
        files
            .iter()
            .filter(|f| match self.record_file(f, DELETED, true) {
                Ok(recorded) => recorded,
                Err(e) => {
                    tracing::debug!("local history: {}: {e}", f.display());
                    false
                }
            })
            .count()
    }

    /// Captures only paths that belong to this delete, including empty folders.
    /// The backup observes the same content limit as automatic history, but
    /// keeps exact bytes so a recreated file does not pick up new file defaults.
    pub fn capture_deletion_undo(&self, paths: &[PathBuf], limit: usize) -> DeletionUndo {
        let mut undo = DeletionUndo::default();
        let mut remaining = limit;
        for path in paths {
            self.capture_deleted_entry(path, &mut remaining, &mut undo);
        }
        undo
    }

    fn capture_deleted_entry(&self, path: &Path, remaining: &mut usize, undo: &mut DeletionUndo) {
        if *remaining == 0 {
            undo.skipped.push(path.into());
            return;
        }
        *remaining -= 1;

        let Ok(metadata) = fs::symlink_metadata(path) else {
            undo.skipped.push(path.into());
            return;
        };
        if is_link(&metadata) {
            undo.skipped.push(path.into());
        } else if metadata.is_dir() {
            if path.file_name().is_some_and(|name| name == ".git") {
                undo.skipped.push(path.into());
                return;
            }
            undo.directories.push(path.into());
            let Ok(entries) = fs::read_dir(path) else {
                undo.skipped.push(path.into());
                return;
            };
            for entry in entries {
                if *remaining == 0 {
                    // Identify the unscanned subtree without enumerating the rest of it.
                    undo.skipped.push(path.into());
                    break;
                }
                if let Ok(entry) = entry {
                    self.capture_deleted_entry(&entry.path(), remaining, undo);
                } else if !undo.skipped.iter().any(|entry| entry.as_ref() == path) {
                    undo.skipped.push(path.into());
                }
            }
        } else if let Some(id) = read_snapshot_disk_text(path)
            .and_then(|raw| self.store(path, &document_text(&raw), DELETED, true, Some(&raw)).ok())
        {
            undo.files.push(DeletedFile { path: path.into(), id });
        } else {
            undo.skipped.push(path.into());
        }
    }

    /// Returns entries the caller should direct the user to recover from the
    /// system Trash. A newly occupied path and its subtree are left alone.
    pub fn restore_deletion_undo(&self, undo: DeletionUndo) -> Vec<ide_core::IpcPath> {
        let mut skipped = undo.skipped;
        let mut blocked: Vec<ide_core::IpcPath> = Vec::new();
        for path in undo.directories {
            if blocked.iter().any(|parent| path.starts_with(parent)) {
                continue;
            }
            if let Err(error) = fs::create_dir(&*path) {
                tracing::debug!("cannot restore deleted directory {}: {error}", path.display());
                skipped.push(path.clone());
                blocked.push(path);
            }
        }
        for file in undo.files {
            if blocked.iter().any(|parent| file.path.starts_with(parent)) {
                continue;
            }
            let restored = self.read_blob(&file.id).and_then(|bytes| restore_deleted_bytes(&file.path, &bytes));
            if let Err(error) = restored {
                tracing::debug!("cannot restore deleted file {}: {error}", file.path.display());
                skipped.push(file.path);
            }
        }
        skipped.sort();
        skipped.dedup();
        skipped
    }

    /// The watcher saw `paths` disappear: files with history that are gone get a
    /// "Deleted" entry pointing at their last content (unless one was recorded already).
    pub fn note_removed(&self, paths: &[PathBuf]) -> IdeResult<()> {
        let mut state = self.state.lock();
        let gone: Vec<(PathBuf, String, u64)> = {
            let mut latest: HashMap<&Path, &HistoryEntry> = HashMap::new();
            for e in state.entries.iter().filter(|e| e.kind == HistoryKind::Snapshot) {
                if paths.iter().any(|p| e.path.starts_with(p)) {
                    latest.insert(&e.path, e);
                }
            }
            latest
                .into_values()
                .filter(|e| e.label != DELETED && !e.path.exists())
                .map(|e| (e.path.to_path_buf(), e.id.clone(), e.size))
                .collect()
        };
        for (path, id, size) in gone {
            let entry = HistoryEntry {
                id,
                path: path.into(),
                timestamp_ms: now_ms(),
                label: DELETED.into(),
                size,
                kind: HistoryKind::Snapshot,
                undo_blob: None,
            };
            self.append(&mut state, entry)?;
        }
        Ok(())
    }

    /// Adds a label (user "Put Label…" or a system event) for everything under `scope`.
    pub fn put_label(&self, scope: &Path, label: &str) -> IdeResult<()> {
        let label = label.trim();
        if label.is_empty() {
            return Err(IdeError::invalid("label is empty"));
        }
        let entry = HistoryEntry {
            id: String::new(),
            path: scope.into(),
            timestamp_ms: now_ms(),
            label: label.to_owned(),
            size: 0,
            kind: HistoryKind::Label,
            undo_blob: None,
        };
        let mut state = self.state.lock();
        self.append(&mut state, entry)
    }

    /// Snapshots of `path` plus the labels that cover it, newest first.
    pub fn list(&self, path: &Path) -> IdeResult<Vec<HistoryEntry>> {
        let state = self.state.lock();
        let mut out: Vec<HistoryEntry> = state
            .entries
            .iter()
            .filter(|e| match e.kind {
                HistoryKind::Snapshot => e.path == path,
                HistoryKind::Label => path.starts_with(&e.path),
            })
            .cloned()
            .collect();
        out.sort_by(|a, b| b.timestamp_ms.total_cmp(&a.timestamp_ms));
        Ok(out)
    }

    /// Snapshots of every file under `dir` (deleted ones included) plus labels.
    pub fn list_dir(&self, dir: &Path) -> IdeResult<DirectoryHistory> {
        let state = self.state.lock();
        let mut entries: Vec<HistoryEntry> = state
            .entries
            .iter()
            .filter(|e| match e.kind {
                HistoryKind::Snapshot => e.path.starts_with(dir),
                HistoryKind::Label => dir.starts_with(&e.path) || e.path.starts_with(dir),
            })
            .cloned()
            .collect();
        drop(state);
        entries.sort_by(|a, b| b.timestamp_ms.total_cmp(&a.timestamp_ms));
        let mut seen = HashSet::new();
        let deleted = entries
            .iter()
            .filter(|e| e.kind == HistoryKind::Snapshot && seen.insert(e.path.clone()))
            .filter(|e| !e.path.exists())
            .map(|e| e.path.clone())
            .collect();
        Ok(DirectoryHistory { entries, deleted })
    }

    fn read_blob(&self, id: &str) -> IdeResult<Vec<u8>> {
        if !valid_id(id) {
            return Err(IdeError::invalid(format!("invalid history id {id:?}")));
        }
        match fs::read(self.blob_path(id)) {
            Ok(bytes) => Ok(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(IdeError::not_found(format!("history snapshot {id} not found")))
            }
            Err(e) => Err(e.into()),
        }
    }

    pub fn content(&self, id: &str) -> IdeResult<String> {
        let bytes = self.read_blob(id)?;
        let text = String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into());
        Ok(document_text(&text).into_owned())
    }

    /// Bytes stored in blobs.
    pub fn stored_bytes(&self) -> u64 {
        let state = self.state.lock();
        let mut seen = HashSet::new();
        state
            .entries
            .iter()
            .filter(|e| e.kind == HistoryKind::Snapshot)
            .flat_map(HistoryEntry::blobs)
            .filter(|(id, _)| seen.insert(*id))
            .map(|(_, size)| size)
            .sum()
    }

    /// Drops entries older than `max_age_days` calendar days and unreferenced blobs.
    pub fn prune(&self, max_age_days: u32) -> IdeResult<()> {
        let cutoff = now_ms() - f64::from(max_age_days) * DAY_MS;
        self.rewrite(|entries| entries.into_iter().filter(|e| e.timestamp_ms >= cutoff).collect())
    }

    /// Applies `retention`: keeps the last N working days (days with entries),
    /// then drops the oldest snapshots until the blobs fit `max_bytes`.
    pub fn apply_retention(&self, retention: Retention) -> IdeResult<()> {
        self.rewrite(|entries| retain(entries, retention))
    }

    /// Deletes all history of this project.
    pub fn clear(&self) -> IdeResult<()> {
        self.rewrite(|_| Vec::new())
    }

    fn rewrite(&self, keep: impl FnOnce(Vec<HistoryEntry>) -> Vec<HistoryEntry>) -> IdeResult<()> {
        let mut state = self.state.lock();
        // Re-read so entries appended by another instance are not lost.
        let kept = keep(self.read_index()?);
        let mut text = String::new();
        for e in &kept {
            text.push_str(&serde_json::to_string(e).map_err(|e| IdeError::internal(e.to_string()))?);
            text.push('\n');
        }
        ide_vfs::write_atomic(&self.index_path(), text.as_bytes())?;

        let referenced: HashSet<&str> = kept.iter().flat_map(HistoryEntry::blobs).map(|(id, _)| id).collect();
        for shard in fs::read_dir(self.dir.join("blobs"))?.flatten() {
            let Ok(files) = fs::read_dir(shard.path()) else { continue };
            let mut remaining = 0usize;
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().into_owned();
                if referenced.contains(name.as_str()) {
                    remaining += 1;
                } else if let Err(e) = fs::remove_file(file.path()) {
                    tracing::debug!("local history: cannot remove {}: {e}", file.path().display());
                    remaining += 1;
                }
            }
            if remaining == 0 {
                let _ = fs::remove_dir(shard.path());
            }
        }
        *state = HistoryState::from_entries(kept);
        Ok(())
    }
}

fn day_of(ms: f64) -> i64 {
    (ms / DAY_MS).floor() as i64
}

/// Entries surviving `retention` (input in log order, output too).
fn retain(entries: Vec<HistoryEntry>, retention: Retention) -> Vec<HistoryEntry> {
    let days: std::collections::BTreeSet<i64> = entries.iter().map(|e| day_of(e.timestamp_ms)).collect();
    let first_day = days.iter().rev().nth(retention.working_days.saturating_sub(1) as usize).copied();
    let mut kept: Vec<HistoryEntry> = match (first_day, retention.working_days) {
        (_, 0) => Vec::new(),
        (Some(first), _) => entries.into_iter().filter(|e| day_of(e.timestamp_ms) >= first).collect(),
        (None, _) => entries,
    };
    // Size bound: unique blob bytes, oldest snapshots dropped first.
    let mut refs: HashMap<String, (usize, u64)> = HashMap::new();
    for (id, size) in kept.iter().filter(|e| e.kind == HistoryKind::Snapshot).flat_map(HistoryEntry::blobs) {
        refs.entry(id.to_owned()).or_insert((0, size)).0 += 1;
    }
    let mut total: u64 = refs.values().map(|(_, size)| size).sum();
    if total <= retention.max_bytes {
        return kept;
    }
    let mut order: Vec<usize> = (0..kept.len()).filter(|&i| kept[i].kind == HistoryKind::Snapshot).collect();
    order.sort_by(|&a, &b| kept[a].timestamp_ms.total_cmp(&kept[b].timestamp_ms));
    let mut drop = vec![false; kept.len()];
    for i in order {
        if total <= retention.max_bytes {
            break;
        }
        drop[i] = true;
        for (id, _) in kept[i].blobs() {
            let r = refs.get_mut(id).expect("counted");
            r.0 -= 1;
            if r.0 == 0 {
                total -= r.1;
            }
        }
    }
    let mut i = 0;
    kept.retain(|_| {
        i += 1;
        !drop[i - 1]
    });
    kept
}

/// Files below `dir` (depth-first, hidden folders like `.git` skipped), at most `limit`.
fn collect_files(dir: &Path, limit: usize, out: &mut Vec<PathBuf>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if entry.file_name() != ".git" {
                collect_files(&path, limit, out);
            }
        } else if ft.is_file() {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_list_dedupe_prune() {
        let tmp = tempfile::tempdir().unwrap();
        let store = tmp.path().join("history");
        let root = tmp.path().join("project");
        let h = LocalHistory::open(&store, &root).unwrap();
        let file = root.join("src/main.rs");
        let other = root.join("README.md");

        h.record(&file, "v1", "Saved").unwrap();
        h.record(&file, "v1", "Saved").unwrap(); // identical consecutive: skipped
        std::thread::sleep(std::time::Duration::from_millis(2));
        h.record(&file, "v2", "Saved").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        h.record(&file, "v1", "External change").unwrap(); // not consecutive: kept
        h.record(&other, "v1", "Saved").unwrap();

        let list = h.list(&file).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].label, "External change");
        assert_eq!(h.content(&list[1].id).unwrap(), "v2");
        assert_eq!(list[0].id, list[2].id);
        assert_eq!(list[2].size, 2);
        assert_eq!(h.list(&other).unwrap().len(), 1);
        assert!(h.list(&root.join("nope")).unwrap().is_empty());
        assert_eq!(h.content("../../etc/passwd").unwrap_err().kind, ide_core::error::ErrorKind::InvalidInput);
        assert_eq!(h.content(&"0".repeat(64)).unwrap_err().kind, ide_core::error::ErrorKind::NotFound);

        // Reopening restores the index and dedupe state.
        drop(h);
        let h = LocalHistory::open(&store, &root).unwrap();
        assert_eq!(h.list(&file).unwrap().len(), 3);
        h.record(&file, "v1", "Saved").unwrap();
        assert_eq!(h.list(&file).unwrap().len(), 3);

        // A different project gets a different directory.
        let h2 = LocalHistory::open(&store, &tmp.path().join("other")).unwrap();
        assert!(h2.list(&file).unwrap().is_empty());

        h.prune(1).unwrap();
        assert_eq!(h.list(&file).unwrap().len(), 3);
        let v2 = h.list(&file).unwrap()[1].id.clone();
        h.prune(0).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        h.prune(0).unwrap();
        assert!(h.list(&file).unwrap().is_empty());
        assert_eq!(h.content(&v2).unwrap_err().kind, ide_core::error::ErrorKind::NotFound);
        h.record(&file, "v1", "Saved").unwrap();
        assert_eq!(h.list(&file).unwrap().len(), 1);
    }

    fn entry(id: &str, path: &str, day: i64, size: u64, kind: HistoryKind) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            path: path.into(),
            timestamp_ms: day as f64 * DAY_MS + 1000.0,
            label: "Saved".into(),
            size,
            kind,
            undo_blob: None,
        }
    }

    #[test]
    fn a_file_read_from_disk_matches_the_saved_document_text() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let h = LocalHistory::open(&tmp.path().join("history"), &root).unwrap();
        let a = root.join("a.txt");
        // A save records the document's text; the file on disk has a BOM and CRLF.
        fs::write(&a, b"\xEF\xBB\xBFheader\r\nbody\r\n").unwrap();
        h.record(&a, "header\nbody\n", "Saved").unwrap();
        assert!(h.record_file(&a, "External change", false).unwrap());
        let list = h.list(&a).unwrap();
        assert_eq!(list.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(), ["Saved"], "no second revision");
        // A snapshot stored with its BOM before reads back as document text.
        h.record(&a, "\u{feff}old\r\n", "External change").unwrap();
        let old = &h.list(&a).unwrap()[0];
        assert_eq!(h.content(&old.id).unwrap(), "old\n");
    }

    #[test]
    fn events_labels_and_deletions() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        fs::create_dir_all(root.join("src/sub")).unwrap();
        let h = LocalHistory::open(&tmp.path().join("history"), &root).unwrap();
        let a = root.join("src/a.txt");
        let b = root.join("src/sub/b.txt");
        fs::write(&a, "a1").unwrap();
        fs::write(&b, "b1").unwrap();
        fs::write(root.join("src/bin.dat"), [0u8, 1, 2]).unwrap();

        h.record(&a, "a1", "Saved").unwrap();
        assert!(h.record_file(&a, "External change", false).unwrap());
        assert_eq!(h.list(&a).unwrap().len(), 1, "same content is deduplicated");
        h.record_event(&a, "a1", "Before refactoring: Move").unwrap();
        assert_eq!(h.list(&a).unwrap()[0].label, "Before refactoring: Move");
        assert!(!h.record_file(&root.join("src/bin.dat"), "External change", false).unwrap());

        h.put_label(&root, "Before Git checkout").unwrap();
        assert!(h.put_label(&root, "  ").is_err());
        let list = h.list(&a).unwrap();
        assert_eq!(list[0].kind, HistoryKind::Label);
        assert_eq!(list[0].label, "Before Git checkout");

        // Deleting a folder snapshots every text file below it first.
        assert_eq!(h.record_deletion(&root.join("src/sub"), 100), 1);
        fs::remove_dir_all(root.join("src/sub")).unwrap();
        let after = h.list(&b).unwrap();
        assert_eq!(after.iter().find(|e| e.kind == HistoryKind::Snapshot).unwrap().label, DELETED);
        // The watcher reporting the same removal adds nothing.
        h.note_removed(&[root.join("src/sub")]).unwrap();
        assert_eq!(h.list(&b).unwrap().len(), after.len());

        // An external deletion of a file with history gets a "Deleted" entry.
        fs::remove_file(&a).unwrap();
        h.note_removed(std::slice::from_ref(&a)).unwrap();
        let gone = &h.list(&a).unwrap()[0];
        assert_eq!((gone.label.as_str(), h.content(&gone.id).unwrap().as_str()), (DELETED, "a1"));
        // Recreated with the old content: recorded again.
        fs::write(&a, "a1").unwrap();
        assert!(h.record_file(&a, "External change", false).unwrap());
        assert_eq!(h.list(&a).unwrap()[0].label, "External change");

        let dir = h.list_dir(&root.join("src")).unwrap();
        assert!(dir.entries.iter().any(|e| e.path == b));
        assert!(dir.entries.iter().any(|e| e.kind == HistoryKind::Label));
        assert_eq!(dir.deleted, vec![b.clone()]);
        assert!(h.list_dir(&root.join("other")).unwrap().entries.iter().all(|e| e.kind == HistoryKind::Label));

        // Labels and deletions survive a reopen.
        drop(h);
        let h = LocalHistory::open(&tmp.path().join("history"), &root).unwrap();
        assert_eq!(h.list_dir(&root.join("src")).unwrap().deleted, vec![b]);
        assert!(h.stored_bytes() > 0);
        h.clear().unwrap();
        assert!(h.list(&a).unwrap().is_empty());
        assert_eq!(h.stored_bytes(), 0);
    }

    #[test]
    fn deletion_undo_captures_current_bytes_and_empty_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        let folder = root.join("subject");
        let empty = folder.join("empty-child/leaf");
        fs::create_dir_all(&empty).unwrap();
        let history = LocalHistory::open(&tmp.path().join("history"), &root).unwrap();
        let obsolete = folder.join("obsolete.txt");
        fs::write(&obsolete, "deleted before the folder").unwrap();
        history.capture_deletion_undo(std::slice::from_ref(&obsolete), 100);
        fs::remove_file(&obsolete).unwrap();
        let current = folder.join("current.txt");
        let original = b"\xEF\xBB\xBFheader\r\nbody\n";
        fs::write(&current, original).unwrap();
        history.record(&current, "header\nbody\n", "Saved").unwrap();
        let large = folder.join("sample.bin");
        fs::write(&large, vec![0; 2_300_000]).unwrap();

        let undo = history.capture_deletion_undo(std::slice::from_ref(&folder), 100);
        let revisions = history.list(&current).unwrap();
        assert!(revisions.iter().any(|entry| entry.label == DELETED));
        assert_eq!(revisions[0].id, revisions[1].id, "visible revisions share the normalized content");
        let blob = undo.files[0].id.clone();
        assert_ne!(blob, revisions[0].id);
        assert_eq!(
            history.stored_bytes(),
            ("deleted before the folder".len() + "header\nbody\n".len() + original.len()) as u64
        );
        history.apply_retention(Retention::default()).unwrap();
        fs::remove_dir_all(&folder).unwrap();
        assert_eq!(history.restore_deletion_undo(undo), vec![large]);
        assert_eq!(fs::read(&current).unwrap(), original);
        assert!(empty.is_dir());
        assert!(!obsolete.exists());
        history.clear().unwrap();
        assert!(!history.blob_path(&blob).exists(), "pruning removes the exact bytes too");
    }

    #[test]
    fn deletion_undo_preserves_new_files_and_reports_unavailable_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        let folder = root.join("folder");
        fs::create_dir_all(&folder).unwrap();
        let history = LocalHistory::open(&tmp.path().join("history"), &root).unwrap();
        let file = folder.join("old.txt");
        fs::write(&file, "before deletion").unwrap();

        let undo = history.capture_deletion_undo(std::slice::from_ref(&folder), 100);
        fs::remove_dir_all(&folder).unwrap();
        fs::create_dir_all(&folder).unwrap();
        fs::write(&file, "recreated").unwrap();
        assert_eq!(history.restore_deletion_undo(undo), vec![folder.clone()]);
        assert_eq!(fs::read_to_string(&file).unwrap(), "recreated");

        let file_only = history.capture_deletion_undo(std::slice::from_ref(&file), 100);
        fs::write(&file, "new contents").unwrap();
        assert_eq!(history.restore_deletion_undo(file_only), vec![file.clone()]);
        assert_eq!(fs::read_to_string(&file).unwrap(), "new contents");

        let limited = history.capture_deletion_undo(std::slice::from_ref(&folder), 1);
        assert_eq!(limited.skipped, vec![folder]);
        assert!(limited.files.is_empty());

        let expired = history.capture_deletion_undo(std::slice::from_ref(&file), 100);
        fs::remove_file(&file).unwrap();
        history.clear().unwrap();
        assert_eq!(history.restore_deletion_undo(expired), vec![file.clone()]);
        assert!(!file.exists());
    }

    #[test]
    fn retention_keeps_working_days_and_bounds_size() {
        let id = |c: char| c.to_string().repeat(64);
        let snap = HistoryKind::Snapshot;
        // Activity on days 1, 2, 10 and 30: three working days keep 2, 10, 30.
        let entries = vec![
            entry(&id('a'), "/p/a", 1, 10, snap),
            entry(&id('b'), "/p/a", 2, 10, snap),
            entry("", "/p", 10, 0, HistoryKind::Label),
            entry(&id('c'), "/p/b", 30, 10, snap),
        ];
        let kept = retain(entries.clone(), Retention { working_days: 3, max_bytes: u64::MAX });
        assert_eq!(kept.iter().map(|e| day_of(e.timestamp_ms)).collect::<Vec<_>>(), vec![2, 10, 30]);
        assert!(retain(entries.clone(), Retention { working_days: 0, max_bytes: u64::MAX }).is_empty());
        assert_eq!(retain(entries.clone(), Retention { working_days: 50, max_bytes: u64::MAX }).len(), 4);

        // 30 bytes stored, 15 allowed: the two oldest snapshots go, labels stay.
        let kept = retain(entries.clone(), Retention { working_days: 50, max_bytes: 15 });
        assert_eq!(kept.iter().map(|e| e.kind).collect::<Vec<_>>(), vec![HistoryKind::Label, snap]);
        // A blob shared by two entries only counts once and is freed with the last one.
        let shared = vec![
            entry(&id('a'), "/p/a", 1, 10, snap),
            entry(&id('a'), "/p/b", 2, 10, snap),
            entry(&id('b'), "/p/a", 3, 10, snap),
        ];
        assert_eq!(retain(shared.clone(), Retention { working_days: 9, max_bytes: 20 }).len(), 3);
        assert_eq!(retain(shared, Retention { working_days: 9, max_bytes: 10 }).len(), 1);

        // Through the store: blobs of dropped entries are deleted.
        let tmp = tempfile::tempdir().unwrap();
        let h = LocalHistory::open(&tmp.path().join("history"), &tmp.path().join("p")).unwrap();
        h.record(Path::new("/p/a"), "0123456789", "Saved").unwrap();
        let old = h.list(Path::new("/p/a")).unwrap()[0].id.clone();
        h.record(Path::new("/p/a"), "abcdefghij", "Saved").unwrap();
        h.apply_retention(Retention { working_days: 5, max_bytes: 10 }).unwrap();
        assert_eq!(h.list(Path::new("/p/a")).unwrap().len(), 1);
        assert_eq!(h.content(&old).unwrap_err().kind, ide_core::error::ErrorKind::NotFound);
    }
    #[test]
    fn a_files_original_content_is_there_at_a_label_put_before_its_first_edit() {
        use std::time::{Duration, SystemTime};
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let h = LocalHistory::open(&tmp.path().join("history"), &root).unwrap();
        let set_modified = |path: &Path, at: SystemTime| {
            std::fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
        };
        let old = root.join("old.txt");
        std::fs::write(&old, "as it was").unwrap();
        set_modified(&old, SystemTime::now() - Duration::from_secs(3600));
        h.record(&root.join("other.txt"), "x", "Saved").unwrap();
        std::thread::sleep(Duration::from_millis(2));
        h.put_label(&root, "checkpoint").unwrap();
        // Written after the label: it didn't have this content at the label.
        let new = root.join("new.txt");
        std::fs::write(&new, "fresh").unwrap();
        set_modified(&new, SystemTime::now() + Duration::from_secs(1));

        assert!(h.record_original(&old).unwrap());
        assert!(h.record_original(&new).unwrap());
        // Only a file without history gets one.
        assert!(!h.record_original(&old).unwrap());
        h.record(&old, "edited", "Saved").unwrap();

        let entries = h.list(&old).unwrap();
        let label = entries.iter().find(|e| e.kind == HistoryKind::Label).unwrap();
        let original = entries.iter().find(|e| e.label == ORIGINAL).unwrap();
        assert!(original.timestamp_ms < label.timestamp_ms);
        assert_eq!(h.content(&original.id).unwrap(), "as it was");
        // Not dated before the oldest entry kept: no working day of its own.
        let oldest = h.list(&root.join("other.txt")).unwrap().last().unwrap().timestamp_ms;
        assert!(original.timestamp_ms >= oldest - 1.0);
        let fresh = h.list(&new).unwrap().into_iter().find(|e| e.label == ORIGINAL).unwrap();
        assert!(fresh.timestamp_ms > label.timestamp_ms);
    }
}
