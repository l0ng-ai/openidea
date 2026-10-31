/**
 * Review mode (IntelliJ's `GHPROnCurrentBranchService` with `GHPRReviewInEditorController`):
 * when the checked-out branch tracks the head of an open pull request of the connected
 * repository,
 *
 * - the branch widget shows "#{n} on {branch}" (a warning when the local branch is out of
 *   sync) and its popup gets "Show Pull Request in the Tool Window", "Submit Review…",
 *   "Update to Enable Review Mode…" and the "Review Mode" toggle (`vcs/branchWidgetExtensions`);
 * - editors of the pull request's files show its review (`editor.tsx`) with the "Review Mode"
 *   group at their top-right;
 * - "Show Review Diff" opens the pull request's diff of the file.
 *
 * Provides the `showCurrentBranchPullRequest`, `updateReviewBranch`, `toggleReviewMode` and
 * `isReviewModeOn` handlers behind the `github.pullRequest.showInToolWindow`,
 * `.updateBranch` and `.reviewMode` actions.
 */
import { registerEditorContribution } from "@/editor/api";
import { provideBranchWidgetExtension } from "@/features/vcs/branchWidgetExtensions";
import type { PopupAction } from "@/features/vcs/branches";
import { useVcs } from "@/features/vcs/store";
import { registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { registerMenuGroup } from "@/workbench/contributions";
import { subscribePullRequestData } from "../data/pullRequest";
import { refreshConnection, useGhRepository } from "../data/repository";
import { provideGithubHandler } from "../toolwindow/handlers";
import { openPullRequest } from "../toolwindow/open";
import { activeReviewFile, reviewModeEditorExtension, trackActiveReviewEditor } from "./editor";
import { reloadReviewModeSettings, setReviewModeEnabled, useReviewModeSettings } from "./settings";
import { changesState, trackCurrentBranchPullRequest, updateReviewBranch, useReviewBranch } from "./state";

/** The branch widget's presentation and popup actions (`BranchPresenter`, `Github.Pull.Request.Branch.Popup.Actions`). */
function branchExtension(): () => void {
  let dispose: (() => void) | null = null;
  let stopData: (() => void) | null = null;
  let dataFor: number | null = null;
  const sync = () => {
    const { number: n, branch, updateRequired } = useReviewBranch.getState();
    if (dataFor !== n) {
      stopData?.();
      stopData = n === null ? null : subscribePullRequestData(n, sync);
      dataFor = n;
    }
    if (n === null || !branch) {
      dispose?.();
      dispose = null;
      return;
    }
    const text = tx`#${n} on ${branch}`;
    const state = changesState(n);
    const tooltip = updateRequired
      ? tx`Pull request #${n} exists for current branch ${branch}, but local branch is out of sync with remote`
      : state === "loading"
        ? tx`Loading changes for pull request #${n}`
        : state === "error"
          ? tx`Pull request #${n} exists for current branch ${branch}, but pull request details loading failed`
          : tx`Pull request #${n} exists for current branch ${branch}`;
    const actions: PopupAction[] = [
      {
        id: "github.pullRequest.showInToolWindow",
        label: "Show Pull Request in the Tool Window",
        icon: "toolwindow-pull-requests",
      },
      { id: "github.pullRequest.submitReview", label: "Submit Review…", icon: "github-review", arg: n },
      ...(updateRequired
        ? [{ id: "github.pullRequest.updateBranch", label: "Update to Enable Review Mode…", icon: "github-warning" }]
        : [
            {
              id: "github.pullRequest.reviewMode",
              label: "Review Mode",
              checked: useReviewModeSettings.getState().enabled,
            },
          ]),
    ];
    const next = provideBranchWidgetExtension({
      id: "github.pullRequest",
      presentation: { icon: updateRequired ? "github-warning" : "toolwindow-pull-requests", text, tooltip },
      actions,
    });
    dispose?.();
    dispose = next;
  };
  const unsubs = [useReviewBranch.subscribe(sync), useReviewModeSettings.subscribe(sync)];
  sync();
  return () => {
    unsubs.forEach((u) => u());
    stopData?.();
    dispose?.();
  };
}

/** IntelliJ connects on start (`loginIfPossible`): the current branch's pull request is looked up without the tool window. */
function connectEagerly(): () => void {
  const tryConnect = () => {
    const g = useGhRepository.getState();
    if (useVcs.getState().available && useProject.getState().project && !g.availability && !g.checking)
      void refreshConnection();
  };
  const unsubs = [
    useVcs.subscribe((s, prev) => {
      if (s.available !== prev.available) tryConnect();
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) {
        reloadReviewModeSettings();
        // The connection is reset by the feature's own subscription first.
        queueMicrotask(tryConnect);
      }
    }),
  ];
  tryConnect();
  return () => unsubs.forEach((u) => u());
}

export function activateReviewMode(): () => void {
  const disposers = [
    trackCurrentBranchPullRequest(),
    branchExtension(),
    connectEagerly(),
    trackActiveReviewEditor(),
    registerEditorContribution({ id: "github.reviewMode", order: 58, extensions: reviewModeEditorExtension }),
    useReviewBranch.subscribe((s, prev) => {
      if (s.number === prev.number) return;
      setContext("githubCurrentBranchPullRequest", s.number !== null);
    }),
    provideGithubHandler("showCurrentBranchPullRequest", () => {
      const n = useReviewBranch.getState().number;
      if (n !== null) void openPullRequest(n);
    }),
    provideGithubHandler("updateReviewBranch", () => void updateReviewBranch()),
    provideGithubHandler("toggleReviewMode", () => setReviewModeEnabled(!useReviewModeSettings.getState().enabled)),
    provideGithubHandler("isReviewModeOn", () => useReviewModeSettings.getState().enabled),
    registerActions([
      {
        // Code.Review.Editor.Show.Diff
        id: "github.pullRequest.reviewMode.showDiff",
        title: "Show Review Diff",
        category: "GitHub",
        icon: "diff",
        when: "projectOpen && githubConnected && githubCurrentBranchPullRequest",
        run: () => activeReviewFile()?.showDiff(),
      },
    ]),
    registerMenuGroup({
      id: "github.reviewMode",
      menus: ["editor"],
      order: 60,
      items: () => (activeReviewFile() ? [{ kind: "action", action: "github.pullRequest.reviewMode.showDiff" }] : []),
    }),
  ];
  return () => {
    disposers.reverse().forEach((d) => d());
    setContext("githubCurrentBranchPullRequest", false);
  };
}
