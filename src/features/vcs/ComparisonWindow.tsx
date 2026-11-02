import { useEffect } from "react";
import { create } from "zustand";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { activate as activateEditor } from "@/editor/core";
import { editorController } from "@/editor/core/controller";
import { activateLocale } from "@/features/app";
import { confirmLeave } from "@/features/app/closeGuard";
import { installMenuBridge } from "@/features/app/menuBridge";
import { trackRuntimeSettings } from "@/features/settings/runtime";
import { COMPARISON_CLOSED } from "@/platform/comparisonWindow";
import { setContext } from "@/platform/context";
import { isImeKey } from "@/platform/ime";
import { call, commands, type ComparisonLaunch } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { restoreRemote } from "@/platform/remote";
import { Button, Spinner, isPopupOpen } from "@/ui";
import { editorService, notifications } from "@/workbench/contributions";
import { EditorArea } from "@/workbench/EditorArea";
import { OverlayHost } from "@/workbench/OverlayHost";
import { useApplyTheme } from "@/workbench/theme";
import { activate as activateVcs } from "./index";
import { diffInput, type DiffData } from "./diffInput";
import { ChangesBetweenDialog } from "./operations";
import { refreshNow, useVcs } from "./store";
import styles from "./common.module.css";

const useComparison = create<{ launch: ComparisonLaunch | null; full: boolean; error: string | null }>(() => ({
  launch: null,
  full: false,
  error: null,
}));

export function activateComparisonWindow(parent: string): () => void {
  const native = getCurrentWindow();
  const disposers = [
    activateLocale(),
    activateEditor() ?? (() => {}),
    activateVcs(),
    trackRuntimeSettings(),
    installMenuBridge(),
  ];
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
        closed = await confirmLeave();
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
        await emitTo(parent, COMPARISON_CLOSED, {
          label: native.label,
          closed,
          documents: closed ? models.map((model) => model.doc) : [],
        }).catch((error) => console.warn("cannot report comparison close", error));
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
    disposers.reverse().forEach((dispose) => dispose());
  };
}

export function ComparisonWindow() {
  useApplyTheme();
  const { launch, full, error } = useComparison();
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
    <main className={styles.comparisonWindow}>
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : !launch ? (
        <Spinner />
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
