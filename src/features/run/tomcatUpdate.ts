import { executeAction, getAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { maybeEditorService, notifications, useDebugRunSessions } from "@/workbench/contributions";
import { showContextMenu } from "@/ui";
import { buildTomcatArtifact } from "./tomcat";
import { startRun, stopSession, useRun, waitForExit, type RunSession } from "./store";

const updating = new Set<string>();
export async function updateTomcat(session: RunSession, mode: string): Promise<void> {
  if (updating.has(session.id)) return;
  updating.add(session.id);
  try {
    const debugging = useDebugRunSessions.getState().sessions.some((s) => s.configId === session.config.id);
    if (mode === "restart") {
      if (debugging) {
        await stopSession(session.id);
        await waitForExit([session.id]);
        await executeAction("run.debugConfig", session.config);
      } else await startRun(session.config, session.id);
      return;
    }
    await maybeEditorService()?.saveAll();
    await buildTomcatArtifact(session.config);
    await call(commands.runTomcatUpdate(session.config, mode));
    if (mode === "classes" && debugging) {
      const swapped =
        getAction("debug.reloadChangedClasses") &&
        (await executeAction("debug.reloadChangedClasses", { configId: session.config.id }));
      if (!swapped) await call(commands.runTomcatUpdate(session.config, "redeploy"));
    }
    useRun.setState({ activeSession: session.id });
    notifications().notify({ group: "run", level: "info", title: "Application updated" });
  } catch (e) {
    notifications().notify({ group: "run", level: "error", title: "Application update failed", body: String(e) });
  } finally {
    updating.delete(session.id);
  }
}

export function showTomcatUpdate(sessionId?: string): void {
  const state = useRun.getState();
  const candidates = state.sessions.filter((s) => s.config.kind === "tomcat" && s.status === "running");
  const session = candidates.find((s) => s.id === (sessionId || state.activeSession)) ?? candidates[0];
  if (!session) return;
  showContextMenu({ x: window.innerWidth / 2 - 140, y: 100 }, [
    { kind: "header", label: "Update Application" },
    ...(
      [
        ["resources", "Update resources"],
        ["classes", "Update classes and resources"],
        ["redeploy", "Redeploy"],
        ["restart", "Restart server"],
      ] as const
    ).map(([mode, label]) => ({
      label,
      disabled:
        updating.has(session.id) ||
        ((mode === "resources" || mode === "classes") && session.config.params?.deployment === "war"),
      run: () => {
        void updateTomcat(session, mode);
      },
    })),
  ]);
}
