/**
 * Windows that show one dialog of their project window (New Project, Get from VCS): they load
 * the parent's project and settings for the dialog's defaults, then hand results back to it.
 */
import { create } from "zustand";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { logError } from "@/platform/errorLog";
import { commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";

/** The parent window's label, set once its project and settings are here. */
export const useDialogWindow = create<{ parent: string | null }>(() => ({ parent: null }));

export function activateDialogWindow(parent: string): void {
  void (async () => {
    try {
      const project = await commands.projectCurrent();
      useProject.setState(
        project ? { project, settings: project.settings } : { project: null, settings: await commands.settingsGet() },
      );
    } catch (e) {
      logError("cannot load the project of a dialog window", e);
    }
    useDialogWindow.setState({ parent });
  })();
}

export const closeDialogWindow = () => void getCurrentWebviewWindow().close();
