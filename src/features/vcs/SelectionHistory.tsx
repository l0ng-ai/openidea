/**
 * History for Selection editor tab (IDEA's Show History for Selection): the
 * commits that changed the selected lines (`git log -L`, renames followed),
 * newest first, each shown as the block before and after it. Unsaved or
 * uncommitted edits of the block come first as Local Changes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
const PREFETCH_AHEAD = 2;
const DIFF_CACHE_SIZE = 64;
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
    ...history.diffs.map((revision, index) => ({
      kind: "revision" as const,
      revision: { ...revision, ranges: null },
      index,
    })),
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

  const [diffs, setDiffs] = useState<{ history: BlockHistorySummary; revisions: Map<string, BlockRevision> } | null>(
    null,
  );
  const [diffError, setDiffError] = useState<{ history: BlockHistorySummary; row: HistoryRow; message: string } | null>(
    null,
  );
  const cached = diffs?.history === history ? diffs.revisions : undefined;
  const revision =
    current?.kind === "revision" && history
      ? (history.diffs[current.index] ?? cached?.get(current.revision.id))
      : undefined;

  const inFlight = useRef<{
    history: BlockHistorySummary;
    start: number;
    end: number;
    urgentRow: HistoryRow | null;
    cancel: () => void;
  } | null>(null);

  useEffect(
    () => () => {
      inFlight.current?.cancel();
      inFlight.current = null;
    },
    [],
  );

  useEffect(() => {
    const cancelInFlight = () => {
      inFlight.current?.cancel();
      inFlight.current = null;
    };
    if (!history?.anchor || history.rest.length === 0 || current?.kind !== "revision") {
      cancelInFlight();
      return;
    }
    const { anchor } = history;
    const total = history.diffs.length + history.rest.length;
    const hasDiff = (index: number) => {
      if (index < history.diffs.length) return true;
      const row = history.rest[index - history.diffs.length];
      return row != null && cached?.has(row.id) === true;
    };

    let target: number | null = null;
    let urgentRow: HistoryRow | null = null;
    if (!hasDiff(current.index)) {
      target = current.index;
      urgentRow = current;
    } else {
      const limit = Math.min(total - 1, current.index + PREFETCH_AHEAD);
      for (let i = current.index + 1; i <= limit; i++) {
        if (!hasDiff(i)) {
          target = i;
          break;
        }
      }
    }

    const activeFetch = inFlight.current;
    if (
      activeFetch &&
      activeFetch.history === history &&
      target !== null &&
      target >= activeFetch.start &&
      target < activeFetch.end
    ) {
      activeFetch.urgentRow = urgentRow;
      return;
    }

    cancelInFlight();
    if (target === null) return;

    const offset = target - history.diffs.length;
    const slice = history.rest.slice(offset, offset + DIFF_BATCH);
    if (slice.length === 0) return;

    const session = useRemote.getState().session;
    const canReadAt = !session || session.commands.includes("vcs_block_history_revisions_at");
    const spots: BlockRevisionSpot[] | null =
      canReadAt && slice.every((row) => row.ranges !== null)
        ? slice.map((row) => ({ id: row.id, ranges: row.ranges }))
        : null;
    const commits = slice.map((row) => row.id);
    const start = target;
    const end = target + slice.length;

    const entry = {
      history,
      start,
      end,
      urgentRow,
      cancel: () => {},
    };
    entry.cancel = historyRequest(
      (request) =>
        call(
          spots
            ? commands.vcsBlockHistoryRevisionsAt(request, data.path, spots)
            : commands.vcsBlockHistoryRevisions(request, data.path, anchor, start, commits),
        ),
      (batch) => {
        if (inFlight.current === entry) inFlight.current = null;
        setDiffError(null);
        setDiffs((previous) => {
          const revisions = new Map(previous?.history === history ? previous.revisions : []);
          for (const diff of batch) {
            revisions.delete(diff.id);
            revisions.set(diff.id, diff);
          }
          while (revisions.size > DIFF_CACHE_SIZE) revisions.delete(revisions.keys().next().value!);
          return { history, revisions };
        });
      },
      (message) => {
        if (inFlight.current === entry) inFlight.current = null;
        if (entry.urgentRow) setDiffError({ history, row: entry.urgentRow, message });
      },
    );
    inFlight.current = entry;
  }, [history, current, cached, data.path]);

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
