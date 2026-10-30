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
        match outcome.write_changes() {
            Some(Ok(_)) => writes.record(&repo.index_path()),
            Some(Err(e)) => tracing::debug!("could not write refreshed index: {e}"),
            None => {}
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
