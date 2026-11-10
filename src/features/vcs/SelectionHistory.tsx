/**
 * History for Selection editor tab (IDEA's Show History for Selection): the
 * commits that changed the selected lines (`git log -L`, renames followed),
 * newest first, each shown as the block before and after it. Unsaved or
 * uncommitted edits of the block come first as Local Changes.
 */
import { useEffect, useState } from "react";
import type { BlockHistory, BlockRevision } from "@/bindings";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { List, Spinner, T } from "@/ui";
import type { EditorInput } from "@/workbench/contributions";
import { DiffEditor } from "./DiffEditor";
import { diffInput, type DiffSide } from "./diffInput";
import { baseName, formatTime } from "./model";
import { errorMessage } from "./ops";
import type { SelectionHistoryData } from "./selectionHistoryKind";
import layout from "./LocalHistory.module.css";
import styles from "./SelectionHistory.module.css";
import { tx } from "@/platform/i18n";

export type HistoryRow =
  | { kind: "local"; head: string; current: string }
  | { kind: "revision"; revision: BlockRevision };

const HEAD = "HEAD";

/** Lines `from..=to` of `text`, each ending with a line break (as Git prints a block). */
export function blockOf(text: string, [from, to]: readonly [number, number]): string {
  return text
    .split("\n")
    .slice(from, to + 1)
    .map((line) => `${line.replace(/\r$/, "")}\n`)
    .join("");
}

/** The rows of the list: Local Changes when the block differs from HEAD, then the commits. */
export function historyRows(history: BlockHistory, current: string): HistoryRow[] {
  const rows: HistoryRow[] = history.revisions.map((revision) => ({ kind: "revision", revision }));
  const head = history.revisions[0]?.after;
  if (history.headLines && head !== undefined && head !== current) rows.unshift({ kind: "local", head, current });
  return rows;
}

function sides(row: HistoryRow): [DiffSide, DiffSide] {
  if (row.kind === "local")
    return [
      { type: "text", text: row.head, label: HEAD },
      { type: "text", text: row.current, label: tx("Local Changes") },
    ];
  const r = row.revision;
  return [
    { type: "text", text: r.before, label: `${r.shortId}^` },
    { type: "text", text: r.after, label: r.shortId },
  ];
}

export function SelectionHistoryEditor({ input }: { input: EditorInput }) {
  const data = input.data as SelectionHistoryData;
  const [history, setHistory] = useState<BlockHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const request = nextRequestId();
    let done = false;
    call(commands.vcsBlockHistory(request, data.path, data.text, data.lines))
      .then(setHistory, (e: unknown) => {
        if (!isCancelled(e)) setError(errorMessage(e));
      })
      .finally(() => {
        done = true;
      });
    return () => {
      if (!done) void commands.cancelRequest(request);
    };
  }, [data]);

  const rows = history ? historyRows(history, blockOf(data.text, data.lines)) : [];
  const current = rows[Math.min(active, rows.length - 1)];
  const [from, to] = data.lines;

  let detail;
  if (!current)
    detail = (
      <div className={layout.message}>
        <T>Select a revision</T>
      </div>
    );
  else {
    const [left, right] = sides(current);
    detail = (
      <DiffEditor
        key={current.kind === "local" ? "local" : current.revision.id}
        input={diffInput({ path: data.path, left, right })}
      />
    );
  }

  return (
    <div className={layout.root}>
      <div className={layout.sidebar}>
        <div className={layout.header}>
          <span className={layout.title}>
            <T>History for Selection</T>
          </span>
          <span className={styles.range}>{`${baseName(data.path)}:${from + 1}-${to + 1}`}</span>
        </div>
        {error ? (
          <div className={layout.message}>{error}</div>
        ) : !history ? (
          <div className={layout.message}>
            <Spinner size={14} />
          </div>
        ) : (
          <List
            items={rows}
            getKey={(row) => (row.kind === "local" ? "local" : row.revision.id)}
            activeIndex={Math.min(active, rows.length - 1)}
            onActiveChange={setActive}
            onActivate={(_row, i) => setActive(i)}
            rowHeight={38}
            aria-label="Revisions"
            className={layout.list}
            empty={
              <span className={layout.message}>
                {history.headLines ? tx`No commits changed these lines` : tx`These lines are not committed yet`}
              </span>
            }
            renderItem={(row) =>
              row.kind === "local" ? (
                <span className={layout.entry}>
                  <span className={styles.summary}>
                    <T>Local Changes</T>
                  </span>
                  <span className={styles.meta}>
                    <T>Not Committed Yet</T>
                  </span>
                </span>
              ) : (
                <span className={layout.entry}>
                  <span className={styles.summary}>{row.revision.summary}</span>
                  <span className={styles.meta}>
                    {`${row.revision.shortId} · ${row.revision.author} · ${formatTime(row.revision.timeMs)}`}
                  </span>
                </span>
              )
            }
          />
        )}
      </div>
      <div className={layout.diff}>{detail}</div>
    </div>
  );
}
