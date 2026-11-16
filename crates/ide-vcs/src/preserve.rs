//! Local changes put aside around merge, rebase and pull, and brought back once the
//! operation is over: staged changes as staged (git's `--autostash` brings everything
//! back unstaged). An operation that stops on conflicts keeps them aside until it is
//! continued, skipped, aborted or concluded by a commit.

use crate::Repo;
use crate::cli::{self, run};
use crate::write::unmerged_paths;
use ide_core::{IdeError, IdeResult};

/// `.git/<MARKER>` holds the id of the stash the changes went to.
const MARKER: &str = "openidea-saved-changes";

/// Stashes the local changes of tracked files, if any.
pub(crate) fn save(r: &Repo, message: &str) -> IdeResult<()> {
    let marker = r.git_dir.join(MARKER);
    if marker.exists() {
        // Changes saved by an operation still in progress stay where they are; those of
        // one concluded outside the IDE come back first.
        if r.branch_info()?.operation.is_some() {
            return Ok(());
        }
        restore(r)?;
    }
    if run(r.root(), &["status", "--porcelain", "--untracked-files=no"], None)?.stdout_str().trim().is_empty() {
        return Ok(());
    }
    let before = stash_top(r);
    run(r.root(), &["stash", "push", "-q", "-m", message], None)?;
    // A stash that succeeds without a new entry found nothing it saves: the status above also
    // lists submodules at another commit or with changes inside, which a stash leaves in place.
    let Some(id) = stash_top(r).filter(|id| Some(id) != before.as_ref()) else { return Ok(()) };
    std::fs::write(marker, id)?;
    Ok(())
}

fn stash_top(r: &Repo) -> Option<String> {
    run(r.root(), &["rev-parse", "-q", "--verify", "refs/stash"], None).ok().map(|o| o.stdout_str().trim().to_owned())
}

/// Brings the saved changes back once no operation is in progress. Fails when they come
/// back with conflicts (they then also stay in the stash).
pub(crate) fn restore(r: &Repo) -> IdeResult<()> {
    let marker = r.git_dir.join(MARKER);
    let Ok(saved) = std::fs::read_to_string(&marker) else { return Ok(()) };
    if r.branch_info()?.operation.is_some() {
        return Ok(());
    }
    let _ = std::fs::remove_file(&marker);
    let saved = saved.trim();
    let stashes = run(r.root(), &["stash", "list", "--format=%H"], None)?.stdout_str();
    let Some(index) = stashes.lines().position(|id| id.trim() == saved) else { return Ok(()) };
    let entry = format!("stash@{{{index}}}");
    if cli::run_raw(r.root(), &["stash", "pop", "-q", "--index", &entry], None)?.code == Some(0) {
        return Ok(());
    }
    // The staged part no longer applies as it was: bring everything back unstaged.
    if unmerged_paths(r)?.is_empty() && cli::run_raw(r.root(), &["stash", "pop", "-q", &entry], None)?.code == Some(0) {
        return Ok(());
    }
    Err(IdeError::invalid("local changes were restored with conflicts; resolve them (a copy stays in the stash)"))
}

/// Runs `op` with the local changes put aside, and brings them back if it finished.
pub(crate) fn around<T>(r: &Repo, message: &str, op: impl FnOnce() -> IdeResult<T>) -> IdeResult<T> {
    save(r, message)?;
    let result = op();
    let restored = restore(r);
    let value = result?;
    restored.map(|_| value)
}
