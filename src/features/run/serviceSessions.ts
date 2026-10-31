import type { RunConfig } from "@/platform/ipc";
import type { DebugServiceSession } from "@/workbench/contributions";
import { stopSession, type RunSession } from "./store";

/** One execution: a Run process and its attached debuggers, or a direct debug launch. */
export interface ServiceSession {
  config: RunConfig;
  startedAt: number;
  run?: RunSession;
  debug: DebugServiceSession[];
}

const running = (s: RunSession) => s.status === "running" || s.status === "starting";
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
    if (d.processId === null) await d.stop();
    else {
      const group = groups.get(d.processId) ?? [];
      group.push(d);
      groups.set(d.processId, group);
    }
  }
  for (const [processId, group] of groups) {
    for (const d of group.slice(0, -1)) await d.stop({ stopProcess: false });
    await group.at(-1)!.stop();
    for (const [id, run] of runs) if (run.runId === processId) runs.delete(id);
  }
  for (const run of runs.values()) await stopSession(run.id);
}
