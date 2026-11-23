//! Git's -x applies to the whole invocation. For mixed batches, resume the
//! queued commits after Git finishes the single pick that needed resolution.

use crate::{ApplyCommitOptions, Repo, cli, ops};
use ide_core::workflow_settings::EmptyCherryPickAction;
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::time::SystemTime;

const PLAN: &str = "openidea-cherry-pick.json";

#[derive(Clone, Copy, Default)]
pub struct CherryPickOptions<'a> {
    pub record_origin: bool,
    pub record_origin_for: &'a [String],
    pub empty_action: EmptyCherryPickAction,
}

#[derive(Clone, Serialize, Deserialize)]
struct Pick {
    commit: String,
    record_origin: bool,
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
struct Pause {
    commit: String,
    head: (Option<String>, Option<String>),
    modified: SystemTime,
}

#[derive(Serialize, Deserialize)]
struct Pending {
    pause: Pause,
    remaining: Vec<Pick>,
}

pub(crate) fn start(
    repo: &Repo,
    commits: &[String],
    options: CherryPickOptions<'_>,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<u32> {
    let ids = ops::checked_apply_commits(repo, commits, "cherry-pick")?;
    let action = options.empty_action;
    if options.record_origin_for.is_empty() {
        return ops::apply_cherry_pick(repo, &ids, options.record_origin, action, cancel, out);
    }
    let selected: HashSet<_> = commits.iter().collect();
    let origins: HashSet<_> = options.record_origin_for.iter().collect();
    if !origins.is_subset(&selected) {
        return Err(IdeError::invalid("Cherry-pick origins must be among the selected commits"));
    }
    if selected.len() == origins.len() {
        return ops::apply_cherry_pick(repo, &ids, true, action, cancel, out);
    }
    let picks: Vec<_> = commits
        .iter()
        .zip(ids)
        .map(|(original, commit)| Pick { commit, record_origin: origins.contains(original) })
        .collect();
    apply(repo, &picks, action, cancel, out)
}

pub(crate) fn resume(
    repo: &Repo,
    args: &[&str],
    edited: Option<(&str, &ApplyCommitOptions)>,
    action: EmptyCherryPickAction,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<u32> {
    let picking = args.first() == Some(&"cherry-pick");
    let pending = picking.then(|| load(repo)).flatten();
    let mut run_sequence = true;
    if let Some((message, options)) = edited {
        // Capture the pending plan first: committing removes CHERRY_PICK_HEAD.
        ops::commit_apply_message(repo, message, options, cancel, out)?;
        run_sequence = repo.git_dir.join("sequencer/todo").is_file();
    }
    let empty = if !run_sequence {
        0
    } else if picking {
        ops::apply_resolving_empty(repo, "cherry-pick", args, action, cancel, out)?
    } else {
        cli::run_streaming(repo.root(), args, cancel, out)?;
        0
    };
    match pending {
        Some(pending) => apply(repo, &pending.remaining, action, cancel, out).map(|rest| empty + rest),
        None => Ok(empty),
    }
}

fn apply(
    repo: &Repo,
    picks: &[Pick],
    action: EmptyCherryPickAction,
    cancel: &CancellationToken,
    out: &dyn Fn(String),
) -> IdeResult<u32> {
    if repo.operation()?.is_some() {
        return Err(IdeError::invalid("Another Git operation is in progress."));
    }
    clear(repo);
    let mut empty = 0;
    for (index, pick) in picks.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let head = repo.head()?;
        match ops::apply_cherry_pick(repo, std::slice::from_ref(&pick.commit), pick.record_origin, action, cancel, out)
        {
            Ok(count) => empty += count,
            Err(error) => {
                let remaining = &picks[index + 1..];
                if !remaining.is_empty()
                    && let Some(pause) = current_pause(repo)
                    && pause.commit == pick.commit
                    && pause.head == head
                {
                    save(repo, pause, remaining)?;
                }
                return Err(error);
            }
        }
    }
    Ok(empty)
}

fn current_pause(repo: &Repo) -> Option<Pause> {
    let path = repo.git_dir.join("CHERRY_PICK_HEAD");
    let modified = fs::metadata(&path).ok()?.modified().ok()?;
    let commit = fs::read_to_string(&path).ok()?.trim().to_owned();
    Some(Pause { commit, head: repo.head().ok()?, modified })
}

fn load(repo: &Repo) -> Option<Pending> {
    let pending: Pending = serde_json::from_slice(&fs::read(repo.git_dir.join(PLAN)).ok()?).ok()?;
    // The same commit can be cherry-picked later outside the IDE. Its Git
    // checkpoint must match before any previously queued picks are replayed.
    (current_pause(repo)? == pending.pause
        && pending.remaining.iter().all(|pick| gix::ObjectId::from_hex(pick.commit.as_bytes()).is_ok()))
    .then_some(pending)
}

fn save(repo: &Repo, pause: Pause, remaining: &[Pick]) -> IdeResult<()> {
    let mut file = tempfile::NamedTempFile::new_in(&repo.git_dir)?;
    serde_json::to_writer(&mut file, &(Pending { pause, remaining: remaining.to_vec() }))
        .map_err(|err| IdeError::internal(err.to_string()))?;
    file.persist(repo.git_dir.join(PLAN)).map_err(|err| err.error)?;
    Ok(())
}

pub(crate) fn clear(repo: &Repo) {
    let _ = fs::remove_file(repo.git_dir.join(PLAN));
}
