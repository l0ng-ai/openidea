import type { ComponentType } from "react";
import { installLocaleSync } from "./features/app/locale";
import { NewProjectWindow } from "./features/app/newProjectWindow";
import { trackRuntimeSettings } from "./features/settings/runtime";
import { activateDialogWindow } from "./workbench/dialogWindow";
import { activateList } from "./windowBoot";

/** New Project window of project window `parent`: the wizard only, no workbench. */
export function bootNewProjectWindow(parent: string): ComponentType {
  activateList("new project window", [
    ["locale", installLocaleSync],
    ["settings", trackRuntimeSettings],
    ["dialog", () => activateDialogWindow(parent)],
  ]);
  return NewProjectWindow;
}
