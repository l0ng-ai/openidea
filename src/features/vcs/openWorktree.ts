import { executeAction } from "@/platform/actions";
import { t } from "@/platform/i18n";
import { call, commands, isCancelled } from "@/platform/ipc";
import { useRemote } from "@/platform/remote";
import { notifications } from "@/workbench/contributions";

/** Open the selected SSH worktree alongside the current project, never as a client path. */
export async function openWorktree(path: string): Promise<void> {
  const target = useRemote.getState().session?.target;
  if (target?.kind !== "ssh") {
    await executeAction("file.openProjectPath", path);
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
