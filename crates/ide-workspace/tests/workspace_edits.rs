use ide_core::{ChangeSet, FileEdit, LanguageId, NullSink, Pos, Range, TextChange, TextEdit, WorkspaceEdit};
use ide_core::{IdeEvent, error::ErrorKind};
use ide_workspace::Documents;
use parking_lot::Mutex;
use std::path::Path;
use std::sync::Arc;

fn documents() -> Documents {
    Documents::new(Arc::new(NullSink), Box::new(|_, _| LanguageId::plain_text()))
}

fn edit(path: &Path, text: &str) -> FileEdit {
    FileEdit::Edit {
        path: path.to_owned().into(),
        version: None,
        edits: vec![TextEdit { range: Range::new(Pos::new(0, 0), Pos::new(0, 3)), new_text: text.into() }],
    }
}

#[test]
fn later_failure_preserves_disk_and_unsaved_buffer() {
    let tmp = tempfile::tempdir().unwrap();
    let first = tmp.path().join("first.txt");
    let missing = tmp.path().join("missing.txt");
    std::fs::write(&first, "old\n").unwrap();
    let docs = documents();
    let info = docs.open(&first).unwrap();
    docs.edit(info.id, info.version, ChangeSet { changes: vec![TextChange { from: 0, to: 3, insert: "own".into() }] })
        .unwrap();
    let result = docs.apply_workspace_edit(&WorkspaceEdit {
        files: vec![edit(&first, "new"), edit(&missing, "bad")],
        ..Default::default()
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read_to_string(&first).unwrap(), "old\n");
    let after = docs.snapshot(info.id).unwrap();
    assert_eq!(after.text, "own\n");
    assert!(after.dirty);
}

#[test]
fn create_conflict_does_not_modify_earlier_files() {
    let tmp = tempfile::tempdir().unwrap();
    let first = tmp.path().join("first.txt");
    let existing = tmp.path().join("exists.txt");
    std::fs::write(&first, "old\n").unwrap();
    std::fs::write(&existing, "keep").unwrap();
    let docs = documents();
    let result = docs.apply_workspace_edit(&WorkspaceEdit {
        files: vec![edit(&first, "new"), FileEdit::Create { path: existing.clone().into(), overwrite: false }],
        ..Default::default()
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read_to_string(&first).unwrap(), "old\n");
    assert_eq!(std::fs::read_to_string(existing).unwrap(), "keep");
}

fn recorded_documents() -> (Documents, Arc<Mutex<Vec<IdeEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (Documents::new(Arc::new(move |event| sink.lock().push(event)), Box::new(|_, _| LanguageId::plain_text())), events)
}

fn undo_id(events: &Mutex<Vec<IdeEvent>>) -> u32 {
    events
        .lock()
        .iter()
        .rev()
        .find_map(|event| match event {
            IdeEvent::WorkspaceEditApplied { id } => Some(*id),
            _ => None,
        })
        .expect("successful transaction has one undo record")
}

#[test]
fn stale_document_version_rejects_the_whole_edit() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a.txt");
    let b = tmp.path().join("b.txt");
    std::fs::write(&a, "old\n").unwrap();
    std::fs::write(&b, "old\n").unwrap();
    let docs = documents();
    let info = docs.open(&b).unwrap();
    docs.edit(info.id, 0, ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "own ".into() }] }).unwrap();
    let mut second = edit(&b, "new");
    if let FileEdit::Edit { version, .. } = &mut second {
        *version = Some(0);
    }
    let result =
        docs.apply_workspace_edit(&WorkspaceEdit { files: vec![edit(&a, "new"), second], ..Default::default() });
    assert_eq!(result.unwrap_err().kind, ErrorKind::OutOfSync);
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "old\n");
    assert_eq!(docs.snapshot(info.id).unwrap().text, "own old\n");
    assert!(docs.is_dirty(info.id).unwrap());
}

#[test]
fn matching_document_version_is_applied() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a.txt");
    std::fs::write(&a, "old\n").unwrap();
    let docs = documents();
    let info = docs.open(&a).unwrap();
    let mut operation = edit(&a, "new");
    if let FileEdit::Edit { version, .. } = &mut operation {
        *version = Some(info.version as i32);
    }
    docs.apply_workspace_edit(&WorkspaceEdit { files: vec![operation], ..Default::default() }).unwrap();
    assert_eq!(docs.snapshot(info.id).unwrap().text, "new\n");
    assert_eq!(std::fs::read_to_string(a).unwrap(), "new\n");
}

#[test]
fn unversioned_preview_rejects_changed_disk_and_dirty_buffers() {
    let tmp = tempfile::tempdir().unwrap();
    for open in [false, true] {
        let path = tmp.path().join(if open { "open.txt" } else { "closed.txt" });
        std::fs::write(&path, "old\n").unwrap();
        let docs = documents();
        let info = open.then(|| docs.open(&path).unwrap());
        let mut change = WorkspaceEdit { files: vec![edit(&path, "new")], ..Default::default() };
        docs.prepare_workspace_edit(&mut change).unwrap();
        if let Some(info) = &info {
            docs.edit(
                info.id,
                info.version,
                ChangeSet { changes: vec![TextChange { from: 0, to: 3, insert: "own".into() }] },
            )
            .unwrap();
        } else {
            std::fs::write(&path, "own\n").unwrap();
        }
        let original = change.preconditions.clone();
        docs.prepare_workspace_edit(&mut change).unwrap();
        assert_eq!(change.preconditions, original, "resolution must not refresh an old preview's guard");
        assert_eq!(docs.apply_workspace_edit(&change).unwrap_err().kind, ErrorKind::OutOfSync);
        if let Some(info) = info {
            assert_eq!(docs.snapshot(info.id).unwrap().text, "own\n");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "old\n");
        } else {
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "own\n");
        }
    }
}

#[test]
fn grouped_undo_restores_open_closed_and_unsaved_files() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a.txt");
    let b = tmp.path().join("b.txt");
    let c = tmp.path().join("c.txt");
    for path in [&a, &b, &c] {
        std::fs::write(path, "old\r\n").unwrap();
    }
    let (docs, events) = recorded_documents();
    let dirty = docs.open(&a).unwrap();
    let clean = docs.open(&b).unwrap();
    docs.edit(dirty.id, 0, ChangeSet { changes: vec![TextChange { from: 0, to: 3, insert: "own".into() }] }).unwrap();
    let change =
        WorkspaceEdit { files: [&a, &b, &c].into_iter().map(|p| edit(p, "new")).collect(), ..Default::default() };
    docs.apply_workspace_edit(&change).unwrap();
    assert_eq!(docs.snapshot(dirty.id).unwrap().text, "new\n");
    assert!(docs.is_dirty(dirty.id).unwrap());
    assert_eq!(std::fs::read(&a).unwrap(), b"old\r\n", "unrelated unsaved work is not saved");
    assert_eq!(std::fs::read(&c).unwrap(), b"new\r\n");
    let opened_later = docs.open(&c).unwrap();
    let id = undo_id(&events);
    docs.undo_workspace_edit(id).unwrap();
    assert_eq!(docs.snapshot(dirty.id).unwrap().text, "own\n");
    assert!(docs.is_dirty(dirty.id).unwrap());
    for info in [clean, opened_later] {
        assert_eq!(docs.snapshot(info.id).unwrap().text, "old\n");
        assert!(!docs.is_dirty(info.id).unwrap());
    }
    for path in [&a, &b, &c] {
        assert_eq!(std::fs::read(path).unwrap(), b"old\r\n");
    }
    assert!(docs.undo_workspace_edit(id).is_err());
}

#[test]
fn undo_refuses_later_changes_and_retains_the_record() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a.txt");
    std::fs::write(&a, "old\n").unwrap();
    let (docs, events) = recorded_documents();
    docs.apply_workspace_edit(&WorkspaceEdit { files: vec![edit(&a, "new")], ..Default::default() }).unwrap();
    let id = undo_id(&events);
    std::fs::write(&a, "own\n").unwrap();
    assert_eq!(docs.undo_workspace_edit(id).unwrap_err().kind, ErrorKind::OutOfSync);
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "own\n");
    std::fs::write(&a, "new\n").unwrap();
    docs.undo_workspace_edit(id).unwrap();
    assert_eq!(std::fs::read_to_string(a).unwrap(), "old\n");
}

#[test]
fn ordered_resource_operations_and_binary_deletion_are_undoable() {
    let tmp = tempfile::tempdir().unwrap();
    let created = tmp.path().join("new/deep/file.txt");
    let renamed = tmp.path().join("renamed.txt");
    let deleted = tmp.path().join("binary.dat");
    let overwritten = tmp.path().join("overwrite.txt");
    std::fs::write(&deleted, [0, 255, 1, 128]).unwrap();
    std::fs::write(&overwritten, [255, 254, 65, 0]).unwrap();
    let (docs, events) = recorded_documents();
    let change = WorkspaceEdit {
        files: vec![
            FileEdit::Create { path: created.clone().into(), overwrite: false },
            edit(&created, "hello"),
            FileEdit::Rename { from: created.clone().into(), to: renamed.clone().into() },
            FileEdit::Delete { path: deleted.clone().into(), recursive: false },
            FileEdit::Create { path: overwritten.clone().into(), overwrite: true },
        ],
        ..Default::default()
    };
    docs.apply_workspace_edit(&change).unwrap();
    assert_eq!(std::fs::read_to_string(&renamed).unwrap(), "hello");
    assert!(!deleted.exists());
    assert!(std::fs::read(&overwritten).unwrap().is_empty());
    docs.undo_workspace_edit(undo_id(&events)).unwrap();
    assert!(!tmp.path().join("new").exists());
    assert!(!renamed.exists());
    assert_eq!(std::fs::read(deleted).unwrap(), [0, 255, 1, 128]);
    assert_eq!(std::fs::read(overwritten).unwrap(), [255, 254, 65, 0]);
}

#[test]
fn nonrecursive_directory_delete_is_rejected_before_any_write() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a.txt");
    let dir = tmp.path().join("directory");
    std::fs::write(&a, "old\n").unwrap();
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("keep.txt"), "keep").unwrap();
    let change = WorkspaceEdit {
        files: vec![edit(&a, "new"), FileEdit::Delete { path: dir.clone().into(), recursive: false }],
        ..Default::default()
    };
    assert!(documents().apply_workspace_edit(&change).is_err());
    assert_eq!(std::fs::read_to_string(a).unwrap(), "old\n");
    assert!(dir.join("keep.txt").exists());
}

#[test]
fn external_write_not_yet_seen_by_watcher_is_not_overwritten() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("a.txt");
    std::fs::write(&path, "old\n").unwrap();
    let docs = documents();
    let info = docs.open(&path).unwrap();
    std::fs::write(&path, "own\n").unwrap();
    let mut change = WorkspaceEdit { files: vec![edit(&path, "new")], ..Default::default() };
    docs.prepare_workspace_edit(&mut change).unwrap();
    assert_eq!(docs.apply_workspace_edit(&change).unwrap_err().kind, ErrorKind::OutOfSync);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "own\n");
    assert_eq!(docs.snapshot(info.id).unwrap().text, "old\n");
}

#[cfg(unix)]
#[test]
fn undo_restores_deleted_directory_with_symlinks_and_permissions() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("tree");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("script"), "old\n").unwrap();
    std::fs::set_permissions(dir.join("script"), std::fs::Permissions::from_mode(0o751)).unwrap();
    symlink("missing-target", dir.join("link")).unwrap();
    let (docs, events) = recorded_documents();
    docs.apply_workspace_edit(&WorkspaceEdit {
        files: vec![FileEdit::Delete { path: dir.clone().into(), recursive: true }],
        ..Default::default()
    })
    .unwrap();
    assert!(!dir.exists());
    docs.undo_workspace_edit(undo_id(&events)).unwrap();
    assert_eq!(std::fs::read(dir.join("script")).unwrap(), b"old\n");
    assert_eq!(std::fs::metadata(dir.join("script")).unwrap().permissions().mode() & 0o777, 0o751);
    assert_eq!(std::fs::read_link(dir.join("link")).unwrap(), Path::new("missing-target"));
}

#[cfg(unix)]
#[test]
fn preflight_never_writes_through_copied_or_moved_symlinks() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("target.txt");
    let link = tmp.path().join("link.txt");
    let moved = tmp.path().join("moved.txt");
    std::fs::write(&target, "old\n").unwrap();
    symlink(&target, &link).unwrap();
    let docs = documents();
    for files in [
        vec![FileEdit::Create { path: link.clone().into(), overwrite: true }],
        vec![FileEdit::Rename { from: link.clone().into(), to: moved.clone().into() }, edit(&moved, "new")],
    ] {
        assert!(docs.apply_workspace_edit(&WorkspaceEdit { files, ..Default::default() }).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old\n");
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert!(!moved.exists());
    }
}
