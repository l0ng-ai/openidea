/**
 * History for Selection editor tab (IDEA's Show History for Selection): the
 * commits that changed the selected lines (`git log -L`, renames followed),
 * newest first, each shown as the block before and after it. Unsaved or
 * uncommitted edits of the block come first as Local Changes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import type {
  BlockHistorySummary,
  BlockRevision,
  BlockRevisionSpot,
  BlockRevisionSummary,
  RequestId,
} from "@/bindings";
import { call, commands, isCancelled, nextRequestId } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { List, Spinner, SplitGroup, SplitHandle, SplitPanel, T } from "@/ui";
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
  | { kind: "revision"; revision: BlockRevisionSummary; index: number };

const HEAD = "HEAD";
const COLUMNS = ["Revision", "Date", "Author", "Message"] as const;
const DIFF_BATCH = 4;
const DIFF_CACHE_SIZE = DIFF_BATCH * 3;
const NO_ROWS: HistoryRow[] = [];

/** Lines `from..=to` of `text`, each ending with a line break (as Git prints a block). */
export function blockOf(text: string, [from, to]: readonly [number, number]): string {
  return text
    .split("\n")
    .slice(from, to + 1)
    .map((line) => `${line.replace(/\r$/, "")}\n`)
    .join("");
}

/** The rows of the list: Local Changes when the block differs from HEAD, then the commits. */
export function historyRows(history: BlockHistorySummary, current: string): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...history.diffs.map((revision, index) => ({ kind: "revision" as const, revision, index })),
    ...history.rest.map((revision, offset) => ({
      kind: "revision" as const,
      revision,
      index: history.diffs.length + offset,
    })),
  ];
  // Servers that predate `head` only give the newest row's block, which a merge leaves empty.
  const head = history.head ?? history.diffs[0]?.after;
  if (head != null && head !== current) rows.unshift({ kind: "local", head, current });
  return rows;
}

function sides(row: HistoryRow, revision: BlockRevision | undefined): [DiffSide, DiffSide] | undefined {
  if (row.kind === "local")
    return [
      { type: "text", text: row.head, label: HEAD },
      { type: "text", text: row.current, label: tx("Local Changes") },
    ];
  if (!revision) return;
  return [
    { type: "text", text: revision.before, label: `${revision.shortId}^` },
    { type: "text", text: revision.after, label: revision.shortId },
  ];
}

function historyRequest<T>(
  run: (request: RequestId) => Promise<T>,
  onResult: (result: T) => void,
  onError: (error: string) => void,
) {
  const request = nextRequestId();
  let started = false;
  let done = false;
  let live = true;
  void Promise.resolve().then(async () => {
    if (!live) return;
    started = true;
    try {
      const result = await run(request);
      if (live) onResult(result);
    } catch (error) {
      if (live && !isCancelled(error)) onError(errorMessage(error));
    } finally {
      done = true;
    }
  });
  return () => {
    live = false;
    if (started && !done) void commands.cancelRequest(request);
  };
}

export function SelectionHistoryEditor({ input }: { input: EditorInput }) {
  const data = input.data as SelectionHistoryData;
  const [result, setResult] = useState<{
    data: SelectionHistoryData;
    history: BlockHistorySummary;
    hasHead: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{ data: SelectionHistoryData; error: string } | null>(null);
  const [active, setActive] = useState(0);
  const history = result?.data === data ? result.history : null;
  const error = failure?.data === data ? failure.error : null;

  useEffect(
    () =>
      historyRequest(
        async (request) => {
          const session = useRemote.getState().session;
          // Released servers only provide the original command with all diffs.
          if (session && !session.commands.includes("vcs_block_history_summary")) {
            const { headLines, head, revisions } = await call(
              commands.vcsBlockHistory(request, data.path, data.text, data.lines),
            );
            const history: BlockHistorySummary = {
              anchor: null,
              head: head ?? null,
              diffs: revisions,
              rest: [],
            };
            return { history, hasHead: headLines !== null };
          }
          const history = await call(commands.vcsBlockHistorySummary(request, data.path, data.text, data.lines));
          return { history, hasHead: history.anchor !== null };
        },
        ({ history, hasHead }) => {
          setActive(0);
          setResult({ data, history, hasHead });
        },
        (error) => setFailure({ data, error }),
      ),
    [data],
  );

  const rows = useMemo(
    () => (history ? historyRows(history, blockOf(data.text, data.lines)) : NO_ROWS),
    [history, data],
  );
  const current = rows[Math.min(active, rows.length - 1)];

  // Where each revision's diff starts, filled in while Git walks the history again with
  // patches: a row it has reached reads its diff in constant time instead of re-walking
  // the history down to it (`--skip`). Kept out of state: arriving spots change nothing shown.
  const spots = useRef<{ history: BlockHistorySummary; spots: BlockRevisionSpot[] } | null>(null);
  useEffect(() => {
    const anchor = history?.anchor;
    if (!anchor || history.rest.length === 0) return;
    const session = useRemote.getState().session;
    if (
      session &&
      (!session.commands.includes("vcs_block_history_spots") ||
        !session.commands.includes("vcs_block_history_revisions_at"))
    )
      return;
    const found = { history, spots: [] as BlockRevisionSpot[] };
    spots.current = found;
    return historyRequest(
      (request) => {
        const channel = new Channel<BlockRevisionSpot[]>();
        channel.onmessage = (chunk) => found.spots.push(...chunk);
        return call(commands.vcsBlockHistorySpots(request, data.path, anchor, channel));
      },
      () => {},
      // Rows keep loading their diffs the slower way.
      () => {},
    );
  }, [history, data.path]);

  const [diffs, setDiffs] = useState<{ history: BlockHistorySummary; revisions: Map<string, BlockRevision> } | null>(
    null,
  );
  const [diffError, setDiffError] = useState<{ history: BlockHistorySummary; row: HistoryRow; message: string } | null>(
    null,
  );
  const revision =
    current?.kind === "revision" && history
      ? (history.diffs[current.index] ??
        (diffs?.history === history ? diffs.revisions.get(current.revision.id) : undefined))
      : undefined;

  useEffect(() => {
    if (!history?.anchor || current?.kind !== "revision" || revision) return;
    const { anchor } = history;
    const index = current.index;
    const offset = index - history.diffs.length;
    const commits = history.rest.slice(offset, offset + DIFF_BATCH).map((row) => row.id);
    const found = spots.current?.history === history ? spots.current.spots.slice(index, index + DIFF_BATCH) : [];
    const at =
      found.length === commits.length && found.every((spot, i) => spot.id === commits[i] && spot.ranges) ? found : null;
    return historyRequest(
      (request) =>
        call(
          at
            ? commands.vcsBlockHistoryRevisionsAt(request, data.path, at)
            : commands.vcsBlockHistoryRevisions(request, data.path, anchor, index, commits),
        ),
      (batch) => {
        setDiffError(null);
        setDiffs((previous) => {
          const revisions = new Map(previous?.history === history ? previous.revisions : []);
          for (const diff of batch) revisions.set(diff.id, diff);
          while (revisions.size > DIFF_CACHE_SIZE) revisions.delete(revisions.keys().next().value!);
          return { history, revisions };
        });
      },
      (message) => setDiffError({ history, row: current, message }),
    );
  }, [history, current, revision, data.path]);

  const [from, to] = data.lines;
  const range = `${baseName(data.path)}:${from + 1}-${to + 1}`;

  let detail;
  if (!current)
    detail = (
      <div className={layout.message}>
        <T>Select a revision</T>
      </div>
    );
  else {
    const texts = sides(current, revision);
    if (texts) {
      const [left, right] = texts;
      detail = (
        <DiffEditor
          key={current.kind === "local" ? "local" : current.revision.id}
          input={diffInput({ path: data.path, left, right })}
        />
      );
    } else {
      detail = (
        <div className={layout.message}>
          {diffError?.history === history && diffError.row === current ? diffError.message : <Spinner size={14} />}
        </div>
      );
    }
  }

  return (
    <SplitGroup
      className={`${layout.root} ${layout.resizable}`}
      orientation="vertical"
      storageKey="openidea.selectionHistory.layout"
    >
      <SplitPanel id="selection-preview" defaultSize="50%" minSize="25%">
        {detail}
      </SplitPanel>
      <SplitHandle aria-label={tx("Revisions")} />
      <SplitPanel id="selection-revisions" defaultSize="50%" minSize="25%">
        <div className={layout.header}>
          <span className={layout.title}>
            <T>History for Selection</T>
          </span>
          <span className={styles.range} title={range}>
            {range}
          </span>
        </div>
        {error ? (
          <div className={layout.message}>{error}</div>
        ) : !history ? (
          <div className={layout.message}>
            <Spinner size={14} />
          </div>
        ) : (
          <div
            className={styles.table}
            role="grid"
            aria-label={tx("Revisions")}
            aria-colcount={COLUMNS.length}
            aria-rowcount={rows.length + 1}
          >
            <div role="row" aria-rowindex={1} className={`${styles.columns} ${styles.heading}`}>
              {COLUMNS.map((label) => (
                <span key={label} role="columnheader" className={styles.cell}>
                  <T>{label}</T>
                </span>
              ))}
            </div>
            <List
              items={rows}
              getKey={(row) => (row.kind === "local" ? "local" : row.revision.id)}
              activeIndex={Math.min(active, rows.length - 1)}
              onActiveChange={setActive}
              onActivate={(_row, i) => setActive(i)}
              tableBody={{ headerRows: 1 }}
              className={styles.list}
              empty={
                <span className={layout.message}>
                  {result?.hasHead ? tx`No commits changed these lines` : tx`These lines are not committed yet`}
                </span>
              }
              renderItem={(row) => {
                const revision = row.kind === "revision" ? row.revision : null;
                const cells = [
                  revision?.shortId ?? "",
                  formatTime(revision?.timeMs),
                  revision?.author ?? "",
                  revision?.summary ?? tx("Local Changes"),
                ];
                return (
                  <span role="none" className={styles.columns}>
                    {cells.map((value, i) => (
                      <span
                        key={COLUMNS[i]}
                        role="gridcell"
                        className={styles.cell}
                        title={value && (!revision ? tx("Not Committed Yet") : value)}
                      >
                        {value}
                      </span>
                    ))}
                  </span>
                );
              }}
            />
          </div>
        )}
      </SplitPanel>
    </SplitGroup>
  );
}
