import { executeAction, getAction } from "@/platform/actions";
import type { RunConfig } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";

export const UNITY_CONFIG_KIND = "unity-editor";

export async function showUnityAttach(config?: RunConfig): Promise<void> {
  if (!getAction("debug.attachUnity")) {
    notifications().notify({ group: "run", level: "warning", title: "Debugger is not available" });
    return;
  }
  await executeAction("debug.attachUnity", config);
}
