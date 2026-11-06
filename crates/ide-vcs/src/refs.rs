//! HEAD, branches, upstream tracking and stashes via gitoxide.

use crate::repo::{gx, to_string};
use crate::{Branch, BranchInfo, Repo, Stash};
use ide_core::IdeResult;

// Filter symbolic refs before shortening; `refname:short` also strips remote `/HEAD` suffixes.
pub(crate) const DIRECT_BRANCH_FORMAT: &str = "--format=%(if)%(symref)%(then)%(else)%(refname:lstrip=2)%(end)";

pub(crate) fn branch_info(r: &Repo) -> IdeResult<BranchInfo> {
    let repo = r.gix()?;
    let head_ref = repo.head_name().map_err(gx)?;
    let head = head_ref.as_ref().map(|n| to_string(n.as_ref().shorten()));
    let head_commit = repo.head_id().ok().map(|id| id.detach());
    let mut info = BranchInfo {
        head,
        head_commit: head_commit.map(|id| id.to_string()),
        upstream: None,
        ahead: 0,
        behind: 0,
        operation: operation(&repo),
    };
    if let Some(name) = head_ref.as_ref()
        && let Some((upstream_name, upstream_id)) = upstream_of(&repo, name.as_ref())
    {
        info.upstream = Some(upstream_name);
        if let (Some(local), Some(up)) = (head_commit, upstream_id) {
            let (a, b) = ahead_behind(&repo, local, up)?;
            info.ahead = a;
            info.behind = b;
        }
    }
    Ok(info)
}

pub(crate) fn head(repo: &gix::Repository) -> IdeResult<(Option<String>, Option<String>)> {
    let name = repo.head_name().map_err(gx)?.map(|n| to_string(n.as_ref().shorten()));
    Ok((name, repo.head_id().ok().map(|id| id.to_string())))
}

pub(crate) fn operation(repo: &gix::Repository) -> Option<String> {
    use gix::state::InProgress::*;
    let op = match repo.state()? {
        ApplyMailbox | ApplyMailboxRebase => "am",
        Bisect => "bisect",
        CherryPick | CherryPickSequence => "cherry-pick",
        Merge => "merge",
        Rebase | RebaseInteractive => "rebase",
        Revert | RevertSequence => "revert",
    };
    Some(op.to_string())
}

/// Short upstream name (`origin/main`) and, if the tracking ref exists, its commit.
fn upstream_of(repo: &gix::Repository, branch: &gix::refs::FullNameRef) -> Option<(String, Option<gix::ObjectId>)> {
    let tracking = repo.branch_remote_tracking_ref_name(branch, gix::remote::Direction::Fetch)?.ok()?;
    let short = to_string(tracking.as_ref().shorten());
    let id = repo
        .try_find_reference(tracking.as_ref())
        .ok()
        .flatten()
        .and_then(|mut r| r.peel_to_id().ok().map(|id| id.detach()));
    Some((short, id))
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
    let count = |tip: gix::ObjectId, hide: gix::ObjectId| -> IdeResult<u32> {
        let walk = repo.rev_walk([tip]).with_hidden([hide]).all().map_err(gx)?;
        let mut n = 0u32;
        for info in walk {
            info.map_err(gx)?;
            n += 1;
        }
        Ok(n)
    };
    Ok((count(local, upstream)?, count(upstream, local)?))
}

fn commit_time_ms(repo: &gix::Repository, id: gix::ObjectId) -> f64 {
    repo.find_commit(id).ok().and_then(|c| c.time().ok()).map(|t| t.seconds as f64 * 1000.0).unwrap_or(0.0)
}

pub(crate) fn branches(r: &Repo) -> IdeResult<Vec<Branch>> {
    let repo = r.gix()?;
    let head_name = repo.head_name().map_err(gx)?;
    let platform = repo.references().map_err(gx)?;
    let mut out = Vec::new();

    for reference in platform.local_branches().map_err(gx)? {
        let mut reference = reference.map_err(gx)?;
        let full = reference.name().to_owned();
        let Ok(id) = reference.peel_to_id().map(|id| id.detach()) else { continue };
        let current = head_name.as_ref().is_some_and(|h| h == &full);
        let mut branch = Branch {
            name: to_string(full.as_ref().shorten()),
            remote: false,
            current,
            upstream: None,
            ahead: 0,
            behind: 0,
            last_commit_ms: commit_time_ms(&repo, id),
            commit: id.to_string(),
        };
        if let Some((up, up_id)) = upstream_of(&repo, full.as_ref()) {
            branch.upstream = Some(up);
            if let Some(up_id) = up_id {
                let (a, b) = ahead_behind(&repo, id, up_id)?;
                branch.ahead = a;
                branch.behind = b;
            }
        }
        out.push(branch);
    }
    for reference in platform.remote_branches().map_err(gx)? {
        let mut reference = reference.map_err(gx)?;
        let full = reference.name().to_owned();
        // Skip `refs/remotes/<remote>/HEAD` symbolic pointers.
        if full.as_bstr().ends_with(b"/HEAD") {
            continue;
        }
        let Ok(id) = reference.peel_to_id().map(|id| id.detach()) else { continue };
        out.push(Branch {
            name: to_string(full.as_ref().shorten()),
            remote: true,
            current: false,
            upstream: None,
            ahead: 0,
            behind: 0,
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
        out.push(Stash { index: index as u32, message: to_string(line.message.as_ref()), time_ms });
    }
    Ok(out)
}
