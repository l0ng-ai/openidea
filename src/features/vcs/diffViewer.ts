import { tx } from "@/platform/i18n";
import { lazyComponent } from "@/ui";
import { registerEditorKind } from "@/workbench/contributions";
import { COMBINED_DIFF_KIND, combinedDiffDocumentOwner, type CombinedDiffData } from "./allInOneDiff";
import { DIFF_KIND, diffInput, diffInputAtCaret, diffTitle, type DiffData } from "./diffInput";
import { stagedDiffPath, stagedDocumentLifecycle } from "./stagedDocument";

/** The diff viewer (editor kind `diff`), also for windows that show diffs without Git (deployment). */
export function activateDiffViewer(): () => void {
  const staged = stagedDocumentLifecycle(true);
  const combinedStaged = stagedDocumentLifecycle(true, ({ key, data }) =>
    (data as CombinedDiffData).items
      .filter(stagedDiffPath)
      .map((item) => combinedDiffDocumentOwner(key, diffInput(item).key)),
  );
  const single = registerEditorKind({
    kind: DIFF_KIND,
    standalone: true,
    component: lazyComponent(() => import("./diff-editor-tab").then((m) => m.DiffEditorTab)),
    title: (input) => diffTitle(input.data as DiffData),
    icon: () => "diff",
    navigationInput: diffInputAtCaret,
    document: (input) => (stagedDiffPath(input.data as DiffData) ? staged : undefined),
  });
  const combined = registerEditorKind({
    kind: COMBINED_DIFF_KIND,
    standalone: true,
    component: lazyComponent(() => import("./CombinedDiff").then((m) => m.CombinedDiffTab)),
    title: (input) => (input.data as CombinedDiffData).title ?? tx("Combined Changes Diff"),
    document: (input) => ((input.data as CombinedDiffData).items.some(stagedDiffPath) ? combinedStaged : undefined),
    icon: () => "diff",
  });
  return () => {
    single();
    combined();
  };
}
