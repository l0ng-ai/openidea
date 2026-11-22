//! Remote ref checks that leave the object database and tracking refs alone.

use crate::{Repo, TrackedTip, UpstreamTracking, cli, ops::remote_fetch_url, refs, repo};
use gix::bstr::ByteSlice;
use ide_core::error::ErrorKind;
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnfetchedBranch {
    pub branch: String,
    pub tracked_tip: TrackedTip,
    pub advertised_commit: String,
}

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct IncomingRemoteError {
    pub remote: String,
    pub error: IdeError,
}

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct IncomingRefsReport {
    pub branches: Vec<UnfetchedBranch>,
    pub errors: Vec<IncomingRemoteError>,
}

#[derive(Default)]
pub(crate) struct IncomingObservations {
    generation: u64,
    branches: HashMap<String, UnfetchedBranch>,
    // Resolved URLs may contain credentials. Keep them in the repository, outside IPC reports.
    endpoints: HashMap<String, String>,
}

impl Repo {
    pub fn check_incoming_refs(&self, cancel: &CancellationToken) -> IdeResult<IncomingRefsReport> {
        let _scope = self.execution_scope();
        let generation = {
            let mut observations = self.incoming_observations.lock().unwrap_or_else(|p| p.into_inner());
            observations.generation += 1;
            observations.generation
        };
        let mut endpoints = HashMap::new();
        let report = self.read_incoming_refs(&mut endpoints, cancel);
        let mut observations = self.incoming_observations.lock().unwrap_or_else(|p| p.into_inner());
        if generation == observations.generation && !cancel.is_cancelled() {
            observations.branches = report
                .as_ref()
                .into_iter()
                .flat_map(|report| &report.branches)
                .map(|branch| (branch.branch.clone(), branch.clone()))
                .collect();
            observations.endpoints = endpoints;
        }
        report
    }

    pub(crate) fn observed_incoming_tip(
        &self,
        branch: &str,
        tracking: &UpstreamTracking,
        tracked_tip: &str,
        endpoint: &str,
    ) -> Option<String> {
        let observations = self.incoming_observations.lock().unwrap_or_else(|p| p.into_inner());
        let observed = observations.branches.get(branch)?;
        if &observed.tracked_tip.tracking != tracking
            || observed.tracked_tip.commit != tracked_tip
            || observations.endpoints.get(&tracking.remote)? != endpoint
        {
            return None;
        }
        Some(observed.advertised_commit.clone())
    }

    fn read_incoming_refs(
        &self,
        endpoints: &mut HashMap<String, String>,
        cancel: &CancellationToken,
    ) -> IdeResult<IncomingRefsReport> {
        let repo = self.gix()?;
        let remotes = repo.remote_names();
        let mut by_remote: BTreeMap<String, Vec<(String, TrackedTip)>> = BTreeMap::new();
        for reference in repo.references().map_err(repo::gx)?.local_branches().map_err(repo::gx)? {
            if cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            let reference = reference.map_err(repo::gx)?;
            if reference.target().try_name().is_some() {
                continue;
            }
            let name = reference.name();
            let Some(tracking) = refs::configured_upstream(&repo, name) else { continue };
            if !remotes.iter().any(|remote| remote.as_bstr() == tracking.remote.as_str()) {
                continue;
            }
            let Some((_, tip)) = refs::upstream_of(&repo, name) else { continue };
            by_remote
                .entry(tracking.remote.clone())
                .or_default()
                .push((repo::to_string(name.shorten()), TrackedTip { tracking, commit: tip.to_string() }));
        }

        let mut branches = Vec::new();
        let mut errors = Vec::new();
        for (remote, tracked) in by_remote {
            let mut refs: Vec<_> =
                tracked.iter().map(|(_, tip)| format!("refs/heads/{}", tip.tracking.branch)).collect();
            refs.sort_unstable();
            refs.dedup();
            let advertised = match remote_fetch_url(self, &remote, cancel)
                .and_then(|url| self.advertised_heads(&remote, &refs, cancel).map(|advertised| (url, advertised)))
            {
                Ok(advertised) => advertised,
                Err(error) if error.kind == ErrorKind::Cancelled => return Err(error),
                Err(error) => {
                    errors.push(IncomingRemoteError { remote, error });
                    continue;
                }
            };
            let (endpoint, advertised) = advertised;
            let before = branches.len();
            for (branch, tracked_tip) in tracked {
                let Some(commit) = advertised.get(tracked_tip.tracking.branch.as_str()) else { continue };
                if *commit != tracked_tip.commit {
                    branches.push(UnfetchedBranch { branch, tracked_tip, advertised_commit: commit.clone() });
                }
            }
            if branches.len() > before {
                if remote_fetch_url(self, &remote, cancel).is_ok_and(|url| url == endpoint) {
                    endpoints.insert(remote, endpoint);
                } else {
                    branches.truncate(before);
                }
            }
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        Ok(IncomingRefsReport { branches, errors })
    }

    fn advertised_heads(
        &self,
        remote: &str,
        refs: &[String],
        cancel: &CancellationToken,
    ) -> IdeResult<HashMap<String, String>> {
        let base = ["ls-remote", "--heads", "--refs", "--", remote];
        let mut heads = HashMap::new();
        for batch in cli::batch_paths(cli::base_command_line_len(&base), refs, 16 * 1024) {
            let mut args = base.to_vec();
            args.extend(batch.iter().map(String::as_str));
            let output = cli::run_with_saved_credentials(self.root(), &args, cancel)?;
            for line in output.stdout_str().lines() {
                let Some((commit, reference)) = line.split_once('\t') else { continue };
                let Some(branch) = reference.strip_prefix("refs/heads/") else { continue };
                if let Ok(commit) = gix::ObjectId::from_hex(commit.as_bytes()) {
                    heads.insert(branch.to_owned(), commit.to_string());
                }
            }
        }
        Ok(heads)
    }
}
