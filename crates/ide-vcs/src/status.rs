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
    // Persist refreshed stat info so the next status is cheaper (like `git status` does).
    // Only when something changed: `write_changes` writes even an empty change set, and
    // the rewritten `.git/index` comes back as a VCS change that triggers the next status.
    if let Some(mut outcome) = iter.into_outcome()
        && outcome.has_changes()
        && let Some(Err(e)) = outcome.write_changes()
    {
        tracing::debug!("could not write refreshed index: {e}");
    }

    Ok(map
        .into_iter()
        .filter(|(_, e)| e.staged.is_some() || e.unstaged.is_some())
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
