/**
 * Per pull request data cache, like IntelliJ's `GHPRDataProvider` (details, changes,
 * viewed state, review, timeline providers): each slice loads on first use, keeps its
 * value while reloading, and is shared by every view of the pull request (its tab, the
 * timeline editor, the review diff).
 *
 *   const details = usePullRequestData(number, "details");   // { value, loading, error }
 *   await reloadPullRequestData(number, "mergeability");
 *
 * Slices: details (`findPullRequest`), mergeability (`findPullRequestMergeability`, as
 * `GHPRMergeabilityState`), commits, changes (REST files with patches), viewedState (per
 * path), threads (review threads), pendingReview (the viewer's unsubmitted review) and
 * participants. The timeline is cursor-paged separately (`usePullRequestTimeline`).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { errorMessage } from "../api/client";
import * as api from "../api/requests";
import type {
  GHCommitFile,
  GHPRMergeabilityState,
  GHPRTimelineItem,
  GHPullRequest,
  GHPullRequestCommit,
  GHPullRequestFileViewedState,
  GHPullRequestPendingReview,
  GHPullRequestReviewThread,
  GHUser,
} from "../api/types";
import { markSeen } from "./interaction";
import { updateListItem } from "./list";
import { buildMergeabilityState } from "./model";
import { currentUserHasPermission, useGhRepository } from "./repository";

export interface Loadable<T> {
  /** Last loaded value; kept while reloading. */
  value: T | undefined;
  loading: boolean;
  error: string | null;
}

interface Slices {
  details: GHPullRequest;
  mergeability: GHPRMergeabilityState;
  commits: GHPullRequestCommit[];
  changes: GHCommitFile[];
  viewedState: Record<string, GHPullRequestFileViewedState>;
  threads: GHPullRequestReviewThread[];
  pendingReview: GHPullRequestPendingReview | null;
  participants: GHUser[];
}

export type PullRequestSlice = keyof Slices;

export interface TimelineState {
  items: GHPRTimelineItem[];
  /** Cursor after the last loaded item. */
  cursor: string | null;
  /** More pages exist after `cursor` (as far as is known). */
  hasMore: boolean;
  /** Nothing requested yet. */
  initial: boolean;
  loading: boolean;
  error: string | null;
}

type PrData = { [K in PullRequestSlice]: Loadable<Slices[K]> } & { timeline: TimelineState };

const EMPTY: Loadable<never> = { value: undefined, loading: false, error: null };
const EMPTY_TIMELINE: TimelineState = {
  items: [],
  cursor: null,
  hasMore: true,
  initial: true,
  loading: false,
  error: null,
};

const usePullRequests = create<{ prs: Record<number, Partial<PrData>> }>(() => ({ prs: {} }));

function patch<K extends keyof PrData>(number: number, key: K, value: Partial<PrData[K]>) {
  usePullRequests.setState((s) => {
    const pr = s.prs[number] ?? {};
    const prev = (pr[key] ?? (key === "timeline" ? EMPTY_TIMELINE : EMPTY)) as PrData[K];
    return { prs: { ...s.prs, [number]: { ...pr, [key]: { ...prev, ...value } } } };
  });
}

function patchSlice<K extends PullRequestSlice>(number: number, key: K, value: Partial<Loadable<Slices[K]>>) {
  patch(number, key, value as Partial<PrData[K]>);
}

function slice<K extends PullRequestSlice>(number: number, key: K): Loadable<Slices[K]> {
  return (usePullRequests.getState().prs[number]?.[key] as Loadable<Slices[K]> | undefined) ?? EMPTY;
}

/** The node id of pull request `number` (from its details, else looked up). */
export async function pullRequestId(number: number): Promise<string> {
  const known = slice(number, "details").value?.id;
  if (known) return known;
  const id = await api.findPullRequestId(number);
  if (!id) throw new Error(`Pull request #${number} not found`);
  return id;
}

const fetchers: { [K in PullRequestSlice]: (number: number) => Promise<Slices[K]> } = {
  details: async (n) => {
    const pr = await api.findPullRequest(n);
    if (!pr) throw new Error(`Pull request #${n} not found`);
    updateListItem(pr);
    return pr;
  },
  mergeability: async (n) => {
    const data = await api.findPullRequestMergeability(n);
    if (!data) throw new Error(`Pull request #${n} not found`);
    return buildMergeabilityState(data, currentUserHasPermission("ADMIN"));
  },
  commits: (n) => api.allPages((c) => api.pullRequestCommitsPage(n, c)),
  changes: (n) => api.pullRequestChangedFiles(n),
  viewedState: async (n) => {
    const files = await api.allPages((c) => api.pullRequestFilesPage(n, c));
    return Object.fromEntries(files.map((f) => [f.path, f.viewerViewedState]));
  },
  threads: (n) => api.allPages((c) => api.pullRequestReviewThreadsPage(n, c)),
  pendingReview: async (n) => api.findPendingReview(await pullRequestId(n)),
  participants: (n) => api.allPages((c) => api.pullRequestParticipantsPage(n, c)),
};

const inFlight = new Map<string, { seq: number; promise: Promise<unknown> }>();
let seqCounter = 0;
/** Bumped on disconnect / another repository: results of older requests are dropped. */
let epoch = 0;

/** Loads `key` of pull request `number` again (the value stays visible meanwhile). */
export function reloadPullRequestData<K extends PullRequestSlice>(number: number, key: K): Promise<Slices[K]> {
  const id = `${number}:${key}`;
  const seq = ++seqCounter;
  const started = epoch;
  patchSlice(number, key, { loading: true, error: null });
  const promise = fetchers[key](number).then(
    (value) => {
      if (inFlight.get(id)?.seq === seq && started === epoch) {
        inFlight.delete(id);
        patchSlice(number, key, { value, loading: false, error: null });
      }
      return value;
    },
    (e: unknown) => {
      if (inFlight.get(id)?.seq === seq && started === epoch) {
        inFlight.delete(id);
        patchSlice(number, key, { loading: false, error: errorMessage(e) });
      }
      throw e;
    },
  );
  inFlight.set(id, { seq, promise });
  return promise;
}

/** Loads `key` unless it is loaded or loading; resolves with the value. */
export function loadPullRequestData<K extends PullRequestSlice>(number: number, key: K): Promise<Slices[K]> {
  const running = inFlight.get(`${number}:${key}`);
  if (running) return running.promise as Promise<Slices[K]>;
  const s = slice(number, key);
  if (s.value !== undefined) return Promise.resolve(s.value);
  return reloadPullRequestData(number, key);
}

/** The current state of a slice, without loading it. */
export function pullRequestData<K extends PullRequestSlice>(number: number, key: K): Loadable<Slices[K]> {
  return slice(number, key);
}

/** React hook: slice `key` of pull request `number`, loaded on first use. */
export function usePullRequestData<K extends PullRequestSlice>(number: number, key: K): Loadable<Slices[K]> {
  const connected = useGhRepository((s) => !!s.connection);
  useEffect(() => {
    if (connected) void loadPullRequestData(number, key).catch(() => undefined);
  }, [number, key, connected]);
  return usePullRequests((s) => (s.prs[number]?.[key] as Loadable<Slices[K]> | undefined) ?? EMPTY);
}

/** Replaces a loaded value (a mutation returned the new state, an optimistic update). */
export function setPullRequestData<K extends PullRequestSlice>(
  number: number,
  key: K,
  update: (value: Slices[K] | undefined) => Slices[K],
) {
  patchSlice(number, key, { value: update(slice(number, key).value) });
}

/** Calls `listener` after any data of pull request `number` changed (outside React); returns the unsubscriber. */
export function subscribePullRequestData(number: number, listener: () => void): () => void {
  return usePullRequests.subscribe((s, prev) => {
    if (s.prs[number] !== prev.prs[number]) listener();
  });
}

/** Pull request `number` as far as it is cached (the list row while details load). */
export function cachedDetails(number: number): GHPullRequest | undefined {
  return slice(number, "details").value;
}

// ---------------------------------------------------------------------------
// Timeline (`GHPRTimelineDataProvider`: pages of 100, then polled for new items)

function timelineOf(number: number): TimelineState {
  return usePullRequests.getState().prs[number]?.timeline ?? EMPTY_TIMELINE;
}

const timelineRuns = new Map<number, Promise<void>>();

async function fetchTimelinePages(number: number, from: string | null, all: boolean) {
  const items: GHPRTimelineItem[] = [];
  let cursor = from;
  let hasMore = true;
  do {
    const page = await api.pullRequestTimelinePage(number, cursor);
    if (!page) throw new Error(`Pull request #${number} not found`);
    items.push(...page.nodes);
    hasMore = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor ?? cursor;
  } while (all && hasMore);
  return { items, cursor, hasMore };
}

function runTimeline(number: number, run: () => Promise<void>): Promise<void> {
  const running = timelineRuns.get(number);
  if (running) return running;
  const started = epoch;
  patch(number, "timeline", { loading: true, error: null, initial: false });
  const promise = run()
    .catch((e: unknown) => {
      if (started === epoch) patch(number, "timeline", { error: errorMessage(e) });
    })
    .finally(() => {
      timelineRuns.delete(number);
      if (started === epoch) patch(number, "timeline", { loading: false });
      const t = timelineOf(number);
      const details = slice(number, "details").value;
      // IntelliJ stores "last seen" once the timeline is fully loaded.
      if (!t.hasMore && !t.error && details) markSeen(details.id);
    });
  timelineRuns.set(number, promise);
  return promise;
}

/** Loads the next timeline page (the first one on first use). */
export function loadTimelinePage(number: number): Promise<void> {
  const t = timelineOf(number);
  if (!t.hasMore && !t.initial) return Promise.resolve();
  const started = epoch;
  return runTimeline(number, async () => {
    const page = await fetchTimelinePages(number, t.cursor, false);
    if (started !== epoch) return;
    patch(number, "timeline", {
      items: [...timelineOf(number).items, ...page.items],
      cursor: page.cursor,
      hasMore: page.hasMore,
    });
  });
}

/** New items after the loaded ones (`timelineUpdateSignal`); loads the first page when nothing is loaded. */
export function updateTimeline(number: number): Promise<void> {
  const t = timelineOf(number);
  if (t.initial) return loadTimelinePage(number);
  if (t.hasMore) return Promise.resolve();
  const started = epoch;
  return runTimeline(number, async () => {
    const page = await fetchTimelinePages(number, t.cursor, true);
    if (started !== epoch) return;
    patch(number, "timeline", {
      items: [...timelineOf(number).items, ...page.items],
      cursor: page.cursor,
      hasMore: false,
    });
  });
}

/**
 * Reloads the whole timeline (`signalTimelineNeedsReload`): fully loaded timelines fetch
 * every page before replacing the items, partly loaded ones start over from the first page.
 */
export function reloadTimeline(number: number): Promise<void> {
  const t = timelineOf(number);
  const complete = !t.initial && !t.hasMore;
  const started = epoch;
  return runTimeline(number, async () => {
    const page = await fetchTimelinePages(number, null, complete);
    if (started !== epoch) return;
    patch(number, "timeline", { items: page.items, cursor: page.cursor, hasMore: page.hasMore });
  });
}

/** React hook: the timeline of `number`, its first page loaded on first use. */
export function usePullRequestTimeline(number: number): TimelineState {
  const connected = useGhRepository((s) => !!s.connection);
  useEffect(() => {
    if (connected && timelineOf(number).initial) void loadTimelinePage(number);
  }, [number, connected]);
  return usePullRequests((s) => s.prs[number]?.timeline ?? EMPTY_TIMELINE);
}

// ---------------------------------------------------------------------------

/** `updateAll()` of the timeline / "Refresh Review Data": details, mergeability, timeline and threads. */
export async function reloadPullRequest(number: number): Promise<void> {
  const loaded = usePullRequests.getState().prs[number] ?? {};
  const keys = (Object.keys(fetchers) as PullRequestSlice[]).filter(
    (k) => k === "details" || loaded[k]?.value !== undefined,
  );
  await Promise.allSettled([
    ...keys.map((k) => reloadPullRequestData(number, k)),
    ...(loaded.timeline && !loaded.timeline.initial ? [reloadTimeline(number)] : []),
  ]);
}

/** Forgets every pull request (disconnect, another repository). */
export function clearPullRequests() {
  epoch++;
  inFlight.clear();
  timelineRuns.clear();
  usePullRequests.setState({ prs: {} });
}

useGhRepository.subscribe((s, prev) => {
  const a = s.connection?.coordinates;
  const b = prev.connection?.coordinates;
  if (a?.owner !== b?.owner || a?.name !== b?.name) clearPullRequests();
});
