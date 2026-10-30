/**
 * Local git work for pull requests: checkout (`gh pr checkout`), fetching what a diff
 * needs (`ghPrPrepareDiff`, cached per head / base commit) and opening a changed file in
 * the diff viewer (`vcs.openDiff`) with its review threads as notes. Long operations run
 * one at a time and are shown in the tool window's banner (`useGhBusy`), cancellable.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { DiffAnnotation, DiffData } from "@/features/vcs/diffInput";
import { executeAction } from "@/platform/actions";
import type { PrDiffRevisions, RequestId } from "@/platform/ipc";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { openExternalUrl } from "@/platform/openUrl";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { errorMessage } from "../api/client";
import type { GHCommitFile, GHPullRequest, GHPullRequestReviewThread } from "../api/types";
import { loadPullRequestData, pullRequestData } from "./pullRequest";
import { nameWithOwner, requireConnection } from "./repository";

/** The running operation (checkout, fetch for a diff) with its last output line. */
export const useGhBusy = create<{ busy: { title: string; line: string; request: RequestId } | null }>(() => ({
  busy: null,
}));

/** Runs a cancellable, streaming gh / git operation; null when it failed, was cancelled or another one runs. */
export async function withBusy<T>(
  title: string,
  run: (request: RequestId, out: Channel<string>) => Promise<T>,
): Promise<T | null> {
  if (useGhBusy.getState().busy) {
    notifications().notify({
      group: "vcs",
      level: "info",
      title: "Another GitHub operation is still running",
      key: "github-busy",
    });
    return null;
  }
  const request = nextRequestId();
  const out = new Channel<string>();
  out.onmessage = (line) => useGhBusy.setState((s) => (s.busy ? { busy: { ...s.busy, line } } : s));
  useGhBusy.setState({ busy: { title, line: "", request } });
  try {
    return await run(request, out);
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({
        group: "vcs",
        level: "error",
        title: `${title.replace(/…$/, "")} failed`,
        body: errorMessage(e),
        key: "github-op",
      });
    return null;
  } finally {
    useGhBusy.setState({ busy: null });
  }
}

export function cancelBusy() {
  const b = useGhBusy.getState().busy;
  if (b) void commands.cancelRequest(b.request);
}

/** "Checkout Branch": fetches and checks out the pull request's branch (gh's local name). */
export async function checkoutPullRequest(number: number): Promise<boolean> {
  const done = await withBusy(`Checking out #${number}…`, (r, out) => call(commands.ghPrCheckout(r, number, out)));
  if (done === null) return false;
  notifications().notify({
    group: "vcs",
    level: "info",
    title: `Checked out pull request #${number}`,
    key: "github-checkout",
  });
  return true;
}

const diffCache = new Map<string, PrDiffRevisions>();

/** Fetches what the local repository lacks to diff `pr` (once per head / base commit). */
export async function prepareDiff(pr: GHPullRequest): Promise<PrDiffRevisions | null> {
  const key = `${pr.number}:${pr.headRefOid}:${pr.baseRefOid}`;
  const hit = diffCache.get(key);
  if (hit) return hit;
  const repo = nameWithOwner(requireConnection().coordinates);
  const revs = await withBusy(`Fetching #${pr.number}…`, (r, out) =>
    call(commands.ghPrPrepareDiff(r, pr.number, pr.headRefOid, pr.baseRefOid, pr.baseRefName, repo, out)),
  );
  if (revs) diffCache.set(key, revs);
  return revs;
}

export function clearDiffCache() {
  diffCache.clear();
}

/** Current (not outdated) threads of `path` as diff notes: the first comment, at the thread's line. */
export function threadNotes(path: string, threads: readonly GHPullRequestReviewThread[]): DiffAnnotation[] {
  return threads.flatMap((t) => {
    const first = t.comments.nodes[0];
    if (t.path !== path || t.line == null || !first) return [];
    return [
      {
        side: t.diffSide === "LEFT" ? "left" : "right",
        line: t.line - 1,
        author: first.author?.login ?? "ghost",
        body: first.body,
        date: first.createdAt,
      } satisfies DiffAnnotation,
    ];
  });
}

/** `DiffData` for a changed file of `pr`: merge base ↔ head. */
export function fileDiffData(
  pr: Pick<GHPullRequest, "number" | "baseRefName" | "headRefName">,
  file: Pick<GHCommitFile, "filename" | "status" | "previousFilename">,
  revs: PrDiffRevisions,
  threads: readonly GHPullRequestReviewThread[] = [],
): DiffData {
  const root = revs.root;
  const changed = revs.files.find((f) => f.path === file.filename);
  const added = file.status === "added" || changed?.kind === "added";
  const deleted = file.status === "removed" || changed?.kind === "deleted";
  const oldPath = file.previousFilename ?? changed?.oldPath ?? null;
  const n = pr.number;
  const name = file.filename.slice(file.filename.lastIndexOf("/") + 1);
  return {
    path: `${root}/${file.filename}`,
    left: added
      ? { type: "text", text: "", label: tx("(does not exist)") }
      : {
          type: "rev",
          rev: revs.base,
          path: oldPath ? `${root}/${oldPath}` : undefined,
          label: `${pr.baseRefName} (${revs.base.slice(0, 8)})`,
        },
    right: deleted
      ? { type: "text", text: "", label: tx("(deleted)") }
      : { type: "rev", rev: revs.head, label: `#${n} ${pr.headRefName}` },
    title: `#${n}: ${name}`,
    annotations: threadNotes(file.filename, threads),
  };
}

/** Opens `path` of pull request `number` in the diff viewer (fetching what it needs first). */
export async function openPullRequestFileDiff(number: number, path: string): Promise<void> {
  const [pr, files] = await Promise.all([
    loadPullRequestData(number, "details"),
    loadPullRequestData(number, "changes"),
  ]);
  const revs = await prepareDiff(pr);
  if (!revs) return;
  const file = files.find((f) => f.filename === path) ?? {
    filename: path,
    status: "modified" as const,
    previousFilename: null,
  };
  const threads = pullRequestData(number, "threads").value ?? [];
  await executeAction("vcs.openDiff", fileDiffData(pr, file, revs, threads));
}

/** "View Pull Request in Browser" and other links. */
export function openInBrowser(url: string): Promise<void> {
  return openExternalUrl(url);
}

/** "Copy Pull Request URL". */
export async function copyUrl(url: string): Promise<void> {
  await navigator.clipboard?.writeText(url);
}

/**
 * "Open in Worktree": fetches the pull request's head, adds the worktree
 * `<repository root>_PR_<n>` on it (detached) and opens it in a new window.
 */
export async function openInWorktree(number: number): Promise<void> {
  const pr = await loadPullRequestData(number, "details");
  const revs = await prepareDiff(pr);
  if (!revs) return;
  const path = `${String(revs.root).replace(/[\\/]+$/, "")}_PR_${number}`;
  const added = await withBusy(`Creating worktree for #${number}…`, async () => {
    await call(commands.vcsAddWorktree(null, path, pr.headRefOid, null));
    return true;
  });
  if (added) await executeAction("file.openInNewWindow", path);
}
