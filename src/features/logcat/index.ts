/**
 * Logcat tool window: what an Android device prints, via `adb logcat`, with the
 * level and text filters of IDEA's Android plugin.
 */
import { registerToolWindow } from "@/workbench/contributions";
import { LogcatView } from "./LogcatView";
import { resetLogcat } from "./store";

export function activate(): () => void {
  const dispose = registerToolWindow({
    id: "logcat",
    title: "Logcat",
    icon: "toolwindow-logcat",
    anchor: "bottom",
    stripe: "shown",
    order: 26,
    component: LogcatView,
    // A device can be watched without a project open.
    requiresProject: false,
  });
  return () => {
    dispose();
    resetLogcat();
  };
}
