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
import "./ui/palette.css";
import { registerActions, type Action } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { lazyComponent } from "@/ui";
import {
  registerCloneSource,
  registerEditorKind,
  registerGitLogChecks,
  registerOverlay,
  registerToolWindow,
} from "@/workbench/contributions";
import { useGithubShell } from "./shell";
import { githubHandler, handlerContextKey } from "./toolwindow/handlers";
import { GithubDialogHost } from "./ui/dialogs";
import { activateSettingsPages } from "./settingsPages";

export { activateSettingsPages } from "./settingsPages";

const WINDOW = "pullRequests";
const TIMELINE_KIND = "github.timeline";
const WHEN = "projectOpen";
const CONNECTED = "projectOpen && githubConnected";
const IN_WINDOW = `activeToolWindow == '${WINDOW}'`;

/** The pull requests UI and data load after start-up (or on first use); registrations stay here. */
type Runtime = typeof import("./runtime");
let runtime: Runtime | null = null;
let loading: Promise<Runtime> | null = null;
let dispose: (() => void) | null = null;
let active = false;

function load(): Promise<Runtime> {
  return (loading ??= import("./runtime").then(
    (m) => {
      runtime = m;
      if (active && !dispose) dispose = m.activate();
      return m;
    },
    (e: unknown) => {
      loading = null; // A failed chunk load may succeed later.
      throw e;
    },
  ));
}

type ActionSpec = Omit<Action, "run"> & { run?: Action["run"] };

function actions(): ActionSpec[] {
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
    },
    {
      id: "github.checkoutPullRequest",
      title: "Checkout Pull Request…",
      description: "Checks out the selected pull request, a number given as argument, or asks for one.",
      category: "GitHub",
      icon: "branch",
      keywords: ["github", "pr"],
      when: WHEN,
    },
    {
      // Github.Open.In.Browser
      id: "github.openInBrowser",
      title: "Open on GitHub",
      category: "GitHub",
      icon: "external-link",
      when: WHEN,
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
    },
    // Tool window
    {
      // GHPRSwitchRemoteAction
      id: "github.changeRepository",
      title: "Change Repository or Account…",
      category: "GitHub",
      when: WHEN,
    },
    {
      // pull.request.select.action
      id: "github.selectOpenedPullRequest",
      title: "Select Opened Pull Request",
      category: "GitHub",
      icon: "locate",
      when: `${CONNECTED} && githubTimelineActive`,
    },
    // A pull request
    {
      // Github.PullRequest.Show
      id: "github.pullRequest.show",
      title: "View Pull Request",
      description: "View pull request information and timeline",
      category: "GitHub",
      when: CONNECTED,
    },
    {
      // Github.PullRequest.Timeline.Show
      id: "github.pullRequest.showTimeline",
      title: "View Timeline",
      description: "View pull request timeline",
      category: "GitHub",
      icon: "github-timeline",
      when: CONNECTED,
    },
    {
      // Github.PullRequest.Details.Reload
      id: "github.pullRequest.refresh",
      title: "Refresh Pull Request",
      category: "GitHub",
      icon: "refresh",
      when: CONNECTED,
      keyWhen: `${IN_WINDOW} && githubPrTab == 'pr'`,
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
    },
    {
      // Github.PullRequest.Open.Link
      id: "github.pullRequest.openInBrowser",
      title: "View Pull Request in Browser",
      category: "GitHub",
      icon: "external-link",
      keywords: ["open pull request in github"],
      when: CONNECTED,
    },
    {
      // Github.PullRequest.Copy.Link
      id: "github.pullRequest.copyUrl",
      title: "Copy Pull Request URL",
      category: "GitHub",
      icon: "copy",
      when: CONNECTED,
    },
    {
      // Github.PullRequest.CheckoutBranch
      id: "github.pullRequest.checkoutBranch",
      title: "Checkout Branch",
      description: "Fetch and checkout the pull request branch",
      category: "GitHub",
      icon: "branch",
      when: CONNECTED,
    },
    {
      // Github.PullRequest.OpenInWorktree
      id: "github.pullRequest.openInWorktree",
      title: "Open in Worktree",
      description: "Fetch and open the pull request branch in a Git worktree",
      category: "GitHub",
      when: CONNECTED,
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
    },
    // Implemented by other parts (`provideGithubHandler`)
    {
      // Github.PullRequest.Review.Submit
      id: "github.pullRequest.submitReview",
      title: "Submit Review…",
      category: "GitHub",
      // The details panel's popup; without it (the branch popup in review mode) one of its own.
      when: `${CONNECTED} && (${handlerContextKey("submitReview")} || githubCurrentBranchPullRequest)`,
    },
    {
      // Github.PullRequest.Changed.MarkViewed.Toggle
      id: "github.pullRequest.toggleViewed",
      title: "Toggle viewed/not viewed state",
      description: "Toggle viewed/not viewed state for the selection or file",
      category: "GitHub",
      // The file of the focused review diff, else the details panel's selection.
      when: `${CONNECTED} && (${handlerContextKey("toggleViewed")} || githubReviewDiff)`,
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

const lazyView = (name: "PullRequestsToolWindow" | "PullRequestsTabs" | "PullRequestsHeaderActions") =>
  lazyComponent<{ id: string }>(() => import("./toolwindow/PullRequestsToolWindow").then((m) => m[name]));

const useHeaderMenu = () => useGithubShell((s) => s.headerMenu);

export function activate(): () => void {
  active = true;
  setContext("githubPrTab", "list");
  const disposers = [
    activateSettingsPages(),
    registerCloneSource({
      id: "github",
      label: "GitHub",
      icon: "github",
      order: 10,
      component: lazyComponent(() => import("./clone/GitHubCloneSource").then((m) => m.GitHubCloneSource)),
    }),
    registerGitLogChecks(lazyComponent(() => import("./LogCommitChecks").then((m) => m.LogCommitChecks))),
    registerToolWindow({
      id: WINDOW,
      title: "Pull Requests",
      icon: "toolwindow-pull-requests",
      anchor: "left",
      order: 2,
      stripe: "onUse",
      component: lazyView("PullRequestsToolWindow"),
      headerContent: lazyView("PullRequestsTabs"),
      headerActions: lazyView("PullRequestsHeaderActions"),
      headerMenu: useHeaderMenu,
    }),
    registerEditorKind({
      kind: TIMELINE_KIND,
      component: lazyComponent(() => import("./timeline/TimelineEditor").then((m) => m.TimelineEditor)),
      title: (input) =>
        runtime?.timeline.title(input) ?? `#${(input.data as { number?: number } | undefined)?.number ?? "?"}`,
      icon: (input) => runtime?.timeline.icon(input) ?? "github-timeline",
    }),
    registerOverlay({ id: "github.dialogs", component: GithubDialogHost }),
    registerActions(actions().map((a) => ({ ...a, run: a.run ?? (async (c) => (await load()).runs[a.id]!(c)) }))),
  ];
  // Review mode follows the current branch: start once the window is up.
  const idle = typeof requestIdleCallback === "function" ? requestIdleCallback : (f: () => void) => setTimeout(f, 200);
  idle(() => void load().catch((e: unknown) => console.error("could not load GitHub", e)));
  return () => {
    active = false;
    dispose?.();
    dispose = null;
    disposers.reverse().forEach((d) => d());
  };
}
