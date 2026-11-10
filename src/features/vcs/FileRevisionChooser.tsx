import { useEffect, useState, type KeyboardEvent } from "react";
import type { Commit } from "@/bindings";
import { call, commands, nextRequestId } from "@/platform/ipc";
import { Dialog, List, SearchField, Spinner, T, listNavigate } from "@/ui";
import { openDialog } from "./dialogs";
import { openVcsDiff } from "./diffInput";
import { hasFileHistory } from "./fileRevisions";
import { formatTime } from "./model";
import { repositoryPath } from "./repositoryPaths";
import { repoOf } from "./store";
import styles from "./FileRevisionChooser.module.css";

export function compareWithFileRevision(path: string | null | undefined) {
  if (!path || !hasFileHistory(path)) return;
  const repo = repoOf(path);
  openDialog((close) => (
    <FileRevisionChooser
      path={path}
      repo={repo}
      onClose={close}
      onChoose={(commit) => {
        close();
        if (repoOf(path) !== repo) return;
        void openVcsDiff({
          path,
          left: {
            type: "rev",
            rev: commit.id,
            label: commit.shortId,
            path: commit.historyPath ? repositoryPath(repo, commit.historyPath) : path,
          },
          right: { type: "worktree" },
        });
      }}
    />
  ));
}

function FileRevisionChooser({
  path,
  repo,
  onClose,
  onChoose,
}: {
  path: string;
  repo: string | null;
  onClose: () => void;
  onChoose: (commit: Commit) => void;
}) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    let alive = true;
    let pending = true;
    const request = nextRequestId();
    void call(
      commands.vcsLog(repo, {
        branch: null,
        path,
        author: null,
        text: null,
        skip: 0,
        limit: 0,
        follow: true,
        summaryOnly: true,
        request,
      }),
    )
      .then((rows) => alive && setCommits(rows))
      .catch((e) => alive && setError(String(e)))
      .finally(() => {
        pending = false;
      });
    return () => {
      alive = false;
      if (pending) void commands.cancelRequest(request).catch(() => undefined);
    };
  }, [path, repo]);
  const q = query.trim().toLocaleLowerCase();
  const items = (commits ?? []).filter((c) =>
    `${c.id} ${formatTime(c.timeMs)} ${c.author} ${c.summary}`.toLocaleLowerCase().includes(q),
  );
  const idx = Math.min(active, items.length - 1);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (items[idx]) onChoose(items[idx]);
      return;
    }
    const next = listNavigate(e.key, { items, active: idx, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };
  return (
    <Dialog open title="Compare with Revision…" onClose={onClose} width={720} position="top">
      <div className={styles.search}>
        <SearchField
          data-autofocus
          value={query}
          onChange={(value) => {
            setQuery(value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search file revisions"
          aria-label="Search file revisions"
          variant="bare"
        />
      </div>
      <div className={styles.body}>
        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : commits === null ? (
          <Spinner size={14} />
        ) : (
          <List
            items={items}
            getKey={(c) => c.id}
            activeIndex={idx}
            onActiveChange={setActive}
            onActivate={onChoose}
            focusable={false}
            hoverSelects
            rowHeight={28}
            aria-label="File revisions"
            empty={<T>No commits</T>}
            className={styles.list}
            renderItem={(c) => (
              <span className={styles.row} title={`${c.shortId} ${formatTime(c.timeMs)} ${c.author} ${c.summary}`}>
                <span className={styles.hash}>{c.shortId}</span>
                <span className={styles.date}>{formatTime(c.timeMs)}</span>
                <span className={styles.author}>{c.author}</span>
                <span className={styles.subject}>{c.summary}</span>
              </span>
            )}
          />
        )}
      </div>
    </Dialog>
  );
}
