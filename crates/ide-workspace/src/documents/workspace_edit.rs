//! Preflight, rollback and grouped undo for edits spanning documents and files.

use super::{DocState, Documents, RegEntry, disk_len, keys_for};
use ide_core::error::ErrorKind;
use ide_core::{DocId, FileEdit, IdeError, IdeEvent, IdeResult, NullSink, WorkspaceEdit, WorkspaceEditPrecondition};
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Default)]
pub(super) struct History {
    next: u32,
    records: VecDeque<(u32, Record)>,
}

struct SavedPath {
    path: PathBuf,
    backup: Option<PathBuf>,
}

struct Record {
    directory: tempfile::TempDir,
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
                        if state.dirty && file.starts_with(path) {
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
        let mut record = self.backup(&roots)?;
        self.preflight(&record, &edit)?;
        fs::remove_dir_all(record.directory.path().join("stage"))?;
        self.validate_preconditions(&edit.preconditions)?;
        if let Err(error) = self.apply_sequence(&edit, before_operation) {
            return Err(self.recover(record, error));
        }
        record.after = match self.fingerprints(&roots) {
            Ok(after) => after,
            Err(error) => return Err(self.recover(record, error)),
        };
        if remember {
            let mut history = self.workspace_edits.lock();
            history.next += 1;
            let id = history.next;
            history.records.push_back((id, record));
            while history.records.len() > 20 {
                history.records.pop_front();
            }
            self.sink.emit(IdeEvent::WorkspaceEditApplied { id });
        }
        Ok(())
    }

    fn backup(&self, roots: &[PathBuf]) -> IdeResult<Record> {
        let directory = tempfile::Builder::new().prefix("openidea-workspace-edit-").tempdir()?;
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
        Ok(Record { directory, paths, documents, after: Vec::new() })
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
                        self.apply_edits(info.id, edits)?;
                        // Do not save unrelated unsaved work as a side effect of a refactoring.
                        if !info.dirty {
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

    /// Refuse to overwrite work made after the refactoring; keep the undo record on failure.
    pub fn undo_workspace_edit(&self, id: u32) -> IdeResult<()> {
        let _operation = self.operations.lock();
        let mut history = self.workspace_edits.lock();
        let index = history
            .records
            .iter()
            .position(|(key, _)| *key == id)
            .ok_or_else(|| IdeError::not_found("the refactoring can no longer be undone"))?;
        let record = &history.records[index].1;
        self.validate_preconditions(&record.after)?;
        let current = self.backup(&record.paths.iter().map(|p| p.path.clone()).collect::<Vec<_>>())?;
        if let Err(error) = self.restore(record) {
            return Err(self.recover(current, error));
        }
        history.records.remove(index);
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
