import type { AgentEntry, AgentTask } from "@/bindings";
import { useEffect, useState } from "react";
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
