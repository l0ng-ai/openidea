/**
 * Shell services and built-in contributions. Call before `activateFeatures()`
 * so features can rely on the tool window and notification services.
 */
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import {
  provideNotificationService,
  provideToolWindowService,
  registerOverlay,
  registerStatusItem,
  registerToolWindow,
} from "./contributions";
import { installBrowserGuards } from "./browserGuards";
import { installDistractionFree } from "./distractionFree";
import { installFileDrop } from "./fileDrop";
import { installFocusTracking } from "./focus";
import { clearNotifications, installNotifyEvents, notificationServiceImpl } from "./notificationStore";
import {
  NOTIFICATIONS_TOOL_WINDOW,
  NotificationsHeaderActions,
  NotificationsToolWindow,
  useUnreadNotifications,
} from "./Notifications";
import { loadPlatformInfo } from "@/platform/platformInfo";
import { registerShellActions } from "./shellActions";
import { MainToolbarDialogHost } from "./MainToolbarDialog";
import { StatusInfo, TaskStatus } from "./StatusBar";
import { installTaskEvents } from "./tasks";
import { installToolWindowActions } from "./toolwindows/actions";
import {
  installToolWindowLayoutSync,
  loadToolWindowLayout,
  setFocusedToolWindow,
  toolWindowServiceImpl,
} from "./toolwindows/store";

export function activateWorkbench(): () => void {
  provideToolWindowService(toolWindowServiceImpl);
  provideNotificationService(notificationServiceImpl);
  void loadPlatformInfo();

  // Synchronous so the frame's first render after opening already has the project's layout.
  const onProject = (root: string | null) => {
    setContext("projectOpen", root !== null);
    setContext("workspaceOpen", !!useProject.getState().project?.workspace);
    setContext("lightEdit", useProject.getState().lightEdit);
    if (root !== null) loadToolWindowLayout(root);
  };
  onProject(useProject.getState().project?.root ?? null);
  const unsubProject = useProject.subscribe((s, prev) => {
    if (s.project?.root === prev.project?.root && s.lightEdit === prev.lightEdit) return;
    // The previous project's notifications (and their actions) no longer apply.
    if (prev.project) clearNotifications();
    onProject(s.project?.root ?? null);
  });

  const disposers = [
    unsubProject,
    registerShellActions(),
    installToolWindowActions(),
    installToolWindowLayoutSync(),
    installDistractionFree(),
    installFocusTracking(setFocusedToolWindow),
    installTaskEvents(),
    installNotifyEvents(),
    installBrowserGuards(),
    installFileDrop(),
    registerOverlay({ id: "workbench.customizeToolbar", component: MainToolbarDialogHost }),
    registerStatusItem({ id: "workbench.tasks", align: "right", priority: 0, component: TaskStatus, lightEdit: true }),
    registerStatusItem({ id: "workbench.info", align: "left", priority: 5, component: StatusInfo, lightEdit: true }),
    registerToolWindow({
      id: NOTIFICATIONS_TOOL_WINDOW,
      title: "Notifications",
      icon: "bell",
      anchor: "right",
      order: 0,
      component: NotificationsToolWindow,
      headerActions: NotificationsHeaderActions,
      useBadge: useUnreadNotifications,
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

/** Shell services for a secondary window (Settings): notifications, platform info, browser guards. */
export function activateSecondaryWindow(): () => void {
  provideNotificationService(notificationServiceImpl);
  void loadPlatformInfo();
  return installBrowserGuards();
}
