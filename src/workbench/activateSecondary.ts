/**
 * Shell services for a secondary window (Settings, Compare, Diff, Sync with Deployed):
 * notifications, platform info and browser guards, without pulling in workbench UI.
 */
import { loadPlatformInfo } from "@/platform/platformInfo";
import { installBrowserGuards } from "./browserGuards";
import { provideNotificationService } from "./contributions";
import { notificationServiceImpl } from "./notificationStore";

export function activateSecondaryWindow(): () => void {
  provideNotificationService(notificationServiceImpl);
  void loadPlatformInfo();
  return installBrowserGuards();
}
