import type { AgentChange, AgentCommit, AgentTask } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { basename, useProject } from "@/platform/project";
import clsx from "clsx";
import { Icon, IconButton, showContextMenu, T } from "@/ui";
import styles from "../Session.module.css";
import { ContextMeter } from "./ContextMeter";
import { formatSentAt } from "../conversation";
import { branchLabel, hasTaskTerminal, isBusy, providerIcon, statusLabel } from "../model";
import { useAgents } from "../store";
import { taskMenu } from "../taskActions";
import { providerName, useNow } from "./shared";

/** The task's terminal, at the end of its status line. */
function StatusActions({ task }: { task: AgentTask }) {
  return (
    <span className={styles.statusActions}>
      <IconButton
        size="small"
        icon="terminal"
        title="Terminal"
        onClick={() => void executeAction("terminal.openAt", task.cwd)}
      />
    </span>
  );
}

/**
 * The task's agent, model, checkout and state, just above the composer. In a narrow session it fits
 * the width as the agent panels of Zed and Cursor do: the provider shows its icon alone and the
 * changes their count, then what the IDE shows elsewhere (the project's branch, the task's state)
 * gives way, keeping the changes and the meters; tooltips keep the full text.
 */
export function SessionStatus({
  task,
  head,
  changes,
  commits,
  effortAnnouncement,
  onOpenChanges,
}: {
  task: AgentTask;
  head: string | null;
  changes: AgentChange[] | null;
  commits: readonly AgentCommit[];
  effortAnnouncement: string | null;
  onOpenChanges: () => void;
}) {
  const tx = useTx();
  const project = useProject((s) => s.project);
  const projectRoot = task.projectRoot ?? project?.root ?? null;
  const projectName = project?.workspace && projectRoot ? basename(projectRoot) : project?.name;
  const local = task.isolation !== "worktree";
  const branch = local ? head : branchLabel(task.branch) || null;
  const pickedModel = task.status !== "archived" && task.config.some((o) => o.category === "model");
  const added = changes?.reduce((n, c) => n + c.added, 0) ?? 0;
  const removed = changes?.reduce((n, c) => n + c.removed, 0) ?? 0;
  const filesLabel = changes?.length
    ? tx(changes.length === 1 ? "1 changed file" : "{count} changed files").replace("{count}", String(changes.length))
    : "";
  const commitsLabel = tx(commits.length === 1 ? "1 commit" : "{count} commits").replace(
    "{count}",
    String(commits.length),
  );
  return (
    <div
      className={styles.statusBar}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, taskMenu([task]));
      }}
    >
      {/* Where the task works, in one quiet line like the new-task page: project (in a workspace), branch, worktree. */}
      <span className={styles.where} title={task.cwd}>
        {/* Which agent runs the task: with several tasks side by side, this tells their answers apart. */}
        <span className={styles.fact} title={providerName(task.provider)}>
          <Icon name={providerIcon(task.provider)} size={13} />
          <span className={clsx(styles.factText, styles.providerName)}>{providerName(task.provider)}</span>
        </span>
        {project?.workspace && projectName && (
          <span className={styles.fact}>
            <Icon name="folder" size={13} />
            <span className={styles.factText}>{projectName}</span>
          </span>
        )}
        {branch && (
          // A local task's branch is the project's, which the branch widget shows.
          <span className={clsx(styles.fact, local && styles.shownElsewhere)} title={branch}>
            <Icon name="branch" size={13} />
            <span className={styles.factText}>{branch}</span>
          </span>
        )}
        {!local && (
          <span className={styles.fact}>
            <T>Worktree</T>
          </span>
        )}
        {task.model && !pickedModel && <span className={styles.fact}>{task.model}</span>}
        {!!task.stats?.compressions && (
          <span className={styles.fact} title={tx("The agent compressed the conversation to fit its context")}>
            {tx("compressed ×{count}").replace("{count}", String(task.stats.compressions))}
          </span>
        )}
      </span>
      {/* Ready is the usual state: only the others are worth a word. */}
      {task.status !== "ready" && (
        // The composer shows a running or waiting task; a usage limit says when it resets, nowhere else.
        <span className={clsx(styles.state, task.status !== "limited" && styles.shownElsewhere)}>
          <T>{statusLabel(task.status)}</T>
          {task.status === "limited" && task.resetsMs != null && ` · ${tx`resets ${formatSentAt(task.resetsMs)}`}`}
        </span>
      )}
      <span className={styles.state} role="status" aria-live="polite" aria-atomic="true">
        {effortAnnouncement ? tx("Effort: {level}").replace("{level}", effortAnnouncement) : ""}
      </span>
      {/* What changed sits before the meter, time and terminal, or above them when the row is full. */}
      <span className={styles.statusEnd}>
        {(!!changes?.length || !!commits.length) && (
          <span className={styles.statusChips}>
            {!!changes?.length && (
              <button type="button" className={styles.statusChip} title={filesLabel} onClick={onOpenChanges}>
                <Icon name="edit" size={12} />
                {/* The counts are the chip's own items, so its gap spaces them and the label can still truncate. */}
                <span className={styles.statusChipLabel}>{filesLabel}</span>
                <span className={styles.statusChipCount} aria-hidden>
                  {changes.length}
                </span>
                {added > 0 && <span className={styles.added}>+{added}</span>}
                {removed > 0 && <span className={styles.removed}>−{removed}</span>}
              </button>
            )}
            {!!commits.length && (
              <button type="button" className={styles.statusChip} title={commitsLabel} onClick={onOpenChanges}>
                <Icon name="commit" size={12} />
                <span className={styles.statusChipLabel}>{commitsLabel}</span>
                <span className={styles.statusChipCount} aria-hidden>
                  {commits.length}
                </span>
              </button>
            )}
          </span>
        )}
        <span className={styles.statusMeters}>
          <Meters task={task} />
          {hasTaskTerminal(task, projectRoot) && <StatusActions task={task} />}
        </span>
      </span>
    </div>
  );
}

/**
 * Compact context-window meter in the status bar; clicking it opens the unified
 * Session Info popover with cost, context breakdown, last-turn tokens and usage limits.
 */
function Meters({ task }: { task: AgentTask }) {
  const show = useProject((s) => s.settings?.agents);
  const busy = isBusy(task.status);
  const now = useNow(60_000);
  const usage = show?.showContextUsage !== false ? task.usage : null;
  const reported = useAgents((s) => s.limits.get(task.provider));
  const limits = show?.showUsageLimits !== false ? (reported ?? []) : [];
  const cost = show?.showCost === true ? (task.usage?.cost ?? null) : null;
  const turnTokens = show?.showContextUsage !== false && !busy ? (task.stats?.tokens ?? null) : null;

  if (!usage && limits.length === 0 && !cost && !turnTokens) return null;

  return (
    <span className={styles.meters}>
      <ContextMeter
        key={task.id}
        task={task}
        usage={usage}
        limits={limits}
        cost={cost}
        turnTokens={turnTokens}
        now={now}
      />
    </span>
  );
}
