use gix::bstr::{BStr, ByteSlice};
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{
    OutgoingCommits, Repo, cli,
    ops::{remote_fetch_url, remote_push_urls},
    refs,
};

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PushSelection {
    /// A local branch. A detached source has no branch and requires a commit ID.
    pub branch: Option<String>,
    pub revision: Option<String>,
    pub remote: String,
    pub target: String,
    /// A configured non-branch destination, for example a Gerrit review ref.
    #[serde(default)]
    pub special_ref: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DefaultPushTarget {
    pub selection: PushSelection,
    pub set_upstream: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct CommitPushTarget {
    pub branch: Option<String>,
    pub destination: Option<DefaultPushTarget>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
pub struct PushTargetChoices {
    pub branch: Option<String>,
    pub destination: Option<DefaultPushTarget>,
    pub destinations: Vec<DefaultPushTarget>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PushInspection {
    pub state: PushTargetState,
    pub local_tip: String,
    /// An empty value expects the branch to be absent. Null means no tip was available.
    pub remote_tip: Option<String>,
    pub remote_commits: u32,
    pub remote_checked: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PushTargetState {
    Ready,
    Diverged,
    FetchRequired,
}

impl PushSelection {
    pub(crate) fn refs(&self, repo: &Repo, cancel: &CancellationToken) -> IdeResult<(Option<String>, String, String)> {
        let source = self.branch.as_ref().map(|branch| format!("refs/heads/{branch}"));
        let target = self.target_ref(repo, cancel)?;
        if let Some(source) = source.as_deref() {
            cli::run_cancellable(repo.root(), &["check-ref-format", source], cancel)?;
        }
        let rev = if let Some(source) = source.as_deref() {
            self.revision.as_deref().unwrap_or(source)
        } else {
            self.revision
                .as_deref()
                .filter(|rev| gix::ObjectId::from_hex(rev.as_bytes()).is_ok())
                .ok_or_else(|| IdeError::invalid("A detached push requires a commit ID."))?
        };
        let local_tip = commit_id(repo, rev, cancel)?;
        Ok((source, target, local_tip))
    }

    fn target_ref(&self, repo: &Repo, cancel: &CancellationToken) -> IdeResult<String> {
        let target = if self.special_ref {
            if !self.target.starts_with("refs/") {
                return Err(IdeError::invalid("Invalid push destination"));
            }
            self.target.clone()
        } else {
            format!("refs/heads/{}", self.target)
        };
        cli::run_cancellable(repo.root(), &["check-ref-format", &target], cancel)?;
        Ok(target)
    }
}

fn commit_id(repo: &Repo, rev: &str, cancel: &CancellationToken) -> IdeResult<String> {
    let rev = format!("{rev}^{{commit}}");
    let output = cli::run_cancellable(repo.root(), &["rev-parse", "--verify", "--end-of-options", &rev], cancel)?;
    Ok(output.stdout_str().trim().to_owned())
}

impl Repo {
    /// Prefer the checked-out branch if it contains the selected commit, then another
    /// containing local branch. A tag or remote branch alone is a detached source.
    pub fn commit_push_target(&self, revision: &str, cancel: &CancellationToken) -> IdeResult<CommitPushTarget> {
        let choices = self.resolve_push_targets(None, Some(revision), cancel, false)?;
        Ok(CommitPushTarget { branch: choices.branch, destination: choices.destination })
    }

    /// The destination shown by Push and used by Commit and Push for a local source.
    pub fn default_push_target(&self, branch: Option<&str>) -> IdeResult<Option<DefaultPushTarget>> {
        self.resolve_push_targets(branch, None, &CancellationToken::new(), false).map(|choices| choices.destination)
    }

    /// Resolve one source and its configured destination on every available remote.
    pub fn push_target_choices(
        &self,
        branch: Option<&str>,
        commit: Option<&str>,
        cancel: &CancellationToken,
    ) -> IdeResult<PushTargetChoices> {
        self.resolve_push_targets(branch, commit, cancel, true)
    }

    fn commit_push_source(&self, revision: &str, cancel: &CancellationToken) -> IdeResult<(Option<String>, String)> {
        let revision = commit_id(self, revision, cancel)?;
        let refs = cli::run_cancellable(
            self.root(),
            &[
                "for-each-ref",
                &format!("--contains={revision}"),
                "--sort=version:refname",
                "--format=%(HEAD)%(refname:lstrip=2)",
                "refs/heads/",
            ],
            cancel,
        )?
        .stdout_str();
        let local = || refs.lines().filter_map(|line| line.strip_prefix(' '));
        let branch = refs
            .lines()
            .find_map(|line| line.strip_prefix('*'))
            .or_else(|| local().find(|name| matches!(*name, "main" | "master")))
            .or_else(|| local().next());
        Ok((branch.map(str::to_owned), revision))
    }

    fn resolve_push_targets(
        &self,
        branch: Option<&str>,
        commit: Option<&str>,
        cancel: &CancellationToken,
        alternatives: bool,
    ) -> IdeResult<PushTargetChoices> {
        let repo = self.gix()?;
        let selected = commit.map(|commit| self.commit_push_source(commit, cancel)).transpose()?;
        let branch = selected.as_ref().map_or(branch, |(branch, _)| branch.as_deref());
        let head = repo.head_name().map_err(crate::repo::gx)?;
        let source = if let Some(branch) = branch {
            let reference =
                repo.try_find_reference(format!("refs/heads/{branch}").as_str()).map_err(crate::repo::gx)?;
            let Some(reference) = reference else { return Ok(PushTargetChoices::default()) };
            Some(reference.name().to_owned())
        } else if selected.is_none() {
            head.clone()
        } else {
            None
        };
        let revision = selected
            .map(|(_, revision)| revision)
            .or_else(|| if source.is_some() { None } else { repo.head_id().ok().map(|tip| tip.to_string()) });
        let branch = source.as_ref().map(|name| name.as_ref().shorten().to_str_lossy().into_owned());
        if source.is_none() && revision.is_none() {
            return Ok(PushTargetChoices::default());
        }
        let names = repo.remote_names();
        let remote = default_push_remote(&repo, &names, branch.as_deref());
        let make = |remote: &BStr| -> IdeResult<DefaultPushTarget> {
            if let Some(source) = &source {
                let remote = repo.find_remote(remote).map_err(crate::repo::gx)?;
                let mut target = branch_push_target(&repo, source.as_ref(), &remote)?;
                if let Some(revision) = &revision {
                    target.selection.revision = Some(revision.clone());
                    target.set_upstream = false;
                }
                return Ok(target);
            }
            detached_push_target(
                &repo,
                revision.as_deref().expect("a detached source has a revision"),
                remote,
                head.as_ref().map(|head| head.as_ref().shorten()),
            )
        };
        let destination = remote.map(make).transpose()?;
        let destinations =
            if alternatives { names.iter().filter_map(|name| make(name.as_bstr()).ok()).collect() } else { Vec::new() };
        Ok(PushTargetChoices { branch, destination, destinations })
    }
}

fn default_push_remote<'names>(
    repo: &gix::Repository,
    names: &'names gix::remote::Names,
    branch: Option<&str>,
) -> Option<&'names BStr> {
    let preferred = branch.and_then(|branch| repo.branch_remote_name(branch, gix::remote::Direction::Push));
    let remote = match preferred.as_ref().map(|name| name.as_bstr()) {
        Some(name) if name != "." => names.iter().find(|candidate| candidate.as_bstr() == name),
        _ => names.iter().find(|name| name.as_bstr() == "origin").or_else(|| names.iter().next()),
    };
    remote.map(|name| name.as_bstr())
}

fn branch_push_target(
    repo: &gix::Repository,
    source: &gix::refs::FullNameRef,
    configured: &gix::Remote<'_>,
) -> IdeResult<DefaultPushTarget> {
    let remote = configured.name().ok_or_else(|| IdeError::invalid("Unknown push remote"))?.as_bstr();
    let branch = source.shorten().to_str_lossy().into_owned();
    let upstream_remote = repo.branch_remote_name(branch.as_str(), gix::remote::Direction::Fetch);
    let upstream =
        repo.branch_remote_ref_name(source, gix::remote::Direction::Fetch).transpose().map_err(crate::repo::gx)?;
    let remote_name = remote.to_str_lossy().into_owned();
    let specs = configured.refspecs(gix::remote::Direction::Push);
    let target = configured_destination(repo, source, &branch, specs)
        .or_else(|| {
            (upstream_remote.as_ref().map(|upstream| upstream.as_bstr()) == Some(remote))
                .then_some(upstream.as_ref())
                .flatten()
                .map(|name| name.as_bstr().to_str_lossy().into_owned())
        })
        .unwrap_or_else(|| source.as_bstr().to_str_lossy().into_owned());
    let tracking_prefix = format!("refs/remotes/{remote_name}/");
    let (target, special_ref) =
        if let Some(short) = target.strip_prefix("refs/heads/").or_else(|| target.strip_prefix(&tracking_prefix)) {
            (short.to_owned(), false)
        } else {
            let special = target.starts_with("refs/");
            (target, special)
        };
    let tracking = format!("refs/remotes/{remote_name}/{target}");
    let set_upstream = !special_ref
        && upstream.is_none()
        && repo.try_find_reference(tracking.as_str()).map_err(crate::repo::gx)?.is_none();
    Ok(DefaultPushTarget {
        selection: PushSelection { branch: Some(branch), revision: None, remote: remote_name, target, special_ref },
        set_upstream,
    })
}

fn push_tracking_tip(remote: &gix::Remote<'_>, target: &str) -> Option<(String, gix::ObjectId)> {
    use gix::remote::Direction::{Fetch, Push};
    let fetch_url = remote.url(Fetch)?;
    let mut push_urls = remote.urls(Push);
    if push_urls.next()? != fetch_url || push_urls.next().is_some() {
        return None;
    }
    let target_ref = format!("refs/heads/{target}");
    let null = remote.repo().object_hash().null();
    let group =
        gix::refspec::MatchGroup { specs: remote.refspecs(Fetch).iter().map(gix::refspec::RefSpec::to_ref).collect() };
    let matches = group.match_lhs(std::iter::once(gix::refspec::match_group::Item {
        full_ref_name: target_ref.as_str().into(),
        target: &null,
        object: None,
    }));
    let mut destinations = matches.mappings.iter().filter_map(|mapping| mapping.rhs.as_deref());
    let tracking = destinations.next()?;
    if destinations.any(|other| other != tracking) {
        return None;
    }
    let mut reference = remote.repo().try_find_reference(tracking).ok()??;
    let name = crate::repo::to_string(reference.name().as_bstr());
    let tip = reference.peel_to_id().ok()?.detach();
    Some((name, tip))
}

pub(crate) fn outgoing_commits(
    repo: &gix::Repository,
    remotes: &gix::remote::Names,
    source: &gix::refs::FullNameRef,
    local: gix::ObjectId,
    counted_upstream: Option<(gix::ObjectId, u32)>,
) -> Option<OutgoingCommits> {
    let name = source.shorten().to_str_lossy();
    let remote = repo.find_remote(default_push_remote(repo, remotes, Some(&name))?).ok()?;
    let target = branch_push_target(repo, source, &remote).ok()?.selection;
    if target.special_ref {
        return None;
    }
    let (reference, tip) = push_tracking_tip(&remote, &target.target)?;
    let count = if tip == local {
        0
    } else if let Some((_, count)) = counted_upstream.filter(|(upstream, _)| *upstream == tip) {
        count
    } else {
        crate::refs::count_commits(repo, local, tip).ok()?
    };
    Some(OutgoingCommits { remote: target.remote, branch: target.target, reference, count })
}

impl Repo {
    /// Compare the selected source with the destination actually used by Git push.
    pub fn inspect_push(
        &self,
        selection: &PushSelection,
        live: bool,
        cancel: &CancellationToken,
    ) -> IdeResult<PushInspection> {
        let _scope = self.execution_scope();
        let (source, target, local_tip) = selection.refs(self, cancel)?;
        let urls = remote_push_urls(self, &selection.remote, cancel)?;
        let mut result = PushInspection {
            state: PushTargetState::Ready,
            local_tip,
            remote_tip: None,
            remote_commits: 0,
            remote_checked: selection.special_ref,
        };
        if selection.special_ref {
            return Ok(result);
        }
        if urls.len() != 1 {
            return Ok(result);
        }

        let mut advertised = None;
        if live {
            match cli::run_with_saved_credentials_raw(
                self.root(),
                &["ls-remote", "--exit-code", "--refs", "--", &urls[0], &target],
                cancel,
            ) {
                Ok(output) if output.code == Some(2) => {
                    result.remote_checked = true;
                    result.remote_tip = Some(String::new());
                    return Ok(result);
                }
                Ok(output) if output.code == Some(0) => {
                    advertised = output
                        .stdout_str()
                        .lines()
                        .filter_map(|line| line.split_once('\t'))
                        .find(|(_, name)| *name == target)
                        .and_then(|(id, _)| gix::ObjectId::from_hex(id.as_bytes()).ok())
                        .map(|id| id.to_string());
                    result.remote_checked = advertised.is_some();
                }
                Err(error) if error.kind == ErrorKind::Cancelled => return Err(error),
                _ => {}
            }
        }
        // Neither a fetch ref nor its observation describes a separate push endpoint.
        let tip = advertised.or_else(|| {
            if remote_fetch_url(self, &selection.remote, cancel).ok()? != urls[0] {
                return None;
            }
            let repo = self.gix().ok()?;
            let remote = repo.find_remote(selection.remote.as_str()).ok()?;
            let (_, tracked) = push_tracking_tip(&remote, &selection.target)?;
            let tracked = tracked.to_string();
            let observed = source.as_deref().and_then(|source| {
                let reference = repo.find_reference(source).ok()?;
                let tracking = refs::configured_upstream(&repo, reference.name())?;
                if tracking.remote != selection.remote || tracking.branch != selection.target {
                    return None;
                }
                self.observed_incoming_tip(selection.branch.as_deref()?, &tracking, &tracked, &urls[0])
            });
            Some(observed.unwrap_or(tracked))
        });
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let Some(tip) = tip else { return Ok(result) };
        if let Err(error) = commit_id(self, &tip, cancel) {
            if error.kind == ErrorKind::Cancelled {
                return Err(error);
            }
            result.state = PushTargetState::FetchRequired;
            result.remote_tip = Some(tip);
            return Ok(result);
        }
        let range = format!("{}...{tip}", result.local_tip);
        let counts = cli::run_cancellable(self.root(), &["rev-list", "--left-right", "--count", &range], cancel)?;
        let counts = counts.stdout_str();
        if let Some((ahead, behind)) = counts.trim().split_once('\t')
            && ahead.parse::<u32>().is_ok_and(|ahead| ahead > 0)
            && let Ok(behind) = behind.parse::<u32>()
            && behind > 0
        {
            result.state = PushTargetState::Diverged;
            result.remote_commits = behind;
        }
        result.remote_tip = Some(tip);
        Ok(result)
    }

    pub fn fetch_push_target(
        &self,
        selection: &PushSelection,
        cancel: &CancellationToken,
        out: &dyn Fn(String),
    ) -> IdeResult<()> {
        let _scope = self.execution_scope();
        let target = selection.target_ref(self, cancel)?;
        let urls = remote_push_urls(self, &selection.remote, cancel)?;
        let [url] = urls.as_slice() else {
            return Err(IdeError::invalid("The remote has multiple push URLs."));
        };
        if &remote_fetch_url(self, &selection.remote, cancel)? == url {
            // The configured fetch refspec maps this branch to its remote-tracking ref.
            cli::run_streaming(
                self.root(),
                &["fetch", "--progress", "--no-tags", "--no-write-fetch-head", "--", &selection.remote, &target],
                cancel,
                out,
            )
        } else {
            // A separate push endpoint must not change the fetch endpoint's tracking refs.
            cli::run_cancellable(
                self.root(),
                &["fetch", "--no-tags", "--no-write-fetch-head", "--", url, &target],
                cancel,
            )
            .map(|_| ())
        }
    }
}

fn detached_push_target(
    repo: &gix::Repository,
    revision: &str,
    remote: &BStr,
    current_branch: Option<&BStr>,
) -> IdeResult<DefaultPushTarget> {
    let remote = remote.to_str_lossy().into_owned();
    let mut target = current_branch.map_or_else(|| "detached".to_owned(), |branch| branch.to_str_lossy().into_owned());
    let mut suffix = 2;
    loop {
        let tracking = format!("refs/remotes/{remote}/{target}");
        if current_branch.is_some() || repo.try_find_reference(tracking.as_str()).map_err(crate::repo::gx)?.is_none() {
            return Ok(DefaultPushTarget {
                selection: PushSelection {
                    branch: None,
                    revision: Some(revision.to_owned()),
                    remote,
                    target,
                    special_ref: false,
                },
                set_upstream: false,
            });
        }
        target = format!("detached{suffix}");
        suffix += 1;
    }
}

fn configured_destination(
    repo: &gix::Repository,
    source: &gix::refs::FullNameRef,
    branch: &str,
    specs: &[gix::refspec::RefSpec],
) -> Option<String> {
    let mut wildcards = Vec::new();
    for spec in specs.iter().map(gix::refspec::RefSpec::to_ref) {
        let (Some(lhs), Some(rhs)) = (spec.source(), spec.destination()) else { continue };
        if lhs == "HEAD" || lhs == branch || lhs == source.as_bstr() {
            return Some(rhs.to_str_lossy().into_owned());
        }
        if lhs.contains(&b'*') {
            wildcards.push(spec);
        }
    }
    let null_id = repo.object_hash().null();
    gix::refspec::MatchGroup { specs: wildcards }
        .match_lhs(std::iter::once(gix::refspec::match_group::Item {
            full_ref_name: source.as_bstr(),
            target: &null_id,
            object: None,
        }))
        .mappings
        .into_iter()
        .find_map(|m| m.rhs.map(|rhs| rhs.to_str_lossy().into_owned()))
}
