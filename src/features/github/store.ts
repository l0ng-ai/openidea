/** Pull request state of the Pull Requests tool window: gh availability, list query, selection, details. */
import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import type {
  GhAvailability,
  PrDiffRevisions,
  PrListQuery,
  PrReviewComment,
  PullRequestDetails,
  PullRequestSummary,
  RequestId,
} from "@/platform/ipc";
import { call, commands, isCancelled, isTauri, nextRequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { loadLastSearch, rememberSearch, saveLastSearch, sameQuery } from "./searchHistory";

export type DetailTab = "overview" | "files" | "commits" | "conversation";

interface GithubState {
  availability: GhAvailability | null;
  checking: boolean;
  query: PrListQuery;
  list: PullRequestSummary[];
  listLoading: boolean;
  listError: string | null;
  selected: number | null;
  details: PullRequestDetails | null;
  detailsLoading: boolean;
  detailsError: string | null;
  reviewComments: PrReviewComment[];
  tab: DetailTab;
  /** Running gh operation (checkout, create, fetch for diff), with its last output line. */
  busy: { title: string; line: string; request: RequestId } | null;
  /** Files tab: under their directories (IDEA's Group by Directory) or a flat list. */
  groupFilesByDirectory: boolean;
}

export const DEFAULT_QUERY: PrListQuery = {
  state: "open",
  authorMe: false,
  reviewRequested: false,
  assigneeMe: false,
  search: "",
  limit: 100,
};

export const useGithub = create<GithubState>(() => ({
  availability: null,
  checking: false,
  query: DEFAULT_QUERY,
  list: [],
  listLoading: false,
  listError: null,
  selected: null,
  details: null,
  detailsLoading: false,
  detailsError: null,
  reviewComments: [],
  tab: "overview",
  busy: null,
  groupFilesByDirectory: loadGrouping(),
}));

const GROUPING_KEY = "openidea.github.groupFilesByDirectory.v1";

function loadGrouping(): boolean {
  try {
    return globalThis.localStorage?.getItem(GROUPING_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setGroupFilesByDirectory(groupFilesByDirectory: boolean) {
  useGithub.setState({ groupFilesByDirectory });
  try {
    globalThis.localStorage?.setItem(GROUPING_KEY, String(groupFilesByDirectory));
  } catch {
    /* storage unavailable */
  }
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function readyRepo() {
  const a = useGithub.getState().availability;
  return a?.kind === "ready" ? a.repo : null;
}

export async function checkAvailability(): Promise<GhAvailability | null> {
  if (!isTauri()) return null;
  useGithub.setState({ checking: true });
  try {
    const availability = await call(commands.ghAvailability());
    useGithub.setState({ availability });
    return availability;
  } catch (e) {
    const availability: GhAvailability = { kind: "error", message: errorMessage(e) };
    useGithub.setState({ availability });
    return availability;
  } finally {
    useGithub.setState({ checking: false });
  }
}

let listSeq = 0;
export async function loadList(): Promise<void> {
  if (useGithub.getState().availability?.kind !== "ready") return;
  const seq = ++listSeq;
  useGithub.setState({ listLoading: true, listError: null });
  try {
    const list = await call(commands.ghPrList(useGithub.getState().query));
    if (seq === listSeq) useGithub.setState({ list });
  } catch (e) {
    if (seq === listSeq) useGithub.setState({ listError: errorMessage(e), list: [] });
  } finally {
    if (seq === listSeq) useGithub.setState({ listLoading: false });
  }
}

/** Re-checks gh and reloads the list (and the open details). */
export async function refreshAll(): Promise<void> {
  const a = await checkAvailability();
  if (a?.kind !== "ready") return;
  await loadList();
  const n = useGithub.getState().selected;
  if (n !== null) await loadDetails(n);
}

const projectRoot = () => useProject.getState().project?.root ?? null;

/** IDEA waits before keeping a filter-only change in the history (the user may still be toggling). */
const FILTER_HISTORY_DELAY = 10_000;
/** Typed text is kept once it stops changing (the list follows each pause in typing). */
const TEXT_HISTORY_DELAY = 2_000;
let historyTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Applies `patch` to the list query and reloads. The query becomes the project's last
 * search, and enters the search history once it has stayed for a moment (`now`: at once,
 * as on Enter or when picked from the history).
 */
export function setQuery(patch: Partial<PrListQuery>, opts: { now?: boolean } = {}) {
  const prev = useGithub.getState().query;
  const query = { ...prev, ...patch };
  useGithub.setState({ query });
  void loadList();
  const root = projectRoot();
  saveLastSearch(root, query);
  clearTimeout(historyTimer);
  const remember = () => {
    if (projectRoot() === root && sameQuery(useGithub.getState().query, query))
      rememberSearch(root, query, DEFAULT_QUERY);
  };
  if (opts.now) remember();
  else
    historyTimer = setTimeout(
      remember,
      prev.search.trim() === query.search.trim() ? FILTER_HISTORY_DELAY : TEXT_HISTORY_DELAY,
    );
}

let detailSeq = 0;
export async function loadDetails(number: number): Promise<void> {
  const seq = ++detailSeq;
  const same = useGithub.getState().details?.summary.number === number;
  useGithub.setState({
    selected: number,
    detailsLoading: true,
    detailsError: null,
    ...(same ? {} : { details: null, reviewComments: [] }),
  });
  try {
    const [details, comments] = await Promise.all([
      call(commands.ghPrView(number)),
      call(commands.ghPrReviewComments(number)).catch(() => [] as PrReviewComment[]),
    ]);
    if (seq === detailSeq) useGithub.setState({ details, reviewComments: comments });
  } catch (e) {
    if (seq === detailSeq) useGithub.setState({ detailsError: errorMessage(e) });
  } finally {
    if (seq === detailSeq) useGithub.setState({ detailsLoading: false });
  }
}

export function select(number: number | null) {
  if (number === null) {
    useGithub.setState({ selected: null, details: null, reviewComments: [] });
    return;
  }
  if (useGithub.getState().selected !== number) void loadDetails(number);
}

/** Runs a cancellable, streaming gh operation shown in the view's banner. */
export async function withBusy<T>(
  title: string,
  run: (request: RequestId, out: Channel<string>) => Promise<T>,
): Promise<T | null> {
  if (useGithub.getState().busy) {
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
  out.onmessage = (line) => useGithub.setState((s) => (s.busy ? { busy: { ...s.busy, line } } : s));
  useGithub.setState({ busy: { title, line: "", request } });
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
    useGithub.setState({ busy: null });
  }
}

export function cancelBusy() {
  const b = useGithub.getState().busy;
  if (b) void commands.cancelRequest(b.request);
}

const diffCache = new Map<string, PrDiffRevisions>();

/** Another project: start over, from the filter its list showed last. */
export function resetGithub(root: string | null) {
  diffCache.clear();
  clearTimeout(historyTimer);
  useGithub.setState({
    availability: null,
    list: [],
    selected: null,
    details: null,
    reviewComments: [],
    query: loadLastSearch(root, DEFAULT_QUERY) ?? DEFAULT_QUERY,
  });
}

/** Fetches what the local repository lacks to diff `pr`, once per head commit. */
export async function diffRevisions(pr: PullRequestDetails): Promise<PrDiffRevisions | null> {
  const key = `${pr.summary.number}:${pr.headOid}:${pr.baseOid}`;
  const hit = diffCache.get(key);
  if (hit) return hit;
  const repo = readyRepo();
  const revs = await withBusy(`Fetching #${pr.summary.number}…`, (r, out) =>
    call(
      commands.ghPrPrepareDiff(
        r,
        pr.summary.number,
        pr.headOid,
        pr.baseOid,
        pr.summary.baseRef,
        repo?.nameWithOwner ?? "",
        out,
      ),
    ),
  );
  if (revs) diffCache.set(key, revs);
  return revs;
}
