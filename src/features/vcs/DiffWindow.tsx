/**
 * The diff window (`diff-<parent>-<n>`): one file's diff in a window of its own (IDEA's
 * "Show Diff in New Window"), beside its project window.
 */
import clsx from "clsx";
import { create } from "zustand";
import { flushSync } from "react-dom";
import { registerAction } from "@/platform/actions";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { activateEmbeddedDocuments } from "@/editor/core/embeddedDocuments";
import { tx } from "@/platform/i18n";
import { AUX_CLOSED, type AuxCloseResult } from "@/platform/auxWindow";
import { setContext } from "@/platform/context";
import { isImeKey } from "@/platform/ime";
import { call, commands, isTauri, type DiffLaunch } from "@/platform/ipc";
import { projectFolder, useProject } from "@/platform/project";
import { installDiffWindowSave } from "./diffWindowSave";
import { restoreRemote } from "@/platform/remote";
import { usePlatform } from "@/platform/platformInfo";
import { Spinner, T, isPopupOpen } from "@/ui";
import { ask, showError } from "@/workbench/messages";
import { editorService, notifications, provideEditorService, type OpenOptions } from "@/workbench/contributions";
import { OverlayHost } from "@/workbench/OverlayHost";
import { TitleBar } from "@/workbench/TitleBar";
import { WindowResizeHandles } from "@/workbench/WindowResizeHandles";
import { useApplyTheme, windowBackgroundHex } from "@/workbench/theme";
import { DiffEditor } from "./DiffEditor";
import { DIFF_KIND, diffInput, diffTitle, type DiffData, type DiffSide } from "./diffInput";
import { refreshNow, useVcs } from "./store";
import styles from "./common.module.css";

/** Opens `path` in the project window's editor (DiffEditor's "Jump to Source"). */
const OPEN_SOURCE = "openidea://diff/open-source";

const useDiff = create<{
  data: DiffData | null;
  project: string;
  title: string;
  error: string | null;
  closing: boolean;
}>(() => ({ data: null, project: "", title: "", error: null, closing: false }));

/** The launch's diff as the diff viewer's input data. */
function toDiffData(launch: DiffLaunch): DiffData {
  return {
    path: launch.path,
    left: launch.left as DiffSide,
    right: launch.right as DiffSide,
    line: launch.line ?? undefined,
  };
}

/** The project, file and revisions shown in the native caption. */
function diffCaption(data: DiffData): string {
  const project = useDiff.getState().project;
  const file = diffTitle(data);
  return tx`${project} - Diff: ${file}`;
}

function showCaption(caption: string) {
  if (useDiff.getState().title === caption) return;
  useDiff.setState({ title: caption });
  void getCurrentWindow()
    .setTitle(caption)
    .catch(() => {});
}

/** Hands `path` to the project window's editor, which owns the project's documents and tabs. */
function openSource(parent: string, path: string, options?: OpenOptions) {
  return emitTo(parent, OPEN_SOURCE, { path, options });
}

/** Loads the diff of this window's launch and hands its editor commands to the project window. */
export function activateDiffWindow(parent: string): () => void {
  const native = getCurrentWindow();
  const documents = activateEmbeddedDocuments();
  provideEditorService({
    openFile: (path, options) => openSource(parent, path, options),
    openInput: (input, options) => {
      // F7 along a diff chain shows the neighbour here; anything else goes to the project window.
      const data = input.kind === DIFF_KIND ? (input.data as DiffData) : null;
      if (!data) return input.path ? openSource(parent, input.path, options) : Promise.resolve();
      useDiff.setState({ data });
      showCaption(diffCaption(data));
      return Promise.resolve();
    },
    activePath: () => null,
    activeCursor: () => null,
    saveAll: documents.save,
  });
  let disposed = false;
  let closing = false;
  let stopClose: (() => void) | undefined;
  let stopSave: (() => void) | undefined;
  const unregisterSave = registerAction({
    id: "file.save",
    title: "Save All",
    category: "File",
    run: async () => {
      try {
        await documents.save();
      } catch (error) {
        showError(tx("Could not save diff"), error instanceof Error ? error.message : String(error));
      }
    },
  });
  const savingReady = installDiffWindowSave(parent, documents.save).then((off) => {
    if (disposed) off();
    else stopSave = off;
  });
  void native
    .onCloseRequested(async (event) => {
      if (closing) {
        event.preventDefault();
        return;
      }
      closing = true;
      // 保存和释放文档期间禁止继续输入；取消关闭后恢复编辑。
      flushSync(() => useDiff.setState({ closing: true }));
      let closed = false;
      try {
        if (documents.dirty() && useProject.getState().settings?.files?.autoSave === false) {
          const answer = await ask({
            title: tx("Save local changes?"),
            body: tx("Save the files edited in this diff before closing."),
            buttons: [{ id: "save", label: tx("Save and Close"), primary: true }],
          });
          if (answer.button !== "save") {
            event.preventDefault();
            return;
          }
        }
        await documents.save();
        await documents.dispose();
        closed = true;
      } catch (error) {
        event.preventDefault();
        notifications().notify({
          level: "error",
          title: tx("Could not close diff"),
          body: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (!closed) useDiff.setState({ closing: false });
        const result: AuxCloseResult = { label: native.label, closed, documents: [] };
        await emitTo(parent, AUX_CLOSED, result).catch((error) =>
          console.warn("cannot report diff window close", error),
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
    await savingReady;
    await restoreRemote();
    const launch = (await commands.windowTakeLaunch())?.diffWindow;
    if (!launch) throw new Error(tx("Missing diff request"));
    const project = await commands.projectCurrent();
    if (!project) throw new Error(tx("The diff’s project is no longer open"));
    // Settings only: restoring the project's editor session here would overwrite the main window's tabs.
    useProject.setState({ settings: project.settings });
    const roots = await call(commands.vcsRoots());
    useVcs.setState({
      available: roots.length > 0,
      root: project.root,
      roots: roots.map((root) => root.root),
    });
    setContext("projectOpen", true);
    setContext("vcsAvailable", roots.length > 0);
    await refreshNow();
    const data = toDiffData(launch);
    useDiff.setState({ project: project.name, data });
    showCaption(diffCaption(data));
  })().catch((error) => useDiff.setState({ error: String(error) }));
  return () => {
    disposed = true;
    stopClose?.();
    stopSave?.();
    unregisterSave();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keydown", onCloseShortcut, true);
  };
}

/** Jump to Source from a diff window opens the file in its project window's editor. */
export function installDiffEditorHost(): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let stop: (() => void) | undefined;
  void getCurrentWindow()
    .listen<{ path: string; options?: OpenOptions }>(OPEN_SOURCE, ({ payload }) => {
      const folder = projectFolder(useProject.getState().project, payload.path);
      if (folder && payload.path.startsWith(`${folder.root}/`)) {
        void editorService()
          .openFile(payload.path, payload.options)
          .then(() => getCurrentWindow().setFocus());
      }
    })
    .then((off) => {
      if (disposed) off();
      else stop = off;
    });
  return () => {
    disposed = true;
    stop?.();
  };
}

/** Opens one diff in a window of this project window (falls back to an editor tab outside Tauri). */
export function showDiffWindow(data: DiffData, fallback: () => void) {
  if (!isTauri()) {
    fallback();
    return;
  }
  const launch: DiffLaunch = {
    path: data.path,
    left: data.left,
    right: data.right,
    line: data.line,
  };
  void call(commands.windowOpenDiff(launch, windowBackgroundHex())).catch((error) =>
    showError(tx("Cannot show diff in a new window"), error instanceof Error ? error.message : String(error)),
  );
}

export function DiffWindow() {
  useApplyTheme();
  const { data, title, error, closing } = useDiff();
  // macOS overlays traffic lights on the bar; Windows and Linux are frameless, like Settings.
  const os = usePlatform((s) => s.os);
  const ownTitleBar = usePlatform((s) => s.overlayTitleBar || s.framelessTitleBar);
  return (
    <main className={clsx(styles.comparisonWindow, os === "linux" && styles.comparisonWindowEdge)}>
      {ownTitleBar && <TitleBar minimal dialog title={title} />}
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : !data ? (
        <div className={styles.comparisonWindowLoading} role="status">
          <Spinner />
          <T>Loading…</T>
        </div>
      ) : (
        <div className={styles.comparisonWindowBody} inert={closing}>
          <DiffEditor input={diffInput(data)} />
        </div>
      )}
      <OverlayHost />
      <WindowResizeHandles />
    </main>
  );
}
