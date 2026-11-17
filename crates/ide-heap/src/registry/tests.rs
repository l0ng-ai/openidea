use std::sync::Arc;

use ide_core::{CancellationToken, DebugSessionId};

use super::*;
use crate::analysis::{AnalyzeOptions, analyze};
use crate::disk::create_snapshot_dir;
use crate::error::HeapError;
use crate::progress::HeapPhase;
use crate::testing::sample;

fn no_progress(_: HeapPhase, _: u64, _: u64) -> Result<(), HeapError> {
    Ok(())
}

fn captured() -> HeapOrigin {
    HeapOrigin::Captured {
        session: DebugSessionId(7),
        pid: 4242,
        java_version: "21.0.2".into(),
        taken_while_suspended: true,
        dump_ms: 35,
    }
}

fn external(path: &Path) -> HeapOrigin {
    HeapOrigin::File { path: IpcPath(path.to_path_buf()) }
}

/// A snapshot whose index files are mapped from `dir`, like a real one: `dump` is analyzed in
/// place and `dir` receives the columns.
fn open_in(dir: &Path, dump: &Path, origin: HeapOrigin) -> impl FnOnce(HeapSnapshotId) -> OpenSnapshot {
    let dir = dir.to_path_buf();
    let dump = dump.to_path_buf();
    move |id| {
        std::fs::write(&dump, sample().bytes()).unwrap();
        let index = analyze(&dump, &dir, AnalyzeOptions::default(), &no_progress, &CancellationToken::new()).unwrap();
        let info = HeapSnapshotInfo {
            id,
            label: origin.label(),
            origin,
            summary: index.summary.clone(),
            created_ms: 1_700_000_000_000,
        };
        OpenSnapshot::new(info, index, dir, dump)
    }
}

/// Inserts a captured snapshot with its own directory under the registry's root.
fn insert_captured(registry: &HeapRegistry) -> (HeapSnapshotInfo, PathBuf) {
    let dir = create_snapshot_dir(registry.root()).unwrap();
    let dump = dir.join("dump.hprof");
    let info = registry.insert(open_in(&dir, &dump, captured()));
    (info, dir)
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> =
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    names
}

#[test]
fn closing_snapshot_removes_dir() {
    let root = tempfile::tempdir().unwrap();
    let registry = HeapRegistry::new(root.path().to_path_buf());
    let (info, dir) = insert_captured(&registry);
    assert!(dir.join("dump.hprof").exists() && dir.join("summary.json").exists());
    assert!(registry.close(info.id));
    assert!(!dir.exists());
    assert!(!registry.close(info.id));
    assert!(registry.get(info.id).is_none());
}

#[test]
fn external_dump_is_never_deleted() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let dump = outside.path().join("app.hprof");
    let registry = HeapRegistry::new(root.path().to_path_buf());
    let dir = create_snapshot_dir(registry.root()).unwrap();
    let info = registry.insert(open_in(&dir, &dump, external(&dump)));
    assert_eq!(info.label, "app.hprof");
    assert!(dir.join("summary.json").exists());
    assert!(registry.close(info.id));
    assert!(!dir.exists());
    assert!(dump.exists());
}

#[test]
fn a_dump_inside_the_dir_of_a_file_snapshot_keeps_the_dir() {
    let root = tempfile::tempdir().unwrap();
    let registry = HeapRegistry::new(root.path().to_path_buf());
    let dir = create_snapshot_dir(registry.root()).unwrap();
    let dump = dir.join("opened.hprof");
    let info = registry.insert(open_in(&dir, &dump, external(&dump)));
    assert!(registry.close(info.id));
    assert!(dump.exists());
}

#[test]
fn a_dir_outside_the_root_is_never_deleted() {
    let root = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let registry = HeapRegistry::new(root.path().to_path_buf());
    let dump = elsewhere.path().join("dump.hprof");
    let info = registry.insert(open_in(elsewhere.path(), &dump, captured()));
    assert!(registry.close(info.id));
    assert!(dump.exists());
    // Neither the root itself nor a path that climbs out of it counts as a snapshot dir.
    let sneaky = root.path().join("..").join(elsewhere.path().file_name().unwrap());
    let info = registry.insert(open_in(&sneaky, &dump, captured()));
    assert!(registry.close(info.id));
    assert!(dump.exists());
}

#[cfg(unix)]
#[test]
fn a_symlinked_dir_is_not_followed() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let dump = outside.path().join("dump.hprof");
    let link = root.path().join("link");
    std::os::unix::fs::symlink(outside.path(), &link).unwrap();
    let registry = HeapRegistry::new(root.path().to_path_buf());
    let info = registry.insert(open_in(&link, &dump, captured()));
    assert!(registry.close(info.id));
    assert!(dump.exists());
}

#[test]
fn ids_are_never_reused() {
    let root = tempfile::tempdir().unwrap();
    let registry = HeapRegistry::new(root.path().to_path_buf());
    let (first, _) = insert_captured(&registry);
    assert!(registry.close(first.id));
    let (second, _) = insert_captured(&registry);
    let (third, _) = insert_captured(&registry);
    assert!(first.id.0 < second.id.0 && second.id.0 < third.id.0);
}

#[test]
fn the_registry_decides_the_id_in_the_info() {
    let root = tempfile::tempdir().unwrap();
    let registry = HeapRegistry::new(root.path().to_path_buf());
    let dir = create_snapshot_dir(registry.root()).unwrap();
    let dump = dir.join("dump.hprof");
    let make = open_in(&dir, &dump, captured());
    let info = registry.insert(|id| {
        let mut snapshot = make(id);
        snapshot.info.id = HeapSnapshotId(u32::MAX);
        snapshot
    });
    assert_ne!(info.id, HeapSnapshotId(u32::MAX));
    assert_eq!(registry.get(info.id).unwrap().info.id, info.id);
}

#[test]
fn list_is_in_opening_order_and_get_shares_the_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let registry = HeapRegistry::new(root.path().to_path_buf());
    let (a, _) = insert_captured(&registry);
    let (b, _) = insert_captured(&registry);
    let (c, _) = insert_captured(&registry);
    assert!(registry.close(b.id));
    assert_eq!(registry.list(), [a.clone(), c.clone()]);
    let one = registry.get(a.id).unwrap();
    let two = registry.get(a.id).unwrap();
    assert!(Arc::ptr_eq(&one, &two));
    assert_eq!(one.info, a);
    assert_eq!(one.index().summary, a.summary);
}

#[test]
fn a_snapshot_in_use_keeps_its_dir_until_the_last_holder_lets_go() {
    let root = tempfile::tempdir().unwrap();
    let registry = HeapRegistry::new(root.path().to_path_buf());
    let (info, dir) = insert_captured(&registry);
    let held = registry.get(info.id).unwrap();
    assert!(registry.close(info.id));
    assert!(registry.get(info.id).is_none() && registry.list().is_empty());
    assert!(dir.exists());
    drop(held);
    assert!(!dir.exists());
}

#[test]
fn dropping_the_registry_removes_the_open_snapshots() {
    let root = tempfile::tempdir().unwrap();
    let registry = HeapRegistry::new(root.path().to_path_buf());
    let (_, dir) = insert_captured(&registry);
    drop(registry);
    assert!(!dir.exists());
    assert!(names(root.path()).is_empty());
}

#[cfg(unix)]
#[test]
fn new_clears_dirs_whose_owner_died() {
    let root = tempfile::tempdir().unwrap();
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let dead = child.id();
    child.wait().unwrap();
    let dead_dir = root.path().join("dead");
    std::fs::create_dir(&dead_dir).unwrap();
    std::fs::write(dead_dir.join("owner"), dead.to_string()).unwrap();
    let live_dir = create_snapshot_dir(root.path()).unwrap();
    let registry = HeapRegistry::new(root.path().to_path_buf());
    assert!(!dead_dir.exists());
    assert!(live_dir.exists());
    assert_eq!(registry.root(), root.path());
}

#[test]
fn concurrent_inserts_get_distinct_ids() {
    let root = tempfile::tempdir().unwrap();
    let registry = Arc::new(HeapRegistry::new(root.path().to_path_buf()));
    let handles: Vec<_> = (0..6)
        .map(|_| {
            let registry = registry.clone();
            std::thread::spawn(move || (0..3).map(|_| insert_captured(&registry).0.id).collect::<Vec<_>>())
        })
        .collect();
    let mut ids: Vec<_> = handles.into_iter().flat_map(|h| h.join().unwrap()).collect();
    ids.sort_by_key(|id| id.0);
    ids.dedup();
    assert_eq!(ids.len(), 18);
    assert_eq!(registry.list().len(), 18);
    for id in ids {
        assert!(registry.close(id));
    }
    assert!(names(root.path()).is_empty());
}

#[test]
fn labels_name_the_pid_or_the_file() {
    assert_eq!(captured().label(), "4242");
    assert_eq!(external(Path::new("/tmp/dumps/app.hprof")).label(), "app.hprof");
    assert_eq!(external(Path::new("/")).label(), "/");
}

#[test]
fn origin_and_info_serialize_as_the_ui_expects() {
    let value = serde_json::to_value(captured()).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "kind": "captured", "session": 7, "pid": 4242, "javaVersion": "21.0.2",
            "takenWhileSuspended": true, "dumpMs": 35
        })
    );
    assert_eq!(serde_json::to_value(external(Path::new("/a/b.hprof"))).unwrap()["path"], "/a/b.hprof");
    assert_eq!(serde_json::to_value(HeapSnapshotId(3)).unwrap(), serde_json::json!(3));
    let back: HeapOrigin = serde_json::from_value(value).unwrap();
    assert_eq!(back, captured());
}

// `HeapRegistry::get` hands out `Arc<OpenSnapshot>` to query threads.
const _: fn() = || {
    fn check<T: Send + Sync>() {}
    check::<HeapIndex>();
    check::<OpenSnapshot>();
    check::<HeapRegistry>();
};
