import type { ComponentType } from "react";
import { activate as editor } from "./editor/core";
import { activate as agents } from "./features/agents";
import { activateEditorWindow, EditorWindow } from "./editor/core/EditorWindow";
import { installLocaleSync } from "./features/app/locale";
import { installMenuBridge } from "./features/app/menuBridge";
import { trackRuntimeSettings } from "./features/settings/runtime";
import { installKeyboardDispatcher } from "./platform/keymap";
import { activateList } from "./windowBoot";

/**
 * Lightweight editor window of project window `parent`: one file or agent conversation, sharing
 * the parent's documents, language servers and agents, with no workbench chrome.
 */
export function bootEditorWindow(parent: string): ComponentType {
  activateList("editor window", [
    ["locale", installLocaleSync],
    ["settings", trackRuntimeSettings],
    ["menu", installMenuBridge],
    ["editor", editor],
    ["agents", agents],
    ["editorWindow", () => activateEditorWindow(parent)],
  ]);
  installKeyboardDispatcher();
  return EditorWindow;
}
