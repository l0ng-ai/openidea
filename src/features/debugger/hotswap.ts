/**
 * HotSwap (IDEA: Run › Debugging Actions › Reload Changed Classes) through
 * java-debug's hot code replace: compile with jdtls, then `redefineClasses`
 * in every Java debug session. When jdtls finishes a build on its own (after
 * a save) java-debug reports `BUILD_COMPLETE` and, like IDEA's default
 * "Reload classes after compilation: Ask", we offer the reload.
 */
import { call, commands, isTauri, type DebugEvent, type DebugSessionId } from "@/platform/ipc";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { isLive, useDebug, type DebugSession } from "./state";
import { tx } from "@/platform/i18n";

const KEY = "debug.hotswap";
/** `BUILD_COMPLETE` events of our own build are not worth a prompt. */
let quietUntil = 0;

export function hotSwapSessions(): DebugSession[] {
  return Object.values(useDebug.getState().sessions).filter((s) => isLive(s) && !!s.caps?.hotCodeReplace);
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "es"}`;
}

/** Message for the reload result (IDEA wording). */
export function hotSwapMessage(
  changed: number,
  errors: string[],
): { level: "info" | "error"; title: string; body?: string } {
  if (errors.length) return { level: "error", title: "Hot Swap failed", body: errors.join("\n") };
  if (changed === 0) return { level: "info", title: "Loaded classes are up to date. Nothing to reload." };
  return { level: "info", title: tx`${plural(changed, "class")} reloaded` };
}

/** Compiles (unless `build` is false) and reloads changed classes into every Java debug session. */
export async function reloadChangedClasses(build = true, configId?: string): Promise<void> {
  const sessions = hotSwapSessions().filter((s) => !configId || s.runConfig?.id === configId);
  if (!sessions.length || !isTauri()) {
    notifications().notify({ group: "run", level: "info", key: KEY, title: "No debug session can reload classes" });
    return;
  }
  quietUntil = Date.now() + 60_000;
  try {
    if (build) {
      try {
        await maybeEditorService()?.saveAll();
      } catch {
        /* best effort */
      }
      const modules = new Set(sessions.map((s) => s.launch?.cwd ?? ""));
      for (const module of modules) {
        const status = await call(commands.javaBuildWorkspace(module)).catch(() => null);
        if (status === "failed" || status === "withErrors") {
          notifications().notify({
            group: "run",
            level: "error",
            key: KEY,
            title: "Hot Swap failed",
            body: "Compilation failed: fix the errors and reload again.",
          });
          return;
        }
      }
    }
    const changed = new Set<string>();
    const errors: string[] = [];
    for (const s of sessions) {
      try {
        const r = await call(commands.debugRedefineClasses(s.id));
        r.changedClasses.forEach((c) => changed.add(c));
        if (r.errorMessage) errors.push(r.errorMessage);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    const m = hotSwapMessage(changed.size, errors);
    notifications().notify({ group: "run", key: KEY, ...m });
  } finally {
    quietUntil = Date.now() + 2_000;
  }
}

/** java-debug's `hotcodereplace` events of a session this window owns. */
export function onHotCodeReplace(session: DebugSessionId, event: Extract<DebugEvent, { kind: "hotCodeReplace" }>) {
  if (!useDebug.getState().sessions[session]) return;
  switch (event.changeType) {
    case "BUILD_COMPLETE":
      if (Date.now() < quietUntil) return;
      notifications().notify({
        group: "run",
        level: "info",
        key: KEY,
        title: "Classes changed",
        body: "Reload the changed classes into the running debug session?",
        actions: [{ label: "Reload", run: () => void reloadChangedClasses(false) }],
      });
      break;
    case "ERROR":
    case "WARNING":
      notifications().notify({
        group: "run",
        level: event.changeType === "ERROR" ? "error" : "warning",
        key: KEY,
        title: "Hot Swap",
        body: event.message,
      });
      break;
  }
}
