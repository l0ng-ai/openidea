import type { ComponentType } from "react";
import { installLocaleSync } from "./features/app/locale";
import { ConnectWindow } from "./features/remote-dev/connectWindow";
import { trackRuntimeSettings } from "./features/settings/runtime";
import { activateDialogWindow } from "./workbench/dialogWindow";
import { activateList } from "./windowBoot";

/** Remote Development window of project window `parent`: the connect dialog only, no workbench. */
export function bootConnectWindow(parent: string): ComponentType {
  activateList("remote development window", [
    ["locale", installLocaleSync],
    ["settings", trackRuntimeSettings],
    ["dialog", () => activateDialogWindow(parent)],
  ]);
  return ConnectWindow;
}
