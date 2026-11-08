use std::time::{Duration, SystemTime};

use super::*;

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> =
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    names
}

fn dir_with_owner(root: &Path, name: &str, owner: Option<&str>) {
    let dir = root.join(name);
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("dump.hprof"), b"x").unwrap();
    if let Some(owner) = owner {
        std::fs::write(dir.join(OWNER_FILE), owner).unwrap();
    }
}

#[test]
fn estimates() {
    assert_eq!(capture_need(664_018_520, 20_087_506), 664_018_520 + 106 * 20_087_506 + (1 << 30));
    assert_eq!(index_need(10), 900 + (1 << 30));
}

#[test]
fn estimates_saturate_instead_of_wrapping() {
    assert_eq!(capture_need(u64::MAX, u64::MAX), u64::MAX);
    assert_eq!(index_need(u64::MAX), u64::MAX);
}

#[cfg(unix)]
#[test]
fn not_enough_space_for_estimate() {
    let dir = tempfile::tempdir().unwrap();
    let free = free_bytes(dir.path()).expect("statvfs works on a temp dir");
    assert!(free > 0);
    assert!(capture_need(u64::MAX / 4, 0) > free);
}

#[cfg(unix)]
#[test]
fn free_bytes_of_a_missing_dir_is_unknown() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(free_bytes(&dir.path().join("missing")), None);
}

#[cfg(not(unix))]
#[test]
fn free_space_is_not_checked_off_unix() {
    assert_eq!(free_bytes(Path::new(".")), None);
}

#[test]
fn snapshots_root_is_under_the_cache() {
    let local = Path::new("local");
    assert_eq!(snapshots_root(local), local.join("cache").join("heap-snapshots"));
}

#[test]
fn snapshot_dir_records_its_owner_and_leaves_no_tmp() {
    let root = tempfile::tempdir().unwrap();
    let missing_parent = root.path().join("cache").join("heap-snapshots");
    let dir = create_snapshot_dir(&missing_parent).unwrap();
    assert_eq!(dir.parent(), Some(missing_parent.as_path()));
    assert!(uuid::Uuid::parse_str(dir.file_name().unwrap().to_str().unwrap()).is_ok());
    assert_eq!(std::fs::read_to_string(dir.join(OWNER_FILE)).unwrap(), std::process::id().to_string());
    assert_eq!(names(&missing_parent), [dir.file_name().unwrap().to_str().unwrap()]);
    assert_ne!(create_snapshot_dir(&missing_parent).unwrap(), dir);
}

#[test]
fn stale_dirs_removed_on_start() {
    let root = tempfile::tempdir().unwrap();
    dir_with_owner(root.path(), "a", Some("999999"));
    dir_with_owner(root.path(), "b", Some(&std::process::id().to_string()));
    dir_with_owner(root.path(), "c", None);
    remove_stale(root.path(), |pid| pid == std::process::id());
    assert_eq!(names(root.path()), ["b"]);
}

#[test]
fn owner_that_is_not_a_pid_is_stale() {
    let root = tempfile::tempdir().unwrap();
    dir_with_owner(root.path(), "empty", Some(""));
    dir_with_owner(root.path(), "word", Some("not-a-pid"));
    dir_with_owner(root.path(), "negative", Some("-1"));
    dir_with_owner(root.path(), "padded", Some(&format!(" {}\n", std::process::id())));
    remove_stale(root.path(), |pid| pid == std::process::id());
    assert_eq!(names(root.path()), ["padded"]);
}

#[test]
fn stale_scan_tolerates_a_missing_root_and_leaves_loose_files_alone() {
    let root = tempfile::tempdir().unwrap();
    remove_stale(&root.path().join("missing"), |_| false);
    std::fs::write(root.path().join("notes.txt"), b"keep").unwrap();
    remove_stale(root.path(), |_| false);
    assert_eq!(names(root.path()), ["notes.txt"]);
}

#[test]
fn unfinished_dir_is_left_alone_for_an_hour() {
    let root = tempfile::tempdir().unwrap();
    // Another host may be between `create_dir` and the rename of its own snapshot dir.
    dir_with_owner(root.path(), "young.tmp", None);
    let now = SystemTime::now();
    remove_stale_at(root.path(), |_| false, now);
    assert_eq!(names(root.path()), ["young.tmp"]);
    remove_stale_at(root.path(), |_| false, now + TMP_GRACE - Duration::from_secs(60));
    assert_eq!(names(root.path()), ["young.tmp"]);
    remove_stale_at(root.path(), |_| false, now + TMP_GRACE + Duration::from_secs(60));
    assert!(names(root.path()).is_empty());
}

#[cfg(unix)]
#[test]
fn stale_scan_never_follows_a_symlink_out_of_the_root() {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("precious"), b"x").unwrap();
    let root = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
    remove_stale(root.path(), |_| false);
    remove_stale_at(root.path(), |_| false, SystemTime::now() + 2 * TMP_GRACE);
    assert_eq!(names(outside.path()), ["precious"]);
}

#[cfg(unix)]
#[test]
fn process_alive_tells_live_from_dead_pids() {
    assert!(process_alive(std::process::id()));
    assert!(!process_alive(0));
    assert!(!process_alive(u32::MAX));
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    assert!(!process_alive(pid));
}
