import type { RunConfig } from "@/platform/ipc";
import type { DebugServiceSession } from "@/workbench/contributions";
import { stopSession, useRun, waitForExit, type RunSession, isLive } from "./store";

/** One execution: a Run process and its attached debuggers, or a direct debug launch. */
export interface ServiceSession {
  config: RunConfig;
  startedAt: number;
  run?: RunSession;
  debug: DebugServiceSession[];
}

const running = (s: RunSession) => isLive(s);
const debugging = (s: DebugServiceSession) => s.status !== "terminated";

export function serviceSessions(runs: readonly RunSession[], debug: readonly DebugServiceSession[]): ServiceSession[] {
  const out = runs.map((run): ServiceSession => ({ config: run.config, startedAt: run.startedAt, run, debug: [] }));
  const processes = new Map(out.filter((s) => s.run!.runId !== null).map((s) => [s.run!.runId, s]));
  for (const session of debug) {
    const owner = session.processId === null ? undefined : processes.get(session.processId);
    if (owner && owner.config.id === session.config.id) owner.debug.push(session);
    else out.push({ config: session.config, startedAt: session.startedAt, debug: [session] });
  }
  return out;
}

export function liveServiceSession(session: ServiceSession): boolean {
  return !!(session.run && running(session.run)) || session.debug.some(debugging);
}

/** Only a live debugger owns controls; retained output alone cannot claim a live Run. */
export function serviceDebugger(session: ServiceSession | undefined): DebugServiceSession | undefined {
  return session?.debug.filter(debugging).sort((a, b) => b.startedAt - a.startedAt || b.id - a.id)[0];
}

function compareSessions(a: ServiceSession, b: ServiceSession): number {
  const key = (s: ServiceSession) => s.run?.id ?? `debug:${s.debug[0]!.id}`;
  return (
    Number(liveServiceSession(b)) - Number(liveServiceSession(a)) ||
    b.startedAt - a.startedAt ||
    Number(b.debug.length > 0) - Number(a.debug.length > 0) ||
    key(a).localeCompare(key(b))
  );
}

export function currentServiceSessions(sessions: readonly ServiceSession[]): Map<string, ServiceSession> {
  const out = new Map<string, ServiceSession>();
  for (const session of sessions) {
    const previous = out.get(session.config.id);
    if (!previous || compareSessions(session, previous) < 0) out.set(session.config.id, session);
  }
  return out;
}

export function currentServiceSession(
  configId: string,
  sessions: readonly ServiceSession[],
): ServiceSession | undefined {
  return currentServiceSessions(sessions).get(configId);
}

/** A build process may expose several JDWP ports, each with its own debugger root. */
export async function stopServiceSessions(sessions: readonly ServiceSession[]): Promise<void> {
  const roots = new Map<number, DebugServiceSession>();
  const runs = new Map<string, RunSession>();
  for (const s of sessions) {
    for (const d of s.debug) if (debugging(d)) roots.set(d.id, d);
    if (s.run && running(s.run)) runs.set(s.run.id, s.run);
  }
  const groups = new Map<number, DebugServiceSession[]>();
  for (const d of roots.values()) {
    // oxlint-disable-next-line no-await-in-loop -- this pass stops detached roots and groups the rest as it goes; debugger stops mutate shared debug state and emit ordered console events
    if (d.processId === null) await d.stop();
    else {
      const group = groups.get(d.processId) ?? [];
      group.push(d);
      groups.set(d.processId, group);
    }
  }
  for (const [processId, group] of groups) {
    const run = [...runs.values()].find((s) => s.runId === processId);
    if (run) {
      // Detaching a live JVM republishes its JDWP port and can trigger another attachment.
      // oxlint-disable-next-line no-await-in-loop -- stop the owning Run before any root of this process is detached
      await stopSession(run.id);
      // oxlint-disable-next-line no-await-in-loop -- wait for the process to exit before detaching; a still-live JVM must not be detached or JDWP can reattach
      await waitForExit([run.id]);
      if (useRun.getState().sessions.some((s) => s.id === run.id && running(s))) {
        runs.delete(run.id);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- detach shared roots one at a time, before the last root stops the process; detach order drives JDWP and console output order
      for (const d of group) await d.stop({ stopProcess: false });
    } else {
      // oxlint-disable-next-line no-await-in-loop -- detach all but the last root in order; the last one below stops the shared process
      for (const d of group.slice(0, -1)) await d.stop({ stopProcess: false });
      // oxlint-disable-next-line no-await-in-loop -- the final root stops the process only after every other root detached
      await group.at(-1)!.stop();
    }
    for (const [id, run] of runs) if (run.runId === processId) runs.delete(id);
  }
  // oxlint-disable-next-line no-await-in-loop -- leftover runs are stopped after every group was torn down and `runs` pruned; sequential stops keep lifecycle transitions and output ordered
  for (const run of runs.values()) await stopSession(run.id);
}
