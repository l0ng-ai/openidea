/**
 * Desktop shell integration: native menu bridge, multi-window, window title,
 * close / quit guards, About, Keymap Reference, logs, update check and i18n wiring.
 */
import { registerOverlay, registerStatusItem } from "@/workbench/contributions";
import { AboutOverlay } from "./AboutDialog";
import { appActions, updateActions } from "./appActions";
import { checkForUpdatesOnStartup } from "./updates";
import { installCloseGuard } from "./closeGuard";
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

/** The UI locale of a secondary (Settings) window. */
export const activateLocale = installLocaleSync;

export function activate(): () => void {
  const disposers = [
    installLocaleSync(),
    registerLocalizedActions(() => [...appActions(), ...windowActions()]),
    registerOverlay({ id: "app.about", component: AboutOverlay }),
    registerOverlay({ id: "app.keymapReference", component: KeymapReferenceOverlay }),
    registerOverlay({ id: "app.invalidateCaches", component: InvalidateCachesOverlay }),
    registerOverlay({ id: "app.newProject", component: NewProjectOverlay }),
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
