/** VCS › Create Git Repository…: `git init` in a folder chosen under the project. */
import { open } from "@/platform/dialog";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { discoverRoots } from "./store";

export async function createRepository() {
  const root = useProject.getState().project?.root;
  const dir = await open({ title: tx("Select Directory for Git Init"), directory: true, defaultPath: root });
  if (typeof dir !== "string") return;
  try {
    await call(commands.vcsInit(dir));
  } catch (e) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: tx("Couldn't create Git repository"),
      body: String((e as Error)?.message ?? e),
    });
    return;
  }
  notifications().notify({ group: "vcs", level: "info", title: tx`Created Git repository in ${dir}` });
  await discoverRoots();
}
