import type { AgentEntry, AgentRetry, AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Spinner, T } from "@/ui";
import styles from "../Session.module.css";
import { retryParts } from "../composerModel";
import { formatDuration } from "../conversation";
import { subagentWorking, type SubagentEntry } from "../model";
import { asksInCard } from "../permission";
import { ACTIVITY_STATUS, activityOf } from "../workingStatus";
import { useNow, type UserEntry } from "./shared";

/** The agent lost its API connection (or was refused) and retries on its own. */
function Retrying({ retry }: { retry: AgentRetry }) {
  const tx = useTx();
  const now = useNow(1000);
  const { attempt, wait } = retryParts(retry, now);
  return (
    <span className={styles.retrying} title={retry.error ?? undefined}>
      {wait > 0
        ? tx`API request failed, retrying in ${wait}s (attempt ${attempt})`
        : tx`API request failed, retrying (attempt ${attempt})`}
    </span>
  );
}

export function Elapsed({ since }: { since: number }) {
  const now = useNow(1000);
  return <span className={styles.muted}>{formatDuration(now - since)}</span>;
}

/**
 * The end of the conversation while the agent works on it: what it is doing (starting, working,
 * retrying the API) and for how long. Hidden while it waits for an approval, which says so itself.
 */
export function WorkingRow({
  task,
  entries,
  subagent,
}: {
  task: AgentTask;
  entries: AgentEntry[] | null;
  subagent: SubagentEntry | null;
}) {
  if (subagent) {
    if (!subagentWorking(subagent.status)) return null;
    return (
      <div className={styles.working} role="status">
        <Spinner size={12} />
        {subagent.status === "needsInput" ? <T>Waiting for your answer…</T> : <WorkingLabel turn={entries ?? []} />}
        {subagent.startedMs != null && <Elapsed since={subagent.startedMs} />}
      </div>
    );
  }
  if (task.status !== "running" && task.status !== "starting") return null;
  if (entries?.some((e) => e.type === "permission" && !e.chosen && !asksInCard(e))) return null;
  const userAt = entries?.findLastIndex((e) => e.type === "user") ?? -1;
  const lastUser = userAt >= 0 ? (entries![userAt] as UserEntry) : undefined;
  return (
    <div className={styles.working} role="status">
      <Spinner size={12} />
      {task.retry ? (
        <Retrying retry={task.retry} />
      ) : task.status === "starting" ? (
        <T>Starting the agent…</T>
      ) : (
        <WorkingLabel turn={entries?.slice(userAt + 1) ?? []} />
      )}
      {lastUser?.sentMs != null && !lastUser.doneMs && <Elapsed since={lastUser.sentMs} />}
    </div>
  );
}

/** What the agent is doing, from the turn's latest output. */
function WorkingLabel({ turn }: { turn: AgentEntry[] }) {
  const tx = useTx();
  return tx(ACTIVITY_STATUS[activityOf(turn) ?? "working"]);
}
