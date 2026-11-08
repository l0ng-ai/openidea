/**
 * Desktop shell integration: native menu bridge, multi-window, window title,
 * close / quit guards, About, Keymap Reference, logs, update check and i18n wiring.
 */
import { registerOverlay, registerStatusItem } from "@/workbench/contributions";
import { AboutOverlay } from "./AboutDialog";
import { appActions, updateActions } from "./appActions";
import { checkForUpdatesOnStartup } from "./updates";
import { cliActions } from "./cliCommand";
import { installCloseGuard } from "./closeGuard";
import { TerminationOverlay } from "./termination";
import { InvalidateCachesOverlay, registerInvalidateCachesActions } from "./InvalidateCaches";
import { buildInfo } from "./host";
import { KeymapReferenceOverlay } from "./KeymapReference";
import { LightEditStatus } from "./LightEditStatus";
import { installLocaleSync, registerLocalizedActions } from "./locale";
import { installMenuBridge } from "./menuBridge";
import { NewProjectOverlay } from "./NewProject";
import { projectActions, registerPowerSaveBanner } from "./projectActions";
import { installWindowTitle } from "./title";
import { installLaunchHandling, installLightEditAutoClose, windowActions } from "./windows";
import { WorkspaceDialogHost } from "./WorkspaceDialog";
import { installWindowGroups } from "@/platform/windowGroups";

/** The UI locale of a secondary (Settings, comparison) window. */
export const activateLocale = installLocaleSync;
/** Native menu items of a secondary window that runs actions itself (comparison). */
export const activateMenuBridge = installMenuBridge;
export { confirmLeave } from "./closeGuard";

export function activate(): () => void {
  const disposers = [
    installLocaleSync(),
    registerLocalizedActions(() => [...appActions(), ...windowActions()]),
    registerLocalizedActions(cliActions),
    registerOverlay({ id: "app.about", component: AboutOverlay }),
    registerOverlay({ id: "app.keymapReference", component: KeymapReferenceOverlay }),
    registerOverlay({ id: "app.invalidateCaches", component: InvalidateCachesOverlay }),
    registerOverlay({ id: "app.newProject", component: NewProjectOverlay }),
    registerOverlay({ id: "app.termination", component: TerminationOverlay }),
    registerStatusItem({
      id: "app.lightEdit",
      align: "left",
      priority: 20,
      component: LightEditStatus,
      lightEdit: true,
    }),
    registerLocalizedActions(projectActions),
    registerPowerSaveBanner(),
    registerInvalidateCachesActions(),
    installMenuBridge(),
    installWindowTitle(),
    installCloseGuard(),
    installLaunchHandling(),
    installWindowGroups(),
    registerOverlay({ id: "app.workspace", component: WorkspaceDialogHost }),
    installLightEditAutoClose(),
  ];
  let disposed = false;
  void buildInfo().then((b) => {
    if (!b?.updates || disposed) return;
    disposers.push(registerLocalizedActions(updateActions));
    void checkForUpdatesOnStartup();
  });
  return () => {
    disposed = true;
    disposers.reverse().forEach((d) => d());
  };
}
