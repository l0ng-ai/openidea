/**
 * GitHub pull requests, ported from IntelliJ's GitHub plugin: the Pull Requests tool window
 * (list, `#N` details tabs, New Pull Request), the timeline editor, review in the diff
 * viewer and review mode. GitHub is reached through gh (`api/`), cached per repository
 * and pull request (`data/`); shared components live in `ui/`, the shell in `toolwindow/`.
 *
 * Action ids map IntelliJ's (`Github.PullRequest.Show` → `github.pullRequest.show`);
 * `github.pullRequests`, `.createPullRequest`, `.checkoutPullRequest`, `.openInBrowser`
 * and `.refresh` are the Git › GitHub menu's.
 */
import { registerActions, type Action } from "@/platform/actions";
import { getContext, setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { lazyComponent } from "@/ui";
import { maybeEditorService, registerEditorKind, registerOverlay, registerToolWindow } from "@/workbench/contributions";
import { activateReviewDiff, toggleReviewDiffViewed } from "./diff";
import { reloadList } from "./data/list";
import { checkoutPullRequest, clearDiffCache, copyUrl, openInBrowser, openInWorktree } from "./data/local";
import { deleteMergedBranch } from "./data/operations";
import { cachedDetails, loadPullRequestData, reloadPullRequest } from "./data/pullRequest";
import { refreshConnection, resetConnection, useGhRepository } from "./data/repository";
import { showSubmitReview } from "./details/SubmitReviewPopup";
import { activateReviewMode } from "./reviewMode";
import { githubHandler, handlerContextKey } from "./toolwindow/handlers";
import {
  openCreatePullRequest,
  openPullRequest,
  selectOpenedPullRequest,
  showPullRequests,
  WINDOW,
} from "./toolwindow/open";
import {
  changeRepository,
  PullRequestsHeaderActions,
  PullRequestsTabs,
  PullRequestsToolWindow,
  usePullRequestsHeaderMenu,
} from "./toolwindow/PullRequestsToolWindow";
import { contextPullRequest, resetTabs } from "./toolwindow/store";
import {
  activeTimelinePullRequest,
  openTimeline,
  TIMELINE_KIND,
  timelineIcon,
  timelineTitle,
} from "./toolwindow/timelineInput";
import { GithubDialogHost, numberDialog } from "./ui/dialogs";

const WHEN = "projectOpen";
const CONNECTED = "projectOpen && githubConnected";
const IN_WINDOW = `activeToolWindow == '${WINDOW}'`;

/** The pull request an action applies to: its argument, the timeline editor, the active tab or the list selection. */
function targetPullRequest(arg: unknown): number | null {
  if (typeof arg === "number") return arg;
  return activeTimelinePullRequest() ?? contextPullRequest();
}

async function withPullRequest(arg: unknown, run: (number: number) => unknown) {
  const n = targetPullRequest(arg);
  if (n !== null) await run(n);
}

async function prUrl(number: number): Promise<string> {
  return cachedDetails(number)?.url ?? (await loadPullRequestData(number, "details")).url;
}

function actions(): Action[] {
  return [
    // Git › GitHub
    {
      // Github.View.Pull.Request
      id: "github.pullRequests",
      title: "View Pull Requests",
      category: "GitHub",
      icon: "toolwindow-pull-requests",
      keywords: ["github", "pr", "review", "merge request", "code review"],
      when: WHEN,
      run: () => void showPullRequests(),
    },
    {
      // Github.Create.Pull.Request
      id: "github.createPullRequest",
      title: "Create Pull Request…",
      category: "GitHub",
      icon: "plus",
      keywords: ["github", "pr", "new pull request", "start pull request", "merge request", "code review"],
      when: WHEN,
      keyWhen: IN_WINDOW,
      run: () => openCreatePullRequest(),
    },
    {
      id: "github.checkoutPullRequest",
      title: "Checkout Pull Request…",
      description: "Checks out the selected pull request, a number given as argument, or asks for one.",
      category: "GitHub",
      icon: "branch",
      keywords: ["github", "pr"],
      when: WHEN,
      run: async ({ arg }) => {
        if (!(await showPullRequests(false))) return;
        const n = targetPullRequest(arg) ?? (await numberDialog("Checkout Pull Request"));
        if (n) await checkoutPullRequest(n);
      },
    },
    {
      // Github.Open.In.Browser
      id: "github.openInBrowser",
      title: "Open on GitHub",
      category: "GitHub",
      icon: "external-link",
      when: WHEN,
      run: async () => {
        if (!(await showPullRequests(false))) return;
        const n = targetPullRequest(undefined);
        const url = n !== null ? await prUrl(n) : useGhRepository.getState().connection?.repository.url;
        if (url) await openInBrowser(url);
      },
    },
    {
      // Github.PullRequest.List.Reload
      id: "github.refresh",
      title: "Refresh Pull Requests List",
      category: "GitHub",
      icon: "refresh",
      keywords: ["refresh list", "reload"],
      when: WHEN,
      keyWhen: `${IN_WINDOW} && githubPrTab == 'list'`,
      run: async () => {
        await refreshConnection();
        if (useGhRepository.getState().connection) await reloadList();
      },
    },
    // Tool window
    {
      // GHPRSwitchRemoteAction
      id: "github.changeRepository",
      title: "Change Repository or Account…",
      category: "GitHub",
      when: CONNECTED,
      run: () => changeRepository(),
    },
    {
      // pull.request.select.action
      id: "github.selectOpenedPullRequest",
      title: "Select Opened Pull Request",
      category: "GitHub",
      icon: "locate",
      when: `${CONNECTED} && githubTimelineActive`,
      run: () => selectOpenedPullRequest(),
    },
    // A pull request
    {
      // Github.PullRequest.Show
      id: "github.pullRequest.show",
      title: "View Pull Request",
      description: "View pull request information and timeline",
      category: "GitHub",
      when: CONNECTED,
      run: ({ arg }) => withPullRequest(arg, (n) => openPullRequest(n)),
    },
    {
      // Github.PullRequest.Timeline.Show
      id: "github.pullRequest.showTimeline",
      title: "View Timeline",
      description: "View pull request timeline",
      category: "GitHub",
      icon: "github-timeline",
      when: CONNECTED,
      run: ({ arg }) => withPullRequest(arg, (n) => openTimeline(n, { focus: true })),
    },
    {
      // Github.PullRequest.Details.Reload
      id: "github.pullRequest.refresh",
      title: "Refresh Pull Request",
      category: "GitHub",
      icon: "refresh",
      when: CONNECTED,
      keyWhen: `${IN_WINDOW} && githubPrTab == 'pr'`,
      run: ({ arg }) => withPullRequest(arg, reloadPullRequest),
    },
    {
      // Github.PullRequest.Timeline.Update
      id: "github.pullRequest.timeline.refresh",
      title: "Refresh Timeline",
      description: "Check for new timeline events",
      category: "GitHub",
      icon: "refresh",
      when: `${CONNECTED} && githubTimelineActive`,
      keyWhen: "editorAreaFocus",
      run: () => withPullRequest(undefined, reloadPullRequest),
    },
    {
      // Github.PullRequest.Open.Link
      id: "github.pullRequest.openInBrowser",
      title: "View Pull Request in Browser",
      category: "GitHub",
      icon: "external-link",
      keywords: ["open pull request in github"],
      when: CONNECTED,
      run: ({ arg }) => withPullRequest(arg, async (n) => openInBrowser(await prUrl(n))),
    },
    {
      // Github.PullRequest.Copy.Link
      id: "github.pullRequest.copyUrl",
      title: "Copy Pull Request URL",
      category: "GitHub",
      icon: "copy",
      when: CONNECTED,
      run: ({ arg }) => withPullRequest(arg, async (n) => copyUrl(await prUrl(n))),
    },
    {
      // Github.PullRequest.CheckoutBranch
      id: "github.pullRequest.checkoutBranch",
      title: "Checkout Branch",
      description: "Fetch and checkout the pull request branch",
      category: "GitHub",
      icon: "branch",
      when: CONNECTED,
      run: ({ arg }) => withPullRequest(arg, checkoutPullRequest),
    },
    {
      // Github.PullRequest.OpenInWorktree
      id: "github.pullRequest.openInWorktree",
      title: "Open in Worktree",
      description: "Fetch and open the pull request branch in a Git worktree",
      category: "GitHub",
      when: CONNECTED,
      run: ({ arg }) => withPullRequest(arg, openInWorktree),
    },
    {
      // GitHub.Timeline.DeleteMergedBranch
      id: "github.pullRequest.deleteMergedBranch",
      title: "Delete Branch",
      description: "Delete the merged branch on GitHub",
      category: "GitHub",
      icon: "trash",
      hidden: true,
      when: CONNECTED,
      run: ({ arg }) =>
        withPullRequest(arg, async (n) => {
          const ref = (await loadPullRequestData(n, "details")).headRef;
          if (ref) await deleteMergedBranch(n, ref.id);
        }),
    },
    // Implemented by other parts (`provideGithubHandler`)
    {
      // Github.PullRequest.Review.Submit
      id: "github.pullRequest.submitReview",
      title: "Submit Review…",
      category: "GitHub",
      // The details panel's popup; without it (the branch popup in review mode) one of its own.
      when: `${CONNECTED} && (${handlerContextKey("submitReview")} || githubCurrentBranchPullRequest)`,
      run: ({ arg }) =>
        withPullRequest(arg, (n) => {
          const handler = githubHandler("submitReview");
          if (handler) handler(n);
          else void showSubmitReview(n);
        }),
    },
    {
      // Github.PullRequest.Changed.MarkViewed.Toggle
      id: "github.pullRequest.toggleViewed",
      title: "Toggle viewed/not viewed state",
      description: "Toggle viewed/not viewed state for the selection or file",
      category: "GitHub",
      // The file of the focused review diff, else the details panel's selection.
      when: `${CONNECTED} && (${handlerContextKey("toggleViewed")} || githubReviewDiff)`,
      run: () => {
        if (!(getContext().diffEditorFocus && toggleReviewDiffViewed())) githubHandler("toggleViewed")?.();
      },
    },
    {
      // Github.Pull.Request.Show.In.Toolwindow
      id: "github.pullRequest.showInToolWindow",
      title: "Show Pull Request in the Tool Window",
      category: "GitHub",
      icon: "toolwindow-pull-requests",
      when: `${CONNECTED} && ${handlerContextKey("showCurrentBranchPullRequest")}`,
      run: () => githubHandler("showCurrentBranchPullRequest")?.(),
    },
    {
      // Github.Pull.Request.Branch.Update
      id: "github.pullRequest.updateBranch",
      title: "Update to Enable Review Mode…",
      category: "GitHub",
      icon: "github-warning",
      when: `${CONNECTED} && ${handlerContextKey("updateReviewBranch")}`,
      run: () => githubHandler("updateReviewBranch")?.(),
    },
    {
      // Github.Pull.Request.Review.In.Editor.Toggle
      id: "github.pullRequest.reviewMode",
      title: "Review Mode",
      category: "GitHub",
      when: `${CONNECTED} && ${handlerContextKey("toggleReviewMode")}`,
      toggled: () => githubHandler("isReviewModeOn")?.() ?? false,
      run: () => githubHandler("toggleReviewMode")?.(),
    },
  ];
}

export function activate(): () => void {
  setContext("githubPrTab", "list");
  const disposers = [
    registerToolWindow({
      id: WINDOW,
      title: "Pull Requests",
      icon: "toolwindow-pull-requests",
      anchor: "left",
      order: 2,
      stripe: "onUse",
      component: PullRequestsToolWindow,
      headerContent: PullRequestsTabs,
      headerActions: PullRequestsHeaderActions,
      headerMenu: usePullRequestsHeaderMenu,
    }),
    registerEditorKind({
      kind: TIMELINE_KIND,
      component: lazyComponent(() => import("./timeline/TimelineEditor").then((m) => m.TimelineEditor)),
      title: timelineTitle,
      icon: timelineIcon,
    }),
    registerOverlay({ id: "github.dialogs", component: GithubDialogHost }),
    registerActions(actions()),
    useGhRepository.subscribe((s, prev) => {
      setContext("githubConnected", !!s.connection);
      setContext("githubTimelineActive", activeTimelinePullRequest() !== null);
      const a = s.connection?.coordinates;
      const b = prev.connection?.coordinates;
      if (a?.owner !== b?.owner || a?.name !== b?.name) {
        resetTabs();
        clearDiffCache();
      }
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) resetConnection();
    }),
    activateReviewDiff(),
    activateReviewMode(),
  ];
  const editors = maybeEditorService();
  const stopEditors = editors?.onActiveInputChange?.(() =>
    setContext("githubTimelineActive", activeTimelinePullRequest() !== null),
  );
  if (stopEditors) disposers.push(stopEditors);
  return () => disposers.reverse().forEach((d) => d());
}
