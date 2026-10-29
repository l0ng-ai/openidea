import { executeAction, getAction, registerActions } from "@/platform/actions";
import { isTauri } from "@/platform/ipc";
import { closeProject, confirmLeaveProject, openProject, useProject } from "@/platform/project";
import { runSearchFieldCommand, showContextMenu } from "@/ui";
import { showCustomizeToolbar } from "./MainToolbarDialog";
import { quickSwitchItems } from "./quickSwitch";
import { notify } from "./notificationStore";
import { NOTIFICATIONS_TOOL_WINDOW } from "./Notifications";
import { activateToolWindow } from "./toolwindows/store";
import { toggleTheme } from "./theme";
import { cancelTask, canCancel, useTasks } from "./tasks";
import { maybeEditorService, showStatusInfo } from "./contributions";

export async function openProjectDialog() {
  if (!isTauri()) {
    notify({
      level: "warning",
      title: "Opening folders requires the desktop app",
      body: "Run `pnpm tauri dev` to use the file system.",
    });
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const defaultPath = useProject.getState().settings?.general?.defaultProjectDirectory?.trim() || undefined;
  const picked = await open({ directory: true, multiple: false, title: "Open Folder", defaultPath });
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  // The app feature applies "Open project in" (new / this window / ask).
  if (getAction("file.openProjectPath")) {
    await executeAction("file.openProjectPath", path);
    return;
  }
  if (!(await confirmLeaveProject())) return;
  try {
    await openProject(path);
  } catch (e) {
    notify({ level: "error", title: "Could not open project", body: e instanceof Error ? e.message : String(e) });
  }
}

/** Stop Background Processes (⇧⌘F2): the one running cancellable task, else a choice of them. */
export function stopBackgroundProcesses() {
  const running = useTasks.getState().tasks.filter(canCancel);
  if (!running.length) return showStatusInfo("No background processes to stop");
  if (running.length === 1) return cancelTask(running[0]!.id);
  showContextMenu({ x: window.innerWidth / 2 - 160, y: 96 }, [
    ...running.map((t) => ({ id: String(t.id), label: t.title, icon: "stop", run: () => cancelTask(t.id) })),
    { kind: "separator" as const },
    { id: "all", label: "Stop All", run: () => running.forEach((t) => cancelTask(t.id)) },
  ]);
}

/** Generic actions owned by the shell. */
export function registerShellActions(): () => void {
  return registerActions([
    {
      id: "file.openProject",
      title: "Open…",
      category: "File",
      icon: "folder-open",
      keywords: ["folder", "project"],
      run: openProjectDialog,
    },
    {
      id: "file.closeProject",
      title: "Close Project",
      category: "File",
      when: "projectOpen",
      run: async () => {
        if (!useProject.getState().project || !(await confirmLeaveProject())) return;
        try {
          await closeProject();
        } catch (e) {
          maybeEditorService()?.cancelClose?.();
          throw e;
        }
      },
    },
    {
      id: "workbench.stopBackgroundProcesses",
      title: "Stop Background Processes…",
      category: "Window",
      keywords: ["cancel task", "background tasks", "progress"],
      run: stopBackgroundProcesses,
    },
    {
      id: "view.toggleTheme",
      title: "Toggle Light/Dark Theme",
      category: "View",
      icon: "sun",
      keywords: ["appearance", "theme"],
      run: toggleTheme,
    },
    {
      id: "view.quickSwitchScheme",
      title: "Quick Switch Scheme…",
      category: "View",
      keywords: ["theme", "color scheme", "keymap", "view mode"],
      run: () => showContextMenu({ x: window.innerWidth / 2 - 120, y: 96 }, quickSwitchItems()),
    },
    {
      id: "toolbar.customize",
      title: "Customize Main Toolbar…",
      category: "View",
      keywords: ["toolbar", "widgets", "title bar"],
      run: showCustomizeToolbar,
    },
    {
      id: "view.notifications",
      title: "Notifications",
      category: "View",
      icon: "bell",
      run: () => activateToolWindow(NOTIFICATIONS_TOOL_WINDOW),
    },
    // Keys of search fields (find bar, Find in Files) that are editor shortcuts elsewhere.
    {
      id: "find.field.newLine",
      title: "New Line in Search Field",
      category: "Find",
      hidden: true,
      when: "searchFieldNewLine",
      run: () => void runSearchFieldCommand("newLine"),
    },
    {
      id: "find.field.recentSearches",
      title: "Recent Searches",
      category: "Find",
      hidden: true,
      when: "searchFieldHistory",
      run: () => void runSearchFieldCommand("history"),
    },
  ]);
}
