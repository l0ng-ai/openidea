/** Hot reload from the Run tool window: `flutter run` takes `r` and `R` as commands on stdin. */
import type { RunConfig } from "@/platform/ipc";
import { acceptsInput, useRun, writeTerminal, type RunSession } from "./store";

/** Options that turn off `flutter run`'s hot mode, or (`--machine`) replace its key commands with JSON. */
const NO_HOT_KEYS = new Set(["--release", "--profile", "--jit-release", "--no-hot", "--trace-startup", "--machine"]);

export function supportsHotReload(config: RunConfig): boolean {
  return config.kind === "flutter" && config.args[0] === "run" && !config.args.some((arg) => NO_HOT_KEYS.has(arg));
}

const canHotReload = (session: RunSession) => supportsHotReload(session.config) && acceptsInput(session);

/** The active session when it can reload, else the newest one that can. */
export function hotReloadSession(): RunSession | undefined {
  const { sessions, activeSession } = useRun.getState();
  const active = sessions.find((s) => s.id === activeSession);
  return active && canHotReload(active) ? active : [...sessions].reverse().find(canHotReload);
}

export const hotReload = (sessionId: string) => writeTerminal(sessionId, "r");
export const hotRestart = (sessionId: string) => writeTerminal(sessionId, "R");
