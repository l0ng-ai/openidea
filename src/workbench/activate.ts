/**
 * Shell services and built-in contributions. Call before `activateFeatures()`
 * so features can rely on the tool window and notification services.
 */
import { openPolicy } from "./projectWindow";
import { setContext } from "@/platform/context";
import { isRemoteWindow, useRemote } from "@/platform/remote";
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
import { clearProjectNotifications, installNotifyEvents, notificationServiceImpl } from "./notificationStore";
import {
  NOTIFICATIONS_TOOL_WINDOW,
  NotificationsHeaderActions,
  NotificationsToolWindow,
  useUnreadNotifications,
} from "./Notifications";
import { loadPlatformInfo } from "@/platform/platformInfo";
import { registerShellActions } from "./shellActions";
import { MainToolbarDialogHost } from "./MainToolbarDialog";
import { BackgroundTasksHost, StatusInfo, TaskStatus } from "./StatusBar";
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

  const syncProjectContext = () => {
    const project = useProject.getState().project;
    setContext("projectLocal", !!project && !isRemoteWindow() && !useProject.getState().lightEdit);
    setContext("workspaceOpen", !!project?.workspace);
    setContext("projectAttached", !!project?.workspace && project.workspace.projects[0] === project.root);
    setContext("workspaceContainer", !!project?.workspace && project.workspace.projects[0] !== project.root);
    setContext("projectOpenAsk", openPolicy() === "ask");
  };
  // Synchronous so the frame's first render after opening already has the project's layout.
  const onProject = (root: string | null) => {
    setContext("projectOpen", root !== null);
    syncProjectContext();
    setContext("lightEdit", useProject.getState().lightEdit);
    if (root !== null) loadToolWindowLayout(root);
  };
  onProject(useProject.getState().project?.root ?? null);
  const unsubProject = useProject.subscribe((s, prev) => {
    syncProjectContext();
    if (s.project?.root === prev.project?.root && s.lightEdit === prev.lightEdit) return;
    // The previous project's notifications (and their actions) no longer apply.
    if (prev.project) clearProjectNotifications();
    onProject(s.project?.root ?? null);
  });

  const disposers = [
    unsubProject,
    useRemote.subscribe(syncProjectContext),
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
    registerOverlay({ id: "workbench.backgroundTasks", component: BackgroundTasksHost }),
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
