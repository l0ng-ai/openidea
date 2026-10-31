//! Parsing of recorded `gh` JSON output.

use ide_github::*;

#[test]
fn pr_list() {
    let prs = parse_list(include_str!("fixtures/pr_list.json")).unwrap();
    assert_eq!(prs.len(), 2);
    assert_eq!(prs[0].number, 14770);
    assert_eq!(prs[0].state, PrState::Merged);
    assert_eq!(prs[0].author, "BagToad");
    assert_eq!(prs[0].review_decision.as_deref(), Some("APPROVED"));
    assert_eq!(prs[1].labels, [PrLabel { name: "dependencies".into(), color: "0366d6".into() }]);
    assert!(prs[1].is_draft);
    assert_eq!(prs[1].state, PrState::Open);
    assert_eq!(prs[1].review_decision, None, "empty decision means none");
}

#[test]
fn pr_view() {
    let pr = parse_view(include_str!("fixtures/pr_view.json")).unwrap();
    assert_eq!(pr.summary.number, 14768);
    assert_eq!(pr.summary.head_ref, "babakks/refresh-token-bump-deps");
    assert_eq!(pr.head_oid, "6ec1ba54542baca6cc5932582634104c83f36a28");
    assert_eq!(pr.merge_state_status, "UNKNOWN");
    assert_eq!(pr.files.len(), 2);
    assert_eq!(pr.files[0].change_type, "MODIFIED");
    assert_eq!(pr.commits[0].headline, "chore(deps): bump github.com/cli/oauth to v1.3.0");
    assert_eq!(pr.commits[0].author, "babakks");
    let statuses: Vec<(&str, CheckStatus)> = pr.checks.iter().map(|c| (c.name.as_str(), c.status)).collect();
    assert_eq!(
        statuses,
        [
            ("lint", CheckStatus::Failure),
            ("build (windows)", CheckStatus::Pending),
            ("ci/legacy", CheckStatus::Pending),
            ("build (ubuntu)", CheckStatus::Success),
            ("docs", CheckStatus::Skipped)
        ]
    );
    assert_eq!(pr.checks[3].workflow.as_deref(), Some("Tests"));
    let reviewers: Vec<(&str, &str)> = pr.reviewers.iter().map(|r| (r.login.as_str(), r.state.as_str())).collect();
    assert_eq!(
        reviewers,
        [("copilot-pull-request-reviewer", "COMMENTED"), ("williammartin", "APPROVED"), ("niik", "REQUESTED")]
    );
    // The empty COMMENTED review is left out; the comment and approval are in date order.
    let timeline: Vec<(&str, Option<&str>)> =
        pr.timeline.iter().map(|t| (t.author.as_str(), t.review_state.as_deref())).collect();
    assert_eq!(timeline, [("babakks", None), ("williammartin", Some("APPROVED"))]);
    assert_eq!(pr.merged_at.as_deref(), Some("2026-10-21T12:29:58Z"));
}

#[test]
fn review_comments_across_pages() {
    let c = parse_review_comments(include_str!("fixtures/review_comments.json")).unwrap();
    assert_eq!(c.len(), 3);
    assert_eq!(c[0].path, "pkg/cmd/status/status.go");
    assert_eq!(c[0].line, Some(679));
    assert_eq!(c[0].side, "RIGHT");
    assert_eq!(c[0].author, "Copilot");
    assert_eq!(c[1].in_reply_to, Some(4335329893));
    assert_eq!(c[2].line, None, "outdated comment");
    assert_eq!(c[2].side, "LEFT");
}

#[test]
fn repo_view() {
    let r = parse_repo(r#"{"defaultBranchRef":{"name":"main"},"nameWithOwner":"l0ng-ai/openidea","url":"https://github.com/l0ng-ai/openidea"}"#)
        .unwrap();
    assert_eq!(r.name_with_owner, "l0ng-ai/openidea");
    assert_eq!(r.default_branch.as_deref(), Some("main"));
    assert!(r.merge_commit_allowed && r.squash_merge_allowed && r.rebase_merge_allowed, "unknown: allowed");
    assert_eq!(r.viewer_permission, "");

    let r = parse_repo(
        r#"{"mergeCommitAllowed":true,"nameWithOwner":"o/r","url":"","rebaseMergeAllowed":false,"squashMergeAllowed":false,"viewerPermission":"WRITE"}"#,
    )
    .unwrap();
    assert!(r.merge_commit_allowed);
    assert!(!r.squash_merge_allowed && !r.rebase_merge_allowed);
    assert_eq!(r.viewer_permission, "WRITE");
}

#[test]
fn list_arguments() {
    let q = PrListQuery {
        state: PrStateFilter::Merged,
        author_me: true,
        review_requested: true,
        assignee_me: false,
        search: " fix login ".into(),
        limit: 1000,
    };
    let args = list_args(&q);
    let joined = args.join(" ");
    assert!(joined.starts_with("pr list --json number,title"));
    assert!(joined.contains("--limit 500 --state merged --author @me"));
    assert_eq!(args.last().map(String::as_str), Some("review-requested:@me fix login"));
}

#[test]
fn api_arguments() {
    let req =
        GhApiRequest { method: "post".into(), endpoint: "graphql".into(), body: Some("{}".into()), paginate: false };
    assert_eq!(api_args(&req).unwrap(), ["api", "--method", "POST", "graphql", "--input", "-"]);
    let req = GhApiRequest {
        method: "GET".into(),
        endpoint: "repos/{owner}/{repo}/labels".into(),
        body: None,
        paginate: true,
    };
    assert_eq!(
        api_args(&req).unwrap(),
        ["api", "--method", "GET", "repos/{owner}/{repo}/labels", "--paginate", "--slurp"]
    );
    for bad in ["--hostname", "https://evil.example/x", ""] {
        assert!(api_args(&GhApiRequest { endpoint: bad.into(), ..req.clone() }).is_err(), "{bad}");
    }
    assert!(api_args(&GhApiRequest { method: "TRACE".into(), ..req }).is_err());
}
