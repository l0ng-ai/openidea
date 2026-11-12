import { executeAction, getAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";

export function isUnityProject(): boolean {
  return !!useProject.getState().project?.unity;
}

export async function showUnityAttach(): Promise<void> {
  if (!isUnityProject()) return;
  if (!getAction("debug.attachUnity")) {
    notifications().notify({ group: "run", level: "warning", title: "Debugger is not available" });
    return;
  }
  await executeAction("debug.attachUnity");
}
