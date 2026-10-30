import { compoundChildren } from "./configs";
import type { RunConfig } from "@/platform/ipc";
import type { DebugRunSession } from "@/workbench/contributions";
import { rerunSession, sessionsOf, stopSession, useRun, type RunSession } from "./store";

/** Selection, never tool-window focus or an unrelated process, determines the primary target. */
export function selectedTarget(selectedId: string | null, runs: RunSession[], debug: DebugRunSession[]) {
  const candidates = [
    ...runs
      .filter((s) => (s.status === "running" || s.status === "starting") && s.config.id === selectedId)
      .map((s) => ({
        name: s.config.name,
        startedAt: s.startedAt,
        debug: false,
        paused: false,
        rerun: () => rerunSession(s.id),
        stop: () => void stopSession(s.id),
        resume: () => {},
      })),
    ...debug.filter((s) => s.configId != null && s.configId === selectedId).map((s) => ({ ...s, debug: true })),
  ];
  return candidates.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

export function compoundTargets(config: RunConfig | undefined, runs: RunSession[], debug: DebugRunSession[]) {
  if (config?.kind !== "compound") return [];
  const ids = new Set(compoundChildren(config, useRun.getState().configs).map((c) => c.id));
  return [
    ...sessionsOf(config, runs).map((s) => ({ stop: () => void stopSession(s.id) })),
    ...debug.filter((s) => s.configId != null && ids.has(s.configId)),
  ];
}
