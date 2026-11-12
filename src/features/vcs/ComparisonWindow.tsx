/**
 * The comparison window (`comparison-<parent>-<n>`): files that differ between two revisions of
 * its parent's project, and their diff, in a window of its own (IDEA's Changes Between dialog).
 */
import clsx from "clsx";
import { useEffect } from "react";
import { create } from "zustand";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { editorController } from "@/editor/core/controller";
import { AUX_CLOSED, type AuxCloseResult } from "@/platform/auxWindow";
import { setContext } from "@/platform/context";
import { isImeKey } from "@/platform/ime";
import { call, commands, type ComparisonLaunch } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { restoreRemote } from "@/platform/remote";
import { usePlatform } from "@/platform/platformInfo";
import { Button, Spinner, T, isPopupOpen } from "@/ui";
import { editorService, notifications } from "@/workbench/contributions";
import { EditorArea } from "@/workbench/EditorArea";
import { OverlayHost } from "@/workbench/OverlayHost";
import { TitleBar } from "@/workbench/TitleBar";
import { useApplyTheme } from "@/workbench/theme";
import { diffInput, type DiffData } from "./diffInput";
import { ChangesBetweenDialog } from "./operations";
import { refreshNow, useVcs } from "./store";
import styles from "./common.module.css";

const useComparison = create<{
  launch: ComparisonLaunch | null;
  title: string;
  full: boolean;
  error: string | null;
}>(() => ({ launch: null, title: "", full: false, error: null }));

/**
 * Loads the comparison of this window's launch. `confirmLeave` settles unsaved changes of the
 * documents edited here, in the named project, before the window closes.
 */
export function activateComparisonWindow(
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
              commands.docClose(model.doc).catch((error) => console.warn("cannot release comparison document", error)),
            ),
          );
        }
      } catch (error) {
        notifications().notify({ level: "error", title: "Could not close comparison", body: String(error) });
      } finally {
        if (!closed) event.preventDefault();
        const result: AuxCloseResult = {
          label: native.label,
          closed,
          documents: closed ? models.map((model) => model.doc) : [],
        };
        await emitTo(parent, AUX_CLOSED, result).catch((error) =>
          console.warn("cannot report comparison close", error),
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
    await restoreRemote();
    const launch = (await commands.windowTakeLaunch())?.comparison;
    if (!launch) throw new Error("Missing comparison request");
    const project = await commands.projectCurrent();
    if (!project) throw new Error("The comparison's project is no longer open");
    projectName = project.name;
    // Settings only: restoring the project's editor session here would overwrite the main window's tabs.
    useProject.setState({ settings: project.settings });
    const roots = await call(commands.vcsRoots());
    useVcs.setState({
      available: roots.length > 0,
      root: project.root,
      roots: roots.map((root) => root.root),
      repo: launch.repo,
    });
    setContext("projectOpen", true);
    setContext("vcsAvailable", roots.length > 0);
    await refreshNow();
    useComparison.setState({ launch });
  })().catch((error) => useComparison.setState({ error: String(error) }));
  return () => {
    disposed = true;
    stopClose?.();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keydown", onCloseShortcut, true);
  };
}

/** The comparison's caption, on the title bar and the native window (Window menu, task switcher). */
function showCaption(caption: string) {
  if (useComparison.getState().title === caption) return;
  useComparison.setState({ title: caption });
  void getCurrentWindow()
    .setTitle(caption)
    .catch(() => {});
}

export function ComparisonWindow() {
  useApplyTheme();
  const { launch, title, full, error } = useComparison();
  // macOS overlays traffic lights on the bar; Windows and Linux are frameless, like Settings.
  const os = usePlatform((s) => s.os);
  const ownTitleBar = usePlatform((s) => s.overlayTitleBar || s.framelessTitleBar);
  const showDiff = (data: DiffData) => {
    void editorService()
      .openInput(diffInput(data), { focus: true })
      .then(() => useComparison.setState({ full: true }))
      .catch((error) => notifications().notify({ level: "error", title: "Could not show diff", body: String(error) }));
  };
  useEffect(() => {
    if (full) editorService().focus?.();
  }, [full]);
  return (
    <main className={clsx(styles.comparisonWindow, os === "linux" && styles.comparisonWindowEdge)}>
      {ownTitleBar && <TitleBar minimal dialog title={title} />}
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : !launch ? (
        <div className={styles.comparisonWindowLoading} role="status">
          <Spinner />
          <T>Loading…</T>
        </div>
      ) : (
        <>
          {full && (
            <div className={styles.compareToolbar}>
              <Button onClick={() => useComparison.setState({ full: false })}>Back to Changed Files</Button>
            </div>
          )}
          <div className={styles.comparisonWindowBody} hidden={full}>
            <ChangesBetweenDialog
              from={launch.from}
              to={launch.to}
              scope={launch.scope ?? undefined}
              native
              onCaption={showCaption}
              onShowDiff={showDiff}
              onClose={() => void getCurrentWindow().close()}
            />
          </div>
          <div className={styles.comparisonWindowBody} hidden={!full}>
            <EditorArea />
          </div>
        </>
      )}
      <OverlayHost />
    </main>
  );
}
