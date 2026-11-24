import { useId, useState, type KeyboardEvent } from "react";
import type { Commit } from "@/bindings";
import { tx } from "@/platform/i18n";
import { Dialog, List, SearchField, T, listNavigate } from "@/ui";
import { openDialog } from "./dialogs";
import { formatTime } from "./model";
import { commitKey } from "./multiRoot";
import styles from "./CommitChooser.module.css";

const ROW_HEIGHT = 42;
const VISIBLE_ROWS = 8;

export function chooseLogCommit(commits: Commit[], title: string): Promise<Commit | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <CommitChooser
        commits={commits}
        title={title}
        onDone={(commit) => {
          close();
          resolve(commit);
        }}
      />
    ));
  });
}

function CommitChooser({
  commits,
  title,
  onDone,
}: {
  commits: Commit[];
  title: string;
  onDone: (commit: Commit | null) => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const filter = query.toLocaleLowerCase();
  const shown = commits.filter((commit) =>
    `${commit.id} ${commit.summary} ${commit.author}`.toLocaleLowerCase().includes(filter),
  );
  const selected = Math.min(active, shown.length - 1);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (shown[selected]) onDone(shown[selected]);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = listNavigate(event.key, { items: shown, active: selected, wrap: true });
      if (next === null) return;
      event.preventDefault();
      setActive(next);
    }
  };

  return (
    <Dialog open title={title} onClose={() => onDone(null)} width={520}>
      <div className={styles.search}>
        <SearchField
          data-autofocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={selected >= 0 ? `${listId}-${selected}` : undefined}
          value={query}
          onChange={(value) => {
            setQuery(value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search commits"
          aria-label="Search commits"
        />
      </div>
      <div
        className={styles.results}
        style={{ height: Math.max(1, Math.min(commits.length, VISIBLE_ROWS)) * ROW_HEIGHT }}
      >
        <List
          id={listId}
          items={shown}
          getKey={commitKey}
          activeIndex={selected}
          onActiveChange={setActive}
          onActivate={onDone}
          focusable={false}
          rowHeight={ROW_HEIGHT}
          aria-label={tx(title)}
          empty={<T>No commits</T>}
          className={styles.list}
          renderItem={(commit) => {
            const date = formatTime(commit.timeMs);
            return (
              <span className={styles.choice} title={[commit.summary, commit.shortId, commit.author, date].join("\n")}>
                <span className={styles.subject}>{commit.summary}</span>
                <span className={styles.metadata}>
                  <span className={styles.hash}>{commit.shortId}</span>
                  <span className={styles.author}>{commit.author}</span>
                  {date && <span className={styles.date}>{date}</span>}
                </span>
              </span>
            );
          }}
        />
      </div>
    </Dialog>
  );
}
