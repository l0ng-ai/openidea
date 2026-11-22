//! Whole-file conflict resolution and the original stages Git saves for undo.

use crate::cli::run;
use crate::repo::gx;
use crate::{ConflictSide, Repo, StashApplyOutcome};
use gix::bstr::BStr;
use gix::index::entry::Stage;
use ide_core::{IdeError, IdeResult};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

const CONFLICT_STAGES: [Stage; 3] = [Stage::Base, Stage::Ours, Stage::Theirs];
const RESTORE_CONFLICTS: &str = "openidea-manual-stash-conflicts.json";

#[derive(Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
pub(crate) enum RestoreConflict {
    #[default]
    ManualStash,
    AutomaticShelf,
    PatchApply,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct RestoreConflicts {
    #[serde(default)]
    kind: RestoreConflict,
    head: (Option<String>, Option<String>),
    stages: BTreeSet<String>,
}

fn unmerged_stages(repo: &Repo) -> IdeResult<BTreeSet<String>> {
    let index = run(repo.root(), &["ls-files", "--unmerged", "-z"], None)?;
    Ok(index
        .stdout
        .split(|&byte| byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| blake3::hash(entry).to_hex().to_string())
        .collect())
}

fn save_restore_conflicts(repo: &Repo, kind: RestoreConflict, stages: BTreeSet<String>) -> IdeResult<()> {
    let conflicts = RestoreConflicts { kind, head: repo.head()?, stages };
    let mut file = tempfile::NamedTempFile::new_in(&repo.git_dir)?;
    serde_json::to_writer(&mut file, &conflicts).map_err(|error| IdeError::internal(error.to_string()))?;
    file.persist(repo.git_dir.join(RESTORE_CONFLICTS)).map_err(|error| error.error)?;
    Ok(())
}

pub(crate) fn clear_restore_conflicts(repo: &Repo) {
    let _ = std::fs::remove_file(repo.git_dir.join(RESTORE_CONFLICTS));
}

pub(crate) fn record_conflicts(repo: &Repo, kind: RestoreConflict) {
    let result = unmerged_stages(repo).and_then(|stages| save_restore_conflicts(repo, kind, stages));
    if let Err(error) = result {
        tracing::warn!(?error, "could not record conflict sides");
    }
}

pub(crate) fn run_manual_unstash(repo: &Repo, args: &[&str]) -> IdeResult<StashApplyOutcome> {
    let _guard = repo.conflict_mutation.lock().unwrap_or_else(|error| error.into_inner());
    let fresh = crate::write::unmerged_paths(repo)?.is_empty();
    if fresh {
        clear_restore_conflicts(repo);
    }
    match run(repo.root(), args, None) {
        Ok(_) => Ok(StashApplyOutcome::Done),
        Err(error) if fresh => {
            let Ok(stages) = unmerged_stages(repo) else { return Err(error) };
            if stages.is_empty() {
                return Err(error);
            }
            if let Err(error) = save_restore_conflicts(repo, RestoreConflict::ManualStash, stages) {
                tracing::warn!(?error, "could not record manual stash conflicts");
            }
            Ok(StashApplyOutcome::Conflicts { repository: repo.root().into() })
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn restore_conflict(repo: &Repo) -> IdeResult<Option<RestoreConflict>> {
    let Ok(bytes) = std::fs::read(repo.git_dir.join(RESTORE_CONFLICTS)) else { return Ok(None) };
    let Ok(conflicts) = serde_json::from_slice::<RestoreConflicts>(&bytes) else { return Ok(None) };
    if conflicts.head != repo.head()? {
        return Ok(None);
    }
    // Resolving a file removes its stages from the index. The remaining files
    // keep the same side labels as long as their original stages still match.
    let stages = unmerged_stages(repo)?;
    Ok((!stages.is_empty() && stages.is_subset(&conflicts.stages)).then_some(conflicts.kind))
}

pub(crate) fn accept_side(repo: &Repo, paths: &[PathBuf], side: ConflictSide) -> IdeResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let _guard = repo.conflict_mutation.lock().unwrap_or_else(|e| e.into_inner());
    let ours = (side == ConflictSide::Ours) != repo.merge_sides()?.reversed;
    let (stage, option) = if ours { (Stage::Ours, "--ours") } else { (Stage::Theirs, "--theirs") };
    let git = repo.gix()?;
    let index = git.open_index().map_err(gx)?;
    let paths = paths.iter().map(|path| repo.rel_path(path)).collect::<IdeResult<BTreeSet<_>>>()?;
    let mut kept = Vec::new();
    let mut deleted = Vec::new();
    for path in paths {
        let key = BStr::new(path.as_bytes());
        if let Some(entry) = index.entry_by_path_and_stage(key, stage) {
            kept.push((path, entry.mode, entry.id));
        } else if CONFLICT_STAGES.iter().any(|&s| index.entry_by_path_and_stage(key, s).is_some()) {
            deleted.push(path);
        } else {
            return Err(IdeError::invalid(format!("{path} has no conflict to resolve")));
        }
    }

    let present: Vec<_> = kept.iter().map(|(path, _, _)| path.clone()).collect();
    checkout(repo, option, &present)?;
    run_literal_paths(repo, &["rm", "--sparse", "--ignore-unmatch"], &deleted)?;
    if !kept.is_empty() {
        let current = git.open_index().map_err(gx)?;
        let mut records = Vec::new();
        for (path, mode, id) in kept {
            let entry = current.entry_by_path_and_stage(BStr::new(path.as_bytes()), stage);
            if !entry.is_some_and(|entry| entry.mode == mode && entry.id == id) {
                return Err(IdeError::invalid(format!("the conflict in {path} changed while resolving it")));
            }
            // Stage the exact blob and mode. Replacing the unmerged entries this way
            // makes Git retain their original stages for Revert Resolved.
            records.extend_from_slice(format!("{:o} {id}\t{path}\0", mode.bits()).as_bytes());
        }
        run(repo.root(), &["update-index", "-z", "--index-info"], Some(&records))?;
    }
    Ok(())
}

struct SavedStage {
    mode: String,
    id: String,
    stage: u8,
}

fn saved_resolutions(repo: &Repo) -> IdeResult<BTreeMap<String, Vec<SavedStage>>> {
    let objects = repo.gix()?;
    let mut resolutions = BTreeMap::<String, Vec<SavedStage>>::new();
    if !matches!(
        crate::refs::operation(&objects).as_deref(),
        Some("merge" | "rebase" | "revert" | "cherry-pick" | "am")
    ) {
        return Ok(resolutions);
    }
    let index = objects.index_or_empty().map_err(gx)?;
    if index.resolve_undo().is_none() {
        return Ok(resolutions);
    }
    let listed = run(repo.root(), &["ls-files", "--resolve-undo", "-z"], None)?;
    for entry in listed.stdout.split(|&b| b == 0).filter_map(|entry| std::str::from_utf8(entry).ok()) {
        let Some((info, path)) = entry.split_once('\t') else { continue };
        let path_key = BStr::new(path.as_bytes());
        if CONFLICT_STAGES.iter().any(|stage| index.entry_by_path_and_stage(path_key, *stage).is_some()) {
            continue;
        }
        let mut fields = info.split_ascii_whitespace();
        if let (Some(mode), Some(id), Some(Ok(stage @ 1..=3))) =
            (fields.next(), fields.next(), fields.next().map(str::parse::<u8>))
        {
            resolutions.entry(path.to_string()).or_default().push(SavedStage {
                mode: mode.to_string(),
                id: id.to_string(),
                stage,
            });
        }
    }
    Ok(resolutions)
}

pub(crate) fn resolved_paths(repo: &Repo) -> IdeResult<Vec<PathBuf>> {
    Ok(saved_resolutions(repo)?.into_keys().map(|path| repo.abs_path(&path)).collect())
}

pub(crate) fn revert_resolved(repo: &Repo, paths: &[PathBuf]) -> IdeResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let _guard = repo.conflict_mutation.lock().unwrap_or_else(|e| e.into_inner());
    let paths = paths.iter().map(|path| repo.rel_path(path)).collect::<IdeResult<BTreeSet<_>>>()?;
    let resolutions = saved_resolutions(repo)?;
    if let Some(path) = paths.iter().find(|path| !resolutions.contains_key(*path)) {
        return Err(IdeError::invalid(format!("{path} has no resolution to revert")));
    }
    let mut merge = Vec::new();
    let mut ours = Vec::new();
    let mut theirs = Vec::new();
    let mut index_info = Vec::new();
    let zero = repo.gix()?.object_hash().null();
    for path in paths {
        let stages = &resolutions[&path];
        let has_ours = stages.iter().any(|s| s.stage == 2);
        let has_theirs = stages.iter().any(|s| s.stage == 3);
        if has_ours && has_theirs {
            merge.push(path);
        } else {
            // Checkout --merge needs both sides. For modify/delete, restore the
            // saved index stages and check out the surviving side.
            index_info.extend_from_slice(format!("0 {zero}\t{path}\0").as_bytes());
            for stage in stages {
                let SavedStage { mode, id, stage } = stage;
                index_info.extend_from_slice(format!("{mode} {id} {stage}\t{path}\0").as_bytes());
            }
            if has_ours {
                ours.push(path);
            } else if has_theirs {
                theirs.push(path);
            }
        }
    }
    checkout(repo, "--merge", &merge)?;
    if !index_info.is_empty() {
        run(repo.root(), &["update-index", "-z", "--index-info"], Some(&index_info))?;
        checkout(repo, "--ours", &ours)?;
        checkout(repo, "--theirs", &theirs)?;
    }
    Ok(())
}

fn checkout(repo: &Repo, option: &str, paths: &[String]) -> IdeResult<()> {
    run_literal_paths(repo, &["checkout", option, "--no-recurse-submodules", "--ignore-skip-worktree-bits"], paths)
}

fn run_literal_paths(repo: &Repo, command: &[&str], paths: &[String]) -> IdeResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut pathspec = paths.join("\0").into_bytes();
    pathspec.push(0);
    let mut args = vec!["--literal-pathspecs"];
    args.extend_from_slice(command);
    args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    run(repo.root(), &args, Some(&pathspec))?;
    Ok(())
}
