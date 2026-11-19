import type { ComponentType } from "react";
import { installLocaleSync } from "./features/app/locale";
import { activateDeploymentWindow, DeploymentWindow } from "./features/deployment/window";
import { trackRuntimeSettings } from "./features/settings/runtime";
import { activateDiffViewer } from "./features/vcs/diffViewer";
import { activateList } from "./windowBoot";

/**
 * Sync with Deployed window of project window `parent`: local files next to
 * their copies on a deployment server, with the diff viewer but no workbench.
 */
export function bootDeploymentWindow(parent: string): ComponentType {
  activateList("deployment window", [
    ["locale", installLocaleSync],
    ["settings", trackRuntimeSettings],
    ["diff", activateDiffViewer],
    ["deployment", () => activateDeploymentWindow(parent)],
  ]);
  return DeploymentWindow;
}
