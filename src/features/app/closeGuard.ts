/**
 * Window close / quit flow.
 *
 * Closing a window (traffic light, Quit closing every window) runs
 * `decideClose`: confirm exit when this is the last window and
 * `general.confirmExit` is on, then Save All / Don't Save / Cancel when
 * documents have unsaved changes. Quit confirms once, then the backend closes
 * every window, each of which runs only its unsaved-changes check.
 */
import { commands, isTauri, onIdeEvent, type Settings } from "@/platform/ipc";
import { t } from "@/platform/i18n";
import { closeProject, provideLeaveProjectGuard, useProject } from "@/platform/project";
import { maybeEditorService, notifications, type EditorCloseSession } from "@/workbench/contributions";
import { ask, type Ask } from "@/workbench/messages";

/** Document ids the backend reports dirty in this window. */
const dirtyDocs = new Set<number>();

export function confirmExitEnabled(settings: Settings | null | undefined): boolean {
  return settings?.general?.confirmExit === true;
}

export interface CloseInput {
  quitting: boolean;
  windows: number;
  confirmExit: boolean;
  dirty: number;
  project: string | null;
}

export interface CloseDeps {
  ask: Ask;
  saveAll: () => Promise<void>;
  disableConfirmExit: () => Promise<void>;
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
  onSaveFailed: (e) =>
    notifications().notify({
      level: "error",
      title: t("app.unsaved.saveFailed"),
      body: e instanceof Error ? e.message : String(e),
    }),
};

let closing = false;

async function onCloseRequested(deps: CloseDeps): Promise<boolean> {
  if (closing) return false;
  closing = true;
  try {
    const ctx = await commands.windowCloseContext();
    const s = useProject.getState();
    // Closing the last project (or LightEdit) window closes its project and shows the welcome
    // screen (to open another one); closing the welcome screen, or quitting, closes the window.
    if (!ctx.quitting && ctx.windows <= 1 && (s.project || s.lightEdit)) {
      if (await confirmLeave(deps)) await closeProject();
      return false;
    }
    const ok = await decideClose(
      {
        quitting: ctx.quitting,
        windows: ctx.windows,
        confirmExit: confirmExitEnabled(s.settings),
        dirty: dirtyDocs.size,
        project: s.project?.name ?? null,
      },
      deps,
    );
    if (!ok && ctx.quitting) await commands.appCancelQuit();
    return ok;
  } catch (e) {
    maybeEditorService()?.cancelClose?.();
    deps.onSaveFailed(e);
    return false;
  } finally {
    closing = false;
  }
}

/** Unsaved changes before this window opens another project in place or closes it. */
export function confirmLeave(deps: CloseDeps = defaultDeps): Promise<boolean> {
  const s = useProject.getState();
  return decideClose(
    { quitting: false, windows: 2, confirmExit: false, dirty: dirtyDocs.size, project: s.project?.name ?? null },
    deps,
  );
}

/** Quit: confirm once (if enabled), then let the backend close every window. */
export async function quitApp(deps: CloseDeps = defaultDeps): Promise<void> {
  if (!isTauri()) return;
  if (confirmExitEnabled(useProject.getState().settings)) {
    const ok = await decideClose(
      { quitting: false, windows: 1, confirmExit: true, dirty: 0, project: null },
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
      const off = await getCurrentWindow().onCloseRequested(async (event) => {
        if (!(await onCloseRequested(deps))) event.preventDefault();
      });
      if (disposed) off();
      else unlisten = off;
    });
  }
  return () => {
    disposed = true;
    unlisten?.();
    unsubs.forEach((u) => u());
  };
}
