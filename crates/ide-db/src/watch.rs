//! Data source files edited outside the Database tool window (by hand, by a coding
//! agent, by `git checkout`) are picked up while the project is open, as IDEA does
//! for `dataSources.xml`. The project file tree's watcher is no help here: it never
//! reports a modification inside a gitignored `.openidea/`.

use crate::source::FILE;
use ide_core::{IdeError, IdeResult, project_dir};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak, mpsc};
use std::time::Duration;

/// How long a burst of writes (an editor's save, an agent's rewrite) settles before
/// the files are read.
const SETTLE: Duration = Duration::from_millis(200);

/// Watches `<root>/.openidea/data-sources.toml` and `<global>/data-sources.toml`;
/// stops when dropped.
pub struct SourcesWatch {
    _watcher: Arc<Mutex<RecommendedWatcher>>,
}

impl SourcesWatch {
    /// Calls `on_change` once a burst of changes to either file settled, on a
    /// background thread.
    pub fn start(root: &Path, global: Option<&Path>, on_change: Box<dyn Fn() + Send>) -> IdeResult<Self> {
        let config: PathBuf = root.join(project_dir::DIR);
        let (tx, rx) = mpsc::channel::<()>();
        let relevant = {
            let config = config.clone();
            move |p: &Path| p.file_name().is_some_and(|n| n == FILE) || p == config
        };
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(e) = res
                && e.paths.iter().any(|p| relevant(p))
            {
                let _ = tx.send(());
            }
        })
        .map_err(|e| IdeError::internal(format!("data sources watcher: {e}")))?;
        let watcher = Arc::new(Mutex::new(watcher));
        {
            let mut w = watcher.lock();
            // The root (not recursively) sees `.openidea/` itself appear or go.
            w.watch(root, RecursiveMode::NonRecursive)
                .map_err(|e| IdeError::internal(format!("data sources watcher: {e}")))?;
            if let Some(dir) = global.filter(|d| d.is_dir())
                && let Err(e) = w.watch(dir, RecursiveMode::NonRecursive)
            {
                tracing::warn!("global data sources watcher: {e}");
            }
        }
        let mut watching = watch_config(&watcher, &config, false);
        let weak: Weak<Mutex<RecommendedWatcher>> = Arc::downgrade(&watcher);
        std::thread::Builder::new().name("openidea-db-sources-watch".into()).spawn(move || {
            while rx.recv().is_ok() {
                // Wait until the writes stop.
                loop {
                    match rx.recv_timeout(SETTLE) {
                        Ok(()) => {}
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                let Some(watcher) = weak.upgrade() else { return };
                watching = watch_config(&watcher, &config, watching);
                drop(watcher);
                on_change();
            }
        })?;
        Ok(Self { _watcher: watcher })
    }
}

/// Watches `.openidea/` once it exists (again: a removed folder loses its watch);
/// returns whether it is watched.
fn watch_config(watcher: &Mutex<RecommendedWatcher>, config: &Path, watching: bool) -> bool {
    if !config.is_dir() {
        return false;
    }
    if watching {
        return true;
    }
    match watcher.lock().watch(config, RecursiveMode::NonRecursive) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("data sources watcher {}: {e}", config.display());
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    fn wait_for(count: &AtomicUsize, at_least: usize) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if count.load(Ordering::SeqCst) >= at_least {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn counting() -> (Arc<AtomicUsize>, Box<dyn Fn() + Send>) {
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        (count, Box::new(move || _ = c.fetch_add(1, Ordering::SeqCst)))
    }

    #[test]
    fn reports_project_and_global_files_and_a_config_folder_created_later() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let (project, global) = (root.join("p"), root.join("app"));
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&global).unwrap();
        let (count, on_change) = counting();
        let _watch = SourcesWatch::start(&project, Some(&global), on_change).unwrap();

        // No `.openidea/` yet: it is created, then the file written into it.
        std::fs::create_dir_all(project.join(".openidea")).unwrap();
        assert!(wait_for(&count, 1));
        let seen = count.load(Ordering::SeqCst);
        std::fs::write(project.join(".openidea/data-sources.toml"), "").unwrap();
        assert!(wait_for(&count, seen + 1), "project file");

        let seen = count.load(Ordering::SeqCst);
        std::fs::write(global.join("data-sources.toml"), "").unwrap();
        assert!(wait_for(&count, seen + 1), "global file");
    }

    #[test]
    fn ignores_other_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir_all(root.join(".openidea")).unwrap();
        let (count, on_change) = counting();
        let _watch = SourcesWatch::start(&root, None, on_change).unwrap();
        // FSEvents can deliver the creation of `.openidea/` above after the watch started.
        std::thread::sleep(Duration::from_secs(1));
        let seen = count.load(Ordering::SeqCst);
        std::fs::write(root.join(".openidea/settings.toml"), "").unwrap();
        std::fs::write(root.join("main.py"), "").unwrap();
        std::thread::sleep(SETTLE * 3);
        assert_eq!(count.load(Ordering::SeqCst), seen);
    }
}
