//! GitHub pull requests (`ide-github`, through the gh CLI) for the project of the window.

use crate::state::AppState;
use ide_core::{IdeError, IdeResult, RequestId};
use ide_github::{
    CreatePullRequest, GhAccountRepos, GhApiRequest, GhAvailability, PrDiffRevisions, PrListQuery, PrReviewComment,
    PullRequestDetails, PullRequestSummary, ReviewEvent,
};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{State, Window};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

/// The working directory of gh: the project repository `repo` names, else the project's
/// primary repository (a folder holding several repositories is not one itself).
fn root(window: &Window, state: &AppState, repo: Option<PathBuf>) -> IdeResult<PathBuf> {
    let project = state.project(window.label())?;
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
fn vcs_changed(state: &AppState, window: &Window, root: &std::path::Path) {
    if let Ok(p) = state.project(window.label()) {
        p.sink.emit(ide_core::IdeEvent::VcsChanged { root: ide_core::IpcPath(root.to_path_buf()) });
    }
}

/// The repositories of the account gh is signed in to ("Get from Version Control" › GitHub); needs no project.
#[tauri::command]
#[specta::specta]
pub async fn gh_account_repos() -> IdeResult<GhAccountRepos> {
    blocking(|| Ok(ide_github::account_repositories())).await
}

#[tauri::command]
#[specta::specta]
pub async fn gh_availability(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
) -> IdeResult<GhAvailability> {
    let root = root(&window, &state, repo)?;
    blocking(move || Ok(ide_github::availability(&root))).await
}

#[tauri::command]
#[specta::specta]
pub async fn gh_pr_list(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    query: PrListQuery,
) -> IdeResult<Vec<PullRequestSummary>> {
    let root = root(&window, &state, repo)?;
    blocking(move || ide_github::list(&root, &query)).await
}

#[tauri::command]
#[specta::specta]
pub async fn gh_pr_view(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    number: u32,
) -> IdeResult<PullRequestDetails> {
    let root = root(&window, &state, repo)?;
    blocking(move || ide_github::view(&root, number)).await
}

#[tauri::command]
#[specta::specta]
pub async fn gh_pr_review_comments(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    number: u32,
) -> IdeResult<Vec<PrReviewComment>> {
    let root = root(&window, &state, repo)?;
    blocking(move || ide_github::review_comments(&root, number)).await
}

#[tauri::command]
#[specta::specta]
pub async fn gh_pr_checkout(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    request: RequestId,
    number: u32,
    on_output: Channel<String>,
) -> IdeResult<()> {
    let root = root(&window, &state, repo)?;
    let cancel = state.begin_request(request);
    let dir = root.clone();
    let result = blocking(move || {
        ide_github::checkout(&dir, number, &cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await;
    state.end_request(request);
    vcs_changed(&state, &window, &root);
    result
}

/// Creates a pull request from the current branch (pushing it first when asked); returns its URL.
#[tauri::command]
#[specta::specta]
pub async fn gh_pr_create(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    request: RequestId,
    pr: CreatePullRequest,
    on_output: Channel<String>,
) -> IdeResult<String> {
    let root = root(&window, &state, repo)?;
    let cancel = state.begin_request(request);
    let dir = root.clone();
    let result = blocking(move || {
        ide_github::create(&dir, &pr, &cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await;
    state.end_request(request);
    vcs_changed(&state, &window, &root);
    result
}

#[tauri::command]
#[specta::specta]
pub async fn gh_pr_review(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    number: u32,
    event: ReviewEvent,
    body: String,
) -> IdeResult<()> {
    let root = root(&window, &state, repo)?;
    blocking(move || ide_github::submit_review(&root, number, event, &body)).await
}

#[tauri::command]
#[specta::specta]
pub async fn gh_pr_comment(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    number: u32,
    body: String,
) -> IdeResult<()> {
    let root = root(&window, &state, repo)?;
    blocking(move || ide_github::add_comment(&root, number, &body)).await
}

/// A GitHub GraphQL / REST call through `gh api`; returns the response body.
#[tauri::command]
#[specta::specta]
pub async fn gh_api(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    request: GhApiRequest,
) -> IdeResult<String> {
    let root = root(&window, &state, repo)?;
    blocking(move || ide_github::api(&root, &request)).await
}

/// Fetches what is missing to diff a pull request locally; returns the revisions to compare.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn gh_pr_prepare_diff(
    window: Window,
    state: State<'_, AppState>,
    repo: Option<PathBuf>,
    request: RequestId,
    number: u32,
    head_oid: String,
    base_oid: String,
    base_ref: String,
    name_with_owner: String,
    on_output: Channel<String>,
) -> IdeResult<PrDiffRevisions> {
    let root = root(&window, &state, repo)?;
    let cancel = state.begin_request(request);
    let result = blocking(move || {
        ide_github::prepare_diff(&root, number, &head_oid, &base_oid, &base_ref, &name_with_owner, &cancel, &|line| {
            let _ = on_output.send(line);
        })
    })
    .await;
    state.end_request(request);
    result
}
