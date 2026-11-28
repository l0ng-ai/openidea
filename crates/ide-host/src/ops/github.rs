//! GitHub pull requests (`ide-github`, through the `gh` CLI) for the project of the window.
//!
//! Runs on the project host (`Host` locally, `openidea-server` in a remote window) so remote
//! SSH / WSL / dev-container projects use the remote host's `gh` CLI, repository, and
//! project-scoped `GH_TOKEN`.

use super::{Channel, blocking};
use crate::Host;
use ide_command::command;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_github::{
    CreatePullRequest, GhAccountRepos, GhApiRequest, GhAvailability, PrDiffRevisions, PrListQuery, PrReviewComment,
    PullRequestDetails, PullRequestSummary, ReviewEvent,
};
use std::path::{Path, PathBuf};

/// The working directory of gh: the project repository `repo` names, else the project's
/// primary repository (a folder holding several repositories is not one itself).
fn root(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<PathBuf> {
    let project = host.project(window)?;
    let repos = project.repos();
    match repo {
        Some(at) => match repos.at_root(&at) {
            Some(r) => Ok(r.root().to_path_buf()),
            None => Err(IdeError::unavailable(format!("{} is not a git repository of the project", at.display()))),
        },
        None => Ok(repos.primary().map_or_else(|| project.root.clone(), |r| r.root().to_path_buf())),
    }
}

/// Emits `VcsChanged` after operations that move HEAD or refs (checkout, push).
fn vcs_changed(host: &Host, window: &str, root: &Path) {
    if let Ok(p) = host.project(window) {
        p.sink.emit(ide_core::IdeEvent::VcsChanged { root: ide_core::IpcPath(root.to_path_buf()) });
    }
}

/// The repositories of the account gh is signed in to ("Get from Version Control" › GitHub); needs no project.
#[command(trust = outside_restricted)]
pub async fn gh_account_repos() -> IdeResult<GhAccountRepos> {
    blocking(|| Ok(ide_github::account_repositories())).await
}

#[command(trust = trusted)]
pub async fn gh_availability(host: &Host, window: &str, repo: Option<PathBuf>) -> IdeResult<GhAvailability> {
    let project = host.project(window)?;
    let root = root(host, window, repo)?;
    blocking(move || {
        crate::github_auth::apply_to_project(&project);
        Ok(ide_github::availability(&root))
    })
    .await
}

#[command(trust = trusted)]
pub async fn gh_pr_list(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    query: PrListQuery,
) -> IdeResult<Vec<PullRequestSummary>> {
    let root = root(host, window, repo)?;
    blocking(move || ide_github::list(&root, &query)).await
}

#[command(trust = trusted)]
pub async fn gh_pr_view(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    number: u32,
) -> IdeResult<PullRequestDetails> {
    let root = root(host, window, repo)?;
    blocking(move || ide_github::view(&root, number)).await
}

#[command(trust = trusted)]
pub async fn gh_pr_review_comments(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    number: u32,
) -> IdeResult<Vec<PrReviewComment>> {
    let root = root(host, window, repo)?;
    blocking(move || ide_github::review_comments(&root, number)).await
}

#[command(trust = trusted)]
pub async fn gh_pr_checkout(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    number: u32,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let root = root(host, window, repo)?;
    let cancel = host.begin_request(request);
    let dir = root.clone();
    let result = blocking(move || {
        ide_github::checkout(&dir, number, &cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await;
    host.end_request(request);
    vcs_changed(host, window, &root);
    result
}

/// Creates a pull request from the current branch (pushing it first when asked); returns its URL.
#[command(trust = trusted)]
pub async fn gh_pr_create(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    pr: CreatePullRequest,
    on_output: Channel<String>,
) -> IdeResult<String> {
    let root = root(host, window, repo)?;
    let git = host.project(window)?.git_executable();
    let cancel = host.begin_request(request);
    let dir = root.clone();
    let result = blocking(move || {
        ide_vcs::with_git_executable(git.as_deref(), || {
            ide_github::create(&dir, &pr, &cancel, &|line| {
                let _ = on_output.send(line);
            })
        })
    })
    .await;
    host.end_request(request);
    vcs_changed(host, window, &root);
    result
}

#[command(trust = trusted)]
pub async fn gh_pr_review(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    number: u32,
    event: ReviewEvent,
    body: String,
) -> IdeResult<()> {
    let root = root(host, window, repo)?;
    blocking(move || ide_github::submit_review(&root, number, event, &body)).await
}

#[command(trust = trusted)]
pub async fn gh_pr_comment(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    number: u32,
    body: String,
) -> IdeResult<()> {
    let root = root(host, window, repo)?;
    blocking(move || ide_github::add_comment(&root, number, &body)).await
}

/// A GitHub GraphQL / REST call through `gh api`; returns the response body.
#[command(trust = trusted)]
pub async fn gh_api(host: &Host, window: &str, repo: Option<PathBuf>, request: GhApiRequest) -> IdeResult<String> {
    let root = root(host, window, repo)?;
    blocking(move || ide_github::api(&root, &request)).await
}

/// Fetches what is missing to diff a pull request locally; returns the revisions to compare.
#[command(trust = trusted)]
#[allow(clippy::too_many_arguments)]
pub async fn gh_pr_prepare_diff(
    host: &Host,
    window: &str,
    repo: Option<PathBuf>,
    request: RequestId,
    number: u32,
    head_oid: String,
    base_oid: String,
    base_ref: String,
    name_with_owner: String,
    on_output: Channel<String>,
) -> IdeResult<PrDiffRevisions> {
    let root = root(host, window, repo)?;
    let git = host.project(window)?.git_executable();
    let cancel = host.begin_request(request);
    let result = blocking(move || {
        let output = |line: String| {
            let _ = on_output.send(line);
        };
        ide_vcs::with_git_executable(git.as_deref(), || {
            ide_github::prepare_diff(&root, number, &head_oid, &base_oid, &base_ref, &name_with_owner, &cancel, &output)
        })
    })
    .await;
    host.end_request(request);
    result
}

ide_command::domain!(
    github:
    gh_account_repos,
    gh_api,
    gh_availability,
    gh_pr_checkout,
    gh_pr_comment,
    gh_pr_create,
    gh_pr_list,
    gh_pr_prepare_diff,
    gh_pr_review,
    gh_pr_review_comments,
    gh_pr_view,
);

#[cfg(test)]
mod tests {
    use super::root;
    use crate::catalogue::TrustClass;
    use crate::rpc::Dispatcher;
    use crate::{Host, HostConfig};
    use ide_core::error::ErrorKind;
    use std::path::Path;
    use std::sync::Arc;

    fn test_host(base: &Path) -> Host {
        Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(|_| {})),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        })
    }

    #[test]
    fn registers_github_commands_on_the_remote_rpc_dispatcher() {
        let dispatcher = Dispatcher::standard();
        assert_eq!(dispatcher.trust("gh_account_repos"), Some(TrustClass::OutsideRestricted));
        for name in [
            "gh_api",
            "gh_availability",
            "gh_pr_checkout",
            "gh_pr_comment",
            "gh_pr_create",
            "gh_pr_list",
            "gh_pr_prepare_diff",
            "gh_pr_review",
            "gh_pr_review_comments",
            "gh_pr_view",
        ] {
            assert_eq!(dispatcher.trust(name), Some(TrustClass::Trusted), "{name}");
        }
    }

    #[tokio::test]
    async fn authorizes_account_repos_without_a_project_and_scopes_repo_lookup_to_project() {
        let dir = tempfile::tempdir().unwrap();
        let host = test_host(dir.path());
        assert!(host.authorize("main", TrustClass::OutsideRestricted).is_ok());
        let err = host.authorize("main", TrustClass::Trusted).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);

        let proj_dir = dir.path().join("repo");
        std::fs::create_dir_all(&proj_dir).unwrap();
        host.open_project("main", &proj_dir).unwrap();
        assert_eq!(root(&host, "main", None).unwrap(), dunce::canonicalize(&proj_dir).unwrap());
        let outsider = root(&host, "main", Some(dir.path().join("other"))).unwrap_err();
        assert_eq!(outsider.kind, ErrorKind::Unavailable);
    }
}
