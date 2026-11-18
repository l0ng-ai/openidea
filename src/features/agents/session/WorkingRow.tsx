import type { AgentEntry, AgentRetry, AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Spinner, T } from "@/ui";
import { useState } from "react";
import styles from "../Session.module.css";
import { useAgentSettings } from "../agentSettings";
import { retryParts } from "../composerModel";
import { formatDuration } from "../conversation";
import { subagentWorking, type SubagentEntry } from "../model";
import { asksInCard } from "../permission";
import {
  ACTIVITY_STATUS,
  activityOf,
  PLAYFUL_MIN_MS,
  PLAYFUL_WORD_MS,
  PLAYFUL_WORDS,
  playfulIndex,
  progressKey,
  type Activity,
} from "../workingStatus";
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
        {subagent.status === "needsInput" ? (
          <T>Waiting for your answer…</T>
        ) : (
          <WorkingLabel turn={entries ?? []} seed={subagent.startedMs ?? 0} />
        )}
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
        <WorkingLabel turn={entries?.slice(userAt + 1) ?? []} seed={lastUser?.sentMs ?? 0} />
      )}
      {lastUser?.sentMs != null && !lastUser.doneMs && <Elapsed since={lastUser.sentMs} />}
    </div>
  );
}

/**
 * What the agent is doing, said by the activity's playful words in turns (the user's own, else the
 * built-in ones) from the start, or once it has reported nothing new for the user's quiet time;
 * screen readers hear only the fact. A word stays its full time while it still fits what the agent
 * does, and a little while when it no longer does, so the row never flickers.
 */
function WorkingLabel({ turn, seed }: { turn: AgentEntry[]; seed: number }) {
  const tx = useTx();
  const { playfulStatus, playfulAfterSeconds, playfulWords } = useAgentSettings();
  const now = useNow(1000);
  const key = progressKey(turn);
  const [progress, setProgress] = useState({ key, at: now });
  if (progress.key !== key) setProgress({ key, at: now });
  // The word on screen, and how many the turn has shown, so the next one continues the order.
  const [playful, setPlayful] = useState<{ shown: number; word: PlayfulWord | null }>({ shown: 0, word: null });
  const activity = activityOf(turn);
  const kind = activity ?? "working";
  const fact = tx(ACTIVITY_STATUS[kind]);
  const own = playfulWords[kind];
  const words = own ?? PLAYFUL_WORDS[kind];
  const due = words.length > 0 && (!activity || now - progress.at >= playfulAfterSeconds * 1000);
  const current = playful.word;
  const fits = due && current?.kind === kind;
  const stays = current && playfulStatus && now - current.since < (fits ? PLAYFUL_WORD_MS : PLAYFUL_MIN_MS);
  let next = playful;
  if (!stays && playfulStatus && due) {
    const text = words[playfulIndex(words.length, seed, playful.shown)]!;
    next = { shown: playful.shown + 1, word: { text, kind, own: !!own, since: now } };
  } else if (!stays && current) next = { shown: playful.shown, word: null };
  if (next !== playful) setPlayful(next);
  if (!next.word) return fact;
  return (
    <>
      <span aria-hidden>{next.word.own ? next.word.text : tx(next.word.text)}</span>
      <span className={styles.srOnly}>{fact}</span>
    </>
  );
}

/** A playful word for `kind` on screen since `since`: the user's own as written, else a built-in one to translate. */
interface PlayfulWord {
  text: string;
  kind: Activity;
  own: boolean;
  since: number;
}
