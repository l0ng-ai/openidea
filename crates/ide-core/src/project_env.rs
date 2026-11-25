//! Environments of project folders (a project's direnv `.envrc`), for the children started
//! inside them. One process can hold several projects (desktop windows), so unlike the
//! process-wide overlay ([`crate::process::set_env_overlay`]) these are kept per root and
//! found from a child's working directory: see [`crate::process::host_env`] and the `_in`
//! variants next to it.

use crate::CancellationToken;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

pub type Changes = Arc<Vec<(OsString, Option<OsString>)>>;

struct Entry {
    root: PathBuf,
    changes: Changes,
    loading: bool,
}

static ENTRIES: Mutex<Vec<Entry>> = Mutex::new(Vec::new());
static SETTLED: Condvar = Condvar::new();

fn entries() -> MutexGuard<'static, Vec<Entry>> {
    ENTRIES.lock().unwrap_or_else(|e| e.into_inner())
}

/// `root`'s environment is being read: [`wait`] blocks until [`set`] or [`remove`]. Children
/// started meanwhile keep getting the last one read.
pub fn begin_loading(root: &Path) {
    let mut entries = entries();
    match entries.iter_mut().find(|e| e.root == root) {
        Some(entry) => entry.loading = true,
        None => entries.push(Entry { root: root.to_path_buf(), changes: Changes::default(), loading: true }),
    }
}

/// What children started in `root` (or below it) get on top of the IDE's own environment
/// (`None`: removed). Ends a [`begin_loading`].
pub fn set(root: &Path, changes: Vec<(OsString, Option<OsString>)>) {
    let mut entries = entries();
    let changes = Arc::new(changes);
    match entries.iter_mut().find(|e| e.root == root) {
        Some(entry) => {
            entry.changes = changes;
            entry.loading = false;
        }
        None => entries.push(Entry { root: root.to_path_buf(), changes, loading: false }),
    }
    SETTLED.notify_all();
}

/// Ends a [`begin_loading`] that read nothing new (an error): the last environment stays.
pub fn settle(root: &Path) {
    if let Some(entry) = entries().iter_mut().find(|e| e.root == root) {
        entry.loading = false;
    }
    SETTLED.notify_all();
}

/// `root` has no environment of its own any more (closed, or not trusted).
pub fn remove(root: &Path) {
    entries().retain(|e| e.root != root);
    SETTLED.notify_all();
}

/// The innermost root holding `dir`.
fn find<'a>(entries: &'a [Entry], dir: &Path) -> Option<&'a Entry> {
    entries.iter().filter(|e| dir.starts_with(&e.root)).max_by_key(|e| e.root.components().count())
}

/// The environment of the project holding `dir` (empty outside every project, or before it was read).
pub fn for_dir(dir: &Path) -> Changes {
    find(&entries(), dir).map(|e| e.changes.clone()).unwrap_or_default()
}

/// Whether the environment of the project holding `dir` is being read.
pub fn is_loading(dir: &Path) -> bool {
    find(&entries(), dir).is_some_and(|e| e.loading)
}

/// Blocks while the environment of the project holding `dir` is being read, or until `cancel`.
/// For what must not start without it: language servers.
pub fn wait(dir: &Path, cancel: &CancellationToken) {
    let mut entries = entries();
    while !cancel.is_cancelled() && find(&entries, dir).is_some_and(|e| e.loading) {
        entries = SETTLED.wait_timeout(entries, Duration::from_millis(200)).unwrap_or_else(|e| e.into_inner()).0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(k: &str, v: Option<&str>) -> (OsString, Option<OsString>) {
        (k.into(), v.map(Into::into))
    }

    #[test]
    fn the_innermost_project_holding_a_folder_applies() {
        let outer = Path::new("/openidea-test-env/outer");
        let inner = Path::new("/openidea-test-env/outer/inner");
        set(outer, vec![change("A", Some("outer"))]);
        set(inner, vec![change("A", Some("inner")), change("B", None)]);
        assert_eq!(*for_dir(&outer.join("src")), [change("A", Some("outer"))]);
        assert_eq!(*for_dir(&inner.join("src/deep")), [change("A", Some("inner")), change("B", None)]);
        assert!(for_dir(Path::new("/openidea-test-env/outer-sibling")).is_empty(), "whole components only");
        remove(inner);
        assert_eq!(*for_dir(inner), [change("A", Some("outer"))]);
        remove(outer);
        assert!(for_dir(inner).is_empty());
    }

    #[test]
    fn waiting_ends_once_the_environment_is_read() {
        let root = Path::new("/openidea-test-env/waiting");
        set(root, vec![change("OLD", Some("1"))]);
        begin_loading(root);
        assert!(is_loading(&root.join("src")));
        assert_eq!(*for_dir(root), [change("OLD", Some("1"))], "the last one read stays until then");
        let reader = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(100));
            set(Path::new("/openidea-test-env/waiting"), vec![change("NEW", Some("2"))]);
        });
        wait(&root.join("src"), &CancellationToken::new());
        assert_eq!(*for_dir(root), [change("NEW", Some("2"))]);
        reader.join().unwrap();

        begin_loading(root);
        let cancel = CancellationToken::new();
        cancel.cancel();
        wait(root, &cancel);
        settle(root);
        assert!(!is_loading(root));
        assert_eq!(*for_dir(root), [change("NEW", Some("2"))]);
        remove(root);
    }
}
