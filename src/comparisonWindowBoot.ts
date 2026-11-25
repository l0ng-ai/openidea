import type { ComponentType } from "react";
import { activate as editor } from "./editor/core";
import { confirmLeave } from "./features/app/closeGuard";
import { installLocaleSync } from "./features/app/locale";
import { installMenuBridge } from "./features/app/menuBridge";
import { trackRuntimeSettings } from "./features/settings/runtime";
import { activate as vcs } from "./features/vcs";
import { activateComparisonWindow, ComparisonWindow } from "./features/vcs/ComparisonWindow";
import { installKeyboardDispatcher } from "./platform/keymap";
import { activateList } from "./windowBoot";

/**
 * Comparison window of project window `parent`: changed files between two
 * revisions and their diffs, with the editor and Git but no workbench.
 */
export function bootComparisonWindow(parent: string): ComponentType {
  activateList("comparison window", [
    ["locale", installLocaleSync],
    ["settings", trackRuntimeSettings],
    ["menu", installMenuBridge],
    ["editor", editor],
    ["vcs", vcs],
    ["comparison", () => activateComparisonWindow(parent, (project) => confirmLeave(undefined, project))],
  ]);
  installKeyboardDispatcher();
  return ComparisonWindow;
}
