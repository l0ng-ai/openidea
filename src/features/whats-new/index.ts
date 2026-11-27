/** The What's New tab: opened from Help, and once on the first start after an update. */
import { t } from "@/platform/i18n";
import { registerActions } from "@/platform/actions";
import { registerEditorKind } from "@/workbench/contributions";
import { checkAfterUpdate, openCurrentWhatsNew, WHATS_NEW_KIND } from "./model";
import { WhatsNewPage } from "./WhatsNew";

export function activate(): () => void {
  const disposers = [
    registerEditorKind({
      kind: WHATS_NEW_KIND,
      component: WhatsNewPage,
      title: () => t("app.whatsNew.title"),
      icon: () => "info",
      // A page to read once: not saved with the session, shown without a project too.
      restorable: false,
      standalone: true,
    }),
    registerActions([
      {
        id: "app.whatsNew",
        title: "What's New",
        category: "Help",
        icon: "info",
        keywords: ["release notes", "changelog", "update notes"],
        run: () => openCurrentWhatsNew(),
      },
    ]),
  ];
  // The first start of a different version shows what changed. The update checks
  // themselves start from the app feature, where a launch project may still be
  // opening; running here means a project-open context never swallows the check.
  void checkAfterUpdate();
  return () => disposers.reverse().forEach((d) => d());
}
