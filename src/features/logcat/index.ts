/**
 * Logcat tool window: what an Android device prints, via `adb logcat`, with the
 * level and text filters of IDEA's Android plugin.
 */
import { registerToolWindow } from "@/workbench/contributions";
import { projectHasFiles } from "@/workbench/toolwindows/availability";
import { lazyComponent } from "@/ui";
import { resetLogcat } from "./store";

export function activate(): () => void {
  const dispose = registerToolWindow({
    id: "logcat",
    title: "Logcat",
    icon: "toolwindow-logcat",
    anchor: "bottom",
    // Listed under the stripe's "…" until first opened: most projects are not Android ones.
    stripe: "onUse",
    // Android projects only; a device can still be watched from its action.
    appliesToProject: () => projectHasFiles({ names: ["AndroidManifest.xml"] }),
    order: 26,
    component: lazyComponent(() => import("./LogcatView").then((m) => m.LogcatView)),
    // A device can be watched without a project open.
    requiresProject: false,
  });
  return () => {
    dispose();
    resetLogcat();
  };
}
