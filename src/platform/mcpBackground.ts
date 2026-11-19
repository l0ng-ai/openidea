/** Projects the built-in MCP server serves without a window: the live list and the wording of each one's state. */
import { useEffect, useMemo, useRef, useState } from "react";
import { call, commands, isTauri, onIdeEvent, type McpBackgroundProject } from "./ipc";
import { tx } from "./i18n";

const POLL_MS = 30_000;
/** While a request is being answered: its end reports nothing, so the list is asked again soon. */
const ANSWERING_POLL_MS = 3_000;
const TICK_MS = 5_000;

/** One sentence for what a background project is doing, as the Settings list shows it. */
export function backgroundProjectState(project: McpBackgroundProject): string {
  const hold = project.keptOpenBy;
  if (hold?.kind === "request") return tx("Answering a request");
  if (hold?.kind === "run") {
    const name = hold.name;
    return tx`Kept open by the run ${name}`;
  }
  if (project.idleSeconds < 60) return tx("Last request just now");
  const n = Math.floor(project.idleSeconds / 60);
  if (project.unloadsInSeconds == null) return tx`Idle ${n} min`;
  const m = Math.max(1, Math.ceil(project.unloadsInSeconds / 60));
  return tx`Idle ${n} min, unloads in ${m} min`;
}

/** Unloads one background project at once; one that is not loaded is already unloaded. */
export function unloadBackgroundProject(root: string): void {
  void call(commands.mcpUnloadBackgroundProject(root)).catch(() => undefined);
}

/**
 * The background projects, current: fetched on mount and when the backend reports a change, and every 30 s
 * while any is loaded, every 3 s while one answers a request (the end of a request and an idle project's
 * counters report nothing). Between fetches the two counters advance locally.
 */
export function useBackgroundProjects(): McpBackgroundProject[] {
  const [state, setState] = useState(() => ({
    projects: [] as McpBackgroundProject[],
    at: Date.now(),
    now: Date.now(),
  }));
  const loaded = state.projects.length > 0;
  const answering = state.projects.some((p) => p.keptOpenBy?.kind === "request");
  const load = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    load.current = () =>
      void call(commands.mcpBackgroundProjects()).then(
        (projects) => {
          if (!live) return;
          const at = Date.now();
          setState({ projects, at, now: at });
        },
        () => undefined,
      );
    load.current();
    const off = onIdeEvent("mcpBackgroundProjectsChanged", () => load.current());
    return () => {
      live = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const poll = setInterval(() => load.current(), answering ? ANSWERING_POLL_MS : POLL_MS);
    const tick = setInterval(() => setState((s) => ({ ...s, now: Date.now() })), TICK_MS);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [loaded, answering]);

  return useMemo(() => {
    const elapsed = Math.max(0, Math.floor((state.now - state.at) / 1000));
    if (!elapsed) return state.projects;
    return state.projects.map((p) => {
      if (p.keptOpenBy) return p;
      return {
        ...p,
        idleSeconds: p.idleSeconds + elapsed,
        unloadsInSeconds: p.unloadsInSeconds == null ? p.unloadsInSeconds : Math.max(0, p.unloadsInSeconds - elapsed),
      };
    });
  }, [state]);
}
