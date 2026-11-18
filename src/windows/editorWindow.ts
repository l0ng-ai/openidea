import { flushSync } from "react-dom";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { activate as activateEditor } from "@/editor/core";
import { editorController, tabTitle } from "@/editor/core/controller";
import { setLibraryRoots, whenAllSynced } from "@/editor/api";
import { AUX_CLOSED, auxiliaryWindow, type AuxCloseResult } from "@/platform/auxWindow";
import { setContext } from "@/platform/context";
import {
  decodeEditorTransfer,
  updateEditorHandoff,
  waitForEditorHandoff,
  withEditorTransfersHeld,
} from "@/platform/editorTransfer";
import { call, commands } from "@/platform/ipc";
import { t, tx } from "@/platform/i18n";
import { installKeyboardDispatcher } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { subscribeProjectResource } from "@/platform/projectResources";
import { installProjectWindowActions } from "@/platform/projectWindowActions";
import { isUntitledUri } from "@/platform/virtualDocs";
import { useContributions, notifications } from "@/workbench/contributions";
import { activateEditorWindowShell } from "@/workbench/editorWindowRuntime";
import { useEditorFrame } from "@/workbench/EditorWindow";
import { ask } from "@/workbench/messages";
import { installLocaleSync } from "@/features/app/locale";
import { installMenuBridge } from "@/features/app/menuBridge";
import { trackRuntimeSettings } from "@/features/settings/runtime";
import { createEditorRuntime } from "./editorRuntime";

export async function startEditorWindow(parent: string): Promise<() => void> {
  const native = getCurrentWindow();
  if (auxiliaryWindow()?.parent !== parent) throw new Error(tx("Missing editor transfer"));
  const ctrl = editorController();
  const runtime = createEditorRuntime();
  const stops: Array<() => void> = [
    activateEditorWindowShell(),
    installLocaleSync(),
    trackRuntimeSettings(),
    installMenuBridge(),
    installProjectWindowActions(parent),
    runtime.dispose,
  ];
  const startup = new AbortController();
  let phase: "preparing" | "ready" | "committed" | "aborted" = "preparing";
  let disposed = false;
  let closing = false;
  let opened = false;
  let transferId = "";
  let roots = () => {};
  const keep = (stop: () => void) => (disposed ? stop() : stops.push(stop));
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    startup.abort();
    stops
      .splice(0)
      .reverse()
      .forEach((stop) => stop());
  };
  const activateInput = () => {
    if (phase === "committed") return;
    phase = "committed";
    flushSync(() => useEditorFrame.setState({ committed: true }));
    ctrl.focus();
  };
  stops.push(() => roots());
  const closeWindow = async () => {
    if (closing || disposed) return;
    closing = true;
    useEditorFrame.setState({ closing: true });
    const documents = [...ctrl.manager.byId.keys()];
    let closed = false;
    try {
      if (phase !== "committed" && transferId) {
        const state = await updateEditorHandoff(transferId, "cancel");
        if (state === "committed")
          await waitForEditorHandoff(transferId, "finished").catch((error) => {
            activateInput();
            throw error;
          });
        if (state === "committed" || state === "finished") activateInput();
      }
      if (phase !== "committed") {
        phase = "aborted";
        startup.abort();
        await ctrl.abortTransfer();
      } else {
        await whenAllSynced();
        const session = await ctrl.prepareClose();
        const dirty = [...ctrl.manager.byId.values()].filter((model) => model.getMeta().dirty).length + session.dirty;
        let saved = false;
        if (dirty && !ctrl.autoSave()) {
          const choice = await ask({
            title: t("app.unsaved.title"),
            body: t("app.unsaved.body", { count: dirty, project: useEditorFrame.getState().title }),
            buttons: [
              { id: "discard", label: t("app.unsaved.discard") },
              { id: "save", label: t("app.unsaved.save"), primary: true },
            ],
            icon: "warning",
          });
          if (choice.button === "save") {
            await ctrl.saveLocalDocuments();
            saved = true;
          } else if (choice.button === "discard") await session.discard();
          else {
            session.cancel();
            return;
          }
        } else if (dirty) {
          await ctrl.saveLocalDocuments();
          saved = true;
        }
        const untitledDirty = [...ctrl.manager.byId.values()].some(
          (model) => isUntitledUri(model.path) && model.getMeta().dirty,
        );
        if (saved && untitledDirty) {
          session.cancel();
          return;
        }
        session.commit();
        await ctrl.finishWindowClose();
      }
      await ctrl.manager.whenReleased();
      closed = true;
    } catch (error) {
      ctrl.cancelClose();
      notifications().notify({ level: "error", title: t("app.unsaved.saveFailed"), body: String(error) });
    } finally {
      await emitTo(parent, AUX_CLOSED, { label: native.label, closed, documents } satisfies AuxCloseResult).catch(
        () => {},
      );
      if (!closed) {
        closing = false;
        useEditorFrame.setState({ closing: false });
      }
    }
    if (closed) {
      dispose();
      await native.destroy();
    }
  };
  stops.push(
    await native.onCloseRequested(async (event) => {
      event.preventDefault();
      if (closing || disposed) return;
      await withEditorTransfersHeld(closeWindow);
    }),
  );
  try {
    const launch = (await commands.windowTakeLaunch())?.editor;
    if (!launch) throw new Error(tx("Missing editor transfer"));
    const transfer = decodeEditorTransfer(launch.payload);
    transferId = launch.id;
    if (transfer.id !== launch.id || transfer.source !== launch.source) throw new Error(tx("Missing editor transfer"));
    try {
      const project = await commands.projectCurrent();
      startup.signal.throwIfAborted();
      if ((project?.root ?? null) !== transfer.project)
        throw new Error(tx("The project for this editor is no longer open"));
      const settings = project?.settings ?? (await commands.settingsGet());
      startup.signal.throwIfAborted();
      useProject.setState({
        project,
        settings,
        lightEdit: !project,
      });
      setContext("projectOpen", !!project);
      setContext("projectLocal", !!project);
      roots = setLibraryRoots("project-window", transfer.libraries);
      keep(
        subscribeProjectResource<string[]>("librarySources", null, (paths) => {
          roots();
          roots = setLibraryRoots("project-window", paths);
        }),
      );
      const editorStop = activateEditor({ persistSession: false });
      if (editorStop) keep(editorStop);
      await runtime.prepare(transfer.tab.input);
      startup.signal.throwIfAborted();
      keep(installKeyboardDispatcher());
      const closeEmpty = () => {
        if (opened && !ctrl.openTabs().length && !closing && !ctrl.transferring) void native.close();
      };
      window.addEventListener("openidea:editor-transferred", closeEmpty);
      keep(() => window.removeEventListener("openidea:editor-transferred", closeEmpty));
      keep(
        ctrl.onActiveInputChange((input) => {
          if (!input) {
            closeEmpty();
            return;
          }
          const name = useProject.getState().project?.name;
          const title = [name, tabTitle(input, useContributions.getState().editorKinds)].filter(Boolean).join(" - ");
          useEditorFrame.setState({ title });
          void native.setTitle(title);
        }),
      );
      await ctrl.adoptTransfer(transfer, startup.signal);
      startup.signal.throwIfAborted();
      opened = true;
      phase = "ready";
      flushSync(() => useEditorFrame.setState({ ready: true }));
      window.dispatchEvent(new Event("openidea:boot-ready"));
      const state = await updateEditorHandoff(transferId, "ready", startup.signal);
      if (state !== "ready" && state !== "committed" && state !== "finished")
        throw new Error(tx("The editor window did not respond"));
    } finally {
      if (!disposed) {
        await call(commands.windowCompleteLaunch()).catch(() => {});
      }
    }
    await waitForEditorHandoff(transferId, "finished", startup.signal);
    if (!closing && !disposed) activateInput();
  } catch (error) {
    if (!disposed && !startup.signal.aborted) {
      const state = transferId
        ? await updateEditorHandoff(transferId, "status", startup.signal).catch(() => null)
        : null;
      if (!disposed && !closing) {
        if (state === "committed" || state === "finished") activateInput();
        else {
          useEditorFrame.setState({ error: String(error) });
          await closeWindow();
        }
      }
    }
  }
  return dispose;
}
