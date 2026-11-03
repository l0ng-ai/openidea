import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { ask } from "@/workbench/messages";

export function isUnityProject(): boolean {
  return !!useProject.getState().project?.unity;
}

let prompt: Promise<void> | undefined;

/** Unity needs its own managed debugger; generic native/CoreCLR attach is not a substitute. */
export function showUnityAttach(): Promise<void> {
  if (!isUnityProject()) return Promise.resolve();
  return (prompt ??= ask({
    title: tx("Attach to Unity Process"),
    body: tx(
      "Run this project in Unity Editor. Debugging requires attaching to the Unity Editor process. Unity debugger attachment is not supported in this version yet.",
    ),
    icon: "info",
    buttons: [{ id: "ok", label: tx("OK"), primary: true }],
    cancel: false,
  })
    .then(() => {})
    .finally(() => {
      prompt = undefined;
    }));
}
