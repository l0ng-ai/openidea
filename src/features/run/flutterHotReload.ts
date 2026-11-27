/** Hot reload from the Run tool window: `app.restart` requests to `flutter run --machine` (see `flutterMachine.ts`). */
import type { RunConfig } from "@/platform/ipc";
import { useFlutterRunApps } from "@/workbench/flutterRunApps";
import { acceptsInput, isLive, useRun, writeTerminal, type RunSession } from "./store";

/** Options that turn off `flutter run`'s hot mode. */
const NO_HOT = new Set(["--release", "--profile", "--jit-release", "--no-hot", "--trace-startup"]);

export function supportsHotReload(config: RunConfig): boolean {
  return config.kind === "flutter" && config.args[0] === "run" && !config.args.some((arg) => NO_HOT.has(arg));
}

/** The session's app started and takes reloads. */
export function canHotReload(session: RunSession, apps = useFlutterRunApps.getState()): boolean {
  const app = apps[session.id];
  return supportsHotReload(session.config) && acceptsInput(session) && !!app?.started && app.supportsRestart;
}

/** The active session when it can reload, else the newest one that can. */
export function hotReloadSession(): RunSession | undefined {
  const { sessions, activeSession } = useRun.getState();
  const active = sessions.find((s) => s.id === activeSession);
  return active && canHotReload(active) ? active : [...sessions].reverse().find((s) => canHotReload(s));
}

let requestId = 0;

function restart(sessionId: string, fullRestart: boolean) {
  const appId = useFlutterRunApps.getState()[sessionId]?.appId;
  if (!appId) return;
  const request = {
    id: ++requestId,
    method: "app.restart",
    params: { appId, fullRestart, pause: false, reason: "manual" },
  };
  writeTerminal(sessionId, `${JSON.stringify([request])}\n`);
}

export const hotReload = (sessionId: string) => restart(sessionId, false);
export const hotRestart = (sessionId: string) => restart(sessionId, true);

/** Marks the apps of ended Run tabs as ended, and forgets those of closed ones. */
export function syncFlutterRunApps(sessions: readonly RunSession[]) {
  const apps = useFlutterRunApps.getState();
  let next: typeof apps | null = null;
  for (const [id, app] of Object.entries(apps)) {
    const session = sessions.find((s) => s.id === id);
    if (session && (isLive(session) || !app.live)) continue;
    next ??= { ...apps };
    if (session) next[id] = { ...app, live: false, started: false };
    else delete next[id];
  }
  if (next) useFlutterRunApps.setState(next, true);
}
