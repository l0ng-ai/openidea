//! jdtls workspaces (`<local data>/lsp/jdtls/<key>`) that no project uses any more.
//!
//! A workspace is keyed by the project folder and by the settings that need a clean import
//! (source paths, output folder, libraries, linked Gradle projects, unlinked Maven poms), so
//! each change of those, and each moved or deleted project, leaves the previous workspace
//! behind: 50–200 MB of imported model and indexes. Like a cache, one unused for a month is
//! removed at start-up; a project that comes back imports again.

use ide_language::LanguageServerConfig;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Touched each time jdtls starts on a workspace.
const USED_MARKER: &str = ".openidea-last-used";
/// Workspaces being removed (renamed first, so a server never starts on a half-deleted one).
const TRASH_PREFIX: &str = ".removed-";
/// How long a workspace may go unused before start-up removes it.
pub const UNUSED_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);

fn root(data_dir: &Path) -> PathBuf {
    data_dir.join("lsp").join("jdtls")
}

/// Records that jdtls is starting on the workspace of `cfg` (its `-data` folder).
pub fn mark_used(cfg: &LanguageServerConfig) {
    let Some(dir) = cfg.args.iter().position(|a| a == "-data").and_then(|i| cfg.args.get(i + 1)) else { return };
    let dir = Path::new(dir);
    if let Err(e) = std::fs::create_dir_all(dir).and_then(|()| std::fs::write(dir.join(USED_MARKER), b"")) {
        tracing::debug!("jdtls: cannot mark {} as used: {e}", dir.display());
    }
}

/// When a workspace was last used: the latest of our marker (written when jdtls starts) and what
/// jdtls itself touches while it runs and when it saves on exit (a server can run for weeks).
fn last_used(dir: &Path) -> Option<SystemTime> {
    let metadata = dir.join(".metadata");
    [
        dir.join(USED_MARKER),
        metadata.join(".log"),
        metadata.join(".plugins").join("org.eclipse.core.resources"),
        metadata,
    ]
    .into_iter()
    .filter_map(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
    .max()
}

/// Moves the workspaces unused for longer than `max_age` aside, before any server starts, and
/// returns what [`remove`] deletes. Quick: only renames.
pub fn take_unused(data_dir: &Path, max_age: Duration) -> Vec<PathBuf> {
    let root = root(data_dir);
    let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
    let now = SystemTime::now();
    let mut taken = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(TRASH_PREFIX) {
            // Left by a start-up that quit before deleting it.
            taken.push(path);
            continue;
        }
        let unused = last_used(&path).and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age > max_age);
        if !unused {
            continue;
        }
        let trash = root.join(format!("{TRASH_PREFIX}{name}"));
        match std::fs::rename(&path, &trash) {
            Ok(()) => taken.push(trash),
            Err(e) => tracing::debug!("jdtls: cannot move unused workspace {}: {e}", path.display()),
        }
    }
    taken
}

/// Deletes what [`take_unused`] moved aside; slow for large workspaces, so off the start-up path.
pub fn remove(taken: Vec<PathBuf>) {
    for dir in taken {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => tracing::info!("jdtls: removed unused workspace {}", dir.display()),
            Err(e) => tracing::warn!("jdtls: cannot remove unused workspace {}: {e}", dir.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn days_ago(days: u64) -> SystemTime {
        SystemTime::now() - Duration::from_secs(days * 24 * 60 * 60)
    }

    /// Back-dates a file, or (on Unix, where a folder opens as a file) a folder.
    fn age(path: &Path, days: u64) {
        let file =
            if path.is_dir() { std::fs::File::open(path) } else { std::fs::File::options().write(true).open(path) };
        file.unwrap().set_modified(days_ago(days)).unwrap();
    }

    fn cfg(data: &Path) -> LanguageServerConfig {
        let languages = ide_language::LanguageRegistry::load(None).unwrap();
        let mut cfg = languages.get(&ide_core::LanguageId::new("java")).unwrap().language_servers.remove(0);
        cfg.args = vec!["-data".into(), data.to_string_lossy().into_owned()];
        cfg
    }

    #[test]
    fn removes_workspaces_unused_for_longer_than_the_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = root(tmp.path());
        let (old, recent) = (root.join("old"), root.join("recent"));
        mark_used(&cfg(&old));
        mark_used(&cfg(&recent));
        age(&old.join(USED_MARKER), 40);
        age(&recent.join(USED_MARKER), 5);
        std::fs::write(root.join("defaults.prefs"), "").unwrap();

        let taken = take_unused(tmp.path(), UNUSED_FOR);
        assert_eq!(taken.len(), 1, "{taken:?}");
        assert!(!old.exists() && recent.exists() && root.join("defaults.prefs").exists());
        remove(taken);
        let mut left: Vec<_> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect();
        left.sort();
        assert_eq!(left, ["defaults.prefs", "recent"]);
    }

    #[test]
    fn a_started_server_marks_its_workspace_again() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = root(tmp.path()).join("p");
        mark_used(&cfg(&ws));
        age(&ws.join(USED_MARKER), 40);
        mark_used(&cfg(&ws));
        assert!(take_unused(tmp.path(), UNUSED_FOR).is_empty());
        assert!(ws.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_workspace_from_before_markers_is_judged_by_its_folders_and_log() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = root(tmp.path()).join("legacy");
        std::fs::create_dir_all(ws.join(".metadata")).unwrap();
        std::fs::write(ws.join(".metadata/.log"), "").unwrap();
        for p in [ws.join(".metadata/.log"), ws.join(".metadata")] {
            age(&p, 90);
        }
        assert_eq!(take_unused(tmp.path(), UNUSED_FOR).len(), 1);
        // The log alone being recent keeps it.
        let tmp = tempfile::tempdir().unwrap();
        let ws = root(tmp.path()).join("legacy");
        std::fs::create_dir_all(ws.join(".metadata")).unwrap();
        std::fs::write(ws.join(".metadata/.log"), "").unwrap();
        age(&ws.join(".metadata"), 90);
        assert!(take_unused(tmp.path(), UNUSED_FOR).is_empty());
    }

    #[test]
    fn leftovers_of_an_interrupted_removal_are_removed() {
        let tmp = tempfile::tempdir().unwrap();
        let trash = root(tmp.path()).join(format!("{TRASH_PREFIX}gone"));
        std::fs::create_dir_all(trash.join(".metadata")).unwrap();
        let taken = take_unused(tmp.path(), UNUSED_FOR);
        assert_eq!(taken, std::slice::from_ref(&trash));
        remove(taken);
        assert!(!trash.exists());
    }
}
