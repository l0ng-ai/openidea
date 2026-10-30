/**
 * PLACEHOLDER (foundation stub) — the list tab's panel. Wave 1 "list" replaces it.
 *
 * Contract: `ListPanel()` takes no props and renders inside the list tab of the Pull
 * Requests tool window while it is connected (`useGhRepository().connection` is set; the
 * tab adds IntelliJ's 8px top padding). It owns:
 * - the search panel: start with `initialSearch(currentUser.login)`, apply with
 *   `setListSearch(value)`, persist with `saveLastSearch` / `rememberSearch`
 *   (`data/searchHistory.ts`, `data/model.ts` for the value and its terms);
 * - the rows from `useGhPrList()` (`items`, `loading`, `error`, `hasMore`), paging with
 *   `loadMore()` past 70% of the scroll, `reloadList()` for Refresh;
 * - selection: report it with `setListSelection(number)` (`toolwindow/store.ts`), open
 *   with `openPullRequest(number)` (`toolwindow/open.ts`) on Enter / double-click.
 * The tool window reloads the list when the tab is selected or the window shown.
 *
 * Until then this lists the open pull requests plainly, so the window stays usable.
 */
import { useEffect } from "react";
import { EmptyState, List, Spinner, T } from "@/ui";
import { tx } from "@/platform/i18n";
import type { GHPullRequestShort } from "../api/types";
import { loadMore, setListSearch, useGhPrList } from "../data/list";
import { useGhRepository } from "../data/repository";
import { initialSearch } from "../data/searchHistory";
import { openPullRequest } from "../toolwindow/open";
import { setListSelection, useGhTabs } from "../toolwindow/store";
import { Placeholder } from "../ui/Placeholder";
import { prettyDate } from "../ui/prettyDate";
import styles from "../toolwindow/ToolWindow.module.css";

function Row({ pr }: { pr: GHPullRequestShort }) {
  const number = pr.number;
  const date = prettyDate(pr.createdAt);
  const author = pr.author?.login;
  return (
    <div className={styles.plainRow}>
      <div className={styles.ellipsis}>{pr.title}</div>
      <div className={styles.secondary}>
        {author ? tx`#${number} · created ${date}, by ${author}` : tx`#${number} · created ${date}`}
      </div>
    </div>
  );
}

export function ListPanel() {
  const login = useGhRepository((s) => s.connection?.currentUser.login);
  const { items, loading, error, loaded, hasMore } = useGhPrList();
  const selected = useGhTabs((s) => s.listSelection);
  useEffect(() => {
    if (login) void setListSearch(initialSearch(login));
  }, [login]);
  const index = items.findIndex((p) => p.number === selected);
  return (
    <div className={styles.column}>
      <Placeholder title="Pull request list (placeholder)" />
      {error ? (
        <EmptyState title="Can't load pull requests">{error}</EmptyState>
      ) : (
        <List
          items={items}
          getKey={(p) => p.id}
          rowHeight={44}
          activeIndex={index}
          onActiveChange={(i) => {
            setListSelection(items[i]?.number ?? null);
            if (i > items.length * 0.7 && hasMore) void loadMore();
          }}
          onActivate={(p) => void openPullRequest(p.number)}
          aria-label="Pull requests"
          className={styles.grow}
          empty={loaded && !loading ? <EmptyState title="No pull requests" /> : <Spinner />}
          renderItem={(p) => <Row pr={p} />}
        />
      )}
      {loading && loaded && (
        <div className={styles.secondary}>
          <T>Loading…</T>
        </div>
      )}
    </div>
  );
}
