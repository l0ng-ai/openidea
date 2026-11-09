/** Clone Repository › GitHub: the repositories of the account gh is signed in to. */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { GhAccountRepo, GhAccountRepos } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import {
  Button,
  EmptyState,
  HighlightedText,
  Icon,
  List,
  SearchField,
  Spinner,
  T,
  fuzzyMatch,
  listNavigate,
} from "@/ui";
import type { CloneSourceProps } from "@/workbench/contributions";
import { openInBrowser } from "../data/local";
import styles from "./GitHubCloneSource.module.css";

type Row = { repo: GhAccountRepo; indices: number[] | null };

/** Repositories matching `query` (fuzzy, on `owner/name`), in the account's order. */
export function matchRepos(repos: readonly GhAccountRepo[], query: string): Row[] {
  const q = query.trim();
  if (!q) return repos.map((repo) => ({ repo, indices: null }));
  return repos.flatMap((repo) => {
    const indices = fuzzyMatch(repo.nameWithOwner, q);
    return indices ? [{ repo, indices }] : [];
  });
}

export function GitHubCloneSource({ url, onUrl, onClone, disabled }: CloneSourceProps) {
  const [state, setState] = useState<GhAccountRepos | null>(null);
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    call(commands.ghAccountRepos())
      .then((s) => alive && setState(s))
      .catch((e) => alive && setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [attempt]);

  const rows = useMemo(() => (state?.kind === "ready" ? matchRepos(state.repos, query) : []), [state, query]);
  const active = rows.findIndex((r) => r.repo.cloneUrl === url);
  const retry = (
    <Button
      size="small"
      onClick={() => {
        setState(null);
        setAttempt((n) => n + 1);
      }}
    >
      <T>Retry</T>
    </Button>
  );

  if (!state)
    return (
      <div className={styles.center}>
        <Spinner />
        <span className={styles.muted}>
          <T>Loading repositories…</T>
        </span>
      </div>
    );
  if (state.kind === "notInstalled")
    return (
      <EmptyState
        title="GitHub CLI is not installed"
        actions={
          <>
            <Button size="small" onClick={() => void openInBrowser("https://cli.github.com")}>
              <T>Install gh…</T>
            </Button>
            {retry}
          </>
        }
      >
        <T>GitHub repositories are listed with the</T> <code>gh</code> <T>command line tool. Install it, then run</T>{" "}
        <code>gh auth login</code>.
      </EmptyState>
    );
  if (state.kind === "notLoggedIn")
    return (
      <EmptyState title="Not logged in to GitHub" actions={retry}>
        <T>Run</T> <code>gh auth login</code> <T>in a terminal, then retry.</T>
      </EmptyState>
    );
  if (state.kind === "error")
    return (
      <EmptyState title="Could not reach GitHub" actions={retry}>
        {state.message}
      </EmptyState>
    );

  const pick = (i: number) => {
    const row = rows[i];
    if (row) onUrl(row.repo.cloneUrl);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && rows[active]) {
      e.preventDefault();
      onClone(rows[active].repo.cloneUrl);
      return;
    }
    const next = listNavigate(e.key, { items: rows, active: Math.max(active, 0) });
    if (next !== null) {
      e.preventDefault();
      pick(next);
    }
  };

  return (
    <div className={styles.pane}>
      <div className={styles.header}>
        <Icon name="github" size={16} />
        <span className={styles.login}>{state.login}</span>
        <SearchField
          className={styles.search}
          aria-label="Search repositories"
          placeholder={tx("Search repositories")}
          value={query}
          onChange={setQuery}
          onKeyDown={onKeyDown}
          disabled={disabled}
          data-autofocus
        />
      </div>
      <div className={styles.list}>
        <List<Row>
          aria-label="Repositories"
          items={rows}
          getKey={(r) => r.repo.nameWithOwner}
          activeIndex={active}
          onActiveChange={pick}
          focusable={false}
          rowHeight={26}
          empty={
            <span className={styles.muted}>
              <T>{state.repos.length ? "No matching repositories" : "No repositories"}</T>
            </span>
          }
          renderItem={(r) => (
            <span
              className={styles.row}
              title={r.repo.description ?? undefined}
              onDoubleClick={() => onClone(r.repo.cloneUrl)}
            >
              <Icon name={r.repo.private ? "lock" : "github"} size={14} className={styles.rowIcon} />
              <span className={styles.name}>
                {r.indices ? <HighlightedText text={r.repo.nameWithOwner} indices={r.indices} /> : r.repo.nameWithOwner}
              </span>
              {r.repo.fork && (
                <span className={styles.tag}>
                  <T>fork</T>
                </span>
              )}
              {r.repo.archived && (
                <span className={styles.tag}>
                  <T>archived</T>
                </span>
              )}
              {r.repo.description && <span className={styles.description}>{r.repo.description}</span>}
            </span>
          )}
        />
      </div>
    </div>
  );
}
