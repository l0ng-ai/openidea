import { executeAction } from "@/platform/actions";
import { t } from "@/platform/i18n";
import { call, commands, isCancelled } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { notifications } from "@/workbench/contributions";

/**
 * Opens a worktree on its host. SSH and WSL always use a remote window.
 */
export async function openWorktree(path: string, newWindow = false): Promise<void> {
  const target = useRemote.getState().session?.target;
  if (target?.kind !== "ssh" && target?.kind !== "wsl") {
    await executeAction("file.openProjectPath", newWindow ? { path, newWindow } : path);
    return;
  }
  try {
    await call(commands.windowOpenRemote(target, path, true));
  } catch (error) {
    if (isCancelled(error)) return;
    notifications().notify({
      level: "error",
      group: "vcs",
      userInitiated: true,
      title: t("app.window.openFailed", { name: path }),
      body: error instanceof Error ? error.message : String(error),
    });
  }
}
