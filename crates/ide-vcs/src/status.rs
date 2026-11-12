//! Working tree status via gitoxide (parallel index refresh + dirwalk).

use crate::repo::{gx, to_string};
use crate::{ChangeKind, FileStatus, Repo};
use gix::status::index_worktree::Item as WtItem;
use gix::status::plumbing::index_as_worktree::{Change as WtChange, EntryStatus};
use ide_core::IdeResult;
use ide_core::ignored::IgnoredNames;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Default)]
struct Entry {
    staged: Option<ChangeKind>,
    unstaged: Option<ChangeKind>,
    renamed_from: Option<String>,
}

pub(crate) fn status(r: &Repo) -> IdeResult<Vec<FileStatus>> {
    let ignored = r.ignored.read().unwrap_or_else(|p| p.into_inner()).clone();
    // gitoxide stops at the first IO error (a directory it may not read), where git warns
    // and lists the rest: git answers then.
    let (map, conflicts) = gix_status(r, &ignored).or_else(|e| {
        tracing::debug!("status via gitoxide failed, asking git: {}", e.message);
        cli_status(r, &ignored)
    })?;
    let mut disk = r.gix().is_ok_and(|repo| crate::repo::ignores_case(&repo)).then(DiskSpelling::default);
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
            // Untracked paths come from the disk already; tracked ones are the index's spelling.
            let path = match disk.as_mut() {
                Some(disk) if e.unstaged != Some(ChangeKind::Untracked) => disk.spell(r.root(), &rel),
                _ => None,
            };
            FileStatus {
                path: r.abs_path(path.as_deref().unwrap_or(&rel)).into(),
                rel_path: rel,
                staged: e.staged,
                unstaged: e.unstaged,
                renamed_from: e.renamed_from,
            }
        })
        .collect())
}

/// Spells repository paths the way a case-insensitive disk does, so that the tree, tabs and
/// editors (which use the disk's names) find a tracked file's status after a case-only rename.
#[derive(Default)]
struct DiskSpelling {
    /// Directory → its entries' names by ASCII-lowercased name.
    dirs: HashMap<PathBuf, HashMap<String, String>>,
}

impl DiskSpelling {
    /// `rel` as spelled on disk, `None` when it already is (or isn't there).
    fn spell(&mut self, root: &Path, rel: &str) -> Option<String> {
        let mut dir = root.to_path_buf();
        let mut parts: Vec<String> = Vec::new();
        let mut changed = false;
        let mut rest = rel.split('/').filter(|s| !s.is_empty());
        for part in rest.by_ref() {
            let names = self.dirs.entry(dir.clone()).or_insert_with(|| {
                std::fs::read_dir(&dir)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter_map(|e| e.file_name().into_string().ok())
                    .map(|name| (name.to_ascii_lowercase(), name))
                    .collect()
            });
            let Some(name) = names.get(&part.to_ascii_lowercase()).cloned() else {
                parts.push(part.to_owned());
                break;
            };
            changed |= name != part;
            dir.push(&name);
            parts.push(name);
        }
        parts.extend(rest.map(str::to_owned));
        changed.then(|| parts.join("/"))
    }
}

type Entries = (BTreeMap<String, Entry>, HashSet<String>);

fn gix_status(r: &Repo, ignored: &IgnoredNames) -> IdeResult<Entries> {
    let repo = r.gix()?;
    let mut map: BTreeMap<String, Entry> = BTreeMap::new();
    let mut conflicts: HashSet<String> = HashSet::new();

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
                        // `content_change` is `None` when only the executable bit changed:
                        // still a modification `git status` lists and `git commit` records.
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

    Ok((map, conflicts))
}

/// `git status --porcelain=v2`: what git lists, unreadable directories skipped.
/// In Restricted Mode git compares content without the repository's clean/process
/// filters and doesn't ask submodules for their own status (which runs their config).
fn cli_status(r: &Repo, ignored: &IgnoredNames) -> IdeResult<Entries> {
    let overrides = crate::cli::filter_overrides(r.root(), &ide_core::CancellationToken::new())?;
    let mut args: Vec<&str> = overrides.iter().map(String::as_str).collect();
    args.extend(["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    if !crate::execution_allowed() {
        args.push("--ignore-submodules=dirty");
    }
    let out = crate::cli::run(r.root(), &args, None)?;
    Ok(parse_porcelain_v2(&String::from_utf8_lossy(&out.stdout), ignored))
}

fn parse_porcelain_v2(out: &str, ignored: &IgnoredNames) -> Entries {
    let kind = |c: u8| match c {
        b'M' | b'T' => Some(ChangeKind::Modified),
        b'A' | b'C' => Some(ChangeKind::Added),
        b'D' => Some(ChangeKind::Deleted),
        b'R' => Some(ChangeKind::Renamed),
        _ => None,
    };
    let mut map: BTreeMap<String, Entry> = BTreeMap::new();
    let mut conflicts: HashSet<String> = HashSet::new();
    let mut records = out.split('\0');
    while let Some(record) = records.next() {
        let (tag, rest) = record.split_once(' ').unwrap_or((record, ""));
        match tag {
            // `1 XY sub mH mI mW hH hI path`, `2 … Xscore path` + NUL + the original path.
            "1" | "2" => {
                let fields = if tag == "1" { 8 } else { 9 };
                let mut parts = rest.splitn(fields, ' ');
                let xy = parts.next().unwrap_or("..").as_bytes();
                let Some(path) = parts.nth(fields - 2) else { continue };
                let e = map.entry(path.to_owned()).or_default();
                e.staged = xy.first().copied().and_then(kind);
                // Intent to add shows as `.A`; worktree renames are off, as with gitoxide.
                e.unstaged = xy.get(1).copied().and_then(kind).filter(|k| *k != ChangeKind::Renamed);
                if tag == "2" {
                    let from = records.next().unwrap_or_default();
                    if e.staged == Some(ChangeKind::Renamed) {
                        e.renamed_from = Some(from.to_owned());
                    }
                }
            }
            // `u XY sub m1 m2 m3 mW h1 h2 h3 path`
            "u" => {
                if let Some(path) = rest.splitn(10, ' ').nth(9) {
                    conflicts.insert(path.to_owned());
                    map.entry(path.to_owned()).or_default().unstaged = Some(ChangeKind::Conflicted);
                }
            }
            "?" if !rest.is_empty() && !ignored.is_ignored_path(rest) => {
                map.entry(rest.to_owned()).or_default().unstaged = Some(ChangeKind::Untracked);
            }
            _ => {}
        }
    }
    (map, conflicts)
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

    /// git's porcelain answer (used when gitoxide can't read the tree) matches gitoxide's.
    #[test]
    fn git_and_gitoxide_report_the_same_status() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.name", "Test User"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        for f in ["modified.txt", "staged.txt", "deleted.txt", "staged_del.txt", "both.txt", "conflict.txt"] {
            std::fs::write(dir.join(f), "a\n").unwrap();
        }
        std::fs::write(dir.join("rename_me.txt"), "some longer content\nthat is stable\nfor rename detection\n")
            .unwrap();
        commit_all(dir, "base");
        git(dir, &["checkout", "-q", "-b", "side"]);
        std::fs::write(dir.join("conflict.txt"), "side\n").unwrap();
        commit_all(dir, "side");
        git(dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("conflict.txt"), "main\n").unwrap();
        commit_all(dir, "main");
        let merge = Command::new("git").current_dir(dir).args(["merge", "-q", "side"]).output().unwrap();
        assert!(!merge.status.success());

        std::fs::write(dir.join("modified.txt"), "b\n").unwrap();
        std::fs::write(dir.join("staged.txt"), "b\n").unwrap();
        git(dir, &["add", "staged.txt"]);
        std::fs::remove_file(dir.join("deleted.txt")).unwrap();
        git(dir, &["rm", "-q", "staged_del.txt"]);
        std::fs::write(dir.join("both.txt"), "b\n").unwrap();
        git(dir, &["add", "both.txt"]);
        std::fs::write(dir.join("both.txt"), "c\n").unwrap();
        git(dir, &["mv", "rename_me.txt", "renamed with space.txt"]);
        std::fs::create_dir_all(dir.join("new dir")).unwrap();
        std::fs::write(dir.join("new dir/untracked.txt"), "u\n").unwrap();
        std::fs::write(dir.join("intent.txt"), "i\n").unwrap();
        git(dir, &["add", "-N", "intent.txt"]);

        let repo = Repo::discover(dir).unwrap().expect("repository found");
        let ignored = IgnoredNames::default();
        let show = |(map, conflicts): Entries| {
            let mut c: Vec<_> = conflicts.into_iter().collect();
            c.sort();
            let m: Vec<_> = map
                .into_iter()
                .map(|(k, e)| format!("{k}: {:?} {:?} {:?}", e.staged, e.unstaged, e.renamed_from))
                .collect();
            (m, c)
        };
        let from_git = show(cli_status(&repo, &ignored).unwrap());
        assert_eq!(from_git, show(gix_status(&repo, &ignored).unwrap()));
        assert!(from_git.0.iter().any(|l| l.starts_with("renamed with space.txt: Some(Renamed)")), "{from_git:?}");
        assert_eq!(from_git.1, ["conflict.txt"]);
    }

    /// A chmod-only change is a modification `git status` lists and `git commit`
    /// records, so status keeps it (#2853): hidden, the Commit view could not show
    /// or commit what a push would carry. `core.fileMode=false` reports nothing.
    #[cfg(unix)]
    #[test]
    fn a_mode_only_change_is_reported_only_when_git_tracks_modes() {
        use std::os::unix::fs::PermissionsExt;
        for file_mode in ["true", "false"] {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path();
            git(dir, &["init", "-q"]);
            git(dir, &["config", "user.name", "Test User"]);
            git(dir, &["config", "user.email", "test@example.com"]);
            git(dir, &["config", "commit.gpgsign", "false"]);
            git(dir, &["config", "core.fileMode", file_mode]);
            std::fs::write(dir.join("script.sh"), "#!/bin/sh\n").unwrap();
            commit_all(dir, "base");
            std::fs::set_permissions(dir.join("script.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();

            let repo = Repo::discover(dir).unwrap().expect("repository found");
            let status = repo.status().unwrap();
            let entry = status.iter().find(|f| f.rel_path == "script.sh");
            if file_mode == "true" {
                assert_eq!(
                    entry.and_then(|f| f.unstaged),
                    Some(ChangeKind::Modified),
                    "a mode-only change is modified"
                );
            } else {
                assert!(entry.is_none(), "core.fileMode=false hides mode changes");
            }
        }
    }

    /// git answers status when gitoxide can't read a directory; in Restricted Mode that run
    /// must not execute the repository's filters.
    #[cfg(unix)]
    #[test]
    fn restricted_status_fallback_does_not_run_repository_filters() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        git(dir, &["init", "-q"]);
        git(dir, &["config", "user.name", "Test User"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("a.txt"), "same\n").unwrap();
        commit_all(dir, "base");
        let marker = dir.join(".git/executed");
        let script = dir.join(".git/marker.sh");
        std::fs::write(&script, format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(dir, &["config", "filter.marker.clean", script.to_str().unwrap()]);
        std::fs::write(dir.join(".gitattributes"), "*.txt filter=marker\n").unwrap();
        // Same size, new mtime: git has to read (and clean) the file to tell whether it changed.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(dir.join("a.txt"), "diff\n").unwrap();

        let repo = Repo::discover(dir).unwrap().expect("repository found");
        let entries = {
            let _scope = crate::ExecutionScope::enter(false);
            cli_status(&repo, &IgnoredNames::default()).unwrap()
        };
        assert!(entries.0.contains_key("a.txt"), "the change is still listed");
        assert!(!marker.exists(), "Restricted Mode ran the repository's clean filter");
        // Control: a trusted run does use the filter, so the fixture is live.
        let _scope = crate::ExecutionScope::enter(true);
        cli_status(&repo, &IgnoredNames::default()).unwrap();
        assert!(marker.exists(), "control: git status did not run the filter");
    }
}
