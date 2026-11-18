/**
 * Lightweight editor window (`editor-<parent>-<n>`): one project file in a window of its own
 * (IDEA-style "Open in New Window" without a second workbench).
 */
import clsx from "clsx";
import { create } from "zustand";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AUX_CLOSED, EDITOR_READY, type AuxCloseResult, type EditorReadyResult } from "@/platform/auxWindow";
import { setContext } from "@/platform/context";
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
import { editorController } from "./controller";
import styles from "@/features/vcs/common.module.css";

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
 * Loads the launch's file into this window's editor. `confirmLeave` settles unsaved changes
 * before the window closes.
 */
export function activateEditorWindow(
  parent: string,
  confirmLeave: (project: string | null) => Promise<boolean>,
): () => void {
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
        closed = await confirmLeave(projectName);
        if (closed) {
          for (const model of models) model.dispose();
          await Promise.all(
            models.map((model) =>
              commands.docClose(model.doc).catch((error) => console.warn("cannot release editor document", error)),
            ),
          );
        }
      } catch (error) {
        notifications().notify({ level: "error", title: "Could not close editor", body: String(error) });
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
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isImeKey(event) || isPopupOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      void native.close();
    }
  };
  const onCloseShortcut = (event: KeyboardEvent) => {
    if (isImeKey(event) || isPopupOpen()) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
      event.preventDefault();
      event.stopImmediatePropagation();
      void native.close();
    }
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keydown", onCloseShortcut, true);
  void (async () => {
    let path = "";
    try {
      await restoreRemote();
      const launch = (await commands.windowTakeLaunch())?.editor as EditorLaunch | null | undefined;
      if (!launch?.path) throw new Error("Missing editor request");
      path = launch.path;
      const project = await commands.projectCurrent();
      if (!project) throw new Error("The editor’s project is no longer open");
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
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keydown", onCloseShortcut, true);
  };
}

export function EditorWindow() {
  useApplyTheme();
  const { path, title, error } = useEditorWindow();
  const os = usePlatform((s) => s.os);
  const ownTitleBar = usePlatform((s) => s.overlayTitleBar || s.framelessTitleBar);
  return (
    <main className={clsx(styles.comparisonWindow, os === "linux" && styles.comparisonWindowEdge)}>
      {ownTitleBar && <TitleBar minimal dialog title={title} />}
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : !path ? (
        <div className={styles.comparisonWindowLoading} role="status">
          <Spinner />
          <T>Loading…</T>
        </div>
      ) : (
        <div className={styles.comparisonWindowBody}>
          <EditorArea />
        </div>
      )}
      <OverlayHost />
      <WindowResizeHandles />
    </main>
  );
}
