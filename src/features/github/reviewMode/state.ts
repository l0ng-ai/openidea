/**
 * The pull request of the checked-out branch (IntelliJ's `prOnCurrentBranch` with
 * `GHPRReviewBranchStateSharedViewModel`): the open pull request whose head is the remote
 * branch the current branch tracks, looked up again when the branch, its upstream or the
 * repository changes; and whether the local branch is out of sync with it (`updateRequired`:
 * its head commit is not in the local history), checked again when HEAD or the pull
 * request's head moves.
 *
 * "Update to Enable Review Mode…" reloads the details, then fetches and checks out the
 * branch (`gh pr checkout`).
 */
import { create } from "zustand";
import { currentRepoRoot, useVcs } from "@/features/vcs/store";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { errorMessage, rest } from "../api/client";
import { checkoutPullRequest } from "../data/local";
import {
  loadPullRequestData,
  pullRequestData,
  reloadPullRequestData,
  subscribePullRequestData,
} from "../data/pullRequest";
import { useGhRepository } from "../data/repository";
import { isUpdateRequired, openPullRequestQuery, trackedBranch } from "./model";

export interface ReviewBranchState {
  /** The open pull request whose head the current branch tracks. */
  number: number | null;
  /** The local branch. */
  branch: string | null;
  /** The pull request's head is not in the local history. */
  updateRequired: boolean;
}

export const useReviewBranch = create<ReviewBranchState>(() => ({ number: null, branch: null, updateRequired: false }));

let lookupSeq = 0;

/** The open pull request for the current branch of the selected repository, or null. */
async function findPullRequestForCurrentBranch(): Promise<{ number: number; branch: string } | null> {
  const connection = useGhRepository.getState().connection;
  const head = useVcs.getState().branch?.head;
  if (!connection || !head) return null;
  const repo = currentRepoRoot();
  const [remote, merge, remotes] = await Promise.all([
    call(commands.vcsConfigGet(repo, `branch.${head}.remote`)),
    call(commands.vcsConfigGet(repo, `branch.${head}.merge`)),
    call(commands.vcsRemotes(repo)),
  ]);
  const tracked = trackedBranch(remote, merge, remotes);
  if (!tracked) return null;
  if (tracked.pullRequest !== null) return { number: tracked.pullRequest, branch: head };
  const query = openPullRequestQuery(connection.coordinates, tracked);
  if (!query) return null;
  const found = await rest<Array<{ number: number }> | null>("GET", query);
  const number = found?.[0]?.number;
  return typeof number === "number" ? { number, branch: head } : null;
}

/** Looks up the pull request of the current branch again (`prOnCurrentBranch`). */
export async function refreshCurrentBranchPullRequest(): Promise<void> {
  const seq = ++lookupSeq;
  let found: { number: number; branch: string } | null = null;
  try {
    found = await findPullRequestForCurrentBranch();
  } catch (e) {
    console.warn("Could not lookup a pull request for current branch", e);
  }
  if (seq !== lookupSeq) return;
  const s = useReviewBranch.getState();
  if (found?.number === s.number && found?.branch === s.branch) return;
  useReviewBranch.setState({ number: found?.number ?? null, branch: found?.branch ?? null, updateRequired: false });
  if (found) {
    void loadPullRequestData(found.number, "details").catch(() => undefined);
    void loadPullRequestData(found.number, "changes").catch(() => undefined);
  }
  await refreshSyncState();
}

let syncSeq = 0;

/** Checks again whether the pull request's head is in the local history. */
export async function refreshSyncState(): Promise<void> {
  const seq = ++syncSeq;
  const n = useReviewBranch.getState().number;
  if (n === null) return;
  let updateRequired = false;
  try {
    const pr = await loadPullRequestData(n, "details");
    const base = await call(commands.vcsMergeBase(currentRepoRoot(), pr.headRefOid, "HEAD")).catch(() => null);
    updateRequired = isUpdateRequired(pr.headRefOid, base);
  } catch {
    // Details not loaded: nothing to compare with (IntelliJ keeps `false`).
  }
  if (seq === syncSeq && useReviewBranch.getState().number === n) useReviewBranch.setState({ updateRequired });
}

/** "Update to Enable Review Mode…": reloads the details, then fetches and checks out the branch. */
export async function updateReviewBranch(): Promise<void> {
  const n = useReviewBranch.getState().number;
  if (n === null) return;
  try {
    await reloadPullRequestData(n, "details");
  } catch (e) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: tx("Pull Request branch update failed"),
      body: errorMessage(e),
      key: "github-review-branch-update",
    });
    return;
  }
  if (await checkoutPullRequest(n)) await refreshSyncState();
}

/** Whether the changes of the pull request are loaded, loading or failed (the widget's tooltip). */
export function changesState(n: number): "loading" | "error" | "loaded" {
  const s = pullRequestData(n, "changes");
  return s.value !== undefined ? "loaded" : s.error ? "error" : "loading";
}

/** Follows the branch, the repository and the pull request's head; returns the disposer. */
export function trackCurrentBranchPullRequest(): () => void {
  let stopData: (() => void) | null = null;
  let lastHead: string | undefined;
  const followData = (n: number | null) => {
    stopData?.();
    stopData = null;
    lastHead = undefined;
    if (n === null) return;
    stopData = subscribePullRequestData(n, () => {
      const head = pullRequestData(n, "details").value?.headRefOid;
      if (head && head !== lastHead) {
        lastHead = head;
        void refreshSyncState();
      }
    });
  };
  const disposers = [
    useVcs.subscribe((s, prev) => {
      const a = s.branch;
      const b = prev.branch;
      if (s.repo !== prev.repo || a?.head !== b?.head || a?.upstream !== b?.upstream)
        void refreshCurrentBranchPullRequest();
      else if (a?.headCommit !== b?.headCommit) void refreshSyncState();
    }),
    useGhRepository.subscribe((s, prev) => {
      if (s.connection !== prev.connection) void refreshCurrentBranchPullRequest();
    }),
    useReviewBranch.subscribe((s, prev) => {
      if (s.number !== prev.number) followData(s.number);
    }),
    () => followData(null),
  ];
  void refreshCurrentBranchPullRequest();
  return () => {
    lookupSeq++;
    syncSeq++;
    disposers.reverse().forEach((d) => d());
    useReviewBranch.setState({ number: null, branch: null, updateRequired: false });
  };
}
