/**
 * Review in the diff viewer (IntelliJ's `GHPRReviewDiffExtension`): pull request diffs
 * (opened by `openPullRequestFileDiff` / the details panel's commit diffs, context
 * `PULL_REQUEST_DIFF`) get their review threads as inlays, the gutter "+" with single- and
 * multi-line comments, Start Review / Add Single Comment, the review toolbar and the viewed
 * toggle, through the vcs diff viewer provider point. Also registers the editor actions and
 * Settings › Version Control › GitHub.
 */
import { registerDiffViewerProvider } from "@/features/vcs/diffViewerProviders";
import { registerActions } from "@/platform/actions";
import { lazyComponent } from "@/ui";
import { registerSettingsPage } from "@/workbench/contributions";
import { useGhRepository } from "../data/repository";
import { clearNewComments } from "./newComments";
import { activeReviewDiff, createReviewDiff } from "./reviewDiff";

const WHEN = "projectOpen && githubConnected && githubReviewDiff";

/** "Mark File as Viewed" / "Mark File as Not Viewed" in the focused review diff; false when none is focused. */
export function toggleReviewDiffViewed(): boolean {
  const diff = activeReviewDiff();
  if (!diff) return false;
  diff.toggleViewed();
  return true;
}

export function activateReviewDiff(): () => void {
  const disposers = [
    registerDiffViewerProvider({ id: "github.review", create: createReviewDiff }),
    registerActions([
      {
        // Code.Review.Editor.New.Comment
        id: "github.pullRequest.diff.addComment",
        title: "Add Review Comment",
        description: "Create a new code review comment on the line under the caret",
        category: "GitHub",
        when: WHEN,
        run: () => activeReviewDiff()?.addComment(false),
      },
      {
        id: "github.pullRequest.diff.addMultilineComment",
        title: "Add Multiline Review Comment",
        description: "Create a new code review comment on the selected lines",
        category: "GitHub",
        when: WHEN,
        run: () => activeReviewDiff()?.addComment(true),
      },
      {
        // CodeReview.PreviousComment
        id: "github.pullRequest.diff.previousComment",
        title: "Previous Comment",
        description: "Go to previous visible comment",
        category: "GitHub",
        icon: "arrow-up",
        when: WHEN,
        run: () => void activeReviewDiff()?.gotoComment(-1),
      },
      {
        // CodeReview.NextComment
        id: "github.pullRequest.diff.nextComment",
        title: "Next Comment",
        description: "Go to next visible comment",
        category: "GitHub",
        icon: "arrow-down",
        when: WHEN,
        run: () => void activeReviewDiff()?.gotoComment(1),
      },
      {
        id: "github.pullRequest.diff.refreshReview",
        title: "Refresh Review Data",
        category: "GitHub",
        icon: "refresh",
        when: WHEN,
        run: () => activeReviewDiff()?.refresh(),
      },
    ]),
    registerSettingsPage({
      id: "vcs.github",
      title: "GitHub",
      order: 9,
      keywords: ["pull request", "viewed", "review"],
      component: lazyComponent(() => import("./GithubSettingsPage").then((m) => m.GithubSettingsPage)),
    }),
    useGhRepository.subscribe((s, prev) => {
      const a = s.connection?.coordinates;
      const b = prev.connection?.coordinates;
      if (a?.owner !== b?.owner || a?.name !== b?.name) clearNewComments();
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
