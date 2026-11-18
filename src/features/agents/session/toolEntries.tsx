import type { AgentEntry, AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Icon, IconButton, Spinner, T } from "@/ui";
import clsx from "clsx";
import { memo, useLayoutEffect } from "react";
import { AgentReply } from "../AgentReply";
import { Markdown } from "../Markdown";
import styles from "../Session.module.css";
import { useAgentSettings } from "../agentSettings";
import { formatDuration } from "../conversation";
import { subagentTitle, subagentWorking, type SubagentEntry } from "../model";
import { useRevealedText } from "../reveal";
import { cancelTask } from "../store";
import { openChangeDiff } from "./ChangesPane";
import { Fold } from "./Folds";
import { liveTool } from "./conversationRows";
import { shortTitle, useNow } from "./shared";

const TOOL_ICONS: Record<string, string> = {
  read: "file",
  edit: "edit",
  delete: "minus",
  move: "edit",
  search: "search",
  execute: "terminal",
  fetch: "web",
  think: "todo",
};

/** The first line of reasoning, without its Markdown emphasis: what a folded thought was about. */
function thoughtPreview(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line
    .replace(/^\s*(#+\s*|[-*]\s+)?/, "")
    .replace(/[*_`]+/g, "")
    .trim();
}

/** The agent's reasoning: open while it streams, folded after, as Settings › Agents › Chat says. */
export function ThoughtEntry({
  task,
  text,
  working,
  onDiagramDrawn,
}: {
  task: AgentTask;
  text: string;
  working: boolean;
  onDiagramDrawn: () => void;
}) {
  const { thinking, smoothText } = useAgentSettings();
  const open = thinking === "expanded" || (thinking === "auto" && working);
  // Streaming reasoning in view is revealed at the reply's pace; folded, nothing is painted.
  const shown = useRevealedText(text, working && smoothText && open);
  useLayoutEffect(() => {
    if (working && open) onDiagramDrawn();
  }, [shown, working, open, onDiagramDrawn]);
  return (
    <div className={clsx(styles.process, styles.thoughtEntry)}>
      <Fold
        className={clsx(styles.thought, thinking === "auto" && working && styles.thoughtLive)}
        open={open}
        summary={
          <summary>
            <Icon name="chevron-right" size={12} className={styles.thoughtChevron} />
            {working ? (
              <span className={styles.shimmer}>
                <T>Thinking</T>
              </span>
            ) : (
              <span className={styles.thoughtPreview}>{thoughtPreview(text) || <T>Reasoning</T>}</span>
            )}
          </summary>
        }
      >
        <div className={styles.thoughtBody}>
          <Markdown text={shown} cwd={task.cwd} onDiagramDrawn={onDiagramDrawn} />
        </div>
      </Fold>
    </div>
  );
}

export const ToolEntry = memo(function ToolEntry({
  task,
  entry,
}: {
  task: AgentTask;
  entry: Extract<AgentEntry, { type: "tool" }>;
}) {
  const { expandToolOutput } = useAgentSettings();
  const head = (
    <>
      <Icon name={TOOL_ICONS[entry.kind] ?? "run"} size={14} />
      <span className={clsx(styles.toolTitle, liveTool(entry) && styles.shimmer)} title={entry.title || entry.kind}>
        {shortTitle(task, entry.title || entry.kind)}
      </span>
      {entry.diffs.map((d) => (
        <button
          key={d.path}
          type="button"
          className={styles.toolDiff}
          title={d.path}
          onClick={(e) => {
            e.preventDefault();
            void openChangeDiff(task, d.path);
          }}
        >
          <span className={styles.added}>+{d.added}</span> <span className={styles.removed}>−{d.removed}</span>
        </button>
      ))}
      {entry.status === "failed" && <Icon name="error" size={12} />}
    </>
  );
  if (!entry.output)
    return (
      <div className={clsx(styles.process, styles.toolEntry)}>
        <div className={styles.tool}>
          <span className={styles.toolChevronSpacer} aria-hidden="true" />
          {head}
        </div>
      </div>
    );
  return (
    <div className={clsx(styles.process, styles.toolEntry)}>
      <Fold
        className={styles.toolDetails}
        open={liveTool(entry) || expandToolOutput}
        summary={
          <summary className={styles.tool}>
            <Icon name="chevron-right" size={12} className={styles.toolChevron} />
            {head}
          </summary>
        }
      >
        <pre className={styles.output}>{entry.output}</pre>
      </Fold>
    </div>
  );
});

function SubagentStatusIcon({ status }: { status: SubagentEntry["status"] }) {
  switch (status) {
    case "running":
      return <Spinner size={11} />;
    case "needsInput":
      return <Icon name="warning" size={13} label="Needs input" />;
    case "done":
      return <Icon name="check" size={13} className={styles.done} label="Done" />;
    case "cancelled":
      return <Icon name="minus" size={13} className={styles.muted} label="Stopped" />;
    case "failed":
      return <Icon name="close" size={13} className={styles.removed} label="Failed" />;
  }
}

/** A subagent in its parent's conversation: what it does, its latest step, what it was asked and answered. */
export function SubagentCard({
  task,
  entry,
  onOpen,
  onDiagramDrawn,
}: {
  task: AgentTask;
  entry: SubagentEntry;
  onOpen: () => void;
  onDiagramDrawn: () => void;
}) {
  const tx = useTx();
  const working = subagentWorking(entry.status);
  const now = useNow(working ? 1000 : 60_000);
  const time = entry.startedMs == null ? null : (entry.endedMs ?? now) - entry.startedMs;
  const title = subagentTitle(entry);
  return (
    <div className={styles.subagent}>
      <div className={styles.subagentHead}>
        <button
          type="button"
          className={styles.subagentOpen}
          onClick={onOpen}
          title={tx("Open the subagent's conversation")}
        >
          <SubagentStatusIcon status={entry.status} />
          <Icon name="toolwindow-agents" size={14} className={styles.muted} />
          <span className={styles.subagentTitle}>{title}</span>
          {entry.description && entry.description !== title && (
            <span className={styles.subagentDescription}>{entry.description}</span>
          )}
          <span className={styles.subagentMeta}>
            {[
              entry.tools > 0 && `${entry.tools} ${tx(entry.tools === 1 ? "tool call" : "tool calls")}`,
              time != null && formatDuration(Math.max(0, time)),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <Icon name="chevron-right" size={12} className={styles.muted} />
        </button>
        {working && entry.cancellable && (
          <IconButton
            icon="stop"
            title="Stop Subagent"
            size="small"
            onClick={() => void cancelTask(task.id, entry.id)}
          />
        )}
      </div>
      {working && entry.activity && (
        <div className={styles.subagentActivity} title={entry.activity}>
          {shortTitle(task, entry.activity)}
        </div>
      )}
      {entry.error && (
        <div className={styles.error} role="alert">
          <Icon name="error" size={14} />
          <span>{entry.error}</span>
        </div>
      )}
      {entry.prompt && (
        <Fold
          className={styles.subagentSection}
          summary={
            <summary>
              <T>Task</T>
            </summary>
          }
        >
          <div className={styles.thoughtText}>{entry.prompt}</div>
        </Fold>
      )}
      {entry.reply && (
        <Fold
          className={styles.subagentSection}
          summary={
            <summary>
              <T>Result</T>
            </summary>
          }
        >
          <div className={styles.subagentReply}>
            <AgentReply text={entry.reply} cwd={task.cwd} task={task} onDiagramDrawn={onDiagramDrawn} />
          </div>
        </Fold>
      )}
    </div>
  );
}

/** The subagents of the conversation still at work, to look in on. */
export function WorkingSubagents({ entries, onOpen }: { entries: AgentEntry[] | null; onOpen: (id: string) => void }) {
  const tx = useTx();
  const working = (entries ?? []).filter((e): e is SubagentEntry => e.type === "subagent" && subagentWorking(e.status));
  if (!working.length) return null;
  return (
    <div className={styles.subagentStrip} aria-label={tx("Subagents at work")}>
      {working.map((e) => (
        <button
          key={e.id}
          type="button"
          className={styles.subagentChip}
          onClick={() => onOpen(e.id)}
          title={e.activity ?? undefined}
        >
          <SubagentStatusIcon status={e.status} />
          <span className={styles.subagentChipTitle}>{subagentTitle(e)}</span>
        </button>
      ))}
    </div>
  );
}
