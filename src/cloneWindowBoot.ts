import type { ComponentType } from "react";
import { installLocaleSync } from "./features/app/locale";
import { githubCloneSource } from "./features/github/clone/source";
import { trackRuntimeSettings } from "./features/settings/runtime";
import { activateCloneLaunches, CloneWindow } from "./features/vcs/cloneWindow";
import { registerCloneSource } from "./workbench/contributions";
import { activateDialogWindow } from "./workbench/dialogWindow";
import { activateList } from "./windowBoot";

/** Get from VCS window of project window `parent`: the clone dialog and its sources, no workbench. */
export function bootCloneWindow(parent: string): ComponentType {
  activateList("clone window", [
    ["locale", installLocaleSync],
    ["settings", trackRuntimeSettings],
    ["github", () => registerCloneSource(githubCloneSource)],
    ["dialog", () => activateDialogWindow(parent)],
    ["launch", activateCloneLaunches],
  ]);
  return CloneWindow;
}
