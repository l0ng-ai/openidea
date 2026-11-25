import { lazyComponent } from "@/ui";
import { registerSettingsPage } from "@/workbench/contributions";

/** Settings › Editor › TODO (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: "editor.todo",
    title: "TODO",
    group: "Editor",
    order: 40,
    keywords: ["todo", "fixme", "hack", "pattern"],
    component: lazyComponent(() => import("./TodoSettingsPage").then((m) => m.TodoSettingsPage)),
  });
}
