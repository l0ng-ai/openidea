/**
 * The list tab's panel (IntelliJ's `GHPRListPanelFactory` / `GHPRListPanelController`):
 * the search panel, a progress stripe while loading, and the pull requests, 50 per page,
 * the next page requested once the scroll passes 70% (checked again after each page).
 * Enter or a double-click opens the selected pull request; the context menu is
 * `Github.PullRequest.ToolWindow.List.Popup`. Load errors replace the list with
 * "Can't load pull requests" and Retry.
 *
 * The search starts as the last one used, else "Assigned to you"; every change is saved
 * as the last search and, by IntelliJ's rules, added to the history (`model.ts`).
 */
import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import { useTx } from "@/platform/i18n";
import { EmptyState, List, ProgressBar, showContextMenu, T, type MenuItem } from "@/ui";
import type { GHPullRequestShort } from "../api/types";
import { loadMore, reloadList, setListSearch, useGhPrList } from "../data/list";
import { filterCount, type PrSearchValue } from "../data/model";
import { useGhRepository } from "../data/repository";
import { initialSearch, rememberSearch, saveLastSearch } from "../data/searchHistory";
import { openPullRequest } from "../toolwindow/open";
import { setListSelection, useGhTabs } from "../toolwindow/store";
import { createSearchHistoryRecorder, defaultFilter, pastThreshold, type SearchHistoryRecorder } from "./model";
import { PullRequestRow } from "./PullRequestRow";
import { SearchPanel } from "./SearchPanel";
import styles from "./List.module.css";

/** Row height: 4px + the 24px first line + the 16px info line + 5px. */
const ROW_HEIGHT = 49;

/** `Github.PullRequest.ToolWindow.List.Popup`. */
function contextMenu(number: number): MenuItem[] {
  return [
    { kind: "action", action: "github.pullRequest.show", arg: number },
    { kind: "action", action: "github.pullRequest.checkoutBranch", arg: number },
    { kind: "action", action: "github.pullRequest.openInWorktree", arg: number },
    { kind: "action", action: "github.pullRequest.openInBrowser", arg: number },
    { kind: "action", action: "github.pullRequest.copyUrl", arg: number },
    { kind: "separator" },
    { kind: "action", action: "github.refresh", label: "Refresh List" },
  ];
}

/** Applies searches to the list, saving them as IntelliJ does; the first call is the initial search. */
function useApplySearch(login: string | undefined): (v: PrSearchValue) => void {
  const recorder = useRef<SearchHistoryRecorder | null>(null);
  useEffect(() => {
    if (!login) return;
    const defaultSearch = defaultFilter();
    const r = createSearchHistoryRecorder({
      defaultSearch,
      saveLast: (v) => saveLastSearch(v),
      remember: (v) => rememberSearch(v, undefined, defaultSearch),
    });
    recorder.current = r;
    r.onChange(initialSearch());
    void setListSearch(initialSearch());
    return () => {
      r.dispose();
      if (recorder.current === r) recorder.current = null;
    };
  }, [login]);
  return useCallback((v: PrSearchValue) => {
    recorder.current?.onChange(v);
    void setListSearch(v);
  }, []);
}

function ErrorState({ error }: { error: string }) {
  return (
    <div className={styles.error}>
      <EmptyState
        title="Can't load pull requests"
        actions={
          <button type="button" className={styles.emptyLink} onClick={() => void reloadList()}>
            <T>Retry</T>
          </button>
        }
      >
        <div className={styles.errorBody}>{error}</div>
      </EmptyState>
    </div>
  );
}

export function ListPanel() {
  const t = useTx();
  const connection = useGhRepository((s) => s.connection);
  const login = connection?.currentUser.login;
  const { search, items, loading, error, loaded, hasMore } = useGhPrList();
  const selected = useGhTabs((s) => s.listSelection);
  const apply = useApplySearch(login);
  const body = useRef<HTMLDivElement>(null);

  const checkScroll = useCallback(() => {
    const list = body.current?.querySelector<HTMLElement>("[role=listbox]");
    if (!list || list.offsetParent === null) return;
    if (pastThreshold(list.scrollTop, list.clientHeight, list.scrollHeight)) void loadMore();
  }, []);
  // After each page: the list may still not fill the view (`ReviewListUtil.wrapWithLazyVerticalScroll`).
  useEffect(() => {
    if (loaded && !loading && hasMore && !error) {
      const id = requestAnimationFrame(checkScroll);
      return () => cancelAnimationFrame(id);
    }
  }, [items.length, loaded, loading, hasMore, error, checkScroll]);

  if (!connection || !login) return null;
  const index = items.findIndex((p) => p.number === selected);
  const onContextMenu = (pr: GHPullRequestShort, _i: number, e: MouseEvent) => {
    e.preventDefault();
    setListSelection(pr.number);
    showContextMenu(e, contextMenu(pr.number));
  };

  const empty = loading ? (
    <EmptyState title="Loading…" />
  ) : filterCount(search) === 0 ? (
    <EmptyState title={t`No pull requests in ${connection.coordinates.name}`} />
  ) : (
    <EmptyState
      title="No pull requests matching filters"
      actions={
        <button type="button" className={styles.emptyLink} onClick={() => apply({})}>
          <T>Clear filters</T>
        </button>
      }
    />
  );

  return (
    <div className={styles.panel}>
      <SearchPanel search={search} apply={apply} login={login} />
      <div ref={body} className={styles.body} onScrollCapture={checkScroll}>
        {loading && <ProgressBar className={styles.stripe} aria-label="Loading…" />}
        {error ? (
          <ErrorState error={error} />
        ) : (
          <List<GHPullRequestShort>
            items={items}
            getKey={(p) => p.id}
            rowHeight={ROW_HEIGHT}
            activeIndex={index}
            onActiveChange={(i) => setListSelection(items[i]?.number ?? null)}
            onActivate={(p, _i, e) => {
              // Enter or a double-click (`CommonShortcuts.ENTER`, `DOUBLE_CLICK_1`).
              if (e.type === "click" && (e as MouseEvent).detail !== 2) return;
              void openPullRequest(p.number);
            }}
            onContextMenu={onContextMenu}
            aria-label="Pull requests"
            className={styles.list}
            empty={empty}
            renderItem={(p) => <PullRequestRow pr={p} currentUser={connection.currentUser} />}
          />
        )}
      </div>
    </div>
  );
}
