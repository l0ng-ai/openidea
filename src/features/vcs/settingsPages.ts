import { tx } from "@/platform/i18n";
import { lazyComponent } from "@/ui";
import { registerEditorKind, registerSettingsPage } from "@/workbench/contributions";
import { MERGE_SCHEME_PREVIEW_KIND } from "./mergeSchemePreviewKind";

/** Settings › Version Control › Log (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  // The three-pane merge preview of Color Scheme › Diff & Merge: registered here so the
  // native Settings window has it too, where the workbench's diff viewer never activates.
  const schemePreview = registerEditorKind({
    kind: MERGE_SCHEME_PREVIEW_KIND,
    component: lazyComponent(() => import("./MergeSchemePreview").then((m) => m.MergeSchemePreview)),
    title: () => tx("Diff & Merge"),
  });
  const log = registerSettingsPage({
    id: "vcs.log",
    title: "Log",
    order: 6,
    keywords: ["git log", "references", "tags", "columns", "commit time"],
    component: lazyComponent(() => import("./LogSettingsPage").then((m) => m.LogSettingsPage)),
  });
  return () => {
    schemePreview();
    log();
  };
}
