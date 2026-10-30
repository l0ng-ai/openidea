//! Working tree status via gitoxide (parallel index refresh + dirwalk).

use crate::repo::{gx, to_string};
use crate::{ChangeKind, FileStatus, Repo};
use gix::status::index_worktree::Item as WtItem;
use gix::status::plumbing::index_as_worktree::{Change as WtChange, EntryStatus};
use ide_core::IdeResult;
use std::collections::{BTreeMap, HashSet};

#[derive(Default)]
struct Entry {
    staged: Option<ChangeKind>,
    unstaged: Option<ChangeKind>,
    renamed_from: Option<String>,
}

pub(crate) fn status(r: &Repo) -> IdeResult<Vec<FileStatus>> {
    let repo = r.gix()?;
    let mut map: BTreeMap<String, Entry> = BTreeMap::new();
    let mut conflicts: HashSet<String> = HashSet::new();
    let ignored = r.ignored.read().unwrap_or_else(|p| p.into_inner()).clone();

    // Stamp before status can read the index: stamping after the load could capture
    // an external `git switch`, `add` or commit's new index and allow the stale
    // snapshot to overwrite it. A change between the stamp and the read only skips
    // one stat refresh, which is safe.
    let index_path = repo.index_path();
    let opened = crate::index_writes::stamp(&index_path);
    let platform = repo
        .status(gix::progress::Discard)
        .map_err(gx)?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_rewrites(None)
        .index_worktree_submodules(gix::status::Submodule::AsConfigured { check_dirty: true })
        .tree_index_track_renames(gix::status::tree_index::TrackRenames::Given(gix::diff::Rewrites::default()));
    let mut iter = platform.into_iter(Vec::<gix::bstr::BString>::new()).map_err(gx)?;
    for item in iter.by_ref() {
        let item = item.map_err(gx)?;
        match item {
            gix::status::Item::IndexWorktree(wt) => match wt {
                WtItem::Modification { rela_path, status, .. } => {
                    let path = to_string(rela_path.as_ref());
                    let kind = match status {
                        EntryStatus::Conflict { .. } => {
                            conflicts.insert(path.clone());
                            ChangeKind::Conflicted
                        }
                        EntryStatus::Change(WtChange::Removed) => ChangeKind::Deleted,
                        EntryStatus::Change(_) => ChangeKind::Modified,
                        EntryStatus::IntentToAdd => ChangeKind::Added,
                        EntryStatus::NeedsUpdate(_) => continue,
                    };
                    map.entry(path).or_default().unstaged = Some(kind);
                }
                WtItem::DirectoryContents { entry, .. } => {
                    if entry.status != gix::dir::entry::Status::Untracked {
                        continue;
                    }
                    let mut path = to_string(entry.rela_path.as_ref());
                    if ignored.is_ignored_path(&path) {
                        continue;
                    }
                    if entry.disk_kind.is_some_and(|k| k.is_dir()) && !path.ends_with('/') {
                        path.push('/');
                    }
                    map.entry(path).or_default().unstaged = Some(ChangeKind::Untracked);
                }
                WtItem::Rewrite { dirwalk_entry, .. } => {
                    // Rewrites are disabled for index↔worktree, but stay correct if git config enables them.
                    let path = to_string(dirwalk_entry.rela_path.as_ref());
                    map.entry(path).or_default().unstaged = Some(ChangeKind::Untracked);
                }
            },
            gix::status::Item::TreeIndex(change) => {
                use gix::diff::index::ChangeRef;
                match change {
                    ChangeRef::Addition { location, .. } => {
                        map.entry(to_string(location.as_ref())).or_default().staged = Some(ChangeKind::Added);
                    }
                    ChangeRef::Deletion { location, .. } => {
                        map.entry(to_string(location.as_ref())).or_default().staged = Some(ChangeKind::Deleted);
                    }
                    ChangeRef::Modification { location, .. } => {
                        map.entry(to_string(location.as_ref())).or_default().staged = Some(ChangeKind::Modified);
                    }
                    ChangeRef::Rewrite { source_location, location, copy, .. } => {
                        let e = map.entry(to_string(location.as_ref())).or_default();
                        if copy {
                            e.staged = Some(ChangeKind::Added);
                        } else {
                            e.staged = Some(ChangeKind::Renamed);
                            e.renamed_from = Some(to_string(source_location.as_ref()));
                        }
                    }
                }
            }
        }
    }
    // Serialize write-back and identity capture with watcher queries.
    if let Some(mut outcome) = iter.into_outcome()
        && outcome.has_changes()
    {
        let mut writes = crate::index_writes::lock();
        // Another process rewrote the index while this status run was reading it
        // (a branch switch rewriting thousands of worktree files is the usual case).
        // Writing the stale snapshot back would restore the previous branch's tree,
        // so drop the refresh and let the next status re-read the current index.
        #[cfg(test)]
        run_between_read_and_write();
        if opened.still_holds(&index_path) {
            match outcome.write_changes() {
                Some(Ok(_)) => writes.record(&index_path),
                Some(Err(e)) => tracing::debug!("could not write refreshed index: {e}"),
                None => {}
            }
        } else {
            tracing::debug!("index changed during status; skipping the stat refresh write-back");
        }
    }

    Ok(map
        .into_iter()
        .filter(|(_, e)| e.staged.is_some() || e.unstaged.is_some())
        // Ignored names mean "the IDE treats these as nonexistent": hide their tracked
        // changes too, not just untracked hits above. Conflicts stay visible so merges
        // cannot stall on a file the user cannot see.
        .filter(|(rel, _)| conflicts.contains(rel) || !ignored.is_ignored_path(rel))
        .map(|(rel, mut e)| {
            if conflicts.contains(&rel) {
                e.staged = None;
                e.renamed_from = None;
                e.unstaged = Some(ChangeKind::Conflicted);
            }
            FileStatus {
                path: r.abs_path(&rel).into(),
                rel_path: rel,
                staged: e.staged,
                unstaged: e.unstaged,
                renamed_from: e.renamed_from,
            }
        })
        .collect())
}

/// Lets a test land an external index write in the window between the status run
/// reading the index and its write-back — the interleaving issue #471 describes.
#[cfg(test)]
fn run_between_read_and_write() {
    let mut hook = BETWEEN_READ_AND_WRITE.with(|h| h.borrow_mut().take());
    if let Some(hook) = hook.take() {
        hook();
    }
}

#[cfg(test)]
thread_local! {
    static BETWEEN_READ_AND_WRITE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .args(["-c", "init.defaultBranch=main", "-c", "core.autocrlf=false"])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn commit_all(dir: &Path, msg: &str) {
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", msg]);
    }

    /// #471: a status run that read the index before an external `git switch`
    /// finished must not write its stale snapshot back over the new index.
    #[test]
    fn an_external_index_write_during_status_is_not_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.name", "Test User"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("base.txt"), "base\n").unwrap();
        commit_all(dir, "base");
        // A branch that differs by a file and a deletion, so a switch rewrites the index.
        git(dir, &["checkout", "-q", "-b", "other"]);
        std::fs::write(dir.join("other.txt"), "other\n").unwrap();
        std::fs::remove_file(dir.join("base.txt")).unwrap();
        commit_all(dir, "other");
        git(dir, &["checkout", "-q", "main"]);
        // Rewrite a file with identical content: its stat info no longer matches the
        // index, so the status run refreshes it and has an index write-back to make.
        std::fs::write(dir.join("base.txt"), "base\n").unwrap();

        let repo = Repo::discover(dir).unwrap().expect("repository found");
        let switched = dir.to_path_buf();
        let hook_ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ran = hook_ran.clone();
        BETWEEN_READ_AND_WRITE.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                ran.store(true, std::sync::atomic::Ordering::SeqCst);
                git(&switched, &["switch", "-q", "--force", "other"]);
            }));
        });
        // The status result itself describes the tree as it was when it read the index
        // (base.txt still modified there); what matters is that it does not write that
        // snapshot back over the index `git switch` produced.
        repo.status().expect("status runs");
        assert!(hook_ran.load(std::sync::atomic::Ordering::SeqCst), "the external write landed mid-status");

        // The index on disk is the one `git switch` wrote: its entries match the new branch.
        let listed = Command::new("git").current_dir(dir).args(["ls-files"]).output().unwrap();
        let files = String::from_utf8_lossy(&listed.stdout);
        assert!(files.contains("other.txt"), "{files}");
        assert!(!files.contains("base.txt"), "{files}");
        // Nothing staged: HEAD and index agree.
        let staged = Command::new("git").current_dir(dir).args(["diff", "--cached", "--stat"]).output().unwrap();
        assert!(staged.stdout.is_empty(), "{}", String::from_utf8_lossy(&staged.stdout));
    }
}
