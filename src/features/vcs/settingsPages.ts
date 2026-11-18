import { lazyComponent } from "@/ui";
import { registerSettingsPage } from "@/workbench/contributions";

/** Settings › Version Control › Log (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: "vcs.log",
    title: "Log",
    order: 6,
    keywords: ["git log", "references", "tags", "columns", "commit time"],
    component: lazyComponent(() => import("./LogSettingsPage").then((m) => m.LogSettingsPage)),
  });
}
