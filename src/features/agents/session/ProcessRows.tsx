import type { AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Icon } from "@/ui";
import clsx from "clsx";
import { memo } from "react";
import styles from "../Session.module.css";
import { summarizeWork, workParts, type WorkSummary } from "../timeline";
import { liveTool, sameRow, type IndexedEntry, type ProcessRow, type ToolEntryData } from "./conversationRows";
import { Fold } from "./Folds";
import { commandTitle, samePropsExcept, shortTitle } from "./shared";
import { ThoughtEntry, ToolEntry } from "./toolEntries";

/** "Edited 2 files · Ran 3 commands": what a run of work did; "Reasoning" when it only thought. */
function workSummaryText(work: WorkSummary, tx: ReturnType<typeof useTx>, toolCalls: number): string[] {
  const parts = workParts(work).map((p) => tx(p.text).replace("{count}", String(p.count)));
  if (!parts.length && toolCalls) parts.push(`${toolCalls} ${tx(toolCalls === 1 ? "tool call" : "tool calls")}`);
  if (!parts.length && work.thoughts) parts.push(tx("Reasoning"));
  return parts;
}

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
    ? live.kind === "execute"
      ? commandTitle(task, live.title || live.kind).title
      : shortTitle(task, live.title || live.kind)
    : working && last.type === "thought"
      ? tx("Thinking")
      : null;
  return (
    <Fold
      id={`run:${row.index}`}
      className={clsx(styles.processRun, styles.process)}
      summary={
        <summary className={styles.processSummary}>
          <Icon name="chevron-right" size={12} className={styles.processChevron} />
          <span className={clsx(styles.processParts, (working || live) && !current && styles.shimmer)}>
            {parts.join(" · ")}
          </span>
          {added > 0 && <span className={styles.added}>+{added}</span>}
          {removed > 0 && <span className={styles.removed}>−{removed}</span>}
          {current && <span className={clsx(styles.processCurrent, styles.shimmer)}>{current}</span>}
        </summary>
      }
    >
      <div className={styles.processBody}>
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
