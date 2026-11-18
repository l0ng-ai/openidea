import type { AgentChange, AgentCommit, AgentEntry, AgentLimit, AgentTask, AgentUsage } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { basename, useProject } from "@/platform/project";
import { Icon, IconButton, showContextMenu, T } from "@/ui";
import styles from "../Session.module.css";
import { costLabel, limitLabel, usageLabel, workTime } from "../composerModel";
import { formatDuration, formatSentAt } from "../conversation";
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

/** The task's agent, model, checkout and state, just above the composer. */
export function SessionStatus({
  task,
  entries,
  head,
  changes,
  commits,
  changesOpen,
  effortAnnouncement,
  onToggleChanges,
}: {
  task: AgentTask;
  entries: AgentEntry[] | null;
  head: string | null;
  changes: AgentChange[] | null;
  commits: readonly AgentCommit[];
  changesOpen: boolean;
  effortAnnouncement: string | null;
  onToggleChanges: () => void;
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
          <span className={styles.factText}>{providerName(task.provider)}</span>
        </span>
        {project?.workspace && projectName && (
          <span className={styles.fact}>
            <Icon name="folder" size={13} />
            <span className={styles.factText}>{projectName}</span>
          </span>
        )}
        {branch && (
          <span className={styles.fact}>
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
      </span>
      {/* Ready is the usual state: only the others are worth a word. */}
      {task.status !== "ready" && (
        <span className={styles.state}>
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
              <button type="button" className={styles.statusChip} aria-expanded={changesOpen} onClick={onToggleChanges}>
                <Icon name="edit" size={12} />
                {/* The counts are the chip's own items, so its gap spaces them and the label can still truncate. */}
                <span className={styles.statusChipLabel}>
                  {tx(changes.length === 1 ? "1 changed file" : "{count} changed files").replace(
                    "{count}",
                    String(changes.length),
                  )}
                </span>
                {added > 0 && <span className={styles.added}>+{added}</span>}
                {removed > 0 && <span className={styles.removed}>−{removed}</span>}
              </button>
            )}
            {!!commits.length && (
              <button type="button" className={styles.statusChip} aria-expanded={changesOpen} onClick={onToggleChanges}>
                <Icon name="commit" size={12} />
                <span className={styles.statusChipLabel}>
                  {tx(commits.length === 1 ? "1 commit" : "{count} commits").replace("{count}", String(commits.length))}
                </span>
              </button>
            )}
          </span>
        )}
        <span className={styles.statusMeters}>
          <Meters task={task} entries={entries} />
          {hasTaskTerminal(task, projectRoot) && <StatusActions task={task} />}
        </span>
      </span>
    </div>
  );
}

/**
 * Context use, usage limits and cost (when the agent reports them) and the time spent on
 * the task, each as Settings › Agents › Chat allows.
 */
function Meters({ task, entries }: { task: AgentTask; entries: AgentEntry[] | null }) {
  const tx = useTx();
  const show = useProject((s) => s.settings?.agents);
  const busy = isBusy(task.status);
  const now = useNow(busy ? 1000 : 60_000);
  const usage = show?.showContextUsage !== false ? task.usage : null;
  const reported = useAgents((s) => s.limits.get(task.provider));
  const limits = show?.showUsageLimits !== false ? (reported ?? []) : [];
  const cost = show?.showCost === true ? task.usage?.cost : null;
  const work = show?.showWorkTime !== false && entries ? workTime(entries, busy ? now : null) : 0;
  return (
    <span className={styles.meters}>
      {usage && <Usage usage={usage} />}
      {limits.map((l) => (
        <Limit key={l.window} limit={l} now={now} />
      ))}
      {cost && <span title={tx("What the session has cost so far, as the agent reports it")}>{costLabel(cost)}</span>}
      {work >= 1000 && <span title={tx("Time the agent spent on this task")}>{formatDuration(work)}</span>}
    </span>
  );
}

/** A usage-limit window: "5h 19%", when it resets in the tooltip. */
function Limit({ limit, now }: { limit: AgentLimit; now: number }) {
  const label = limitLabel(limit, now);
  return (
    <span className={styles.meter} title={label.detail} aria-label={label.detail}>
      <span className={styles.usageBar} aria-hidden>
        <span style={{ width: `${label.percent}%` }} />
      </span>
      {label.short}
    </span>
  );
}

/** Context window use: "167k/1M (17%)", the exact counts in the tooltip. */
function Usage({ usage }: { usage: AgentUsage }) {
  const label = usageLabel(usage);
  return (
    <span className={styles.meter} title={label.detail} aria-label={`Context ${label.short}, ${label.detail}`}>
      <span className={styles.usageBar} aria-hidden>
        <span style={{ width: `${label.percent}%` }} />
      </span>
      {`${label.percent}%`}
    </span>
  );
}
