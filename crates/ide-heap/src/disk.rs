//! Disk-space estimates and the per-snapshot directories under the app's cache.
//!
//! A snapshot directory holds the index columns and, for a capture, the dump itself. Its `owner`
//! file names the host process that created it, so a host that starts later can remove the
//! directories of hosts that died without cleaning up.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Space to leave free on top of an estimate.
pub const DISK_MARGIN: u64 = 1 << 30;

/// hprof ≈ `bytes + 16 × instances`; index columns and scratch arrays ≈ `90 × instances`.
const CAPTURE_BYTES_PER_INSTANCE: u64 = 106;
const INDEX_BYTES_PER_OBJECT: u64 = 90;

const OWNER_FILE: &str = "owner";
const TMP_SUFFIX: &str = ".tmp";
/// A directory still being created by a live host has no `owner` for a moment; one that stays
/// unfinished for longer than this was abandoned.
const TMP_GRACE: Duration = Duration::from_secs(60 * 60);

/// Bytes of free space that a dump of `heap_bytes` bytes holding `instances` instances needs,
/// including its index.
pub fn capture_need(heap_bytes: u64, instances: u64) -> u64 {
    heap_bytes.saturating_add(CAPTURE_BYTES_PER_INSTANCE.saturating_mul(instances)).saturating_add(DISK_MARGIN)
}

/// Bytes of free space that indexing a dump of `objects` objects needs.
pub fn index_need(objects: u64) -> u64 {
    INDEX_BYTES_PER_OBJECT.saturating_mul(objects).saturating_add(DISK_MARGIN)
}

/// Bytes available to this process on the volume holding `dir`; `None` where it is not checked
/// (not unix) or cannot be read, so callers go ahead rather than refuse.
pub fn free_bytes(dir: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;

        let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
        // SAFETY: `path` is NUL-terminated and `stat` is only read after `statvfs` filled it in.
        let stat = unsafe {
            let mut stat = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
            if libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) != 0 {
                return None;
            }
            stat.assume_init()
        };
        // The field widths differ between unix targets.
        #[allow(clippy::unnecessary_cast)]
        Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        None
    }
}

/// `<local_data_dir>/cache/heap-snapshots`.
pub fn snapshots_root(local_data_dir: &Path) -> PathBuf {
    local_data_dir.join("cache").join("heap-snapshots")
}

/// Creates `<root>/<uuid>/` holding an `owner` file with this process's pid. The directory is
/// built as `<uuid>.tmp` and renamed, so another host scanning `root` never sees it without its
/// owner and removes it as abandoned.
pub fn create_snapshot_dir(root: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(root)?;
    let name = uuid::Uuid::new_v4().to_string();
    let building = root.join(format!("{name}{TMP_SUFFIX}"));
    let dir = root.join(&name);
    create_private_dir(&building)?;
    let published =
        fs::write(building.join(OWNER_FILE), std::process::id().to_string()).and_then(|()| fs::rename(&building, &dir));
    if let Err(err) = published {
        let _ = fs::remove_dir_all(&building);
        return Err(err);
    }
    Ok(dir)
}

/// A dump holds whatever was in the JVM's memory, passwords and tokens included, so on unix only
/// the owner may enter the directory. Windows keeps the ACL inherited from the user's data dir.
fn create_private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        fs::DirBuilder::new().create(path)
    }
}

/// Removes the directories under `root` whose owner file is missing, unreadable or names a pid
/// for which `alive` is false, and unfinished `*.tmp` ones older than an hour. Only directories
/// directly under `root` are touched; a symlink there is left alone.
pub fn remove_stale(root: &Path, alive: impl Fn(u32) -> bool) {
    remove_stale_at(root, alive, SystemTime::now());
}

fn remove_stale_at(root: &Path, alive: impl Fn(u32) -> bool, now: SystemTime) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        // `symlink_metadata` does not follow: a link out of `root` is not a directory here.
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        if !meta.file_type().is_dir() {
            continue;
        }
        let stale = if path.extension().is_some_and(|ext| ext == "tmp") {
            meta.modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age >= TMP_GRACE)
        } else {
            read_owner(&path).is_none_or(|pid| !alive(pid))
        };
        if stale && let Err(err) = fs::remove_dir_all(&path) {
            tracing::warn!(dir = %path.display(), %err, "could not remove a stale heap snapshot directory");
        }
    }
}

fn read_owner(dir: &Path) -> Option<u32> {
    let mut text = String::new();
    fs::File::open(dir.join(OWNER_FILE)).ok()?.take(32).read_to_string(&mut text).ok()?;
    text.trim().parse().ok()
}

#[cfg(test)]
mod tests;
