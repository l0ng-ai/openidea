import type { AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Icon } from "@/ui";
import clsx from "clsx";
import { createContext, memo, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { formatDuration } from "../conversation";
import styles from "../Session.module.css";
import { summarizeWork, workParts, type WorkSummary } from "../timeline";
import {
  liveTool,
  rowEntries,
  sameRow,
  type ConversationRow,
  type IndexedEntry,
  type ProcessRow,
  type ToolEntryData,
  type TurnRow,
} from "./conversationRows";
import { Fold } from "./Folds";
import { samePropsExcept, shortTitle } from "./shared";
import { ThoughtEntry, ToolEntry } from "./toolEntries";

/** "Edited 2 files · Read 4 files": what a run of work did; "Reasoning" when it only thought. */
function workSummaryText(work: WorkSummary, tx: ReturnType<typeof useTx>, toolCalls: number): string[] {
  const parts = workParts(work).map((p) => tx(p.text).replace("{count}", String(p.count)));
  if (!parts.length && toolCalls) parts.push(`${toolCalls} ${tx(toolCalls === 1 ? "tool call" : "tool calls")}`);
  if (!parts.length && work.thoughts) parts.push(tx("Reasoning"));
  return parts;
}

/** Renders the rows inside an open turn; the stream owns what a row needs (`Stream`). */
export const RowRenderer = createContext<(row: ConversationRow) => ReactNode>(() => null);

/** A finished turn's work, opened: its rows, painted only while the turn is open. */
function TurnBody({ row }: { row: TurnRow }) {
  const renderRow = useContext(RowRenderer);
  return (
    <div className={styles.turnBody}>
      {row.rows.map((inner) => (
        <div key={inner.index} className={styles.conversationRow}>
          {renderRow(inner)}
        </div>
      ))}
    </div>
  );
}

/** A finished turn's work, folded under its message: one line saying what it did and for how long. */
export const TurnFold = memo(
  function TurnFold({ row }: { row: TurnRow }) {
    const tx = useTx();
    const { turn } = row;
    const entries = row.rows.flatMap(rowEntries);
    const work = summarizeWork(entries);
    const parts = workSummaryText(work, tx, 0);
    const messages = entries.filter((e) => e.type === "agent").length;
    if (messages)
      parts.push(tx(messages === 1 ? "1 message" : "{count} messages").replace("{count}", String(messages)));
    const took = turn.sentMs != null && turn.doneMs != null ? formatDuration(turn.doneMs - turn.sentMs) : null;
    return (
      <Fold
        id={`turn:${turn.user}`}
        className={clsx(styles.turnFold, styles.process)}
        summary={
          <summary className={styles.processSummary}>
            <Icon name="chevron-right" size={12} className={styles.processChevron} />
            <span className={styles.processParts}>{parts.join(" · ")}</span>
            {work.added > 0 && <span className={styles.added}>+{work.added}</span>}
            {work.removed > 0 && <span className={styles.removed}>−{work.removed}</span>}
            {took && <span className={styles.muted}>{took}</span>}
          </summary>
        }
      >
        <TurnBody row={row} />
      </Fold>
    );
  },
  (a, b) => sameRow(a.row, b.row),
);

interface ProcessRunProps {
  row: ProcessRow;
  task: AgentTask;
  lastIndex: number;
  busy: boolean;
  /** How long each finished thought took, by entry index. */
  thinking: ReadonlyMap<number, number> | null;
  onDiagramDrawn: () => void;
}

/** Whether the run holds what the agent is doing right now. */
const holdsLive = ({ row, busy, lastIndex }: ProcessRunProps) =>
  busy && row.entries.some(({ index }) => index === lastIndex);

/** The rows, the thought durations and the last entry are rebuilt with every chunk: compare what the run paints. */
const sameRun = samePropsExcept<ProcessRunProps>({
  row: (a, b) => sameRow(a.row, b.row),
  busy: () => true,
  lastIndex: (a, b) => holdsLive(a) === holdsLive(b),
  thinking: (a, b) =>
    a.row.entries.every(
      ({ index, entry }) => entry.type !== "thought" || a.thinking?.get(index) === b.thinking?.get(index),
    ),
});

/** Reasoning and tool calls between messages, folded into one row. */
export const ProcessRun = memo(function ProcessRun({
  row,
  task,
  lastIndex,
  busy,
  thinking,
  onDiagramDrawn,
}: ProcessRunProps) {
  const tx = useTx();
  const tools = row.entries.filter(
    (item): item is IndexedEntry & { entry: ToolEntryData } => item.entry.type === "tool",
  );
  const work = summarizeWork(row.entries.map(({ entry }) => entry));
  const { added, removed } = work;
  const working = busy && row.entries.some(({ index }) => index === lastIndex);
  const parts = workSummaryText(work, tx, tools.length);
  // What the run is doing now: the call still running, or the reasoning it ends with.
  const live = [...tools].reverse().find(({ entry }) => liveTool(entry))?.entry;
  const last = row.entries.at(-1)!.entry;
  const current = live
    ? shortTitle(task, live.title || live.kind)
    : working && last.type === "thought"
      ? tx("Thinking")
      : null;
  // While the run grows, its open body follows the latest call unless scrolled up.
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && working && following.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <Fold
      id={`run:${row.index}`}
      className={clsx(styles.processRun, styles.process)}
      summary={
        <summary className={styles.processSummary}>
          <Icon name="chevron-right" size={12} className={styles.processChevron} />
          <span className={clsx(styles.processParts, (working || live) && styles.shimmer)}>{parts.join(" · ")}</span>
          {added > 0 && <span className={styles.added}>+{added}</span>}
          {removed > 0 && <span className={styles.removed}>−{removed}</span>}
          {current && <span className={clsx(styles.processCurrent, styles.shimmer)}>{current}</span>}
        </summary>
      }
    >
      <div
        ref={body}
        className={styles.processBody}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {row.entries.map(({ index, entry }) =>
          entry.type === "tool" ? (
            <ToolEntry key={index} task={task} entry={entry} />
          ) : entry.type === "thought" ? (
            <ThoughtEntry
              key={index}
              task={task}
              text={entry.text}
              took={thinking?.get(index) ?? null}
              working={busy && index === lastIndex}
              onDiagramDrawn={onDiagramDrawn}
            />
          ) : null,
        )}
      </div>
    </Fold>
  );
}, sameRun);
