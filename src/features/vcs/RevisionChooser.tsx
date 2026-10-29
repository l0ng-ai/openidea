/** Chooser for "Compare with Branch or Revision…". */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Dialog, HighlightedText, Icon, List, SearchField, fuzzyMatch, listNavigate } from "@/ui";
import { sortLocal, sortRemote } from "./branches";
import { openDialog } from "./dialogs";
import { call, commands } from "@/platform/ipc";
import type { Branch } from "@/bindings";
import { currentRepo } from "./store";
import styles from "./common.module.css";

interface Item {
  rev: string;
  detail: string;
  matches: number[] | null;
}

export interface ChooseRevisionOptions {
  /** Offer the repository's tags too. */
  tags?: boolean;
  placeholder?: string;
}

export function chooseRevision(title: string, options: ChooseRevisionOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <Chooser
        title={title}
        options={options}
        onDone={(r) => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function Chooser({
  title,
  options,
  onDone,
}: {
  title: string;
  options: ChooseRevisionOptions;
  onDone: (rev: string | null) => void;
}) {
  const [repo] = useState(currentRepo);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    let alive = true;
    void call(commands.vcsBranches(repo))
      .then((b) => alive && setBranches(b))
      .catch(() => undefined);
    if (options.tags) {
      void call(commands.vcsTags(repo))
        .then((t) => alive && setTags(t))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [options.tags]);
  const items = useMemo(() => {
    const all: Item[] = [
      { rev: "HEAD", detail: "Last commit", matches: null },
      ...sortLocal(branches).map((b) => ({
        rev: b.name,
        detail: b.current ? "current branch" : "local",
        matches: null,
      })),
      ...sortRemote(branches).map((b) => ({ rev: b.name, detail: "remote", matches: null })),
      ...tags.map((t) => ({ rev: t, detail: "tag", matches: null })),
    ];
    const q = query.trim();
    const filtered = q
      ? all.flatMap((i) => {
          const m = fuzzyMatch(i.rev, q);
          return m ? [{ ...i, matches: m }] : [];
        })
      : all;
    if (q && !filtered.some((i) => i.rev === q)) filtered.push({ rev: q, detail: "revision", matches: null });
    return filtered;
  }, [branches, tags, query]);
  const idx = Math.min(active, items.length - 1);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const it = items[idx];
      if (it) onDone(it.rev);
      return;
    }
    const n = listNavigate(e.key, { items, active: idx, wrap: true });
    if (n !== null) {
      e.preventDefault();
      setActive(n);
    }
  };
  return (
    <Dialog open title={title} onClose={() => onDone(null)} width={460} position="top">
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-popup)" }}>
        <SearchField
          data-autofocus
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={options.placeholder ?? "Branch, tag or commit hash"}
          aria-label="Revision"
          variant="bare"
        />
      </div>
      <div style={{ height: 280, display: "flex", flexDirection: "column", padding: "4px 0" }}>
        <List
          items={items}
          getKey={(i) => `${i.detail}:${i.rev}`}
          activeIndex={idx}
          onActiveChange={setActive}
          onActivate={(i) => onDone(i.rev)}
          focusable={false}
          hoverSelects
          rowHeight={24}
          aria-label="Revisions"
          className={styles.grow}
          renderItem={(i) => (
            <span className={styles.fileRow} style={{ flex: 1, padding: 0 }}>
              <Icon name={i.detail === "revision" ? "commit" : i.detail === "tag" ? "tag" : "branch"} size={14} />
              <HighlightedText
                className={`${styles.fileName} ${styles.mono}`}
                text={i.rev}
                indices={i.matches}
                tone="accent"
              />
              <span className={styles.fileDir}>{i.detail}</span>
            </span>
          )}
        />
      </div>
    </Dialog>
  );
}
