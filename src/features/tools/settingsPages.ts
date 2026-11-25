import { lazyComponent } from "@/ui";
import { registerSettingsPage } from "@/workbench/contributions";
import { SETTINGS_PAGE_ID } from "./store";

/** The Language Servers page (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: SETTINGS_PAGE_ID,
    title: "Language Servers",
    group: "Languages & Frameworks",
    order: 400,
    keywords: [
      "lsp",
      "language server",
      "debugger",
      "adapter",
      "dap",
      "install",
      "initialization options",
      "rust-analyzer",
      "gopls",
      "pyright",
    ],
    projectScope: true,
    component: lazyComponent(() => import("./LanguageServersPage").then((m) => m.LanguageServersPage)),
  });
}
