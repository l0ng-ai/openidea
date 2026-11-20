import { tx } from "@/platform/i18n";
import { lazyComponent } from "@/ui";
import { registerEditorKind } from "@/workbench/contributions";
import { COMBINED_DIFF_KIND, type CombinedDiffData } from "./allInOneDiff";
import { DIFF_KIND, diffInputAtCaret, diffTitle, type DiffData } from "./diffInput";

/** The diff viewer (editor kind `diff`), also for windows that show diffs without Git (deployment). */
export function activateDiffViewer(): () => void {
  const single = registerEditorKind({
    kind: DIFF_KIND,
    standalone: true,
    component: lazyComponent(() => import("./diff-editor-tab").then((m) => m.DiffEditorTab)),
    title: (input) => diffTitle(input.data as DiffData),
    icon: () => "diff",
    navigationInput: diffInputAtCaret,
  });
  const combined = registerEditorKind({
    kind: COMBINED_DIFF_KIND,
    standalone: true,
    component: lazyComponent(() => import("./CombinedDiff").then((m) => m.CombinedDiffTab)),
    title: (input) => (input.data as CombinedDiffData).title ?? tx("Combined Changes Diff"),
    icon: () => "diff",
  });
  return () => {
    single();
    combined();
  };
}
