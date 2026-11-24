import type { ComponentType } from "react";
import { installLocaleSync } from "./features/app/locale";
import { installMenuBridge } from "./features/app/menuBridge";
import { trackRuntimeSettings } from "./features/settings/runtime";
import { activate as vcs } from "./features/vcs";
import { activateDiffWindow, DiffWindow } from "./features/vcs/DiffWindow";
import { installKeyboardDispatcher } from "./platform/keymap";
import { activateList } from "./windowBoot";

/**
 * Diff window of project window `parent`: one file's diff, with Git and its own
 * documents but no workbench.
 */
export function bootDiffWindow(parent: string): ComponentType {
  activateList("diff window", [
    ["locale", installLocaleSync],
    ["settings", trackRuntimeSettings],
    ["menu", installMenuBridge],
    ["vcs", vcs],
    ["diff", () => activateDiffWindow(parent)],
  ]);
  installKeyboardDispatcher();
  return DiffWindow;
}
