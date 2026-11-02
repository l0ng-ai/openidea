//! IPC types for pull requests and their parsers from `gh … --json` output.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Whether pull requests can be shown for the project, and why not.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GhAvailability {
    Ready {
        repo: GhRepo,
        /// The signed-in user.
        login: Option<String>,
    },
    /// No `gh` executable was found.
    NotInstalled,
    /// `gh auth login` has not been run (or the token expired).
    NotLoggedIn {
        message: String,
    },
    /// The project has no GitHub remote (or is not a git repository).
    NotGitHub {
        message: String,
    },
    Error {
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GhRepo {
    /// `owner/name`.
    pub name_with_owner: String,
    pub url: String,
    pub default_branch: Option<String>,
    /// Merge methods the repository allows (all of them when gh does not say).
    pub merge_commit_allowed: bool,
    pub squash_merge_allowed: bool,
    pub rebase_merge_allowed: bool,
    /// The signed-in user's permission: `ADMIN`, `MAINTAIN`, `WRITE`, `TRIAGE`, `READ`; empty when unknown.
    pub viewer_permission: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

impl PrState {
    fn parse(s: &str) -> Self {
        match s.to_ascii_uppercase().as_str() {
            "MERGED" => Self::Merged,
            "CLOSED" => Self::Closed,
            _ => Self::Open,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrLabel {
    pub name: String,
    /// Hex colour without `#`, as GitHub stores it.
    pub color: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: u32,
    pub title: String,
    pub author: String,
    pub state: PrState,
    pub is_draft: bool,
    pub head_ref: String,
    pub base_ref: String,
    pub created_at: String,
    pub updated_at: String,
    pub labels: Vec<PrLabel>,
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or `None`.
    pub review_decision: Option<String>,
    pub url: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Pending,
    Success,
    Failure,
    Cancelled,
    Skipped,
    Neutral,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    /// Workflow of a check run (GitHub Actions), if any.
    pub workflow: Option<String>,
    pub status: CheckStatus,
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewer {
    pub login: String,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, or `REQUESTED` (no review yet).
    pub state: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrCommit {
    pub oid: String,
    pub headline: String,
    pub body: String,
    pub author: String,
    pub date: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
    /// `ADDED`, `MODIFIED`, `DELETED`, `RENAMED`, `COPIED`, `CHANGED`.
    pub change_type: String,
}

/// A conversation comment or a submitted review (the timeline).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrTimelineItem {
    pub author: String,
    pub body: String,
    pub created_at: String,
    /// `None` for comments; the review state for reviews.
    pub review_state: Option<String>,
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetails {
    pub summary: PullRequestSummary,
    pub body: String,
    pub head_oid: String,
    pub base_oid: String,
    /// `MERGEABLE`, `CONFLICTING`, `UNKNOWN`.
    pub mergeable: String,
    /// GitHub's merge box state: `CLEAN`, `UNSTABLE`, `HAS_HOOKS`, `BLOCKED`, `BEHIND`, `DIRTY`, `DRAFT`, `UNKNOWN`.
    pub merge_state_status: String,
    pub is_cross_repository: bool,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
    pub checks: Vec<PrCheck>,
    pub reviewers: Vec<PrReviewer>,
    pub assignees: Vec<String>,
    pub commits: Vec<PrCommit>,
    pub files: Vec<PrFile>,
    /// Comments and reviews, oldest first.
    pub timeline: Vec<PrTimelineItem>,
}

/// An inline review comment on a diff line.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewComment {
    pub id: u64,
    pub in_reply_to: Option<u64>,
    pub path: String,
    /// 1-based line in the current diff; `None` when the comment is outdated.
    pub line: Option<u32>,
    pub original_line: Option<u32>,
    /// `LEFT` (base) or `RIGHT` (head).
    pub side: String,
    pub body: String,
    pub author: String,
    pub created_at: String,
    pub url: String,
    pub diff_hunk: String,
}

// ---- raw gh shapes ----

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawActor {
    login: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawLabel {
    name: String,
    color: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawSummary {
    number: u32,
    title: String,
    author: Option<RawActor>,
    state: String,
    is_draft: bool,
    head_ref_name: String,
    base_ref_name: String,
    created_at: String,
    updated_at: String,
    labels: Vec<RawLabel>,
    review_decision: Option<String>,
    url: String,
    additions: u32,
    deletions: u32,
}

impl RawSummary {
    fn into_summary(self) -> PullRequestSummary {
        PullRequestSummary {
            number: self.number,
            title: self.title,
            author: self.author.map(|a| a.login).unwrap_or_else(|| "ghost".into()),
            state: PrState::parse(&self.state),
            is_draft: self.is_draft,
            head_ref: self.head_ref_name,
            base_ref: self.base_ref_name,
            created_at: self.created_at,
            updated_at: self.updated_at,
            labels: self.labels.into_iter().map(|l| PrLabel { name: l.name, color: l.color }).collect(),
            review_decision: self.review_decision.filter(|d| !d.is_empty()),
            url: self.url,
            additions: self.additions,
            deletions: self.deletions,
        }
    }
}

/// Fields requested from `gh pr list`.
pub const LIST_FIELDS: &str = "number,title,author,state,isDraft,headRefName,baseRefName,createdAt,updatedAt,labels,reviewDecision,url,additions,deletions";

/// Fields requested from `gh pr view`.
pub const VIEW_FIELDS: &str = "number,title,author,state,isDraft,headRefName,baseRefName,createdAt,updatedAt,labels,reviewDecision,url,additions,deletions,body,headRefOid,baseRefOid,mergeable,mergeStateStatus,isCrossRepository,mergedAt,closedAt,statusCheckRollup,reviewRequests,reviews,assignees,commits,files,comments";

pub fn parse_list(json: &str) -> serde_json::Result<Vec<PullRequestSummary>> {
    let raw: Vec<RawSummary> = serde_json::from_str(json)?;
    Ok(raw.into_iter().map(RawSummary::into_summary).collect())
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawCheck {
    #[serde(rename = "__typename")]
    typename: String,
    // CheckRun
    name: String,
    status: String,
    conclusion: String,
    details_url: String,
    workflow_name: String,
    // StatusContext
    context: String,
    state: String,
    target_url: String,
}

fn check_status(c: &RawCheck) -> CheckStatus {
    if c.typename == "StatusContext" || (!c.context.is_empty() && c.name.is_empty()) {
        return match c.state.as_str() {
            "SUCCESS" => CheckStatus::Success,
            "FAILURE" | "ERROR" => CheckStatus::Failure,
            _ => CheckStatus::Pending,
        };
    }
    if c.status != "COMPLETED" {
        return CheckStatus::Pending;
    }
    match c.conclusion.as_str() {
        "SUCCESS" => CheckStatus::Success,
        "FAILURE" | "TIMED_OUT" | "STARTUP_FAILURE" | "ACTION_REQUIRED" => CheckStatus::Failure,
        "CANCELLED" => CheckStatus::Cancelled,
        "SKIPPED" => CheckStatus::Skipped,
        _ => CheckStatus::Neutral,
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawRequest {
    login: Option<String>,
    /// Team requests carry a name / slug instead of a login.
    name: Option<String>,
    slug: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawReview {
    author: Option<RawActor>,
    body: String,
    state: String,
    submitted_at: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawComment {
    author: Option<RawActor>,
    body: String,
    created_at: String,
    url: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawCommit {
    oid: String,
    message_headline: String,
    message_body: String,
    committed_date: String,
    authors: Vec<RawCommitAuthor>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawCommitAuthor {
    login: String,
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawFile {
    path: String,
    additions: u32,
    deletions: u32,
    change_type: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawDetails {
    #[serde(flatten)]
    summary: RawSummary,
    body: String,
    head_ref_oid: String,
    base_ref_oid: String,
    mergeable: String,
    merge_state_status: String,
    is_cross_repository: bool,
    merged_at: Option<String>,
    closed_at: Option<String>,
    status_check_rollup: Vec<RawCheck>,
    review_requests: Vec<RawRequest>,
    reviews: Vec<RawReview>,
    assignees: Vec<RawActor>,
    commits: Vec<RawCommit>,
    files: Vec<RawFile>,
    comments: Vec<RawComment>,
}

/// The reviewers panel: each reviewer's latest significant review (a later plain
/// comment does not hide an approval), then requested reviewers who have not
/// reviewed yet. The author's own comments are left out.
fn reviewers(author: &str, reviews: &[RawReview], requests: &[RawRequest]) -> Vec<PrReviewer> {
    let mut out: Vec<PrReviewer> = Vec::new();
    for r in reviews {
        let Some(login) = r.author.as_ref().map(|a| a.login.as_str()).filter(|l| !l.is_empty() && *l != author) else {
            continue;
        };
        if r.state == "PENDING" {
            continue;
        }
        match out.iter_mut().find(|x| x.login == login) {
            Some(x) => {
                if r.state != "COMMENTED" || x.state == "COMMENTED" {
                    x.state = r.state.clone();
                }
            }
            None => out.push(PrReviewer { login: login.to_owned(), state: r.state.clone() }),
        }
    }
    for q in requests {
        let Some(login) = q.login.clone().or_else(|| q.slug.clone()).or_else(|| q.name.clone()) else { continue };
        // A re-requested review supersedes the earlier one.
        match out.iter_mut().find(|x| x.login == login) {
            Some(x) => x.state = "REQUESTED".into(),
            None => out.push(PrReviewer { login, state: "REQUESTED".into() }),
        }
    }
    out
}

pub fn parse_view(json: &str) -> serde_json::Result<PullRequestDetails> {
    let raw: RawDetails = serde_json::from_str(json)?;
    let author = raw.summary.author.as_ref().map(|a| a.login.clone()).unwrap_or_default();
    let reviewers = reviewers(&author, &raw.reviews, &raw.review_requests);
    let mut timeline: Vec<PrTimelineItem> = raw
        .comments
        .into_iter()
        .map(|c| PrTimelineItem {
            author: c.author.map(|a| a.login).unwrap_or_else(|| "ghost".into()),
            body: c.body,
            created_at: c.created_at,
            review_state: None,
            url: Some(c.url).filter(|u| !u.is_empty()),
        })
        .chain(
            raw.reviews
                .into_iter()
                // Empty "commented" reviews only carry inline comments, listed separately.
                .filter(|r| r.state != "PENDING" && !(r.state == "COMMENTED" && r.body.trim().is_empty()))
                .map(|r| PrTimelineItem {
                    author: r.author.map(|a| a.login).unwrap_or_else(|| "ghost".into()),
                    body: r.body,
                    created_at: r.submitted_at,
                    review_state: Some(r.state),
                    url: None,
                }),
        )
        .collect();
    timeline.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let mut checks: Vec<PrCheck> = raw
        .status_check_rollup
        .iter()
        .map(|c| PrCheck {
            name: if c.name.is_empty() { c.context.clone() } else { c.name.clone() },
            workflow: Some(c.workflow_name.clone()).filter(|w| !w.is_empty()),
            status: check_status(c),
            url: [&c.details_url, &c.target_url].into_iter().find(|u| !u.is_empty()).cloned(),
        })
        .collect();
    // Failures first, then running, then the rest (GitHub's merge box order).
    checks.sort_by_key(|c| match c.status {
        CheckStatus::Failure => 0,
        CheckStatus::Pending => 1,
        _ => 2,
    });
    Ok(PullRequestDetails {
        body: raw.body,
        head_oid: raw.head_ref_oid,
        base_oid: raw.base_ref_oid,
        mergeable: raw.mergeable,
        merge_state_status: raw.merge_state_status,
        is_cross_repository: raw.is_cross_repository,
        merged_at: raw.merged_at.filter(|s| !s.is_empty()),
        closed_at: raw.closed_at.filter(|s| !s.is_empty()),
        checks,
        reviewers,
        assignees: raw.assignees.into_iter().map(|a| a.login).collect(),
        commits: raw
            .commits
            .into_iter()
            .map(|c| PrCommit {
                author: c
                    .authors
                    .first()
                    .map(|a| if a.login.is_empty() { a.name.clone() } else { a.login.clone() })
                    .unwrap_or_default(),
                oid: c.oid,
                headline: c.message_headline,
                body: c.message_body,
                date: c.committed_date,
            })
            .collect(),
        files: raw
            .files
            .into_iter()
            .map(|f| PrFile {
                path: f.path,
                additions: f.additions,
                deletions: f.deletions,
                change_type: f.change_type,
            })
            .collect(),
        timeline,
        summary: raw.summary.into_summary(),
    })
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawReviewComment {
    id: u64,
    in_reply_to_id: Option<u64>,
    path: String,
    line: Option<u32>,
    original_line: Option<u32>,
    side: Option<String>,
    body: String,
    user: Option<RawActor>,
    created_at: String,
    html_url: String,
    diff_hunk: String,
}

/// `gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate`: one JSON array per page,
/// concatenated (or an array of pages with `--slurp`).
pub fn parse_review_comments(text: &str) -> serde_json::Result<Vec<PrReviewComment>> {
    let mut raw: Vec<RawReviewComment> = Vec::new();
    for value in serde_json::Deserializer::from_str(text).into_iter::<serde_json::Value>() {
        let value = value?;
        let pages = match value {
            serde_json::Value::Array(items) if items.iter().all(|i| i.is_array()) && !items.is_empty() => items,
            other => vec![other],
        };
        for page in pages {
            raw.extend(serde_json::from_value::<Vec<RawReviewComment>>(page)?);
        }
    }
    let mut out: Vec<PrReviewComment> = raw
        .into_iter()
        .map(|c| PrReviewComment {
            id: c.id,
            in_reply_to: c.in_reply_to_id,
            path: c.path,
            line: c.line,
            original_line: c.original_line,
            side: c.side.unwrap_or_else(|| "RIGHT".into()),
            body: c.body,
            author: c.user.map(|u| u.login).unwrap_or_else(|| "ghost".into()),
            created_at: c.created_at,
            url: c.html_url,
            diff_hunk: c.diff_hunk,
        })
        .collect();
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(out)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RawRepo {
    name_with_owner: String,
    url: String,
    default_branch_ref: Option<RawBranchRef>,
    merge_commit_allowed: Option<bool>,
    squash_merge_allowed: Option<bool>,
    rebase_merge_allowed: Option<bool>,
    viewer_permission: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawBranchRef {
    name: String,
}

/// Fields requested from `gh repo view`.
pub const REPO_FIELDS: &str =
    "nameWithOwner,url,defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerPermission";

/// `gh repo view --json` with [`REPO_FIELDS`].
pub fn parse_repo(json: &str) -> serde_json::Result<GhRepo> {
    let raw: RawRepo = serde_json::from_str(json)?;
    Ok(GhRepo {
        name_with_owner: raw.name_with_owner,
        url: raw.url,
        default_branch: raw.default_branch_ref.map(|b| b.name).filter(|n| !n.is_empty()),
        merge_commit_allowed: raw.merge_commit_allowed.unwrap_or(true),
        squash_merge_allowed: raw.squash_merge_allowed.unwrap_or(true),
        rebase_merge_allowed: raw.rebase_merge_allowed.unwrap_or(true),
        viewer_permission: raw.viewer_permission.unwrap_or_default(),
    })
}

/// What a failed gh command's message means for the Pull Requests view.
pub fn classify_failure(message: &str) -> GhAvailability {
    let lower = message.to_ascii_lowercase();
    let message = message.trim().to_owned();
    if lower.contains("gh auth login")
        || lower.contains("not logged in")
        || lower.contains("authentication required")
        || lower.contains("bad credentials")
        || lower.contains("http 401")
    {
        GhAvailability::NotLoggedIn { message }
    } else if lower.contains("none of the git remotes")
        || lower.contains("no git remotes")
        || lower.contains("not a git repository")
        || lower.contains("could not determine base repo")
        || lower.contains("unable to determine base repository")
    {
        GhAvailability::NotGitHub { message }
    } else {
        GhAvailability::Error { message }
    }
}

/// The remote whose URL points at `owner/name` (any GitHub URL form), if any.
pub fn remote_for<'a>(remotes: &'a [ide_vcs::Remote], name_with_owner: &str) -> Option<&'a ide_vcs::Remote> {
    let want = name_with_owner.to_ascii_lowercase();
    remotes.iter().find(|r| {
        let url = r.url.trim_end_matches('/').to_ascii_lowercase();
        let url = url.strip_suffix(".git").unwrap_or(&url);
        url.ends_with(&format!("/{want}")) || url.ends_with(&format!(":{want}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_failures() {
        assert!(matches!(
            classify_failure("To get started with GitHub CLI, please run:  gh auth login"),
            GhAvailability::NotLoggedIn { .. }
        ));
        assert!(matches!(
            classify_failure("none of the git remotes configured for this repository point to a known GitHub host."),
            GhAvailability::NotGitHub { .. }
        ));
        assert!(matches!(classify_failure("HTTP 502: bad gateway"), GhAvailability::Error { .. }));
    }

    #[test]
    fn finds_remote_by_repo() {
        let remotes = vec![
            ide_vcs::Remote { name: "origin".into(), url: "git@github.com:me/App.git".into() },
            ide_vcs::Remote { name: "upstream".into(), url: "https://github.com/org/app/".into() },
        ];
        assert_eq!(remote_for(&remotes, "me/app").map(|r| r.name.as_str()), Some("origin"));
        assert_eq!(remote_for(&remotes, "org/app").map(|r| r.name.as_str()), Some("upstream"));
        assert_eq!(remote_for(&remotes, "x/app"), None);
    }

    #[test]
    fn reviewers_keep_significant_state() {
        let rv = |who: &str, state: &str| RawReview {
            author: Some(RawActor { login: who.into() }),
            state: state.into(),
            ..Default::default()
        };
        let reviews = [
            rv("ann", "APPROVED"),
            rv("ann", "COMMENTED"),
            rv("bob", "COMMENTED"),
            rv("me", "COMMENTED"),
            rv("bob", "CHANGES_REQUESTED"),
        ];
        let requests = [
            RawRequest { login: Some("cat".into()), ..Default::default() },
            RawRequest { slug: Some("core".into()), ..Default::default() },
        ];
        let got = reviewers("me", &reviews, &requests);
        let pairs: Vec<(&str, &str)> = got.iter().map(|r| (r.login.as_str(), r.state.as_str())).collect();
        assert_eq!(
            pairs,
            [("ann", "APPROVED"), ("bob", "CHANGES_REQUESTED"), ("cat", "REQUESTED"), ("core", "REQUESTED")]
        );
    }
}
