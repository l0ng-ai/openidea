/**
 * When each pull request was last seen (IntelliJ's `GHPRPersistentInteractionState`),
 * stored per project; the list's unread dots compare it with `updatedAt` (`isSeen` in
 * `model.ts`). Entries of pull requests updated since and older than
 * `CLEAR_LAST_SEEN_AFTER_DAYS` are dropped.
 */
import { create } from "zustand";
import { useProject } from "@/platform/project";
import type { GHPullRequestShort, GHUser } from "../api/types";
import { CLEAR_LAST_SEEN_AFTER_DAYS, isSeen } from "./model";

const key = (root: string) => `openidea.github.lastSeen.v1:${root}`;
const projectRoot = () => useProject.getState().project?.root ?? null;

function load(root: string | null): Record<string, number> {
  if (!root) return {};
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(key(root)) ?? "{}") as unknown;
    if (!v || typeof v !== "object") return {};
    return Object.fromEntries(Object.entries(v).filter(([, t]) => typeof t === "number")) as Record<string, number>;
  } catch {
    return {};
  }
}

function save(root: string | null, lastSeen: Record<string, number>) {
  if (!root) return;
  try {
    globalThis.localStorage?.setItem(key(root), JSON.stringify(lastSeen));
  } catch {
    /* storage unavailable */
  }
}

/** Last-seen times (ms) by pull request node id, for the open project. */
export const useLastSeen = create<{ root: string | null; lastSeen: Record<string, number> }>(() => ({
  root: projectRoot(),
  lastSeen: load(projectRoot()),
}));

function current(): Record<string, number> {
  const root = projectRoot();
  if (useLastSeen.getState().root !== root) useLastSeen.setState({ root, lastSeen: load(root) });
  return useLastSeen.getState().lastSeen;
}

/** Records that the pull request with node id `prId` was seen now. */
export function markSeen(prId: string, at = Date.now()) {
  const lastSeen = { ...current(), [prId]: at };
  useLastSeen.setState({ lastSeen });
  save(projectRoot(), lastSeen);
}

/**
 * `isSeen` with the stored time; forgets entries that are stale (unseen updates, older than 14 days).
 * @public
 */
export function isPullRequestSeen(
  pr: Pick<GHPullRequestShort, "id" | "author" | "reviewRequests" | "updatedAt">,
  user: Pick<GHUser, "id">,
  now = Date.now(),
): boolean {
  const all = current();
  const lastSeen = all[pr.id];
  const seen = isSeen(pr, user, lastSeen);
  if (!seen && lastSeen !== undefined && lastSeen < now - CLEAR_LAST_SEEN_AFTER_DAYS * 86_400_000) {
    const { [pr.id]: _, ...rest } = all;
    useLastSeen.setState({ lastSeen: rest });
    save(projectRoot(), rest);
  }
  return seen;
}

/**
 * React hook: whether `pr` is seen; re-renders when the last-seen times change.
 * @public
 */
export function usePullRequestSeen(
  pr: Pick<GHPullRequestShort, "id" | "author" | "reviewRequests" | "updatedAt">,
  user: Pick<GHUser, "id"> | null | undefined,
): boolean {
  const lastSeen = useLastSeen((s) => s.lastSeen[pr.id]);
  return !user || isSeen(pr, user, lastSeen);
}

useProject.subscribe((s, prev) => {
  const root = s.project?.root ?? null;
  if (root !== (prev.project?.root ?? null)) useLastSeen.setState({ root, lastSeen: load(root) });
});
