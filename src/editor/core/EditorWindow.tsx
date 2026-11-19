/**
 * Lightweight editor window (`editor-<parent>-<n>`): one project file in a window of its own
 * ("Open in New Window" without a second workbench).
 */
import clsx from "clsx";
import { create } from "zustand";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AUX_CLOSED, EDITOR_READY, type AuxCloseResult, type EditorReadyResult } from "@/platform/auxWindow";
import { setContext } from "@/platform/context";
import { t, tx } from "@/platform/i18n";
import { isImeKey } from "@/platform/ime";
import { commands, type EditorLaunch } from "@/platform/ipc";
import { basename, useProject } from "@/platform/project";
import { restoreRemote } from "@/platform/remote";
import { usePlatform } from "@/platform/platformInfo";
import { Spinner, T, isPopupOpen } from "@/ui";
import { editorService, notifications } from "@/workbench/contributions";
import { EditorArea } from "@/workbench/EditorArea";
import { OverlayHost } from "@/workbench/OverlayHost";
import { TitleBar } from "@/workbench/TitleBar";
import { WindowResizeHandles } from "@/workbench/WindowResizeHandles";
import { useApplyTheme } from "@/workbench/theme";
import { ask } from "@/workbench/messages";
import { editorController } from "./controller";
import type { DocModel } from "./model/document";
import styles from "./EditorWindow.module.css";

const useEditorWindow = create<{
  path: string | null;
  title: string;
  error: string | null;
}>(() => ({ path: null, title: "", error: null }));

function showCaption(caption: string) {
  if (useEditorWindow.getState().title === caption) return;
  useEditorWindow.setState({ title: caption });
  void getCurrentWindow()
    .setTitle(caption)
    .catch(() => {});
}

async function reportReady(parent: string, result: Omit<EditorReadyResult, "label">) {
  const payload: EditorReadyResult = { label: getCurrentWindow().label, ...result };
  await emitTo(parent, EDITOR_READY, payload).catch((error) =>
    console.warn("cannot report editor window ready", error),
  );
}

/**
 * Settles this window's unsaved files before it closes. Only its own documents count: the project
 * window keeps its processes and any copy of the same file it still has open.
 */
async function settleUnsaved(models: DocModel[], project: string | null): Promise<boolean> {
  const dirty = models.filter((model) => model.getMeta().dirty);
  if (dirty.length === 0) return true;
  if (useProject.getState().settings?.files?.autoSave !== false) {
    await Promise.all(dirty.map((model) => model.save("auto")));
    return true;
  }
  const answer = await ask({
    title: t("app.unsaved.title"),
    body: t("app.unsaved.body", { count: dirty.length, project: project ?? t("app.title.default") }),
    buttons: [
      { id: "discard", label: t("app.unsaved.discard") },
      { id: "save", label: t("app.unsaved.save"), primary: true },
    ],
    icon: "warning",
  });
  if (answer.button === "save") await Promise.all(dirty.map((model) => model.save("explicit")));
  return answer.button === "save" || answer.button === "discard";
}

/** Loads the launch's file into this window's editor. */
export function activateEditorWindow(parent: string): () => void {
  let projectName: string | null = null;
  const native = getCurrentWindow();
  let disposed = false;
  let closing = false;
  let stopClose: (() => void) | undefined;
  void native
    .onCloseRequested(async (event) => {
      if (closing) {
        event.preventDefault();
        return;
      }
      closing = true;
      const models = [...editorController().manager.byId.values()];
      let closed = false;
      try {
        await Promise.all(models.map((model) => model.sync.whenIdle()));
        closed = await settleUnsaved(models, projectName);
        if (closed) {
          for (const model of models) model.dispose();
          await Promise.all(
            models.map((model) =>
              commands.docClose(model.doc).catch((error) => console.warn("cannot release editor document", error)),
            ),
          );
        }
      } catch (error) {
        notifications().notify({ level: "error", title: tx("Could not close editor"), body: String(error) });
      } finally {
        if (!closed) event.preventDefault();
        const result: AuxCloseResult = {
          label: native.label,
          closed,
          documents: closed ? models.map((model) => model.doc) : [],
        };
        await emitTo(parent, AUX_CLOSED, result).catch((error) =>
          console.warn("cannot report editor window close", error),
        );
        closing = false;
      }
    })
    .then((off) => {
      if (disposed) off();
      else stopClose = off;
    });
  const onCloseShortcut = (event: KeyboardEvent) => {
    if (isImeKey(event) || isPopupOpen()) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
      event.preventDefault();
      event.stopImmediatePropagation();
      void native.close();
    }
  };
  window.addEventListener("keydown", onCloseShortcut, true);
  void (async () => {
    let path = "";
    try {
      await restoreRemote();
      const launch = (await commands.windowTakeLaunch())?.editor as EditorLaunch | null | undefined;
      if (!launch?.path) throw new Error(tx("Missing editor request"));
      path = launch.path;
      const project = await commands.projectCurrent();
      if (!project) throw new Error(tx("The editor’s project is no longer open"));
      projectName = project.name;
      // Settings only: restoring the project's editor session here would overwrite the main window's tabs.
      useProject.setState({ settings: project.settings });
      setContext("projectOpen", true);
      const selection =
        launch.line != null && launch.column != null
          ? {
              line: launch.line,
              col: launch.column,
              ...(launch.endLine != null ? { endLine: launch.endLine, endCol: launch.endColumn ?? 0 } : {}),
            }
          : undefined;
      await editorService().openFile(path, { focus: true, selection });
      useEditorWindow.setState({ path });
      showCaption(`${project.name} — ${basename(path)}`);
      await reportReady(parent, { path, ok: true });
    } catch (error) {
      const message = String(error);
      useEditorWindow.setState({ error: message });
      await reportReady(parent, { path, ok: false, error: message });
    }
  })();
  return () => {
    disposed = true;
    stopClose?.();
    window.removeEventListener("keydown", onCloseShortcut, true);
  };
}

export function EditorWindow() {
  useApplyTheme();
  const { path, title, error } = useEditorWindow();
  const os = usePlatform((s) => s.os);
  const ownTitleBar = usePlatform((s) => s.overlayTitleBar || s.framelessTitleBar);
  return (
    <main className={clsx(styles.window, os === "linux" && styles.edge)}>
      {ownTitleBar && <TitleBar minimal dialog title={title} />}
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : !path ? (
        <div className={styles.loading} role="status">
          <Spinner />
          <T>Loading…</T>
        </div>
      ) : (
        <div className={styles.body}>
          <EditorArea />
        </div>
      )}
      <OverlayHost />
      <WindowResizeHandles />
    </main>
  );
}
