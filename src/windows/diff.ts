import { installLocaleSync } from "@/features/app/locale";
import { installMenuBridge } from "@/features/app/menuBridge";
import { trackRuntimeSettings } from "@/features/settings/runtime";
import { activateEditorRuntime } from "@/features/vcs";
import { activateDiffWindow, DiffWindow } from "@/features/vcs/DiffWindow";
import { diffInput } from "@/features/vcs/diffInput";
import { activateAll } from "@/platform/activation";
import { installKeyboardDispatcher } from "@/platform/keymap";
import { installProjectWindowActions } from "@/platform/projectWindowActions";
import { activateSecondaryWindow } from "@/workbench/activateSecondary";

export { DiffWindow as Window };

/** The diff viewer and Git services, without loading the project workbench. */
export function activate(parent: string): () => void {
  return activateAll("diff window", [
    ["shell", activateSecondaryWindow],
    ["locale", installLocaleSync],
    ["settings", trackRuntimeSettings],
    ["menu", installMenuBridge],
    ["project actions", () => installProjectWindowActions(parent)],
    [
      "diff",
      () =>
        activateDiffWindow(parent, async (data) => {
          const stop = await activateEditorRuntime(diffInput(data));
          const stopKeyboard = installKeyboardDispatcher();
          return () => {
            stopKeyboard();
            stop();
          };
        }),
    ],
  ]);
}
