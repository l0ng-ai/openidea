/**
 * HotSwap (IDEA: Run › Debugging Actions › Reload Changed Classes) through
 * java-debug's hot code replace: compile with jdtls, then `redefineClasses`
 * in every Java debug session. When jdtls finishes a build on its own (after
 * a save) java-debug reports `BUILD_COMPLETE` and, like IDEA's default
 * "Reload classes after compilation: Ask", we offer the reload.
 */
import {
  call,
  commands,
  isTauri,
  isCancelled,
  nextRequestId,
  type DebugEvent,
  type DebugSessionId,
  type RequestId,
} from "@/platform/ipc";
import { setContext } from "@/platform/context";
import { executeAction } from "@/platform/actions";
import { basename } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import {
  maybeEditorService,
  notifications,
  onBuildCompleted,
  type BuildCompletedEvent,
} from "@/workbench/contributions";
import { isLive, selectFrame, selectSession, useDebug, type DebugSession } from "./state";
import { tx } from "@/platform/i18n";
import type { MenuItem } from "@/ui/Menu";

const KEY = "debug.hotswap";
const JAVA_BUILD_SYSTEMS = new Set(["maven", "gradle", "javac"]);
/** `BUILD_COMPLETE` events of our own build are not worth a prompt. */
let quietUntil = 0;
/** The compile request HotSwap is waiting on, so it can be cancelled. */
let activeBuild: { request: RequestId; cancelled: boolean } | null = null;
let reloading = false;

/** Cancels a running HotSwap compile; the reload is aborted rather than applied to stale classes. */
export function cancelHotSwapBuild(): void {
  if (activeBuild === null || activeBuild.cancelled) return;
  activeBuild.cancelled = true;
  void commands.cancelRequest(activeBuild.request).catch(() => {});
}

export function hotSwapSessions(): DebugSession[] {
  return Object.values(useDebug.getState().sessions).filter((s) => isLive(s) && !!s.caps?.hotCodeReplace);
}

/** Editor menu: Reload Changed Classes on a Java file while a debug session can reload classes. */
export function hotSwapMenuItems(paths: readonly string[]): MenuItem[] {
  const java = paths.length === 1 && /\.java$/i.test(paths[0]!);
  return java && hotSwapSessions().length ? [{ kind: "action", action: "debug.reloadChangedClasses" }] : [];
}

/** "3 classes", translated per count (the sentence around it is translated on its own). */
const classesText = (n: number) => (n === 1 ? tx`${n} class` : tx`${n} classes`);

// java-debug reports this after redefineClasses succeeds, with no changedClasses count.
const obsoleteMethods = (message: string) => message.trim() === "JVM contains obsolete methods";
// JDI's refusals of a structural change: "add method not implemented", "schema change not implemented", …
const structuralChange = (message: string) => /\bnot implemented\b/i.test(message);

/** Application and Spring Boot configurations offer Enhanced class redefinition (JetBrains Runtime's DCEVM). */
const ENHANCEABLE_KINDS = new Set(["application", "spring-boot"]);

/** Whether the session's configuration could turn on Enhanced class redefinition but has not. */
export function canEnhanceRedefinition(s: DebugSession): boolean {
  const rc = s.runConfig;
  return !!rc && ENHANCEABLE_KINDS.has(rc.kind) && rc.params?.enhancedClassRedefinition !== "true";
}

/** The failure text, plus how to allow structural changes when JDI refused one and the configuration can. */
function failureBody(errors: string[], enhanceable: boolean): string {
  const body = errors.join("\n");
  if (!enhanceable || !errors.some(structuralChange)) return body;
  return (
    body +
    "\n\n" +
    tx(
      "To add or remove methods and fields, turn on Enhanced class redefinition in the run configuration and debug on JetBrains Runtime.",
    )
  );
}

/** Message for the reload result (IDEA wording). */
export function hotSwapMessage(
  changed: number,
  errors: string[],
  bottomFrame = false,
  enhanceable = false,
): { level: "info" | "warning" | "error"; title: string; body?: string } {
  if (errors.some((e) => !obsoleteMethods(e)))
    return { level: "error", title: "Hot Swap failed", body: failureBody(errors, enhanceable) };
  if (errors.length)
    return {
      level: "warning",
      title: "Classes reloaded",
      body:
        tx("Active frames keep running the old code until they return. New calls use the reloaded code.") +
        (bottomFrame
          ? " " +
            tx(
              "The bottom frame cannot be reset. Re-enter the method or restart the debug session to run the new code.",
            )
          : ""),
    };
  if (changed === 0) return { level: "info", title: "Loaded classes are up to date. Nothing to reload." };
  return { level: "info", title: tx`${classesText(changed)} reloaded` };
}

function obsoleteFrameActions(sessions: DebugSession[]) {
  return sessions.flatMap((s) => {
    const frame = s.frames[0];
    // java-debug cannot drop the bottom frame or frames involving a native caller.
    if (
      s.status !== "paused" ||
      !s.caps?.restartFrame ||
      !frame ||
      s.frames.length < 2 ||
      s.frames.slice(0, 2).some((f) => f.name.includes("[native method]"))
    )
      return [];
    return [
      {
        label: sessions.length > 1 ? tx`Reset Frame (${s.name})` : "Reset Frame",
        run: () => {
          const current = useDebug.getState().sessions[s.id];
          if (current?.status !== "paused" || current.frames !== s.frames) return;
          selectSession(s.id);
          selectFrame(s.id, frame.id, false);
          void executeAction("debug.resetFrame");
        },
      },
    ];
  });
}

/** Compiles (unless `build` is false) and reloads changed classes into every Java debug session. */
export async function reloadChangedClasses(build = true, configId?: string, allowBuildErrors = false): Promise<void> {
  if (reloading) return;
  const sessions = hotSwapSessions().filter((s) => !configId || s.runConfig?.id === configId);
  if (!sessions.length || !isTauri()) {
    notifications().notify({ group: "run", level: "info", key: KEY, title: "No debug session can reload classes" });
    return;
  }
  reloading = true;
  quietUntil = Date.now() + 60_000;
  let buildFailed = false;
  try {
    if (build) {
      try {
        await maybeEditorService()?.saveAll();
      } catch {
        /* best effort */
      }
      const modules = new Set(sessions.map((s) => s.launch?.cwd ?? ""));
      for (const module of modules) {
        const request = nextRequestId();
        const compile = { request, cancelled: false };
        activeBuild = compile;
        setContext("debugHotSwapBuilding", true);
        notifications().notify({
          group: "run",
          level: "info",
          key: KEY,
          title: "Compiling changed classes…",
          sticky: true,
          actions: [{ label: "Cancel Hot Swap Build", run: cancelHotSwapBuild }],
        });
        let status: "cancelled" | "failed" | "succeeded" | "withErrors" | null = null;
        try {
          // oxlint-disable-next-line no-await-in-loop -- builds run one module at a time against the shared activeBuild/cancel state and UI context; cancellation aborts the whole reload
          status = await call(commands.javaBuildWorkspace(module, request));
        } catch (e) {
          status = isCancelled(e) ? "cancelled" : null;
        } finally {
          activeBuild = null;
          setContext("debugHotSwapBuilding", false);
        }
        if (compile.cancelled || status === "cancelled") {
          // JDT can write class files before cancellation without publishing their
          // build deltas. java-debug cannot recover those classes on the next build.
          useDebug.setState((state) => ({
            sessions: Object.fromEntries(
              Object.entries(state.sessions).map(([id, s]) => [
                id,
                isLive(s) && s.caps?.hotCodeReplace ? { ...s, hotSwapNeedsRestart: true } : s,
              ]),
            ),
          }));
          notifications().notify({ group: "run", level: "info", key: KEY, title: "Hot Swap cancelled" });
          return;
        }
        if (status === "failed" || status === "withErrors" || status === null) {
          if (!allowBuildErrors) {
            notifications().notify({
              group: "run",
              level: "error",
              key: KEY,
              title: "Hot Swap failed",
              body: "Compilation failed: fix the errors and reload again.",
            });
            return;
          }
          // Single-file Recompile succeeded with javac; another file in the module may still fail
          // in JDT, so continue to redefine any classes compiled cleanly before this error.
          buildFailed = true;
        }
      }
    }
    if (sessions.some((s) => useDebug.getState().sessions[s.id]?.hotSwapNeedsRestart)) {
      notifications().notify({
        group: "run",
        level: "error",
        key: KEY,
        title: "Hot Swap failed",
        body: "A cancelled build may have left classes out of the reload. Restart the debug session to apply all changes.",
      });
      return;
    }
    const changed = new Set<string>();
    const errors: string[] = [];
    const obsolete: DebugSessionId[] = [];
    for (const s of sessions) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- redefines run in session order; errors and obsolete-session results are aggregated in that order for the notification
        const r = await call(commands.debugRedefineClasses(s.id));
        r.changedClasses.forEach((c) => changed.add(c));
        if (r.errorMessage) {
          errors.push(r.errorMessage);
          if (obsoleteMethods(r.errorMessage)) obsolete.push(s.id);
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (buildFailed && changed.size === 0 && errors.length === 0) {
      notifications().notify({
        group: "run",
        level: "error",
        key: KEY,
        title: "Hot Swap failed",
        body: "Compilation failed: fix the errors and reload again.",
      });
      return;
    }
    const affected = obsolete.flatMap((id) => useDebug.getState().sessions[id] ?? []);
    const m = hotSwapMessage(
      changed.size,
      errors,
      affected.some((s) => s.status === "paused" && s.frames.length === 1),
      sessions.some(canEnhanceRedefinition),
    );
    notifications().notify({
      group: "run",
      key: KEY,
      ...m,
      ...(m.level === "warning" ? { sticky: true, actions: obsoleteFrameActions(affected) } : {}),
    });
  } finally {
    reloading = false;
    quietUntil = Date.now() + 2_000;
  }
}

/** Handles a completed user build (`Build Project`, `Build Module`, `Recompile`) for active Java debug sessions. */
export function onJavaBuildCompleted(event: BuildCompletedEvent): void {
  if (!event.userInitiated || !JAVA_BUILD_SYSTEMS.has(event.system) || reloading || !hotSwapSessions().length) return;
  const policy = workflowSettings().debugger.hotSwapAfterCompile;
  if (policy === "never") return;
  quietUntil = Math.max(quietUntil, Date.now() + 2_000);
  const allowBuildErrors = event.kind === "compileFile";
  if (policy === "always") {
    void reloadChangedClasses(true, undefined, allowBuildErrors);
    return;
  }
  const fileName = event.kind === "compileFile" && event.file ? basename(event.file) : "";
  notifications().notify({
    group: "run",
    level: "info",
    key: KEY,
    title: "Classes changed",
    body: fileName
      ? tx`Reload '${fileName}' into the running debug session?`
      : "Reload the changed classes into the running debug session?",
    actions: [{ label: "Reload", run: () => void reloadChangedClasses(true, undefined, allowBuildErrors) }],
  });
}

export function installBuildHotSwap(): () => void {
  return onBuildCompleted(onJavaBuildCompleted);
}

/** java-debug's `hotcodereplace` events of a session this window owns. */
export function onHotCodeReplace(session: DebugSessionId, event: Extract<DebugEvent, { kind: "hotCodeReplace" }>) {
  if (!useDebug.getState().sessions[session]) return;
  switch (event.changeType) {
    case "BUILD_COMPLETE": {
      if (reloading || Date.now() < quietUntil) return;
      const policy = workflowSettings().debugger.hotSwapAfterCompile;
      if (policy === "never") return;
      if (policy === "always") {
        void reloadChangedClasses(false);
        return;
      }
      notifications().notify({
        group: "run",
        level: "info",
        key: KEY,
        title: "Classes changed",
        body: "Reload the changed classes into the running debug session?",
        actions: [{ label: "Reload", run: () => void reloadChangedClasses(false) }],
      });
      break;
    }
    case "ERROR":
    case "WARNING":
      if (obsoleteMethods(event.message)) {
        if (reloading) return;
        const s = useDebug.getState().sessions[session]!;
        notifications().notify({
          group: "run",
          key: KEY,
          ...hotSwapMessage(0, [event.message], s.status === "paused" && s.frames.length === 1),
          sticky: true,
          actions: obsoleteFrameActions([s]),
        });
        return;
      }
      notifications().notify({
        group: "run",
        level: event.changeType === "ERROR" ? "error" : "warning",
        key: KEY,
        title: "Hot Swap",
        body: failureBody([event.message], canEnhanceRedefinition(useDebug.getState().sessions[session]!)),
      });
      break;
  }
}
