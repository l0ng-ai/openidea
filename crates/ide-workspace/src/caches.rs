//! File › Invalidate Caches: caches in use cannot be deleted while projects are
//! open, so (like IDEA) the request is written to a marker file and carried
//! out at the next start, before any project opens.

use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::{Path, PathBuf};

/// Optional parts of the invalidation; the symbol index is always rebuilt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct InvalidateCachesOptions {
    /// Local History of every project.
    pub local_history: bool,
    /// Language server workspaces (jdtls `-data`, …): servers re-import the project.
    pub language_servers: bool,
    /// Build tool sync results (Maven / Gradle) and other per-project caches.
    pub build_caches: bool,
}

const MARKER: &str = "invalidate-caches.json";

/// Data-directory folders removed for `options`.
pub fn cache_dirs(data_dir: &Path, local_data_dir: &Path, options: &InvalidateCachesOptions) -> Vec<PathBuf> {
    let mut dirs = vec![local_data_dir.join("index")];
    if options.local_history {
        dirs.push(data_dir.join("history"));
    }
    if options.language_servers {
        dirs.push(local_data_dir.join("lsp"));
    }
    if options.build_caches {
        dirs.push(local_data_dir.join("cache"));
    }
    // Also invalidate pre-migration caches so a later start cannot revive them.
    if data_dir != local_data_dir {
        dirs.push(data_dir.join("index"));
        if options.language_servers {
            dirs.push(data_dir.join("lsp"));
        }
        if options.build_caches {
            dirs.push(data_dir.join("cache"));
        }
    }
    dirs
}

/// Requests an invalidation at the next start.
pub fn schedule(data_dir: &Path, options: &InvalidateCachesOptions) -> IdeResult<()> {
    let json = serde_json::to_vec(options).map_err(|e| IdeError::internal(e.to_string()))?;
    fs::create_dir_all(data_dir)?;
    ide_vfs::write_atomic(&data_dir.join(MARKER), &json)?;
    Ok(())
}

/// The invalidation waiting for the next start, if any.
pub fn pending(data_dir: &Path) -> Option<InvalidateCachesOptions> {
    let bytes = fs::read(data_dir.join(MARKER)).ok()?;
    Some(serde_json::from_slice(&bytes).unwrap_or_default())
}

pub fn cancel(data_dir: &Path) {
    let _ = fs::remove_file(data_dir.join(MARKER));
}

/// Carries out a scheduled invalidation (call at start-up, before projects
/// open). Returns the folders removed.
pub fn apply_pending(data_dir: &Path, local_data_dir: &Path) -> Vec<PathBuf> {
    let Some(options) = pending(data_dir) else { return Vec::new() };
    cancel(data_dir);
    let mut removed = Vec::new();
    for dir in cache_dirs(data_dir, local_data_dir, &options) {
        match fs::remove_dir_all(&dir) {
            Ok(()) => removed.push(dir),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("invalidate caches: cannot remove {}: {e}", dir.display()),
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_roots_invalidate_local_caches_and_roaming_history() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("roaming");
        let local = tmp.path().join("local");
        let options = InvalidateCachesOptions { local_history: true, language_servers: true, build_caches: true };
        assert_eq!(
            cache_dirs(&data, &local, &options),
            vec![
                local.join("index"),
                data.join("history"),
                local.join("lsp"),
                local.join("cache"),
                data.join("index"),
                data.join("lsp"),
                data.join("cache")
            ]
        );
        for path in cache_dirs(&data, &local, &options) {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir_all(local.join("tools")).unwrap();
        schedule(&data, &options).unwrap();
        assert_eq!(apply_pending(&data, &local).len(), 7);
        assert!(local.join("tools").exists());
        assert_eq!(pending(&data), None);
    }

    #[test]
    fn scheduled_invalidation_runs_once() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        for d in ["index/p1", "history/p1", "lsp/jdtls/x", "cache/p1/build", "tools/jdk"] {
            fs::create_dir_all(data.join(d)).unwrap();
        }
        assert!(apply_pending(data, data).is_empty());

        let opts = InvalidateCachesOptions { local_history: true, language_servers: false, build_caches: true };
        schedule(data, &opts).unwrap();
        assert_eq!(pending(data), Some(opts));
        let removed = apply_pending(data, data);
        assert_eq!(removed, vec![data.join("index"), data.join("history"), data.join("cache")]);
        assert!(data.join("lsp/jdtls/x").exists() && data.join("tools/jdk").exists());
        assert_eq!(pending(data), None);
        assert!(apply_pending(data, data).is_empty());

        schedule(data, &InvalidateCachesOptions::default()).unwrap();
        cancel(data);
        assert_eq!(pending(data), None);
    }
}
