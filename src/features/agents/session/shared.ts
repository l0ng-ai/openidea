import type { AgentEntry, AgentTask } from "@/bindings";
import { useEffect, useState } from "react";
import { splitLeadingCd } from "../shellCommand";
import { useAgents } from "../store";

export function providerName(id: string) {
  return useAgents.getState().providers.find((p) => p.id === id)?.name ?? id;
}

/** `Date.now()`, updated every `interval` ms. */
export function useNow(interval: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

export type UserEntry = Extract<AgentEntry, { type: "user" }>;

/** Agent-written titles with the task's own folder dropped from paths. */
export const shortTitle = (task: AgentTask, title: string) => title.replaceAll(`${task.cwd}/`, "");

/**
 * A command's title without the `cd <dir> &&` agents put before every call, and the folder it
 * moved to when that is not the task's own: the command is what tells calls apart.
 */
export function commandTitle(task: AgentTask, title: string): { title: string; dir: string | null } {
  const { command, dir } = splitLeadingCd(title);
  return { title: shortTitle(task, command), dir: dir === task.cwd || dir === "." ? null : dir };
}

/**
 * `memo`'s comparison for props rebuilt with every render without changing: a prop named in
 * `by` is equal when its rule says so, any other prop when it is the same value.
 */
export function samePropsExcept<P extends object>(by: { [K in keyof P]?: (a: P, b: P) => boolean }) {
  return (a: P, b: P) => {
    const keys = Object.keys(a) as Array<keyof P>;
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      const rule = by[key];
      if (!(rule ? rule(a, b) : Object.is(a[key], b[key]))) return false;
    }
    return true;
  };
}
