//! HEAD, branches, upstream tracking and stashes via gitoxide.

use crate::repo::{gx, to_string};
use crate::{Branch, BranchInfo, HistoryTip, RebaseState, Repo, Stash, TrackedTip, UpstreamTracking};
use gix::bstr::ByteSlice;
use ide_core::IdeResult;
use std::io::{BufRead, BufReader};

// Filter symbolic refs before shortening; `refname:short` also strips remote `/HEAD` suffixes.
pub(crate) const DIRECT_BRANCH_FORMAT: &str = "--format=%(if)%(symref)%(then)%(else)%(refname:lstrip=2)%(end)";

pub(crate) fn branch_info(r: &Repo) -> IdeResult<BranchInfo> {
    let repo = r.gix()?;
    let head_ref = repo.head_name().map_err(gx)?;
    let head = head_ref.as_ref().map(|n| to_string(n.as_ref().shorten()));
    let head_commit = repo.head_id().ok().map(|id| id.detach());
    let upstream_tracking = head_ref.as_ref().and_then(|name| configured_upstream(&repo, name.as_ref()));
    let mut info = BranchInfo {
        head,
        head_commit: head_commit.map(|id| id.to_string()),
        upstream: None,
        upstream_tracking,
        tracked_tip: None,
        ahead: 0,
        behind: 0,
        outgoing: None,
        operation: operation(&repo),
        rebase: None,
    };
    if info.operation.as_deref() == Some("rebase") {
        info.rebase = rebase_state(repo.path());
    }
    let mut counted_upstream = None;
    if let Some(name) = head_ref.as_ref()
        && let Some((upstream_name, upstream_id)) = upstream_of(&repo, name.as_ref())
    {
        info.upstream = Some(upstream_name);
        info.tracked_tip =
            info.upstream_tracking.clone().map(|tracking| TrackedTip { tracking, commit: upstream_id.to_string() });
        if let Some(local) = head_commit {
            let (a, b) = ahead_behind(&repo, local, upstream_id)?;
            info.ahead = a;
            info.behind = b;
            counted_upstream = Some((upstream_id, a));
        }
    }
    if let (Some(name), Some(local)) = (head_ref.as_ref(), head_commit) {
        info.outgoing =
            crate::push_preview::outgoing_commits(&repo, &repo.remote_names(), name.as_ref(), local, counted_upstream);
    }
    Ok(info)
}

pub(crate) fn rebase_dir(git_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    ["rebase-merge", "rebase-apply"].into_iter().map(|dir| git_dir.join(dir)).find(|dir| dir.is_dir())
}

fn rebase_state(git_dir: &std::path::Path) -> Option<RebaseState> {
    let dir = rebase_dir(git_dir)?;
    let read = |name| std::fs::read_to_string(dir.join(name)).ok().map(|value| value.trim().to_owned());
    let branch = read("head-name")?.strip_prefix("refs/heads/").map(str::to_owned);
    Some(RebaseState { original: HistoryTip { branch, commit: read("orig-head")? }, onto: read("onto")? })
}

pub(crate) fn head(repo: &gix::Repository) -> IdeResult<(Option<String>, Option<String>)> {
    let name = repo.head_name().map_err(gx)?.map(|n| to_string(n.as_ref().shorten()));
    Ok((name, repo.head_id().ok().map(|id| id.to_string())))
}

pub(crate) fn operation(repo: &gix::Repository) -> Option<String> {
    use gix::state::InProgress::*;
    let op = match repo.state() {
        Some(ApplyMailbox | ApplyMailboxRebase) => "am",
        Some(Bisect) => "bisect",
        Some(CherryPick | CherryPickSequence) => "cherry-pick",
        Some(Merge) => "merge",
        Some(Rebase | RebaseInteractive) => "rebase",
        Some(Revert | RevertSequence) => "revert",
        None => {
            // Committing a resolved step can clear its HEAD marker while Git still has a todo.
            let path = repo.path().join("sequencer/todo");
            if !path.is_file() {
                return None;
            }
            let mut first = String::new();
            BufReader::new(std::fs::File::open(path).ok()?).read_line(&mut first).ok()?;
            match first.split_whitespace().next()? {
                "pick" => "cherry-pick",
                "revert" => "revert",
                _ => return None,
            }
        }
    };
    Some(op.to_string())
}

/// Short upstream name (`origin/main`) and its commit. A branch whose tracking ref is gone (the
/// remote branch was deleted and pruned) tracks nothing, as in IDEA.
pub(crate) fn upstream_of(repo: &gix::Repository, branch: &gix::refs::FullNameRef) -> Option<(String, gix::ObjectId)> {
    let tracking = repo.branch_remote_tracking_ref_name(branch, gix::remote::Direction::Fetch)?.ok()?;
    let id = repo.try_find_reference(tracking.as_ref()).ok()??.peel_to_id().ok()?.detach();
    Some((to_string(tracking.as_ref().shorten()), id))
}

pub(crate) fn configured_upstream(repo: &gix::Repository, name: &gix::refs::FullNameRef) -> Option<UpstreamTracking> {
    let direction = gix::remote::Direction::Fetch;
    let remote = repo.branch_remote_name(name.shorten(), direction)?;
    let branch = repo.branch_remote_ref_name(name, direction)?.ok()?;
    let branch = branch.as_bstr().strip_prefix(b"refs/heads/")?.as_bstr();
    (remote.as_bstr() != ".")
        .then(|| UpstreamTracking { remote: to_string(remote.as_bstr()), branch: to_string(branch) })
}

/// Commits in `local` not in `upstream`, and vice versa.
pub(crate) fn ahead_behind(
    repo: &gix::Repository,
    local: gix::ObjectId,
    upstream: gix::ObjectId,
) -> IdeResult<(u32, u32)> {
    if local == upstream {
        return Ok((0, 0));
    }
    Ok((count_commits(repo, local, upstream)?, count_commits(repo, upstream, local)?))
}

pub(crate) fn count_commits(repo: &gix::Repository, tip: gix::ObjectId, hide: gix::ObjectId) -> IdeResult<u32> {
    let walk = repo.rev_walk([tip]).with_hidden([hide]).all().map_err(gx)?;
    let mut n = 0u32;
    for info in walk {
        info.map_err(gx)?;
        n += 1;
    }
    Ok(n)
}

fn commit_time_ms(repo: &gix::Repository, id: gix::ObjectId) -> f64 {
    repo.find_commit(id).ok().and_then(|c| c.time().ok()).map(|t| t.seconds as f64 * 1000.0).unwrap_or(0.0)
}

pub(crate) fn branches(r: &Repo) -> IdeResult<Vec<Branch>> {
    let repo = r.gix()?;
    let head_name = repo.head_name().map_err(gx)?;
    let platform = repo.references().map_err(gx)?;
    let remotes = repo.remote_names();
    let mut out = Vec::new();

    for reference in platform.local_branches().map_err(gx)? {
        let mut reference = reference.map_err(gx)?;
        if reference.target().try_name().is_some() {
            continue;
        }
        let full = reference.name().to_owned();
        let Ok(id) = reference.peel_to_id().map(|id| id.detach()) else { continue };
        let current = head_name.as_ref().is_some_and(|h| h == &full);
        let mut branch = Branch {
            name: to_string(full.as_ref().shorten()),
            remote: false,
            current,
            upstream: None,
            tracked_tip: None,
            ahead: 0,
            behind: 0,
            outgoing: None,
            last_commit_ms: commit_time_ms(&repo, id),
            commit: id.to_string(),
        };
        let mut counted_upstream = None;
        if let Some((up, up_id)) = upstream_of(&repo, full.as_ref()) {
            branch.upstream = Some(up);
            branch.tracked_tip = configured_upstream(&repo, full.as_ref())
                .map(|tracking| TrackedTip { tracking, commit: up_id.to_string() });
            let (a, b) = ahead_behind(&repo, id, up_id)?;
            branch.ahead = a;
            branch.behind = b;
            counted_upstream = Some((up_id, a));
        }
        branch.outgoing = crate::push_preview::outgoing_commits(&repo, &remotes, full.as_ref(), id, counted_upstream);
        out.push(branch);
    }
    for reference in platform.remote_branches().map_err(gx)? {
        let mut reference = reference.map_err(gx)?;
        // Skip symbolic aliases such as `refs/remotes/<remote>/HEAD`.
        if reference.target().try_name().is_some() {
            continue;
        }
        let full = reference.name().to_owned();
        let Ok(id) = reference.peel_to_id().map(|id| id.detach()) else { continue };
        out.push(Branch {
            name: to_string(full.as_ref().shorten()),
            remote: true,
            current: false,
            upstream: None,
            tracked_tip: None,
            ahead: 0,
            behind: 0,
            outgoing: None,
            last_commit_ms: commit_time_ms(&repo, id),
            commit: id.to_string(),
        });
    }
    out.sort_by(|a, b| {
        b.current
            .cmp(&a.current)
            .then(b.last_commit_ms.total_cmp(&a.last_commit_ms))
            .then(a.remote.cmp(&b.remote))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

pub(crate) fn stashes(r: &Repo) -> IdeResult<Vec<Stash>> {
    let repo = r.gix()?;
    let Some(reference) = repo.try_find_reference("refs/stash").map_err(gx)? else {
        return Ok(Vec::new());
    };
    let mut platform = reference.log_iter();
    let Some(lines) = platform.rev().map_err(gx)? else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (index, line) in lines.enumerate() {
        let line = line.map_err(gx)?;
        let time_ms = line.signature.time.seconds as f64 * 1000.0;
        let id = line.new_oid.to_owned();
        let (base, untracked) = repo
            .find_commit(id)
            .map(|commit| {
                let mut parents = commit.parent_ids();
                (parents.next().map(|p| p.to_string()), parents.nth(1).map(|p| p.to_string()))
            })
            .unwrap_or_default();
        out.push(Stash {
            index: index as u32,
            message: to_string(line.message.as_ref()),
            time_ms,
            id: id.to_string(),
            base,
            untracked,
        });
    }
    Ok(out)
}
