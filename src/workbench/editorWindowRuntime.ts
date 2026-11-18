import { loadPlatformInfo } from "@/platform/platformInfo";
import { provideNotificationService, provideToolWindowService } from "./contributions";
import { notificationServiceImpl } from "./notificationStore";
import { toolWindowServiceImpl, setFocusedToolWindow, useToolWindowLayout, SLOTS } from "./toolwindows/store";
import { installToolWindowActions } from "./toolwindows/actions";
import { registerShellActions } from "./shellActions";
import { installFocusTracking } from "./focus";
import { installBrowserGuards } from "./browserGuards";

export function activateEditorWindowShell(): () => void {
  const visible = { ...useToolWindowLayout.getState().visible };
  for (const slot of SLOTS) visible[slot] = null;
  useToolWindowLayout.setState({ visible, mounted: new Set() });
  provideNotificationService(notificationServiceImpl);
  provideToolWindowService(toolWindowServiceImpl);
  void loadPlatformInfo();
  const stops = [
    installBrowserGuards(),
    installFocusTracking(setFocusedToolWindow),
    installToolWindowActions(),
    registerShellActions({ projectActions: false }),
  ];
  return () => stops.reverse().forEach((stop) => stop());
}
