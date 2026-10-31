//! Preflight, rollback and grouped undo for edits spanning documents and files.

use super::{DocState, Documents, RegEntry, disk_len, keys_for};
use ide_core::error::ErrorKind;
use ide_core::{DocId, FileEdit, IdeError, IdeEvent, IdeResult, NullSink, WorkspaceEdit, WorkspaceEditPrecondition};
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};
use std::time::{Duration, SystemTime};

const MAX_HISTORY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_HISTORY_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const SNAPSHOT_PREFIX: &str = "openidea-workspace-edit-";

struct ActiveEdit<'a>(&'a AtomicBool);
impl<'a> ActiveEdit<'a> {
    fn new(active: &'a AtomicBool) -> Self {
        active.store(true, Ordering::Relaxed);
        Self(active)
    }
}
impl Drop for ActiveEdit<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

pub(super) struct History {
    next: u32,
    reaper: bool,
    records: VecDeque<(u32, Record)>,
}

impl Default for History {
    fn default() -> Self {
        static CLEANUP: Once = Once::new();
        CLEANUP.call_once(|| cleanup_abandoned(&std::env::temp_dir()));
        Self { next: 0, reaper: false, records: VecDeque::new() }
    }
}

impl History {
    fn prune(&mut self, now: SystemTime, max_bytes: u64, max_age: Duration) {
        self.records.retain(|(_, record)| now.duration_since(record.created).unwrap_or_default() < max_age);
        let mut bytes: u64 = self.records.iter().map(|(_, record)| record.bytes).sum();
        while self.records.len() > 20 || bytes > max_bytes {
            let Some((_, record)) = self.records.pop_front() else { break };
            bytes = bytes.saturating_sub(record.bytes);
        }
    }
}

/// A locked owner file distinguishes live snapshots from abandoned undo/staging
/// data. Unknown legacy directories may contain recovery data, so leave them alone.
fn cleanup_abandoned(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_name().to_string_lossy().starts_with(SNAPSHOT_PREFIX)
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
            || path.join("recovery").exists()
        {
            continue;
        }
        let Ok(owner) = fs::OpenOptions::new().read(true).write(true).open(path.join("owner.lock")) else { continue };
        if owner.try_lock().is_ok() && !path.join("recovery").exists() {
            // Windows cannot remove an open file. Once unlocked the abandoned
            // directory cannot be acquired by a new transaction (names are unique).
            drop(owner);
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn snapshot_bytes(path: &Path) -> IdeResult<u64> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::read_dir(path)?.try_fold(0u64, |bytes, entry| Ok(bytes.saturating_add(snapshot_bytes(&entry?.path())?)))
    } else {
        Ok(meta.len())
    }
}

struct SavedPath {
    path: PathBuf,
    backup: Option<PathBuf>,
}

struct Record {
    // Drop the lock before TempDir removes the directory on Windows.
    _owner: fs::File,
    directory: tempfile::TempDir,
    created: SystemTime,
    bytes: u64,
    undone: bool,
    paths: Vec<SavedPath>,
    documents: Vec<(DocId, DocState)>,
    after: Vec<WorkspaceEditPrecondition>,
}

fn stale(path: &Path) -> IdeError {
    IdeError::new(ErrorKind::OutOfSync, format!("{} changed; request the refactoring again", path.display()))
}

/// Resolve parent aliases while retaining the last component of resource operations.
fn normalized(path: &Path) -> IdeResult<PathBuf> {
    let path = if path.is_absolute() { path.to_owned() } else { std::env::current_dir()?.join(path) };
    let mut clean = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other),
        }
    }
    let Some(name) = clean.file_name() else { return Ok(clean) };
    let parent = clean.parent().expect("absolute path");
    let parent = dunce::canonicalize(parent).map_err(IdeError::from).or_else(|_| normalized(parent))?;
    Ok(parent.join(name))
}

fn text_path(path: &Path) -> IdeResult<PathBuf> {
    dunce::canonicalize(path).map_err(IdeError::from).or_else(|_| normalized(path))
}

fn normalize_edit(edit: &WorkspaceEdit) -> IdeResult<WorkspaceEdit> {
    let files = edit
        .files
        .iter()
        .map(|file| {
            Ok(match file {
                FileEdit::Edit { path, edits, version } => {
                    FileEdit::Edit { path: text_path(path)?.into(), edits: edits.clone(), version: *version }
                }
                FileEdit::Create { path, overwrite } => {
                    FileEdit::Create { path: normalized(path)?.into(), overwrite: *overwrite }
                }
                FileEdit::Rename { from, to } => {
                    FileEdit::Rename { from: normalized(from)?.into(), to: normalized(to)?.into() }
                }
                FileEdit::Delete { path, recursive } => {
                    FileEdit::Delete { path: normalized(path)?.into(), recursive: *recursive }
                }
            })
        })
        .collect::<IdeResult<_>>()?;
    Ok(WorkspaceEdit { files, preconditions: edit.preconditions.clone() })
}

fn paths(edit: &WorkspaceEdit) -> IdeResult<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for file in &edit.files {
        match file {
            FileEdit::Edit { path, .. } | FileEdit::Create { path, .. } | FileEdit::Delete { path, .. } => {
                paths.push(path.to_path_buf())
            }
            FileEdit::Rename { from, to } => {
                if to != from && to.starts_with(from) {
                    return Err(IdeError::invalid("cannot move a directory into itself"));
                }
                paths.extend([from.to_path_buf(), to.to_path_buf()]);
            }
        }
    }
    // Include missing parents so rollback/undo also removes directories we create.
    for path in &mut paths {
        while let Some(parent) = path.parent() {
            match fs::symlink_metadata(parent) {
                Ok(_) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => *path = parent.to_owned(),
                Err(e) => return Err(e.into()),
            }
        }
        if path.parent().is_none() {
            return Err(IdeError::invalid("cannot refactor a filesystem root"));
        }
        if fs::symlink_metadata(&*path).is_ok_and(|m| !m.file_type().is_symlink())
            && let Ok(canonical) = dunce::canonicalize(&*path)
        {
            *path = canonical;
        }
    }
    paths.sort();
    paths.dedup();
    let mut roots: Vec<PathBuf> = Vec::new();
    for path in paths {
        if !roots.iter().any(|p| path.starts_with(p)) {
            roots.push(path);
        }
    }
    Ok(roots)
}

fn hash_bytes(hash: &mut blake3::Hasher, bytes: &[u8]) {
    hash.update(&(bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

fn hash_disk(hash: &mut blake3::Hasher, path: &Path) -> IdeResult<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            hash.update(b"missing");
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };
    hash.update(&[u8::from(meta.permissions().readonly())]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        hash.update(&meta.permissions().mode().to_le_bytes());
    }
    if meta.file_type().is_symlink() {
        hash.update(b"link");
        hash_bytes(hash, fs::read_link(path)?.as_os_str().as_encoded_bytes());
    } else if meta.is_file() {
        hash.update(b"file");
        hash.update(&meta.len().to_le_bytes());
        let mut file = fs::File::open(path)?;
        let mut buffer = [0; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
    } else if meta.is_dir() {
        hash.update(b"directory");
        let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            hash_bytes(hash, entry.file_name().as_encoded_bytes());
            hash_disk(hash, &entry.path())?;
        }
    } else {
        return Err(IdeError::invalid(format!("{} is not a regular file or directory", path.display())));
    }
    Ok(())
}

/// A reverted edit may leave the dirty flag set even when all saved bytes match.
fn has_unsaved_changes(state: &DocState) -> IdeResult<bool> {
    if !state.dirty {
        return Ok(false);
    }
    let text = state.doc.text_for_save();
    let bytes = if state.native_to_ascii {
        ide_vfs::encode_properties_ascii(&text).into_bytes()
    } else {
        ide_vfs::encode(&text, &state.encoding, state.has_bom)?
    };
    match fs::read(&state.path) {
        Ok(disk) => Ok(disk != bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.into()),
    }
}

impl Documents {
    /// Capture disk and unsaved-buffer contents before returning an edit for preview.
    /// Existing preconditions must survive preview filtering and code-action resolution.
    pub fn prepare_workspace_edit(&self, edit: &mut WorkspaceEdit) -> IdeResult<()> {
        let _operation = self.operations.lock();
        if edit.preconditions.is_empty() {
            edit.preconditions = self.fingerprints(&paths(&normalize_edit(edit)?)?)?;
        }
        Ok(())
    }

    fn fingerprints(&self, paths: &[PathBuf]) -> IdeResult<Vec<WorkspaceEditPrecondition>> {
        paths
            .iter()
            .map(|path| {
                let mut hash = blake3::Hasher::new();
                hash_disk(&mut hash, path)?;
                let mut dirty = Vec::new();
                for id in self.open_documents() {
                    self.with_doc(id, |state| {
                        let file = text_path(&state.path)?;
                        if file.starts_with(path) && has_unsaved_changes(state)? {
                            dirty.push((
                                file,
                                state.doc.text(),
                                state.encoding.clone(),
                                state.doc.line_ending(),
                                state.has_bom,
                            ));
                        }
                        Ok(())
                    })?;
                }
                dirty.sort_by(|a, b| a.0.cmp(&b.0));
                for (file, text, encoding, ending, bom) in dirty {
                    hash_bytes(&mut hash, file.as_os_str().as_encoded_bytes());
                    hash_bytes(&mut hash, text.as_bytes());
                    hash_bytes(&mut hash, encoding.as_bytes());
                    hash_bytes(&mut hash, ending.as_str().as_bytes());
                    hash.update(&[u8::from(bom)]);
                }
                Ok(WorkspaceEditPrecondition { path: path.clone().into(), hash: hash.finalize().to_hex().to_string() })
            })
            .collect()
    }

    fn validate_preconditions(&self, expected: &[WorkspaceEditPrecondition]) -> IdeResult<()> {
        let current = self.fingerprints(&expected.iter().map(|p| p.path.to_path_buf()).collect::<Vec<_>>())?;
        for (before, after) in expected.iter().zip(current) {
            if before.hash != after.hash {
                return Err(stale(&before.path));
            }
        }
        Ok(())
    }

    /// Preflight every operation on a private copy, then apply with rollback and grouped undo.
    pub fn apply_workspace_edit(&self, edit: &WorkspaceEdit) -> IdeResult<()> {
        self.apply_workspace_edit_inner(edit, true, &mut |_| Ok(()))
    }

    /// File moves already own a combined move/reference undo record.
    pub fn apply_file_move_edits(&self, edit: &WorkspaceEdit) -> IdeResult<()> {
        self.apply_workspace_edit_inner(edit, false, &mut |_| Ok(()))
    }

    fn apply_workspace_edit_inner(
        &self,
        edit: &WorkspaceEdit,
        remember: bool,
        before_operation: &mut dyn FnMut(usize) -> IdeResult<()>,
    ) -> IdeResult<()> {
        let _operation = self.operations.lock();
        if edit.files.is_empty() {
            return Ok(());
        }
        let mut edit = normalize_edit(edit)?;
        self.prepare_workspace_edit(&mut edit)?;
        self.validate_preconditions(&edit.preconditions)?;
        for file in &edit.files {
            if let FileEdit::Edit { path, version: Some(version), .. } = file {
                let doc = self.by_path(path).ok_or_else(|| stale(path))?;
                if i64::from(self.version(doc)?) != i64::from(*version) {
                    return Err(stale(path));
                }
            }
        }
        edit.deduplicate();
        let roots = paths(&edit)?;
        // The watcher may not have delivered an external write yet. Never save
        // an edit over disk contents that differ from a supposedly clean buffer.
        for id in self.open_documents() {
            self.with_doc(id, |state| {
                if !state.dirty
                    && roots.iter().any(|root| text_path(&state.path).is_ok_and(|path| path.starts_with(root)))
                {
                    let loaded = ide_vfs::load_text_as(&state.path, &state.encoding)?;
                    if ide_text::normalize_line_endings(&loaded.text) != state.doc.text() {
                        return Err(stale(&state.path));
                    }
                }
                Ok(())
            })?;
        }
        self.workspace_edits.lock().prune(SystemTime::now(), MAX_HISTORY_BYTES, MAX_HISTORY_AGE);
        let mut record = self.backup(&roots)?;
        self.preflight(&record, &edit)?;
        fs::remove_dir_all(record.directory.path().join("stage"))?;
        self.validate_preconditions(&edit.preconditions)?;
        // A crash during commit can still need these files. Only a completed
        // commit turns this into an expendable undo snapshot.
        fs::write(record.directory.path().join("recovery"), b"commit in progress")?;
        let _active = ActiveEdit::new(&self.workspace_edit_active);
        if let Err(error) = self.apply_sequence(&edit, before_operation) {
            return Err(self.recover(record, error));
        }
        record.after = match self.fingerprints(&roots) {
            Ok(after) => after,
            Err(error) => return Err(self.recover(record, error)),
        };
        if let Err(error) = fs::remove_file(record.directory.path().join("recovery")) {
            return Err(self.recover(record, error.into()));
        }
        if remember {
            let mut history = self.workspace_edits.lock();
            history.next += 1;
            let id = history.next;
            let mut affected: Vec<ide_core::IpcPath> = roots.into_iter().map(Into::into).collect();
            affected.extend(record.documents.iter().map(|(_, state)| state.path.clone().into()));
            affected.sort();
            affected.dedup();
            history.records.push_back((id, record));
            if !history.reaper {
                history.reaper = true;
                let weak = Arc::downgrade(&self.workspace_edits);
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(Duration::from_secs(60));
                        let Some(history) = weak.upgrade() else { break };
                        let mut history = history.lock();
                        history.prune(SystemTime::now(), MAX_HISTORY_BYTES, MAX_HISTORY_AGE);
                        if history.records.is_empty() {
                            history.reaper = false;
                            break;
                        }
                    }
                });
            }
            history.prune(SystemTime::now(), MAX_HISTORY_BYTES, MAX_HISTORY_AGE);
            self.sink.emit(IdeEvent::WorkspaceEditApplied { id, paths: affected });
        }
        Ok(())
    }

    fn backup(&self, roots: &[PathBuf]) -> IdeResult<Record> {
        let bytes = roots.iter().try_fold(0u64, |bytes, path| {
            let size = if fs::symlink_metadata(path).is_ok() { snapshot_bytes(path)? } else { 0 };
            Ok::<_, IdeError>(bytes.saturating_add(size))
        })?;
        if bytes > MAX_HISTORY_BYTES {
            return Err(IdeError::invalid("workspace edit exceeds the 256 MiB recovery snapshot limit"));
        }
        let directory = tempfile::Builder::new().prefix(SNAPSHOT_PREFIX).tempdir()?;
        // Publish the owner path only after acquiring its lock, so another
        // starting process cannot mistake a new snapshot for an abandoned one.
        let owner = tempfile::NamedTempFile::new_in(directory.path())?;
        owner.as_file().lock()?;
        let owner = owner
            .persist_noclobber(directory.path().join("owner.lock"))
            .map_err(|error| IdeError::from(error.error))?;
        let mut paths = Vec::new();
        for (index, path) in roots.iter().enumerate() {
            let backup = match fs::symlink_metadata(path) {
                Ok(_) => {
                    let backup = directory.path().join(format!("before-{index}"));
                    copy_snapshot(path, &backup)?;
                    Some(backup)
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e.into()),
            };
            paths.push(SavedPath { path: path.clone(), backup });
        }
        let mut documents = Vec::new();
        for id in self.open_documents() {
            self.with_doc(id, |state| {
                if roots.iter().any(|p| text_path(&state.path).is_ok_and(|file| file.starts_with(p))) {
                    documents.push((id, state.clone()));
                }
                Ok(())
            })?;
        }
        let manifest: Vec<_> = paths
            .iter()
            .map(|saved| {
                (
                    ide_core::IpcPath::from(saved.path.clone()),
                    saved.backup.as_ref().map(|path| ide_core::IpcPath::from(path.clone())),
                )
            })
            .collect();
        fs::write(
            directory.path().join("paths.json"),
            serde_json::to_vec(&manifest).map_err(|error| IdeError::internal(error.to_string()))?,
        )?;
        let bytes = snapshot_bytes(directory.path())?
            .saturating_add(documents.iter().map(|(_, state)| u64::from(state.doc.len_utf16()) * 2).sum::<u64>());
        if bytes > MAX_HISTORY_BYTES {
            return Err(IdeError::invalid("workspace edit exceeds the 256 MiB recovery snapshot limit"));
        }
        Ok(Record {
            _owner: owner,
            directory,
            created: SystemTime::now(),
            bytes,
            undone: false,
            paths,
            documents,
            after: Vec::new(),
        })
    }

    fn preflight(&self, record: &Record, edit: &WorkspaceEdit) -> IdeResult<()> {
        let stage = dunce::canonicalize(record.directory.path())?.join("stage");
        let map = |path: &Path| -> PathBuf {
            let volume = path.ancestors().last().expect("absolute path");
            let key = blake3::hash(volume.as_os_str().as_encoded_bytes()).to_hex();
            stage.join(key.as_str()).join(path.strip_prefix(volume).expect("inside volume"))
        };
        for root in &record.paths {
            if let Some(backup) = &root.backup {
                let target = map(&root.path);
                if fs::symlink_metadata(&target).is_err() {
                    copy_snapshot(backup, &target)?;
                }
            }
        }
        let staged = Documents::new(Arc::new(NullSink), Box::new(|_, _| ide_core::LanguageId::plain_text()));
        staged.set_file_defaults(self.file_defaults());
        let mut seed = record.documents.clone();
        // Closed files need the original path's encoding/EditorConfig too, not
        // the settings of the temporary staging directory.
        for file in &edit.files {
            if let FileEdit::Edit { path, .. } = file
                && path.is_file()
                && self.by_path(path).is_none()
            {
                let info = self.open(path)?;
                let state = self.with_doc(info.id, |state| Ok(state.clone()));
                self.close(info.id);
                seed.push((info.id, state?));
            }
        }
        for (id, state) in &seed {
            let mut state = state.clone();
            state.path = map(&text_path(&state.path)?);
            state.observed = false;
            let keys = keys_for(&state.path);
            let mut registry = staged.registry.lock();
            for key in &keys {
                registry.by_key.insert(key.clone(), *id);
            }
            registry.docs.insert(*id, RegEntry { slot: Arc::new(Mutex::new(state)), refs: 1, keys });
        }
        let files = edit
            .files
            .iter()
            .map(|file| match file {
                FileEdit::Edit { path, edits, version } => {
                    FileEdit::Edit { path: map(path).into(), edits: edits.clone(), version: *version }
                }
                FileEdit::Create { path, overwrite } => {
                    FileEdit::Create { path: map(path).into(), overwrite: *overwrite }
                }
                FileEdit::Rename { from, to } => FileEdit::Rename { from: map(from).into(), to: map(to).into() },
                FileEdit::Delete { path, recursive } => {
                    FileEdit::Delete { path: map(path).into(), recursive: *recursive }
                }
            })
            .collect();
        staged.apply_sequence(&WorkspaceEdit { files, preconditions: Vec::new() }, &mut |_| Ok(())).map_err(
            |mut error| {
                for root in &record.paths {
                    error.message = error
                        .message
                        .replace(&map(&root.path).to_string_lossy().to_string(), &root.path.to_string_lossy());
                }
                error
            },
        )
    }

    fn apply_sequence(
        &self,
        edit: &WorkspaceEdit,
        before_operation: &mut dyn FnMut(usize) -> IdeResult<()>,
    ) -> IdeResult<()> {
        for (index, file) in edit.files.iter().enumerate() {
            before_operation(index)?;
            match file {
                FileEdit::Edit { path, .. } | FileEdit::Create { path, .. } | FileEdit::Delete { path, .. } => {
                    check_link_parents(path)?;
                }
                FileEdit::Rename { from, to } => {
                    check_link_parents(from)?;
                    check_link_parents(to)?;
                }
            }
            match file {
                FileEdit::Edit { path, edits, .. } => {
                    if fs::symlink_metadata(path)?.file_type().is_symlink() {
                        return Err(IdeError::invalid("cannot edit a symbolic link introduced by a workspace edit"));
                    }
                    let info = self.open(path)?;
                    let result: IdeResult<()> = (|| {
                        // In-place rename restores its temporary typing before the
                        // server request. A dirty flag alone can therefore describe
                        // a buffer whose encoded bytes already match the saved file.
                        let unsaved = self.with_doc(info.id, |state| has_unsaved_changes(state))?;
                        self.apply_edits(info.id, edits)?;
                        // Do not save unrelated unsaved work as a side effect of a refactoring.
                        if !unsaved {
                            self.save(info.id)?;
                        } else {
                            self.with_doc(info.id, |state| {
                                ide_vfs::encode(&state.doc.text_for_save(), &state.encoding, state.has_bom).map(|_| ())
                            })?;
                        }
                        Ok(())
                    })();
                    self.close(info.id);
                    result?;
                }
                FileEdit::Create { path, overwrite } => {
                    if path.exists() {
                        if !overwrite {
                            return Err(IdeError::new(
                                ErrorKind::AlreadyExists,
                                format!("{} already exists", path.display()),
                            ));
                        }
                        self.check_resource_buffers(path)?;
                        if fs::symlink_metadata(path)?.file_type().is_symlink() {
                            return Err(IdeError::invalid("cannot overwrite a symbolic link in a workspace edit"));
                        }
                        if !path.is_file() {
                            return Err(IdeError::invalid("cannot overwrite a directory"));
                        }
                        ide_vfs::save_text(path, "", "utf-8", false)?;
                    } else {
                        ide_vfs::create_file(path)?;
                    }
                    self.reload_resource_buffers(&[path.to_path_buf()])?;
                }
                FileEdit::Rename { from, to } => {
                    self.check_resource_buffers(from)?;
                    ide_vfs::rename(from, to)?;
                }
                FileEdit::Delete { path, recursive } => {
                    self.check_resource_buffers(path)?;
                    if fs::symlink_metadata(path)?.is_dir() && !recursive && fs::read_dir(path)?.next().is_some() {
                        return Err(IdeError::invalid("recursive deletion was not requested"));
                    }
                    ide_vfs::delete_permanently(path)?;
                }
            }
        }
        Ok(())
    }

    fn check_resource_buffers(&self, path: &Path) -> IdeResult<()> {
        for id in self.open_documents() {
            self.with_doc(id, |state| {
                if state.dirty && text_path(&state.path)?.starts_with(path) {
                    return Err(IdeError::invalid(format!(
                        "save the unsaved changes in {} before changing its file",
                        state.path.display()
                    )));
                }
                Ok(())
            })?;
        }
        Ok(())
    }

    fn restore(&self, record: &Record) -> IdeResult<()> {
        let mut errors = Vec::new();
        let mut failed_paths = Vec::new();
        for saved in &record.paths {
            let result = (|| {
                match fs::symlink_metadata(&saved.path) {
                    Ok(_) => ide_vfs::delete_permanently(&saved.path)?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
                if let Some(backup) = &saved.backup {
                    copy_snapshot(backup, &saved.path)?;
                }
                Ok::<_, IdeError>(())
            })();
            if let Err(error) = result {
                failed_paths.push(saved.path.clone());
                errors.push(format!("{}: {error}", saved.path.display()));
            }
        }
        for (id, before) in &record.documents {
            if self.slot(*id).is_err() {
                continue;
            }
            let result = self.with_doc(*id, |state| {
                self.replace_locked(*id, state, &before.doc.text())?;
                state.encoding = before.encoding.clone();
                state.has_bom = before.has_bom;
                state.doc.set_line_ending(before.doc.line_ending());
                state.disk_mtime = fs::metadata(&state.path).map(|m| ide_vfs::mtime_ms(&m)).unwrap_or(0.0);
                state.disk_len = disk_len(&state.path);
                let disk_failed =
                    text_path(&state.path).is_ok_and(|path| failed_paths.iter().any(|failed| path.starts_with(failed)));
                self.set_dirty(*id, state, before.dirty || disk_failed);
                Ok(())
            });
            if let Err(error) = result {
                errors.push(error.to_string());
            }
        }
        // A file may have been opened after the refactoring; its clean buffer must follow undo too.
        let paths: Vec<PathBuf> = self
            .open_documents()
            .into_iter()
            .filter(|id| !record.documents.iter().any(|(saved, _)| saved == id))
            .filter_map(|id| self.with_doc(id, |state| Ok(state.path.clone())).ok())
            .filter(|path| {
                text_path(path).is_ok_and(|path| record.paths.iter().any(|saved| path.starts_with(&saved.path)))
            })
            .collect();
        if let Err(error) = self.reload_resource_buffers(&paths) {
            errors.push(error.to_string());
        }
        if errors.is_empty() { Ok(()) } else { Err(IdeError::internal(errors.join("; "))) }
    }

    fn reload_resource_buffers(&self, paths: &[PathBuf]) -> IdeResult<()> {
        for path in paths {
            let Some(id) = self.by_path(path) else { continue };
            if !path.is_file() {
                continue;
            }
            self.with_doc(id, |state| {
                if state.dirty {
                    return Err(stale(path));
                }
                let defaults = self.file_defaults();
                let loaded = ide_vfs::load_text_with_fallback(path, defaults.fallback_for(path))?;
                self.replace_locked(id, state, &loaded.text)?;
                state.encoding = loaded.encoding;
                state.has_bom = loaded.has_bom;
                state.disk_mtime = loaded.mtime_ms;
                state.disk_len = disk_len(path);
                Ok(())
            })?;
        }
        Ok(())
    }

    fn recover(&self, record: Record, error: IdeError) -> IdeError {
        match self.restore(&record) {
            Ok(()) => error,
            Err(rollback) => {
                let directory = record.directory.keep();
                IdeError::new(
                    error.kind,
                    format!("{error}; rollback failed: {rollback}. Recovery files: {}", directory.display()),
                )
            }
        }
    }

    /// Explicitly release disposable snapshots before an exit that bypasses Drop.
    /// Failed-rollback recovery directories are detached and remain untouched.
    pub fn clear_workspace_edit_history(&self) {
        let _operation = self.operations.lock();
        self.workspace_edits.lock().records.clear();
    }

    /// Refuse to overwrite work made after the refactoring; keep the undo record on failure.
    pub fn undo_workspace_edit(&self, id: u32) -> IdeResult<()> {
        self.workspace_edit_history(id, false)
    }

    pub fn redo_workspace_edit(&self, id: u32) -> IdeResult<()> {
        self.workspace_edit_history(id, true)
    }

    fn workspace_edit_history(&self, id: u32, redo: bool) -> IdeResult<()> {
        let _operation = self.operations.lock();
        let mut history = self.workspace_edits.lock();
        history.prune(SystemTime::now(), MAX_HISTORY_BYTES, MAX_HISTORY_AGE);
        let index = history
            .records
            .iter()
            .position(|(key, _)| *key == id)
            .ok_or_else(|| IdeError::not_found("the refactoring can no longer be undone"))?;
        let record = &history.records[index].1;
        if record.undone != redo {
            return Err(IdeError::invalid("the refactoring is already in the requested history state"));
        }
        self.validate_preconditions(&record.after)?;
        let roots = record.paths.iter().map(|p| p.path.clone()).collect::<Vec<_>>();
        let mut current = self.backup(&roots)?;
        fs::write(current.directory.path().join("recovery"), b"history restore in progress")?;
        let _active = ActiveEdit::new(&self.workspace_edit_active);
        if let Err(error) = self.restore(record) {
            return Err(self.recover(current, error));
        }
        current.after = match self.fingerprints(&roots) {
            Ok(after) => after,
            Err(error) => return Err(self.recover(current, error)),
        };
        current.undone = !redo;
        current.created = record.created;
        if let Err(error) = fs::remove_file(current.directory.path().join("recovery")) {
            return Err(self.recover(current, error.into()));
        }
        history.records[index].1 = current;
        history.prune(SystemTime::now(), MAX_HISTORY_BYTES, MAX_HISTORY_AGE);
        Ok(())
    }
}

fn check_link_parents(path: &Path) -> IdeResult<()> {
    for parent in path.ancestors().skip(1) {
        match fs::symlink_metadata(parent) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(IdeError::invalid(format!("workspace edit traverses symbolic link {}", parent.display())));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// Snapshot links themselves, including dangling links, instead of their targets.
fn copy_snapshot(from: &Path, to: &Path) -> IdeResult<()> {
    let metadata = fs::symlink_metadata(from)?;
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(from)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, to)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileTypeExt;
            if metadata.file_type().is_symlink_dir() {
                std::os::windows::fs::symlink_dir(target, to)?;
            } else {
                std::os::windows::fs::symlink_file(target, to)?;
            }
        }
    } else if metadata.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_snapshot(&entry.path(), &to.join(entry.file_name()))?;
        }
        fs::set_permissions(to, metadata.permissions())?;
    } else if metadata.is_file() {
        fs::copy(from, to)?;
    } else {
        return Err(IdeError::invalid("cannot snapshot a special file"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{ChangeSet, Pos, Range, TextChange, TextEdit};

    #[test]
    fn snapshot_size_age_and_exit_cleanup_release_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("file.txt");
        fs::write(&path, "old").unwrap();
        let docs = Documents::new(Arc::new(NullSink), Box::new(|_, _| ide_core::LanguageId::plain_text()));
        let mut first = docs.backup(std::slice::from_ref(&path)).unwrap();
        let old_dir = first.directory.path().to_owned();
        let second = docs.backup(std::slice::from_ref(&path)).unwrap();
        let new_dir = second.directory.path().to_owned();
        let max_bytes = second.bytes;
        first.created = SystemTime::now() - MAX_HISTORY_AGE;
        let mut history = docs.workspace_edits.lock();
        history.records.push_back((1, first));
        history.records.push_back((2, second));
        history.prune(SystemTime::now(), MAX_HISTORY_BYTES, MAX_HISTORY_AGE);
        assert!(!old_dir.exists(), "expired snapshots are deleted, not just unindexed");
        assert!(new_dir.exists());
        let third = docs.backup(std::slice::from_ref(&path)).unwrap();
        let last_dir = third.directory.path().to_owned();
        history.records.push_back((3, third));
        history.prune(SystemTime::now(), max_bytes, MAX_HISTORY_AGE);
        assert!(!new_dir.exists(), "the byte budget evicts the oldest record");
        assert!(last_dir.exists());
        drop(history);
        docs.clear_workspace_edit_history();
        assert!(!last_dir.exists(), "normal exit explicitly releases snapshots");
    }

    #[test]
    fn oversized_snapshot_is_refused_before_mutating_any_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("huge.bin");
        fs::File::create(&path).unwrap().set_len(MAX_HISTORY_BYTES + 1).unwrap();
        let docs = Documents::new(Arc::new(NullSink), Box::new(|_, _| ide_core::LanguageId::plain_text()));
        let error = docs
            .apply_workspace_edit(&WorkspaceEdit {
                files: vec![FileEdit::Delete { path: path.clone().into(), recursive: false }],
                ..Default::default()
            })
            .unwrap_err();
        assert!(error.message.contains("256 MiB"));
        assert_eq!(fs::metadata(path).unwrap().len(), MAX_HISTORY_BYTES + 1);
    }

    #[test]
    fn snapshot_crash_child() {
        let Some(root) = std::env::var_os("OPENIDEA_SNAPSHOT_CRASH_FIXTURE") else { return };
        let root = PathBuf::from(root);
        for (name, recovery) in [("undo", false), ("recovery", true)] {
            let directory = tempfile::Builder::new().prefix(SNAPSHOT_PREFIX).tempdir_in(&root).unwrap();
            let owner = fs::OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(directory.path().join("owner.lock"))
                .unwrap();
            owner.lock().unwrap();
            fs::write(directory.path().join("paths.json"), b"[]").unwrap();
            if recovery {
                fs::write(directory.path().join("recovery"), b"rollback required").unwrap();
            }
            fs::write(root.join(name), directory.path().to_string_lossy().as_bytes()).unwrap();
            // Simulate process death: neither TempDir nor the owner lock is dropped.
            std::mem::forget(owner);
            std::mem::forget(directory);
        }
        std::process::exit(0);
    }

    #[test]
    fn startup_cleanup_after_crash_keeps_live_and_recovery_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "documents::workspace_edit::tests::snapshot_crash_child"])
            .env("OPENIDEA_SNAPSHOT_CRASH_FIXTURE", root.path())
            .status()
            .unwrap();
        assert!(status.success());
        let undo = PathBuf::from(fs::read_to_string(root.path().join("undo")).unwrap());
        let recovery = PathBuf::from(fs::read_to_string(root.path().join("recovery")).unwrap());
        assert!(undo.exists());
        let live = tempfile::Builder::new().prefix(SNAPSHOT_PREFIX).tempdir_in(root.path()).unwrap();
        let owner = fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(live.path().join("owner.lock"))
            .unwrap();
        owner.lock().unwrap();
        let unknown = root.path().join(format!("{SNAPSHOT_PREFIX}legacy-recovery"));
        fs::create_dir(&unknown).unwrap();
        cleanup_abandoned(root.path());
        assert!(!undo.exists());
        assert!(recovery.exists(), "crash recovery files are never expired or size-evicted");
        assert!(live.path().exists(), "another live app's owner lock protects its snapshots");
        assert!(unknown.exists(), "legacy recovery files have no safe deletion marker");
        drop(owner);
        cleanup_abandoned(root.path());
        assert!(!live.path().exists());
    }

    #[test]
    fn java_mid_apply_failure_rolls_back_declaration_and_closed_usage() {
        let tmp = tempfile::tempdir().unwrap();
        let declaration = tmp.path().join("Main.java");
        let usage = tmp.path().join("Use.java");
        fs::write(&declaration, "class Original {}\n").unwrap();
        fs::write(&usage, "class Use { Original value; }\n").unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let docs =
            Documents::new(Arc::new(move |e| sink.lock().push(e)), Box::new(|_, _| ide_core::LanguageId::new("java")));
        let info = docs.open(&declaration).unwrap();
        let edit = WorkspaceEdit {
            files: vec![(declaration.clone(), 6, Some(info.version as i32)), (usage.clone(), 12, None)]
                .into_iter()
                .map(|(path, col, version)| FileEdit::Edit {
                    path: path.into(),
                    version,
                    edits: vec![TextEdit {
                        range: Range::new(Pos::new(0, col), Pos::new(0, col + 8)),
                        new_text: "Renamed".into(),
                    }],
                })
                .collect(),
            ..Default::default()
        };
        let error = docs
            .apply_workspace_edit_inner(&edit, true, &mut |index| {
                if index == 1 { Err(IdeError::internal("injected Java usage write failure")) } else { Ok(()) }
            })
            .unwrap_err();
        assert!(error.message.contains("injected Java"));
        assert_eq!(fs::read_to_string(&declaration).unwrap(), "class Original {}\n");
        assert_eq!(fs::read_to_string(&usage).unwrap(), "class Use { Original value; }\n");
        assert_eq!(docs.snapshot(info.id).unwrap().text, "class Original {}\n");
        assert!(!docs.snapshot(info.id).unwrap().dirty);
        assert!(
            events
                .lock()
                .iter()
                .filter_map(|e| match e {
                    IdeEvent::DocPatched { workspace_edit, .. } => Some(workspace_edit),
                    _ => None,
                })
                .all(|grouped| *grouped)
        );
    }

    #[test]
    fn failed_second_write_rolls_back_disk_and_dirty_buffers() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.txt");
        let b = tmp.path().join("b.txt");
        fs::write(&a, "old\r\n").unwrap();
        fs::write(&b, "two\n").unwrap();
        let docs = Documents::new(Arc::new(NullSink), Box::new(|_, _| ide_core::LanguageId::plain_text()));
        let info = docs.open(&a).unwrap();
        docs.edit(info.id, 0, ChangeSet { changes: vec![TextChange { from: 0, to: 3, insert: "own".into() }] })
            .unwrap();
        let edit = WorkspaceEdit {
            files: [&a, &b]
                .into_iter()
                .map(|path| FileEdit::Edit {
                    path: path.clone().into(),
                    version: None,
                    edits: vec![TextEdit { range: Range::new(Pos::new(0, 0), Pos::new(0, 3)), new_text: "new".into() }],
                })
                .collect(),
            ..Default::default()
        };
        let error = docs
            .apply_workspace_edit_inner(&edit, true, &mut |index| {
                if index == 1 { Err(IdeError::new(ErrorKind::Io, "injected write failure")) } else { Ok(()) }
            })
            .unwrap_err();
        assert!(error.message.contains("injected"));
        assert_eq!(fs::read(&a).unwrap(), b"old\r\n");
        assert_eq!(fs::read(&b).unwrap(), b"two\n");
        let after = docs.snapshot(info.id).unwrap();
        assert_eq!(after.text, "own\n");
        assert!(after.dirty);
        assert!(after.version > info.version);
        assert!(docs.workspace_edits.lock().records.is_empty());
    }

    #[test]
    fn failed_commit_restores_encoded_files_and_resource_operations() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first.txt");
        let created = tmp.path().join("new/deep/file.txt");
        let source = tmp.path().join("source.bin");
        let renamed = tmp.path().join("renamed.bin");
        let deleted = tmp.path().join("deleted.bin");
        ide_vfs::save_text(&first, "old\r\n", "utf-16le", true).unwrap();
        let bytes = fs::read(&first).unwrap();
        fs::write(&source, [0, 255, 128]).unwrap();
        fs::write(&deleted, [255, 1, 128]).unwrap();
        let docs = Documents::new(Arc::new(NullSink), Box::new(|_, _| ide_core::LanguageId::plain_text()));
        let info = docs.open(&first).unwrap();
        let edit = WorkspaceEdit {
            files: vec![
                FileEdit::Edit {
                    path: first.clone().into(),
                    version: Some(info.version as i32),
                    edits: vec![TextEdit { range: Range::new(Pos::new(0, 0), Pos::new(0, 3)), new_text: "new".into() }],
                },
                FileEdit::Create { path: created.clone().into(), overwrite: false },
                FileEdit::Rename { from: source.clone().into(), to: renamed.clone().into() },
                FileEdit::Delete { path: deleted.clone().into(), recursive: false },
                FileEdit::Create { path: tmp.path().join("last").into(), overwrite: false },
            ],
            ..Default::default()
        };
        let error = docs
            .apply_workspace_edit_inner(&edit, true, &mut |index| {
                if index == 4 { Err(IdeError::new(ErrorKind::Io, "injected commit failure")) } else { Ok(()) }
            })
            .unwrap_err();
        assert_eq!(error.message, "injected commit failure");
        assert_eq!(fs::read(&first).unwrap(), bytes);
        assert_eq!(fs::read(&source).unwrap(), [0, 255, 128]);
        assert_eq!(fs::read(&deleted).unwrap(), [255, 1, 128]);
        assert!(!renamed.exists());
        assert!(!tmp.path().join("new").exists());
        let after = docs.snapshot(info.id).unwrap();
        assert_eq!(after.text, "old\n");
        assert_eq!(after.encoding, info.encoding);
        assert_eq!(after.line_ending, info.line_ending);
        assert!(!after.dirty);
    }

    #[test]
    fn failed_rollback_keeps_recovery_files_and_marks_the_restored_buffer_dirty() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("subdir");
        fs::create_dir(&parent).unwrap();
        let first = parent.join("first.txt");
        let second = tmp.path().join("second.txt");
        fs::write(&first, "old\n").unwrap();
        fs::write(&second, "two\n").unwrap();
        let docs = Documents::new(Arc::new(NullSink), Box::new(|_, _| ide_core::LanguageId::plain_text()));
        let info = docs.open(&first).unwrap();
        let edit = WorkspaceEdit {
            files: [&first, &second]
                .into_iter()
                .map(|path| FileEdit::Edit {
                    path: path.clone().into(),
                    version: None,
                    edits: vec![TextEdit { range: Range::new(Pos::new(0, 0), Pos::new(0, 3)), new_text: "new".into() }],
                })
                .collect(),
            ..Default::default()
        };
        let error = docs
            .apply_workspace_edit_inner(&edit, true, &mut |index| {
                if index != 1 {
                    return Ok(());
                }
                fs::remove_file(&first)?;
                fs::remove_dir(&parent)?;
                fs::write(&parent, "blocks restoration")?;
                Err(IdeError::new(ErrorKind::Io, "injected commit failure"))
            })
            .unwrap_err();
        assert!(error.message.contains("rollback failed"));
        let recovery = PathBuf::from(error.message.split("Recovery files: ").last().unwrap());
        let manifest: Vec<(ide_core::IpcPath, Option<ide_core::IpcPath>)> =
            serde_json::from_slice(&fs::read(recovery.join("paths.json")).unwrap()).unwrap();
        let backup = manifest
            .iter()
            .find(|(path, _)| path.file_name().is_some_and(|name| name == "first.txt"))
            .unwrap()
            .1
            .as_ref()
            .unwrap();
        assert_eq!(fs::read(backup).unwrap(), b"old\n");
        let after = docs.snapshot(info.id).unwrap();
        assert_eq!(after.text, "old\n");
        assert!(after.dirty, "a buffer whose disk restoration failed must not look saved");
        fs::remove_dir_all(recovery).unwrap();
    }
}
