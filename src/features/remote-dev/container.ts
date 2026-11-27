/** Reopen in Container: the local project's dev container, opened as a remote project. */
import { tx } from "@/platform/i18n";
import { isCancelled } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { notifications } from "@/workbench/contributions";
import { openRemoteProject } from "@/workbench/projectWindow";

/**
 * Builds or starts the dev container of this window's local project (its `devcontainer.json`)
 * and opens the project there. The folder must be trusted: building it runs the project's commands.
 */
export async function reopenInContainer(): Promise<void> {
  const project = useProject.getState().project;
  if (!project || isRemoteWindow()) return;
  try {
    await openRemoteProject({ kind: "devContainer", folder: project.root, config: "" }, project.root);
  } catch (e) {
    if (isCancelled(e)) return;
    notifications().notify({
      group: "remote",
      level: "error",
      title: tx("Could not reopen the project in a container"),
      body: e instanceof Error ? e.message : String(e),
    });
  }
}
