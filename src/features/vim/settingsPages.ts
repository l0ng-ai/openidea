import { lazyComponent } from "@/ui";
import { registerSettingsPage } from "@/workbench/contributions";

export const VIM_SETTINGS_PAGE = "editor.vim";

/** Settings › Editor › Vim (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: VIM_SETTINGS_PAGE,
    title: "Vim",
    group: "Editor",
    order: 45,
    keywords: ["vim", "ideavim", "ideavimrc", "emulation", "shortcut conflicts", "handler"],
    component: lazyComponent(() => import("./VimSettingsPage").then((m) => m.VimSettingsPage)),
  });
}
