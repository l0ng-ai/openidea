import { loadPlatformInfo } from "@/platform/platformInfo";
import { provideNotificationService } from "./contributions";
import { installBrowserGuards } from "./browserGuards";
import { notificationServiceImpl } from "./notificationStore";

/** Shell services shared by auxiliary windows, without the workbench's contributions. */
export function activateSecondaryWindow(): () => void {
  provideNotificationService(notificationServiceImpl);
  void loadPlatformInfo();
  return installBrowserGuards();
}
