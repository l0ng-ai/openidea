/**
 * The pull request list (IntelliJ's `GHPRListLoader` over `issueSearch`): pages of 50,
 * cursor-paged, for the current search value. `loadMore()` fetches the next page (the
 * list calls it while scrolling past 70%); `reloadList()` starts over, keeping the rows
 * visible until the first page arrives. Rows are refreshed in place when a pull request's
 * details load (`updateListItem`).
 */
import { create } from "zustand";
import { errorMessage } from "../api/client";
import * as api from "../api/requests";
import type { GHPullRequest, GHPullRequestShort } from "../api/types";
import { listSearchQuery, sameSearch, type PrSearchValue } from "./model";
import { useGhRepository } from "./repository";

interface ListState {
  search: PrSearchValue;
  items: GHPullRequestShort[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** The first page of the current search arrived (`items` are for `search`). */
  loaded: boolean;
}

export const useGhPrList = create<ListState>(() => ({
  search: {},
  items: [],
  cursor: null,
  hasMore: true,
  loading: false,
  error: null,
  loaded: false,
}));

let seq = 0;

async function fetchPage(reset: boolean): Promise<void> {
  const repo = useGhRepository.getState().connection?.coordinates;
  if (!repo) return;
  const my = ++seq;
  const s = useGhPrList.getState();
  useGhPrList.setState({ loading: true, error: null });
  try {
    const page = await api.searchPullRequests(listSearchQuery(repo, s.search), reset ? null : s.cursor);
    if (my !== seq) return;
    useGhPrList.setState((cur) => {
      const items = reset
        ? page.nodes
        : [...cur.items, ...page.nodes.filter((n) => !cur.items.some((i) => i.id === n.id))];
      return {
        items,
        cursor: page.pageInfo.endCursor,
        hasMore: page.pageInfo.hasNextPage,
        loading: false,
        loaded: true,
      };
    });
  } catch (e) {
    if (my !== seq) return;
    useGhPrList.setState({
      loading: false,
      error: errorMessage(e),
      hasMore: false,
      loaded: true,
      ...(reset ? { items: [] } : {}),
    });
  }
}

/** Shows the pull requests matching `search` (from the first page). */
export function setListSearch(search: PrSearchValue): Promise<void> {
  const same = sameSearch(useGhPrList.getState().search, search);
  useGhPrList.setState({ search, ...(same ? {} : { items: [], loaded: false }), cursor: null, hasMore: true });
  return fetchPage(true);
}

/** Loads the next page, if there is one and none is loading. */
export function loadMore(): Promise<void> {
  const s = useGhPrList.getState();
  if (s.loading || !s.hasMore || !s.loaded) return Promise.resolve();
  return fetchPage(false);
}

/** "Refresh List": the current search from the first page. */
export function reloadList(): Promise<void> {
  useGhPrList.setState({ cursor: null, hasMore: true });
  return fetchPage(true);
}

/** Replaces the row of `pr` with fresher data (details loaded, a mutation's result). */
export function updateListItem(pr: GHPullRequestShort | GHPullRequest) {
  useGhPrList.setState((s) => {
    const i = s.items.findIndex((x) => x.id === pr.id);
    if (i < 0) return s;
    const items = [...s.items];
    items[i] = { ...items[i]!, ...pickShort(pr) };
    return { items };
  });
}

function pickShort(pr: GHPullRequestShort): GHPullRequestShort {
  const {
    id,
    url,
    number,
    title,
    state,
    isDraft,
    author,
    createdAt,
    updatedAt,
    isReadByViewer,
    assignees,
    labels,
    reviewRequests,
    reviewThreads,
    reviews,
    reactions,
    mergeable,
    viewerCanUpdate,
    viewerCanReact,
    viewerDidAuthor,
  } = pr;
  return {
    id,
    url,
    number,
    title,
    state,
    isDraft,
    author,
    createdAt,
    updatedAt,
    isReadByViewer,
    assignees,
    labels,
    reviewRequests,
    reviewThreads,
    reviews,
    reactions,
    mergeable,
    viewerCanUpdate,
    viewerCanReact,
    viewerDidAuthor,
  };
}

/** Forgets the rows (disconnect, another repository). */
export function clearList() {
  seq++;
  useGhPrList.setState({ items: [], cursor: null, hasMore: true, loading: false, error: null, loaded: false });
}

useGhRepository.subscribe((s, prev) => {
  const a = s.connection?.coordinates;
  const b = prev.connection?.coordinates;
  if (a?.owner !== b?.owner || a?.name !== b?.name) clearList();
});
