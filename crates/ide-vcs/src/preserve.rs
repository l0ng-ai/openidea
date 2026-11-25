//! Local changes put aside around checkout, merge, rebase and pull, and brought back once the
//! operation is over: staged changes as staged (git's `--autostash` brings everything
//! back unstaged). An operation that stops on conflicts keeps them aside until it is
//! continued, skipped, aborted or concluded by a commit.

use crate::cli::{self, run};
use crate::shelf::SavedShelves;
use crate::write::{drop_restored_stash, selected_stash_index, unmerged_paths};
use crate::{Repo, Stash};
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;

/// `.git/<MARKER>` holds the saved entry to restore. Older versions stored only a stash commit id.
const MARKER: &str = "openidea-saved-changes";

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum Saved {
    Shelves(SavedShelves),
    Shelf { directory: PathBuf, entry: String, snapshot: String },
    Stash(Stash),
}

/// Saves the local changes of tracked files, if any.
pub(crate) fn save(r: &Repo, message: &str) -> IdeResult<()> {
    let _stash_lock = crate::write::lock_stashes(r)?;
    save_locked(r, message).map(|_| ())
}

fn save_locked(r: &Repo, message: &str) -> IdeResult<Option<Saved>> {
    if r.git_dir.join(MARKER).exists() {
        // Changes saved by an operation still in progress stay where they are; those of
        // one concluded outside the IDE come back first.
        restore_saved(r, None)?;
        if r.git_dir.join(MARKER).exists() {
            return Ok(None);
        }
    }
    if run(r.root(), &["status", "--porcelain", "--untracked-files=no"], None)?.stdout_str().trim().is_empty() {
        return Ok(None);
    }
    let Some(stash) = stash_local_changes(r, message)? else { return Ok(None) };
    let saved = Saved::Stash(stash);
    write_marker(r, &saved)?;
    let options = r.automatic_shelf.read().unwrap_or_else(|poison| poison.into_inner()).clone();
    let (Some(options), Saved::Stash(stash)) = (options, &saved) else { return Ok(Some(saved)) };
    let shelves = match crate::shelf::capture_stash(r, options, message, stash) {
        Ok(shelves) => Saved::Shelves(shelves),
        Err(error) => return Err(rolled_back(error, restore_entry(r, saved, false))),
    };
    if let Err(error) = write_marker(r, &shelves) {
        if let Saved::Shelves(entries) = &shelves {
            entries.discard();
        }
        return Err(rolled_back(error, restore_entry(r, saved, false)));
    }
    if let Err(error) = selected_stash_index(r, stash)
        .and_then(|index| index.map_or(Ok(()), |index| crate::write::stash_drop(r, index)))
    {
        return Err(rolled_back(error, restore_entry(r, shelves, false)));
    }
    Ok(Some(shelves))
}

/// The error that stopped saving, with the rollback's error when that failed too.
fn rolled_back<T>(error: IdeError, rollback: IdeResult<T>) -> IdeError {
    match rollback {
        Ok(_) => error,
        Err(rollback) => IdeError::invalid(format!("{}\n{}", error.message, rollback.message)),
    }
}

fn write_marker(r: &Repo, saved: &Saved) -> IdeResult<()> {
    let saved = serde_json::to_vec(saved).map_err(|e| IdeError::internal(e.to_string()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(&r.git_dir)?;
    temporary.write_all(&saved)?;
    temporary.persist(r.git_dir.join(MARKER)).map_err(|error| error.error)?;
    Ok(())
}

/// Separates a failed switch from a failed restore after a successful switch.
pub(crate) fn checkout(
    r: &Repo,
    message: &str,
    switch: impl FnOnce() -> IdeResult<()>,
) -> IdeResult<IdeResult<Vec<String>>> {
    let _stash_lock = crate::write::lock_stashes(r)?;
    let saved = save_locked(r, message)?.ok_or_else(|| {
        IdeError::invalid(if r.git_dir.join(MARKER).exists() {
            "Local changes from an unfinished Git operation are still put aside. Finish or abort it first."
        } else {
            "could not save the local changes"
        })
    })?;
    let switched = switch();
    if switched.is_ok()
        && matches!(&saved, Saved::Shelves(shelves) if shelves.batch.as_deref().is_some_and(crate::shelf::is_active_batch))
    {
        return Ok(Ok(Vec::new()));
    }
    let restored = restore_entry(r, saved, switched.is_ok());
    match (switched, restored) {
        (Ok(()), restored) => Ok(restored),
        (Err(switch), Err(restore)) => Err(IdeError::invalid(format!("{}\n{}", switch.message, restore.message))),
        (Err(error), Ok(_)) => Err(error),
    }
}

// The caller holds the common stash lock until the new entry is identified.
fn stash_local_changes(r: &Repo, message: &str) -> IdeResult<Option<Stash>> {
    let previous = r.stashes()?.into_iter().next();
    let output = run(r.root(), &["stash", "push", "-m", message], None)?.stdout_str();
    // A stash that succeeds without a new entry found nothing it saves: the status above also
    // lists submodules at another commit or with changes inside, which a stash leaves in place.
    if output.lines().any(|line| line == "No local changes to save") {
        return Ok(None);
    }
    crate::conflict_resolution::clear_restore_conflicts(r);
    let error = || IdeError::invalid("Could not identify the stash containing the saved local changes");
    let message = output
        .lines()
        .find_map(|line| line.strip_prefix("Saved working directory and index state "))
        .ok_or_else(error)?;
    let mut matches = r
        .stashes()?
        .into_iter()
        .take_while(|stash| previous.as_ref().is_none_or(|prev| !prev.same_entry(stash)))
        .filter(|stash| stash.message == message);
    let stash = matches.next().ok_or_else(error)?;
    if matches.next().is_some() {
        return Err(error());
    }
    Ok(Some(stash))
}

fn apply_snapshot(r: &Repo, snapshot: &str, allow_unstaged: bool) -> IdeResult<Vec<String>> {
    let with_index = ["stash", "apply", "-q", "--index", snapshot];
    let mut out = cli::run_raw(r.root(), &with_index, None)?;
    if out.code != Some(0) {
        let conflicts = unmerged_paths(r)?;
        if !conflicts.is_empty() {
            return Ok(conflicts);
        }
        if !allow_unstaged {
            return Err(cli::failure(&with_index, &out.stderr, &out.stdout, out.code));
        }
        let staged = merge_saved_index(r, snapshot).unwrap_or_else(|error| {
            tracing::debug!(%error, "cannot merge saved index");
            None
        });
        let args = ["stash", "apply", "-q", snapshot];
        out = cli::run_raw(r.root(), &args, None)?;
        if out.code != Some(0) {
            let conflicts = unmerged_paths(r)?;
            return if conflicts.is_empty() {
                Err(cli::failure(&args, &out.stderr, &out.stdout, out.code))
            } else {
                Ok(conflicts)
            };
        }
        if let Some((before, merged)) = staged {
            // Update only the index, keeping unrelated entries and the merged working copy.
            run(r.root(), &["read-tree", "-m", "-i", &before, &merged], None)?;
        }
    }
    Ok(Vec::new())
}

/// `stash apply --index` applies a patch without a three-way fallback. The patch
/// can fail on context even when both the staged and working changes merge cleanly.
fn merge_saved_index(r: &Repo, snapshot: &str) -> IdeResult<Option<(String, String)>> {
    let base = format!("{snapshot}^1");
    let saved = format!("{snapshot}^2");
    let patch = crate::patch::shelf_tree_patch_with_prefix(r, &base, &saved, "")?;
    if patch.is_empty() {
        return Ok(None);
    }
    let before = run(r.root(), &["write-tree"], None)?.stdout_str().trim().to_owned();
    let index = cli::TempIndex::new(r);
    let env = index.env();
    cli::run_env(r.root(), &["read-tree", &before], None, &env)?;
    cli::run_env(r.root(), &["apply", "--cached", "--3way", "--whitespace=nowarn", "-"], Some(patch.as_bytes()), &env)?;
    let merged = cli::run_env(r.root(), &["write-tree"], None, &env)?.stdout_str().trim().to_owned();
    Ok((before != merged).then_some((before, merged)))
}

fn restore_entry(r: &Repo, saved: Saved, allow_unstaged: bool) -> IdeResult<Vec<String>> {
    std::fs::remove_file(r.git_dir.join(MARKER))?;
    match saved {
        Saved::Stash(stash) => {
            let conflicts = apply_snapshot(r, &stash.id, allow_unstaged)?;
            if conflicts.is_empty() {
                drop_restored_stash(r, &stash)?;
            }
            Ok(conflicts)
        }
        Saved::Shelf { directory, entry, snapshot } => {
            let restored = restore_shelf(r, &directory, &entry, &snapshot, allow_unstaged);
            if restored.as_ref().is_ok_and(|files| !files.is_empty()) {
                crate::conflict_resolution::record_conflicts(
                    r,
                    crate::conflict_resolution::RestoreConflict::AutomaticShelf,
                );
            }
            restored
        }
        Saved::Shelves(shelves) => {
            let restored = restore_shelves(r, &shelves, allow_unstaged);
            if restored.is_ok() {
                shelves.remove_archive();
            }
            if restored.as_ref().is_ok_and(|files| !files.is_empty()) {
                crate::conflict_resolution::record_conflicts(
                    r,
                    crate::conflict_resolution::RestoreConflict::AutomaticShelf,
                );
            }
            restored
        }
    }
}

fn restore_shelves(r: &Repo, shelves: &SavedShelves, allow_unstaged: bool) -> IdeResult<Vec<String>> {
    let pending = shelves.pending()?;
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    let owned: Vec<_> = pending.iter().map(|entry| crate::patch::parse_patch(&entry.patch)).collect();
    if owned.iter().any(Vec::is_empty) {
        return Err(IdeError::invalid("no file changes found in the patch"));
    }
    shelves.unpack(r)?;
    let conflicts = if pending.len() == shelves.entries.len() && pending.iter().all(|entry| entry.intact) {
        apply_snapshot(r, &shelves.snapshot, allow_unstaged)?
    } else {
        let patch: String = pending.iter().map(|entry| entry.patch.as_str()).collect();
        restore_selected(r, &shelves.snapshot, &patch, &shelves.prefix, allow_unstaged)?
    };
    let local = |file: &crate::PatchFile| file.path.strip_prefix(&shelves.prefix).unwrap_or(&file.path).to_owned();
    let owned: Vec<_> = owned.iter().map(|files| files.iter().map(local).collect::<Vec<_>>()).collect();
    // A rename conflict may have a path that does not appear in any original shelf.
    if conflicts.iter().all(|path| owned.iter().flatten().any(|file| file == path)) {
        for (entry, files) in pending.iter().zip(owned) {
            if files.iter().all(|file| !conflicts.contains(file)) {
                crate::shelf::delete(&shelves.directory, &entry.id)?;
            }
        }
    }
    Ok(conflicts)
}

/// Keep the index state of the remaining files when a shelf or some of its paths were removed.
fn restore_selected(
    r: &Repo,
    snapshot: &str,
    patch: &str,
    prefix: &str,
    allow_unstaged: bool,
) -> IdeResult<Vec<String>> {
    let base = format!("{snapshot}^1");
    let working = crate::patch::shelf_tree_patch_with_prefix(r, &base, snapshot, prefix)?;
    let staged = crate::patch::shelf_tree_patch_with_prefix(r, &base, &format!("{snapshot}^2"), prefix)?;
    let originals: HashMap<_, _> = crate::patch::sections(&staged)
        .into_iter()
        .chain(crate::patch::sections(&working))
        .map(|(section, file)| (file.path, section))
        .collect();
    let selected = crate::patch::sections(patch);
    if selected.iter().any(|(section, file)| originals.get(&file.path) != Some(section)) {
        return Ok(crate::patch::apply_with_prefix(r, patch, prefix)?.conflicts);
    }
    let paths: HashSet<_> = selected.into_iter().map(|(_, file)| file.path).collect();
    let select = |source: &str| -> String {
        crate::patch::sections(source)
            .into_iter()
            .filter(|(_, file)| paths.contains(&file.path))
            .map(|(section, _)| section)
            .collect()
    };
    let indexed = snapshot_tree(r, &base, &select(&staged), prefix)?;
    let worktree = snapshot_tree(r, &base, &select(&working), prefix)?;
    let commit = |tree: &str, parents: &[&str]| -> IdeResult<String> {
        let mut args = vec![
            "-c",
            "user.name=OpenIDEA",
            "-c",
            "user.email=openidea@localhost",
            "commit-tree",
            tree,
            "--no-gpg-sign",
            "-m",
            "Saved local changes",
        ];
        for parent in parents {
            args.extend(["-p", parent]);
        }
        Ok(run(r.root(), &args, None)?.stdout_str().trim().to_owned())
    };
    let indexed = commit(&indexed, &[&base])?;
    let snapshot = commit(&worktree, &[&base, &indexed])?;
    apply_snapshot(r, &snapshot, allow_unstaged)
}

fn snapshot_tree(r: &Repo, base: &str, patch: &str, prefix: &str) -> IdeResult<String> {
    let index = cli::TempIndex::new(r);
    let env = index.env();
    cli::run_env(r.root(), &["read-tree", base], None, &env)?;
    if !patch.is_empty() {
        let strip = crate::patch::strip_option(prefix);
        let mut args = vec!["apply", "--cached", "--binary", "--whitespace=nowarn"];
        args.extend(strip.as_deref());
        args.push("-");
        cli::run_env(r.root(), &args, Some(patch.as_bytes()), &env)?;
    }
    Ok(cli::run_env(r.root(), &["write-tree"], None, &env)?.stdout_str().trim().to_owned())
}

fn restore_shelf(
    r: &Repo,
    directory: &std::path::Path,
    entry: &str,
    snapshot: &str,
    allow_unstaged: bool,
) -> IdeResult<Vec<String>> {
    match crate::shelf::pending_snapshot(directory, entry, snapshot)? {
        None => Ok(Vec::new()),
        Some(false) => Ok(crate::shelf::unshelve(r, directory, entry, true)?.conflicts),
        Some(true) => {
            crate::shelf::materialize_snapshot(r, directory, entry)?;
            let conflicts = apply_snapshot(r, snapshot, allow_unstaged)?;
            if conflicts.is_empty() {
                crate::shelf::delete(directory, entry)?;
            }
            Ok(conflicts)
        }
    }
}

/// Brings the saved changes back once no operation is in progress. Fails when they come
/// back with conflicts (they then also stay in the stash).
pub(crate) fn restore(r: &Repo) -> IdeResult<()> {
    restore_locked(r, None)
}

pub(crate) fn finish_batch(r: &Repo, batch: &str) -> IdeResult<()> {
    restore_locked(r, Some(batch))
}

fn restore_locked(r: &Repo, batch: Option<&str>) -> IdeResult<()> {
    if !r.git_dir.join(MARKER).exists() {
        return Ok(());
    }
    let _stash_lock = crate::write::lock_stashes(r)?;
    restore_saved(r, batch)
}

fn restore_saved(r: &Repo, batch: Option<&str>) -> IdeResult<()> {
    let marker = r.git_dir.join(MARKER);
    let saved = match std::fs::read_to_string(&marker) {
        Ok(saved) => saved,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if r.operation()?.is_some() || !unmerged_paths(r)?.is_empty() {
        return Ok(());
    }
    let saved = saved.trim();
    let parsed = if saved.starts_with('{') {
        Some(serde_json::from_str::<Saved>(saved).map_err(|e| IdeError::internal(e.to_string()))?)
    } else {
        None
    };
    let saved_batch = match &parsed {
        Some(Saved::Shelves(shelves)) => shelves.batch.as_deref(),
        _ => None,
    };
    let restore = match batch {
        Some(batch) => saved_batch == Some(batch),
        None => !saved_batch.is_some_and(crate::shelf::is_active_batch),
    };
    if !restore {
        return Ok(());
    }
    let saved = match parsed {
        Some(Saved::Stash(stash)) => selected_stash_index(r, &stash)?.map(|_| Saved::Stash(stash)),
        Some(shelf) => Some(shelf),
        None => {
            let mut matches = r.stashes()?.into_iter().filter(|stash| stash.id == saved);
            let stash = matches.next();
            if matches.next().is_some() {
                return Err(IdeError::invalid("Could not identify the stash containing the saved local changes"));
            }
            stash.map(Saved::Stash)
        }
    };
    let Some(saved) = saved else {
        std::fs::remove_file(marker)?;
        return Ok(());
    };
    let message = match &saved {
        Saved::Stash(_) => "local changes were restored with conflicts; resolve them (a copy stays in the stash)",
        Saved::Shelf { .. } | Saved::Shelves(_) => {
            "Local changes were restored with conflicts. A copy stays on the Shelf."
        }
    };
    if !restore_entry(r, saved, true)?.is_empty() {
        return Err(IdeError::invalid(message));
    }
    Ok(())
}

/// Runs `op` with the local changes put aside, and brings them back if it finished.
pub(crate) fn around<T>(r: &Repo, message: &str, op: impl FnOnce() -> IdeResult<T>) -> IdeResult<T> {
    save(r, message)?;
    let result = op();
    let restored = restore(r);
    let value = result?;
    restored.map(|_| value)
}
