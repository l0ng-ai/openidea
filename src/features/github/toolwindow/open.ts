/** Opening the Pull Requests tool window, its tabs and the timeline editor. */
import { toolWindowService } from "@/workbench/contributions";
import { pullRequestData, reloadPullRequestData } from "../data/pullRequest";
import { refreshConnection, useGhRepository } from "../data/repository";
import { openCreateTab, openPullRequestTab } from "./store";
import { activeTimelinePullRequest, openTimeline } from "./timelineInput";

export const WINDOW = "pullRequests";

/** Shows the tool window, checking gh and connecting first when needed; whether it is connected. */
export async function showPullRequests(focus = true): Promise<boolean> {
  toolWindowService().show(WINDOW, focus);
  if (!useGhRepository.getState().connection) await refreshConnection();
  return !!useGhRepository.getState().connection;
}

/**
 * "View Pull Request" (Enter / double-click in the list): opens or selects the `#N` tab
 * and opens the timeline editor without focusing it. Details loaded before are refreshed
 * with the mergeability (`GHPROpenPullRequestAction`).
 */
export async function openPullRequest(number: number, opts: { timeline?: boolean } = {}) {
  if (!(await showPullRequests(false))) return;
  openPullRequestTab(number);
  if (pullRequestData(number, "details").value) {
    void reloadPullRequestData(number, "details").catch(() => undefined);
    void reloadPullRequestData(number, "mergeability").catch(() => undefined);
  }
  if (opts.timeline ?? true) await openTimeline(number, { focus: false });
}

/** "Create Pull Request…": the New Pull Request tab. */
export async function openCreatePullRequest() {
  if (await showPullRequests()) openCreateTab();
}

/** "Select Opened Pull Request": the tab of the pull request whose timeline is the active editor. */
export async function selectOpenedPullRequest() {
  const n = activeTimelinePullRequest();
  if (n !== null) await openPullRequest(n, { timeline: false });
}
