/**
 * The Sync with Deployed window (`deployment-<parent>`): one per project window, sharing that
 * project's documents.
 */
import { useSyncExternalStore } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { activateEmbeddedDocuments } from "@/editor/core/embeddedDocuments";
import { AUX_CLOSED, type AuxCloseResult } from "@/platform/auxWindow";
import { commands, type SyncStep } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { isImeKey } from "@/platform/ime";
import { useApplyTheme } from "@/workbench/theme";
import { OverlayHost } from "@/workbench/OverlayHost";
import { TitleBar } from "@/workbench/TitleBar";
import { usePlatform } from "@/platform/platformInfo";
import { WindowResizeHandles } from "@/workbench/WindowResizeHandles";
import { provideEditorService } from "@/workbench/contributions";
import { ask, showError } from "@/workbench/messages";
import { Spinner, T, isPopupOpen } from "@/ui";
import { closeSync, openSync } from "./actions";
import { SecretDialog } from "./Dialogs";
import { SyncDialog } from "./SyncDialog";
import { patchSync, useDeployment } from "./store";
import styles from "./Deployment.module.css";
import { openDeploymentSource } from "./windowBridge";

const LAUNCH_EVENT = "openidea://launch";

let startupError: string | null = null;
const startupListeners = new Set<() => void>();
let saveSyncDocuments: ((steps: SyncStep[]) => Promise<void>) | undefined;
const subscribeStartup = (listener: () => void) => {
  startupListeners.add(listener);
  return () => {
    startupListeners.delete(listener);
  };
};
function fail(error: unknown) {
  if (useDeployment.getState().sync) {
    patchSync({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  startupError = error instanceof Error ? error.message : String(error);
  startupListeners.forEach((listener) => listener());
}

export function activateDeploymentWindow(parent: string): () => void {
  const native = getCurrentWebviewWindow();
  const documents = activateEmbeddedDocuments();
  provideEditorService({
    openFile: (path, options) => openDeploymentSource(parent, path, options),
    openInput: (input, options) => (input.path ? openDeploymentSource(parent, input.path, options) : Promise.resolve()),
    activePath: () => null,
    activeCursor: () => null,
    saveAll: documents.save,
  });
  saveSyncDocuments = (steps) => {
    const root = useProject.getState().project?.root;
    return root
      ? documents.savePaths(steps.map((step) => `${root.replace(/\/$/, "")}/${step.path}`))
      : Promise.resolve();
  };
  let disposed = false;
  let closing = false;
  let queue = Promise.resolve();
  const disposers: Array<() => void> = [];
  // Tells the project window this window stays open, so it stops closing (see `closeDocumentWindows`).
  const stayOpen = () => {
    const result: AuxCloseResult = { label: native.label, closed: false, documents: [] };
    void emitTo(parent, AUX_CLOSED, result).catch(() => {});
  };
  const listen = (ready: Promise<() => void>) => void ready.then((off) => (disposed ? off() : disposers.push(off)));
  const launch = () => {
    queue = queue
      .then(async () => {
        if (disposed || closing) return;
        const pending = await commands.windowTakeLaunch();
        if (!pending?.deployment) return;
        if (useDeployment.getState().sync?.running) {
          await showError(
            "Deployment comparison",
            "Wait for synchronization to finish before opening another comparison.",
          );
          return;
        }
        const project = await commands.projectCurrent();
        if (!project) throw new Error("The project is no longer open.");
        useProject.setState({ project, settings: project.settings });
        const server = workflowSettings().deployment.servers.find((item) => item.id === pending.deployment!.server);
        if (!server) throw new Error("The deployment server is no longer available.");
        await native.setTitle(`Diff Between 'local files' and 'files on ${server.name || server.id}'`);
        await openSync(server, pending.deployment.paths);
        if (!useDeployment.getState().sync && !closing)
          throw new Error("No selected files are mapped to this deployment server.");
      })
      .catch(fail);
  };
  listen(
    native.listen(LAUNCH_EVENT, launch).then((off) => {
      launch();
      return off;
    }),
  );
  listen(
    native.onCloseRequested(async (event) => {
      event.preventDefault();
      if (closing) return;
      closing = true;
      try {
        if (documents.dirty() && useProject.getState().settings?.files?.autoSave === false) {
          const answer = await ask({
            title: "Save local changes?",
            body: "Save the local files edited in this comparison before closing.",
            buttons: [{ id: "save", label: "Save and Close", primary: true }],
          });
          if (answer.button !== "save") return stayOpen();
        }
        await documents.save();
        closeSync();
        useDeployment.getState().secret?.resolve(null);
        await documents.dispose();
        await native.destroy();
      } catch (error) {
        stayOpen();
        await showError("Cannot close deployment comparison", error instanceof Error ? error.message : String(error));
      } finally {
        closing = false;
      }
    }),
  );
  disposers.push(
    useDeployment.subscribe((s, prev) => {
      if (prev.sync && !s.sync && !closing) void native.close();
    }),
  );
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isImeKey(event)) return;
    if (
      (event.key === "Escape" && !isPopupOpen()) ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w")
    ) {
      event.preventDefault();
      void native.close();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void documents.save().catch(fail);
    }
  };
  window.addEventListener("keydown", onKey);
  disposers.push(() => window.removeEventListener("keydown", onKey));
  return () => {
    disposed = true;
    saveSyncDocuments = undefined;
    disposers.reverse().forEach((off) => off());
  };
}

export function DeploymentWindow() {
  useApplyTheme();
  const sync = useDeployment((s) => s.sync);
  const error = useSyncExternalStore(subscribeStartup, () => startupError);
  const ownTitleBar = usePlatform((s) => s.overlayTitleBar || s.framelessTitleBar);
  return (
    <>
      {sync ? (
        <SyncDialog standalone beforeSynchronize={(steps) => saveSyncDocuments?.(steps) ?? Promise.resolve()} />
      ) : (
        <div className={styles.nativeWindow}>
          {ownTitleBar && <TitleBar minimal title="Deployment Comparison" />}
          <div className={styles.center} role={error ? "alert" : "status"}>
            {error || (
              <>
                <Spinner />
                <T>Opening deployment comparison…</T>
              </>
            )}
          </div>
        </div>
      )}
      <SecretDialog />
      <OverlayHost />
      <WindowResizeHandles />
    </>
  );
}
