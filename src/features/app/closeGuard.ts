/**
 * Window close / quit flow.
 *
 * Closing a window (traffic light, Quit closing every window) runs
 * `decideClose`: confirm exit when this is the last window and
 * `general.confirmExit` is on, then Terminate / Cancel when Run/Debug processes
 * still run and `run.confirmTerminate` is on, then Save All / Don't Save / Cancel
 * when documents have unsaved changes. Quit confirms once, then the backend
 * closes every window, each of which runs its own checks.
 */
import { commands, isTauri, onIdeEvent, type Settings } from "@/platform/ipc";
import { t } from "@/platform/i18n";
import { closeProject, provideLeaveProjectGuard, useProject } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import {
  maybeEditorService,
  notifications,
  runningProcesses as liveProcesses,
  stopRunningProcesses,
  type EditorCloseSession,
} from "@/workbench/contributions";
import { beginTermination, endTermination } from "./termination";
import { ask, type Ask } from "@/workbench/messages";
import { AUX_CLOSED, auxiliaryWindow, closeDocumentWindows, type AuxCloseResult } from "@/platform/auxWindow";

/** Document ids the backend reports dirty in this window. */
const dirtyDocs = new Set<number>();

export function dirtyCount(): number {
  return new Set([...dirtyDocs, ...(maybeEditorService()?.dirtyDocumentIds?.() ?? [])]).size;
}

export function confirmExitEnabled(settings: Settings | null | undefined): boolean {
  return settings?.general?.confirmExit === true;
}

export interface CloseInput {
  quitting: boolean;
  windows: number;
  confirmExit: boolean;
  confirmTerminate: boolean;
  /** Running Run/Debug process names this close would terminate. */
  processes: readonly string[];
  dirty: number;
  project: string | null;
}

export interface CloseDeps {
  ask: Ask;
  saveAll: () => Promise<void>;
  disableConfirmExit: () => Promise<void>;
  disableConfirmTerminate: () => Promise<void>;
  /** Running Run/Debug process names in this window. */
  runningProcesses: () => Promise<readonly string[]>;
  /** Stops them, gracefully first and SIGKILL when asked, as IDEA's close does. */
  terminate?: (kill: boolean) => Promise<void>;
  /** Resolves once no process of this window is left. */
  waitForProcesses?: () => Promise<void>;
  onSaveFailed: (e: unknown) => void;
  /** Stops custom document edits/execution before reading their final dirty state. */
  prepareClose?: () => Promise<EditorCloseSession | undefined>;
}

/** Asks whatever must be asked; resolves true when the window may close. */
export async function decideClose(input: CloseInput, deps: CloseDeps): Promise<boolean> {
  if (!input.quitting && input.windows <= 1 && input.confirmExit) {
    const r = await deps.ask({
      title: t("app.exit.title"),
      body: t("app.exit.body"),
      buttons: [{ id: "exit", label: t("app.exit.confirm"), primary: true }],
      checkbox: t("app.exit.dontAsk"),
    });
    if (r.button !== "exit") return false;
    if (r.checked) await deps.disableConfirmExit().catch(() => {});
  }
  let terminateNames: readonly string[] = [];
  if (input.confirmTerminate && input.processes.length > 0) {
    const names = input.processes;
    const r = await deps.ask({
      title:
        names.length === 1
          ? t("app.terminateProcesses.titleOne", { name: names[0]! })
          : t("app.terminateProcesses.titleMany", { count: names.length }),
      body:
        names.length === 1
          ? t("app.terminateProcesses.bodyOne", { name: names[0]! })
          : t("app.terminateProcesses.bodyMany", { count: names.length, names: names.join(", ") }),
      buttons: [{ id: "terminate", label: t("app.terminateProcesses.terminate"), primary: true }],
      checkbox: t("app.terminateProcesses.dontAsk"),
      icon: "warning",
    });
    if (r.button !== "terminate") return false;
    if (r.checked) await deps.disableConfirmTerminate().catch(() => {});
    // Terminated after the save question below, so cancelling that keeps the processes alive.
    terminateNames = names;
  }
  let session: EditorCloseSession | undefined;
  let authorized = false;
  try {
    session = await deps.prepareClose?.();
    const dirty = input.dirty + (session?.dirty ?? 0);
    if (dirty > 0) {
      const r = await deps.ask({
        title: t("app.unsaved.title"),
        body: t("app.unsaved.body", { count: dirty, project: input.project ?? t("app.title.default") }),
        buttons: [
          { id: "discard", label: t("app.unsaved.discard") },
          { id: "save", label: t("app.unsaved.save"), primary: true },
        ],
        icon: "warning",
      });
      if (r.button === "save") await deps.saveAll();
      else if (r.button === "discard") await session?.discard();
      else return false;
    }
    // IDEA asks, then shows "Terminating 'X'" while the graceful shutdown runs; a Kill button
    // there kills the processes and the close finishes once none is left.
    if (terminateNames.length > 0) await terminateForClose(terminateNames, deps);
    session?.commit();
    authorized = true;
    return true;
  } catch (e) {
    deps.onSaveFailed(e);
    return false;
  } finally {
    if (!authorized) session?.cancel();
  }
}

const defaultDeps: CloseDeps = {
  ask,
  saveAll: async () => {
    await maybeEditorService()?.saveAll();
  },
  prepareClose: async () => maybeEditorService()?.prepareClose?.(),
  disableConfirmExit: async () => {
    const r = await commands.settingsSet("global", "general.confirmExit", "false");
    if (r.status === "ok") useProject.setState({ settings: r.data });
  },
  disableConfirmTerminate: async () => {
    const r = await commands.settingsSet("global", "run.confirmTerminate", "false");
    if (r.status === "ok") useProject.setState({ settings: r.data });
  },
  runningProcesses: async () => (await liveProcesses()).map((p) => p.name),
  terminate: (kill) => stopRunningProcesses(kill),
  waitForProcesses: async () => {
    while ((await liveProcesses()).length > 0) await new Promise((r) => setTimeout(r, 100));
  },
  onSaveFailed: (e) =>
    notifications().notify({
      level: "error",
      title: t("app.unsaved.saveFailed"),
      body: e instanceof Error ? e.message : String(e),
    }),
};

/** The close waits for the processes, with the progress panel and a Kill escape hatch. */
async function terminateForClose(names: readonly string[], deps: CloseDeps): Promise<void> {
  if (!deps.terminate) return;
  beginTermination(names, () => {
    void deps.terminate?.(true).catch(() => undefined);
  });
  try {
    await deps.terminate(false);
    await deps.waitForProcesses?.();
  } finally {
    endTermination();
  }
}

/** Process names this close would terminate; an unavailable feature list never blocks closing. */
async function processNames(deps: CloseDeps): Promise<string[]> {
  return [...new Set(await deps.runningProcesses().catch(() => []))].filter(Boolean);
}

let closing = false;

async function onCloseRequested(deps: CloseDeps): Promise<boolean> {
  if (closing) return false;
  closing = true;
  try {
    const ctx = await commands.windowCloseContext();
    if (!(await closeDocumentWindows())) {
      await (ctx.quitting ? commands.appCancelQuit() : commands.windowGroupCancelClose());
      return false;
    }
    const s = useProject.getState();
    // Closing the last project (or LightEdit) window closes its project and shows the welcome
    // screen (to open another one); closing the welcome screen, or quitting, closes the window.
    if (!ctx.quitting && ctx.windows <= 1 && (s.project || s.lightEdit)) {
      if (await confirmLeave(deps)) await closeProject();
      return false;
    }
    const confirmTerminate = workflowSettings().run.confirmTerminate;
    const ok = await decideClose(
      {
        quitting: ctx.quitting,
        windows: ctx.windows,
        confirmExit: confirmExitEnabled(s.settings),
        confirmTerminate,
        processes: confirmTerminate ? await processNames(deps) : [],
        dirty: dirtyCount(),
        project: s.project?.name ?? null,
      },
      deps,
    );
    if (!ok) await (ctx.quitting ? commands.appCancelQuit() : commands.windowGroupCancelClose());
    else if (!ctx.quitting) await commands.windowGroupBeforeClose();
    return ok;
  } catch (e) {
    maybeEditorService()?.cancelClose?.();
    void commands.windowGroupCancelClose().catch(() => {});
    deps.onSaveFailed(e);
    return false;
  } finally {
    closing = false;
  }
}

/**
 * Unsaved changes before this window opens another project in place or closes it. `project` names
 * the project in the prompt when this window doesn't hold it (a comparison window).
 */
export async function confirmLeave(
  deps: CloseDeps = defaultDeps,
  project = useProject.getState().project?.name ?? null,
): Promise<boolean> {
  if (!(await closeDocumentWindows())) return false;
  const confirmTerminate = workflowSettings().run.confirmTerminate;
  return decideClose(
    {
      quitting: false,
      windows: 2,
      confirmExit: false,
      confirmTerminate,
      processes: confirmTerminate ? await processNames(deps) : [],
      dirty: dirtyCount(),
      project,
    },
    deps,
  );
}

/** Quit: confirm once (if enabled), then let the backend close every window. */
export async function quitApp(deps: CloseDeps = defaultDeps): Promise<void> {
  if (!isTauri()) return;
  if (confirmExitEnabled(useProject.getState().settings)) {
    // Each window asks about its own processes as the backend closes it.
    const ok = await decideClose(
      {
        quitting: false,
        windows: 1,
        confirmExit: true,
        confirmTerminate: false,
        processes: [],
        dirty: 0,
        project: null,
      },
      { ...deps, prepareClose: undefined },
    );
    if (!ok) return;
  }
  await commands.appQuit();
}

export function installCloseGuard(deps: CloseDeps = defaultDeps): () => void {
  const unsubs = [
    onIdeEvent("docDirty", (e) => {
      if (e.dirty) dirtyDocs.add(e.doc);
      else dirtyDocs.delete(e.doc);
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root || s.lightEdit !== prev.lightEdit) dirtyDocs.clear();
    }),
    provideLeaveProjectGuard(() => confirmLeave(deps)),
  ];
  let unlisten: (() => void) | undefined;
  let disposed = false;
  if (isTauri()) {
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      // Documents an auxiliary window released are no longer dirty unless this window edits them too.
      const offAux = await getCurrentWindow().listen<AuxCloseResult>(AUX_CLOSED, ({ payload }) => {
        if (
          !payload.closed ||
          auxiliaryWindow(payload.label)?.parent !== getCurrentWindow().label ||
          !Array.isArray(payload.documents)
        )
          return;
        const own = new Set(maybeEditorService()?.dirtyDocumentIds?.() ?? []);
        for (const doc of payload.documents) if (!own.has(doc)) dirtyDocs.delete(doc);
      });
      const off = await getCurrentWindow().onCloseRequested(async (event) => {
        if (!(await onCloseRequested(deps))) event.preventDefault();
      });
      const stop = () => {
        off();
        offAux();
      };
      if (disposed) stop();
      else unlisten = stop;
    });
  }
  return () => {
    disposed = true;
    unlisten?.();
    unsubs.forEach((u) => u());
  };
}
