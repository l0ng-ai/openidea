import { lazyComponent } from "@/ui";
import { registerSettingsPages } from "@/workbench/contributions";

/** Live / postfix / file template pages (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPages([
    {
      id: "editor.liveTemplates",
      title: "Live Templates",
      group: "Editor",
      order: 28,
      keywords: ["snippet", "abbreviation", "surround", "template"],
      component: lazyComponent(() => import("./settings/LiveTemplatesPage").then((m) => m.LiveTemplatesPage)),
    },
    {
      // IDEA: Editor › General › Postfix Completion.
      id: "editor.general.postfixCompletion",
      title: "Postfix Completion",
      group: "Editor",
      order: 7,
      keywords: ["postfix", "template", ".if", ".var", ".for"],
      component: lazyComponent(() => import("./settings/PostfixPage").then((m) => m.PostfixPage)),
    },
    {
      id: "editor.fileTemplates",
      title: "File and Code Templates",
      group: "Editor",
      order: 26,
      keywords: ["new file", "class", "template", "package", "includes", "file header", "code", "scheme", "reformat"],
      component: lazyComponent(() => import("./settings/FileTemplatesPage").then((m) => m.FileTemplatesPage)),
    },
  ]);
}
