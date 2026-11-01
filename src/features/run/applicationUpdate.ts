import { tx } from "@/platform/i18n";
import { create } from "zustand";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { executeAction, getAction } from "@/platform/actions";
import { call, commands, isTauri, nextRequestId, type RunConfig } from "@/platform/ipc";
import { parseJavaArgs, resolveJavaModule } from "@/platform/javaLaunch";
import {
  maybeEditorService,
  notifications,
  useDebugRunSessions,
  type DebugServiceSession,
} from "@/workbench/contributions";
import { showContextMenu } from "@/ui";
import { buildTomcatArtifact } from "./tomcat";
import { runUpdateBuild } from "./buildUpdate";
import { startRun, stopSession, useRun, waitForExit, type RunSession } from "./store";
import { isUpdatable, updateAllowed, type UpdateMode } from "./updatePolicies";

export type UpdateSession = Pick<RunSession, "id" | "config"> & { debug?: DebugServiceSession };
export const useApplicationUpdates = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }));
const updatingConfigs = new Set<string>();

export function updatableSessions(): UpdateSession[] {
  const runs = useRun.getState().sessions.filter((s) => isUpdatable(s.config) && s.status === "running");
  const debug = useDebugRunSessions
    .getState()
    .serviceSessions.filter(
      (s) =>
        isUpdatable(s.config) &&
        (s.status === "running" || s.status === "paused") &&
        !runs.some((r) => r.runId === s.processId && r.config.id === s.config.id),
    )
    .map((s) => ({ id: `debug:${s.id}`, config: s.config, debug: s }));
  return [...runs, ...debug];
}

function params(session: UpdateSession): RunConfig["params"] {
  return useRun.getState().configs.find((c) => c.id === session.config.id)?.params ?? session.config.params;
}

async function updateSpringBoot(config: RunConfig, mode: UpdateMode, debugging: boolean) {
  const module = await resolveJavaModule(config);
  const parsed = parseJavaArgs(config.args);
  if (!parsed.mainClass) throw new Error(tx("The Spring Boot configuration has no main class"));
  const info = await call(
    commands.javaResolveLaunch(module, parsed.classpath === "test", mode === "classes", nextRequestId()),
  );
  if (info.build === "failed" || info.build === "withErrors" || info.build === "cancelled")
    throw new Error(tx("Application update build failed"));
  await runUpdateBuild(await call(commands.runApplicationBuild(config, module)));
  const classPaths = parsed.explicitClasspath?.split(info.pathListSeparator) ?? info.classPaths;
  await call(commands.runApplicationPublish(config, classPaths, parsed.mainClass));
  if (mode === "classes" && debugging && (await executeAction("debug.reloadChangedClasses", { configId: config.id })))
    return;
  notifications().notify({
    group: "run",
    level: "info",
    title: "Resources updated",
    ...(mode === "classes"
      ? {
          body: "Classes were compiled. Restart the application to load them, or launch with the debugger to use HotSwap.",
        }
      : {}),
  });
}

export async function updateApplication(session: UpdateSession, mode: string): Promise<void> {
  if (!updateAllowed(session.config, mode) || updatingConfigs.has(session.config.id)) return;
  updatingConfigs.add(session.config.id);
  useApplicationUpdates.setState((s) => ({ ids: new Set([...s.ids, session.id]) }));
  try {
    const debugging =
      !!session.debug || useDebugRunSessions.getState().sessions.some((s) => s.configId === session.config.id);
    if (mode === "restart") {
      if (session.debug) {
        await session.debug.stop();
        await executeAction("run.debugConfig", session.config);
      } else if (debugging) {
        await stopSession(session.id);
        await waitForExit([session.id]);
        await executeAction("run.debugConfig", session.config);
      } else await startRun(session.config, session.id);
      return;
    }
    await maybeEditorService()?.saveAll();
    if (session.config.kind === "spring-boot") {
      await updateSpringBoot(session.config, mode, debugging);
    } else {
      await buildTomcatArtifact(session.config);
      await call(commands.runTomcatUpdate(session.config, mode));
      if (mode === "classes" && debugging) {
        const swapped =
          getAction("debug.reloadChangedClasses") &&
          (await executeAction("debug.reloadChangedClasses", { configId: session.config.id }));
        if (!swapped) await call(commands.runTomcatUpdate(session.config, "redeploy"));
      }
      notifications().notify({ group: "run", level: "info", title: "Application updated" });
    }
    if (!session.debug) useRun.setState({ activeSession: session.id });
  } catch (e) {
    notifications().notify({ group: "run", level: "error", title: "Application update failed", body: String(e) });
  } finally {
    updatingConfigs.delete(session.config.id);
    useApplicationUpdates.setState((s) => ({ ids: new Set([...s.ids].filter((id) => id !== session.id)) }));
  }
}

export function showApplicationUpdate(sessionId?: string): void {
  const state = useRun.getState();
  const candidates = updatableSessions();
  const session = candidates.find((s) => s.id === (sessionId || state.activeSession)) ?? candidates[0];
  if (!session) return;
  const policy = params(session)?.onUpdate ?? "ask";
  if (policy !== "ask" && updateAllowed(session.config, policy)) {
    void updateApplication(session, policy);
    return;
  }
  const choices = [
    ["resources", "Update resources"],
    ["classes", "Update classes and resources"],
    ...(session.config.kind === "tomcat" ? [["redeploy", "Redeploy"]] : []),
    ["restart", session.config.kind === "tomcat" ? "Restart server" : "Restart"],
  ];
  showContextMenu({ x: window.innerWidth / 2 - 140, y: 100 }, [
    { kind: "header", label: "Update Application" },
    ...choices.map(([mode, label]) => ({
      label: label!,
      disabled: useApplicationUpdates.getState().ids.has(session.id) || !updateAllowed(session.config, mode!),
      run: () => {
        void updateApplication(session, mode!);
      },
    })),
  ]);
}

export function updateOnDeactivation(): void {
  for (const session of updatableSessions()) {
    const mode = params(session)?.onDeactivation;
    if (mode === "resources" || mode === "classes") void updateApplication(session, mode);
  }
}

export function listenForApplicationDeactivation(): () => void {
  if (!isTauri()) return () => {};
  const listener = getCurrentWebviewWindow().listen("ide://application-deactivated", updateOnDeactivation);
  return () => {
    void listener.then((unlisten) => unlisten());
  };
}
