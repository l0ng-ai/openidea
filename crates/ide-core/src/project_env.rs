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
    direnv: Vec<(OsString, Option<OsString>)>,
    github_token: Option<OsString>,
    changes: Changes,
    loading: bool,
}

impl Entry {
    fn new(root: PathBuf) -> Self {
        Self { root, direnv: Vec::new(), github_token: None, changes: Changes::default(), loading: false }
    }

    fn rebuild(&mut self) {
        let mut combined = Vec::with_capacity(self.direnv.len() + usize::from(self.github_token.is_some()));
        if let Some(token) = &self.github_token {
            combined.push(("GH_TOKEN".into(), Some(token.clone())));
        }
        // `.envrc` entries override the project GitHub token when both define `GH_TOKEN`.
        combined.retain(|(k, _)| !self.direnv.iter().any(|(dk, _)| dk == k));
        combined.extend(self.direnv.iter().cloned());
        self.changes = Arc::new(combined);
    }

    fn is_idle_empty(&self) -> bool {
        !self.loading && self.direnv.is_empty() && self.github_token.is_none()
    }
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
        None => {
            let mut entry = Entry::new(root.to_path_buf());
            entry.loading = true;
            entries.push(entry);
        }
    }
}

/// What children started in `root` (or below it) get from direnv on top of the IDE's own
/// environment (`None`: removed). Ends a [`begin_loading`].
pub fn set(root: &Path, changes: Vec<(OsString, Option<OsString>)>) {
    let mut entries = entries();
    match entries.iter_mut().position(|e| e.root == root) {
        Some(idx) => {
            let entry = &mut entries[idx];
            entry.direnv = changes;
            entry.loading = false;
            entry.rebuild();
            if entry.is_idle_empty() {
                entries.remove(idx);
            }
        }
        None if !changes.is_empty() => {
            let mut entry = Entry::new(root.to_path_buf());
            entry.direnv = changes;
            entry.rebuild();
            entries.push(entry);
        }
        None => {}
    }
    SETTLED.notify_all();
}

/// Ends a [`begin_loading`] that read nothing new (an error): the last environment stays.
pub fn settle(root: &Path) {
    let mut entries = entries();
    if let Some(idx) = entries.iter().position(|e| e.root == root) {
        entries[idx].loading = false;
        if entries[idx].is_idle_empty() {
            entries.remove(idx);
        }
    }
    SETTLED.notify_all();
}

/// `root` has no direnv environment of its own any more (no `.envrc`, closed, or not trusted).
/// Preserves any project-scoped GitHub token until [`remove_all`] or [`set_github_token`].
pub fn remove(root: &Path) {
    let mut entries = entries();
    if let Some(idx) = entries.iter().position(|e| e.root == root) {
        let entry = &mut entries[idx];
        entry.direnv.clear();
        entry.loading = false;
        entry.rebuild();
        if entry.is_idle_empty() {
            entries.remove(idx);
        }
    }
    SETTLED.notify_all();
}

/// Sets or clears the project-scoped `GH_TOKEN` injected for children started in `root`
/// (unless overridden by `root`'s direnv `.envrc`). Returns whether the effective token changed.
pub fn set_github_token(root: &Path, token: Option<OsString>) -> bool {
    let token = token.filter(|t| !t.is_empty());
    let mut entries = entries();
    match entries.iter().position(|e| e.root == root) {
        Some(idx) => {
            if entries[idx].github_token == token {
                return false;
            }
            let entry = &mut entries[idx];
            entry.github_token = token;
            entry.rebuild();
            if entry.is_idle_empty() {
                entries.remove(idx);
            }
            true
        }
        None => {
            let Some(token) = token else { return false };
            let mut entry = Entry::new(root.to_path_buf());
            entry.github_token = Some(token);
            entry.rebuild();
            entries.push(entry);
            true
        }
    }
}

/// The project-scoped `GH_TOKEN` configured for the innermost project holding `dir`, if any.
pub fn github_token(dir: &Path) -> Option<OsString> {
    find(&entries(), dir).and_then(|e| e.github_token.clone())
}

/// Removes both direnv and project GitHub token entries for `root` (project closed or untrusted).
pub fn remove_all(root: &Path) {
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

    #[test]
    fn github_token_survives_direnv_absence_and_yields_to_explicit_envrc_override() {
        let root = Path::new("/openidea-test-env/gh-project");
        let worktrees = Path::new("/openidea-test-env/gh-project.worktrees");
        assert!(set_github_token(root, Some("gho_work".into())));
        assert!(!set_github_token(root, Some("gho_work".into())), "idempotent");
        assert!(set_github_token(worktrees, Some("gho_work".into())));
        remove(root); // no `.envrc` in `root`
        assert_eq!(*for_dir(&root.join("src")), [change("GH_TOKEN", Some("gho_work"))]);
        assert_eq!(*for_dir(&worktrees.join("task-1")), [change("GH_TOKEN", Some("gho_work"))]);
        assert_eq!(github_token(&worktrees.join("task-1")), Some("gho_work".into()));

        // An explicit `.envrc` GH_TOKEN overrides the project GitHub account token.
        set(root, vec![change("GH_TOKEN", Some("gho_from_envrc")), change("FOO", Some("bar"))]);
        assert_eq!(*for_dir(root), [change("GH_TOKEN", Some("gho_from_envrc")), change("FOO", Some("bar"))]);

        remove_all(root);
        remove_all(worktrees);
        assert!(for_dir(root).is_empty());
        assert!(for_dir(worktrees).is_empty());
    }
}
