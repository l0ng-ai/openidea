/**
 * The GitHub integration behind `index.ts`'s registrations, loaded after start-up or on
 * first use: action implementations, the connection and review-mode tracking, review in
 * the diff viewer.
 */
import type { ActionContext } from "@/platform/actions";
import { getContext, setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { maybeEditorService, type EditorInput } from "@/workbench/contributions";
import { activateReviewDiff, toggleReviewDiffViewed } from "./diff";
import { reloadList } from "./data/list";
import { checkoutPullRequest, clearDiffCache, copyUrl, openInBrowser, openInWorktree } from "./data/local";
import { deleteMergedBranch } from "./data/operations";
import { cachedDetails, loadPullRequestData, reloadPullRequest } from "./data/pullRequest";
import { refreshConnection, resetConnection, useGhRepository } from "./data/repository";
import { showSubmitReview } from "./details/SubmitReviewPopup";
import { activateReviewMode } from "./reviewMode";
import { useGithubShell } from "./shell";
import { githubHandler } from "./toolwindow/handlers";
import { openCreatePullRequest, openPullRequest, selectOpenedPullRequest, showPullRequests } from "./toolwindow/open";
import { changeRepository, headerMenu } from "./toolwindow/PullRequestsToolWindow";
import { contextPullRequest, resetTabs } from "./toolwindow/store";
import { activeTimelinePullRequest, openTimeline, timelineIcon, timelineTitle } from "./toolwindow/timelineInput";
import { numberDialog } from "./ui/dialogs";

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

type Run = (c: ActionContext) => void | Promise<void>;

/** Implementations of the actions `index.ts` registers, by id. */
export const runs: Record<string, Run> = {
  "github.pullRequests": () => void showPullRequests(),
  "github.createPullRequest": () => openCreatePullRequest(),
  "github.checkoutPullRequest": async ({ arg }) => {
    if (!(await showPullRequests(false))) return;
    const n = targetPullRequest(arg) ?? (await numberDialog("Checkout Pull Request"));
    if (n) await checkoutPullRequest(n);
  },
  "github.openInBrowser": async () => {
    if (!(await showPullRequests(false))) return;
    const n = targetPullRequest(undefined);
    const url = n !== null ? await prUrl(n) : useGhRepository.getState().connection?.repository.url;
    if (url) await openInBrowser(url);
  },
  "github.refresh": async () => {
    await refreshConnection();
    if (useGhRepository.getState().connection) await reloadList();
  },
  // Not connected yet: the tool window offers the repository selector, or explains how to log in.
  "github.changeRepository": () =>
    useGhRepository.getState().connection ? changeRepository() : void showPullRequests(),
  "github.selectOpenedPullRequest": () => selectOpenedPullRequest(),
  "github.pullRequest.show": ({ arg }) => withPullRequest(arg, (n) => openPullRequest(n)),
  "github.pullRequest.showTimeline": ({ arg }) => withPullRequest(arg, (n) => openTimeline(n, { focus: true })),
  "github.pullRequest.refresh": ({ arg }) => withPullRequest(arg, reloadPullRequest),
  "github.pullRequest.timeline.refresh": () => withPullRequest(undefined, reloadPullRequest),
  "github.pullRequest.openInBrowser": ({ arg }) => withPullRequest(arg, async (n) => openInBrowser(await prUrl(n))),
  "github.pullRequest.copyUrl": ({ arg }) => withPullRequest(arg, async (n) => copyUrl(await prUrl(n))),
  "github.pullRequest.checkoutBranch": ({ arg }) => withPullRequest(arg, checkoutPullRequest),
  "github.pullRequest.openInWorktree": ({ arg }) => withPullRequest(arg, openInWorktree),
  "github.pullRequest.deleteMergedBranch": ({ arg }) =>
    withPullRequest(arg, async (n) => {
      const ref = (await loadPullRequestData(n, "details")).headRef;
      if (ref) await deleteMergedBranch(n, ref.id);
    }),
  // The details panel's popup; without it (the branch popup in review mode) one of its own.
  "github.pullRequest.submitReview": ({ arg }) =>
    withPullRequest(arg, (n) => {
      const handler = githubHandler("submitReview");
      if (handler) handler(n);
      else void showSubmitReview(n);
    }),
  // The file of the focused review diff, else the details panel's selection.
  "github.pullRequest.toggleViewed": () => {
    if (!(getContext().diffEditorFocus && toggleReviewDiffViewed())) githubHandler("toggleViewed")?.();
  },
};

/** The timeline tab's title and icon once the details are known. */
export const timeline = {
  title: (input: EditorInput) => timelineTitle(input),
  icon: (input: EditorInput) => timelineIcon(input),
};

export function activate(): () => void {
  const sync = () => {
    const s = useGhRepository.getState();
    setContext("githubConnected", !!s.connection);
    setContext("githubTimelineActive", activeTimelinePullRequest() !== null);
    useGithubShell.setState({ headerMenu: headerMenu(s) });
  };
  sync();
  const disposers = [
    useGhRepository.subscribe((s, prev) => {
      sync();
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
  const stopEditors = maybeEditorService()?.onActiveInputChange?.(() =>
    setContext("githubTimelineActive", activeTimelinePullRequest() !== null),
  );
  if (stopEditors) disposers.push(stopEditors);
  return () => disposers.reverse().forEach((d) => d());
}
