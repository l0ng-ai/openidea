//! GitHub pull requests through the `gh` CLI. Authentication is gh's own
//! (`gh auth login`); the repository is resolved by gh from the project's remotes.
//!
//! Every function blocks; callers run them off the UI / command threads.

mod model;
mod process;

pub use model::*;

use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_vcs::Repo;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

/// API calls normally answer within a few seconds.
const QUICK: Duration = Duration::from_secs(60);

/// Locates the gh executable once per process (GUI apps on macOS have a minimal `PATH`).
pub fn gh_executable() -> Option<PathBuf> {
    static GH: OnceLock<Option<PathBuf>> = OnceLock::new();
    GH.get_or_init(|| {
        if let Some(explicit) = std::env::var_os("OPENIDEA_GH").map(PathBuf::from).filter(|p| p.is_file()) {
            return Some(explicit);
        }
        if let Ok(found) = which::which("gh") {
            return Some(found);
        }
        let candidates: &[&str] = if cfg!(windows) {
            &[r"C:\Program Files\GitHub CLI\gh.exe"]
        } else {
            &["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "/snap/bin/gh"]
        };
        candidates.iter().map(PathBuf::from).find(|p| p.is_file())
    })
    .clone()
}

fn command(root: &Path, args: &[&str]) -> IdeResult<Command> {
    let exe =
        gh_executable().ok_or_else(|| IdeError::unavailable("gh executable not found; install the GitHub CLI"))?;
    let mut cmd = Command::new(exe);
    cmd.current_dir(root)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PAGER", "cat")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("GIT_TERMINAL_PROMPT", "0");
    tracing::debug!(?args, "gh");
    Ok(cmd)
}

fn failure(stderr: &str, stdout: &str) -> IdeError {
    let msg = [stderr, stdout].iter().map(|s| s.trim()).find(|s| !s.is_empty()).unwrap_or("gh failed").to_owned();
    match classify_failure(&msg) {
        GhAvailability::NotLoggedIn { message } | GhAvailability::NotGitHub { message } => {
            IdeError::unavailable(message)
        }
        _ => {
            if msg.to_ascii_lowercase().contains("could not resolve to a pullrequest") || msg.contains("HTTP 404") {
                IdeError::not_found(msg)
            } else {
                IdeError::internal(msg)
            }
        }
    }
}

fn run(root: &Path, args: &[&str]) -> IdeResult<String> {
    let out = process::run(command(root, args)?, QUICK, None)?;
    if out.success { Ok(out.stdout) } else { Err(failure(&out.stderr, &out.stdout)) }
}

fn run_streaming(
    root: &Path,
    args: &[&str],
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<String> {
    let mut stdout = String::new();
    let (ok, stderr) = process::stream(command(root, args)?, cancel, &mut |stream, line| {
        if stream == process::Stream::Stdout {
            stdout.push_str(&line);
            stdout.push('\n');
        }
        if !line.trim().is_empty() {
            on_output(line);
        }
    })?;
    if ok { Ok(stdout) } else { Err(failure(&stderr.join("\n"), &stdout)) }
}

fn parse<T>(r: serde_json::Result<T>) -> IdeResult<T> {
    r.map_err(|e| IdeError::new(ide_core::error::ErrorKind::Protocol, format!("unexpected gh output: {e}")))
}

/// Whether gh is installed and signed in, and which GitHub repository `root` maps to.
pub fn availability(root: &Path) -> GhAvailability {
    if gh_executable().is_none() {
        return GhAvailability::NotInstalled;
    }
    let (repo, login) = std::thread::scope(|s| {
        let repo = s.spawn(|| {
            let cmd = command(root, &["repo", "view", "--json", REPO_FIELDS])?;
            process::run(cmd, QUICK, None)
        });
        let login = s.spawn(|| run(root, &["api", "user", "--jq", ".login"]));
        (repo.join(), login.join())
    });
    let login = login.ok().and_then(Result::ok).map(|l| l.trim().to_owned()).filter(|l| !l.is_empty());
    match repo {
        Ok(Ok(out)) if out.success => match parse_repo(&out.stdout) {
            Ok(repo) => GhAvailability::Ready { repo, login },
            Err(e) => GhAvailability::Error { message: format!("unexpected gh output: {e}") },
        },
        Ok(Ok(out)) => classify_failure(if out.stderr.trim().is_empty() { &out.stdout } else { &out.stderr }),
        Ok(Err(e)) => GhAvailability::Error { message: e.message },
        Err(_) => GhAvailability::Error { message: "gh check panicked".into() },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PrStateFilter {
    Open,
    Closed,
    Merged,
    All,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrListQuery {
    pub state: PrStateFilter,
    pub author_me: bool,
    pub review_requested: bool,
    pub assignee_me: bool,
    /// Free text / GitHub search qualifiers.
    pub search: String,
    pub limit: u32,
}

/// `gh pr list` arguments for `q`.
pub fn list_args(q: &PrListQuery) -> Vec<String> {
    let mut args: Vec<String> = ["pr", "list", "--json", LIST_FIELDS].iter().map(|s| s.to_string()).collect();
    args.push("--limit".into());
    args.push(q.limit.clamp(1, 500).to_string());
    args.push("--state".into());
    args.push(
        match q.state {
            PrStateFilter::Open => "open",
            PrStateFilter::Closed => "closed",
            PrStateFilter::Merged => "merged",
            PrStateFilter::All => "all",
        }
        .into(),
    );
    if q.author_me {
        args.push("--author".into());
        args.push("@me".into());
    }
    if q.assignee_me {
        args.push("--assignee".into());
        args.push("@me".into());
    }
    let mut search: Vec<&str> = Vec::new();
    if q.review_requested {
        search.push("review-requested:@me");
    }
    if !q.search.trim().is_empty() {
        search.push(q.search.trim());
    }
    if !search.is_empty() {
        args.push("--search".into());
        args.push(search.join(" "));
    }
    args
}

pub fn list(root: &Path, q: &PrListQuery) -> IdeResult<Vec<PullRequestSummary>> {
    let args = list_args(q);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    parse(parse_list(&run(root, &refs)?))
}

pub fn view(root: &Path, number: u32) -> IdeResult<PullRequestDetails> {
    let n = number.to_string();
    parse(parse_view(&run(root, &["pr", "view", &n, "--json", VIEW_FIELDS])?))
}

/// Inline review comments of a pull request (every page).
pub fn review_comments(root: &Path, number: u32) -> IdeResult<Vec<PrReviewComment>> {
    let path = format!("repos/{{owner}}/{{repo}}/pulls/{number}/comments?per_page=100");
    parse(parse_review_comments(&run(root, &["api", "--paginate", &path])?))
}

/// `gh pr checkout <n>`: creates / updates a local branch for the pull request and switches to it.
pub fn checkout(root: &Path, number: u32, cancel: &CancellationToken, on_output: &dyn Fn(String)) -> IdeResult<()> {
    let n = number.to_string();
    run_streaming(root, &["pr", "checkout", &n], cancel, on_output).map(drop)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatePullRequest {
    pub title: String,
    pub body: String,
    pub base: String,
    pub draft: bool,
    /// Push the current branch (setting its upstream) before creating.
    pub push: bool,
}

/// Creates a pull request from the current branch; returns its URL.
pub fn create(
    root: &Path,
    req: &CreatePullRequest,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<String> {
    if req.title.trim().is_empty() {
        return Err(IdeError::invalid("the title must not be empty"));
    }
    if req.base.trim().is_empty() || req.base.starts_with('-') {
        return Err(IdeError::invalid("choose a base branch"));
    }
    if req.push {
        let repo = Repo::discover(root)?.ok_or_else(|| IdeError::invalid("not a git repository"))?;
        repo.push(false, true, cancel, on_output)?;
    }
    let mut args = vec!["pr", "create", "--title", req.title.trim(), "--body", &req.body, "--base", req.base.trim()];
    if req.draft {
        args.push("--draft");
    }
    let out = run_streaming(root, &args, cancel, on_output)?;
    Ok(out.lines().map(str::trim).rfind(|l| l.starts_with("http")).unwrap_or_default().to_owned())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewEvent {
    Approve,
    RequestChanges,
    Comment,
}

/// Submits a review (`gh pr review`). Request changes and comment need a body.
pub fn submit_review(root: &Path, number: u32, event: ReviewEvent, body: &str) -> IdeResult<()> {
    if !matches!(event, ReviewEvent::Approve) && body.trim().is_empty() {
        return Err(IdeError::invalid("write a review comment first"));
    }
    let n = number.to_string();
    let flag = match event {
        ReviewEvent::Approve => "--approve",
        ReviewEvent::RequestChanges => "--request-changes",
        ReviewEvent::Comment => "--comment",
    };
    let mut args = vec!["pr", "review", &n, flag];
    if !body.trim().is_empty() {
        args.push("--body");
        args.push(body);
    }
    run(root, &args).map(drop)
}

/// Adds a conversation comment.
pub fn add_comment(root: &Path, number: u32, body: &str) -> IdeResult<()> {
    if body.trim().is_empty() {
        return Err(IdeError::invalid("the comment is empty"));
    }
    let n = number.to_string();
    run(root, &["pr", "comment", &n, "--body", body]).map(drop)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergePullRequest {
    pub method: MergeMethod,
    /// Commit subject and body (merge / squash; ignored for rebase). Empty: GitHub's default.
    pub subject: String,
    pub body: String,
    /// The head the user saw: the merge fails if the branch moved since.
    pub head_oid: String,
    /// Merge with administrator privileges although requirements are not met.
    pub admin: bool,
}

/// `gh pr merge` arguments for `req`.
pub fn merge_args(number: u32, req: &MergePullRequest) -> Vec<String> {
    let mut args: Vec<String> = vec!["pr".into(), "merge".into(), number.to_string()];
    args.push(
        match req.method {
            MergeMethod::Merge => "--merge",
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
        }
        .into(),
    );
    if req.method != MergeMethod::Rebase {
        if !req.subject.trim().is_empty() {
            args.push("--subject".into());
            args.push(req.subject.trim().into());
        }
        if !req.body.trim().is_empty() {
            args.push("--body".into());
            args.push(req.body.trim_end().into());
        }
    }
    if !req.head_oid.is_empty() {
        args.push("--match-head-commit".into());
        args.push(req.head_oid.clone());
    }
    if req.admin {
        args.push("--admin".into());
    }
    args
}

pub fn merge(root: &Path, number: u32, req: &MergePullRequest) -> IdeResult<()> {
    let args = merge_args(number, req);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(root, &refs).map(drop)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PrStateChange {
    Close,
    Reopen,
    /// Draft → ready for review.
    Ready,
}

/// Closes, reopens or marks a draft ready for review (`gh pr close|reopen|ready`).
pub fn change_state(root: &Path, number: u32, change: PrStateChange) -> IdeResult<()> {
    let n = number.to_string();
    let verb = match change {
        PrStateChange::Close => "close",
        PrStateChange::Reopen => "reopen",
        PrStateChange::Ready => "ready",
    };
    run(root, &["pr", verb, &n]).map(drop)
}

/// Requests reviews from `logins` (`gh pr edit --add-reviewer`).
pub fn add_reviewers(root: &Path, number: u32, logins: &[String]) -> IdeResult<()> {
    let logins: Vec<&str> = logins.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if logins.is_empty() {
        return Err(IdeError::invalid("choose a reviewer"));
    }
    if let Some(bad) = logins.iter().find(|l| l.starts_with('-') || l.contains(',')) {
        return Err(IdeError::invalid(format!("not a GitHub login: {bad}")));
    }
    let n = number.to_string();
    let list = logins.join(",");
    run(root, &["pr", "edit", &n, "--add-reviewer", &list]).map(drop)
}

/// Users a review can be requested from (the repository's assignable users).
pub fn potential_reviewers(root: &Path) -> IdeResult<Vec<String>> {
    let out = run(root, &["api", "--paginate", "repos/{owner}/{repo}/assignees?per_page=100", "--jq", ".[].login"])?;
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
}

/// A GitHub API call through `gh api`: GraphQL (`endpoint` `graphql`, `body`
/// `{"query", "variables"}`) or REST (`repos/{owner}/{repo}/…`, gh fills in the
/// placeholders from the project's remote).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GhApiRequest {
    /// `GET`, `POST`, `PATCH`, `PUT`, `DELETE`.
    pub method: String,
    pub endpoint: String,
    /// JSON request body, sent on stdin.
    pub body: Option<String>,
    /// Follow REST `Link` pages; the result is the array of all pages (`--slurp`).
    pub paginate: bool,
}

const METHODS: &[&str] = &["GET", "POST", "PATCH", "PUT", "DELETE"];

/// `gh api` arguments for `req`.
pub fn api_args(req: &GhApiRequest) -> IdeResult<Vec<String>> {
    let method = req.method.to_ascii_uppercase();
    if !METHODS.contains(&method.as_str()) {
        return Err(IdeError::invalid(format!("unsupported HTTP method {}", req.method)));
    }
    let endpoint = req.endpoint.trim();
    if endpoint.is_empty() || endpoint.starts_with('-') || endpoint.contains("://") {
        return Err(IdeError::invalid(format!("not a GitHub API endpoint: {endpoint}")));
    }
    let mut args: Vec<String> = vec!["api".into(), "--method".into(), method, endpoint.into()];
    if req.body.is_some() {
        args.push("--input".into());
        args.push("-".into());
    }
    if req.paginate {
        args.push("--paginate".into());
        args.push("--slurp".into());
    }
    Ok(args)
}

/// Runs `req`; returns the response body (JSON text, empty for `204 No Content`).
pub fn api(root: &Path, req: &GhApiRequest) -> IdeResult<String> {
    let args = api_args(req)?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = process::run_with_input(command(root, &refs)?, req.body.as_deref(), QUICK, None)?;
    if out.success { Ok(out.stdout) } else { Err(failure(&out.stderr, &out.stdout)) }
}

/// Revisions to diff a pull request's files with, present in the local repository.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrDiffRevisions {
    /// Merge base of base and head (what GitHub's "Files changed" compares with).
    pub base: String,
    pub head: String,
    /// Changed files with rename information.
    pub files: Vec<ide_vcs::ChangedFile>,
    /// Worktree root the file paths are relative to.
    pub root: ide_core::IpcPath,
}

/// Makes sure the pull request's head and base commits are available locally
/// (fetching `refs/pull/<n>/head` and the base branch from the matching remote),
/// then returns the revisions to compare.
#[allow(clippy::too_many_arguments)]
pub fn prepare_diff(
    root: &Path,
    number: u32,
    head_oid: &str,
    base_oid: &str,
    base_ref: &str,
    name_with_owner: &str,
    cancel: &CancellationToken,
    on_output: &dyn Fn(String),
) -> IdeResult<PrDiffRevisions> {
    let repo = Repo::discover(root)?.ok_or_else(|| IdeError::invalid("not a git repository"))?;
    if !repo.has_commit(head_oid) || !repo.has_commit(base_oid) {
        let remotes = repo.remotes()?;
        let remote = remote_for(&remotes, name_with_owner)
            .or_else(|| remotes.iter().find(|r| r.name == "origin"))
            .or(remotes.first())
            .ok_or_else(|| IdeError::invalid("the repository has no remotes"))?;
        let mut refspecs = vec![format!("refs/pull/{number}/head")];
        if !base_ref.is_empty() {
            refspecs.push(format!("refs/heads/{base_ref}"));
        }
        repo.fetch_refspecs(&remote.name, &refspecs, cancel, on_output)?;
        if !repo.has_commit(head_oid) {
            return Err(IdeError::not_found(format!("commit {head_oid} of #{number} could not be fetched")));
        }
    }
    let base = if repo.has_commit(base_oid) {
        repo.merge_base(base_oid, head_oid)?.unwrap_or_else(|| base_oid.to_owned())
    } else {
        format!("{head_oid}~1")
    };
    let files = repo.diff_files(&base, head_oid)?;
    Ok(PrDiffRevisions { base, head: head_oid.to_owned(), files, root: ide_core::IpcPath(repo.root().to_path_buf()) })
}
