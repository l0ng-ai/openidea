/**
 * The Compare tool window: `Show Diff with Working Tree` shows the worktree diff
 * in the sidebar instead of a dialog, with Jump to Source and Swap Sides (#2442).
 */
import { create } from "zustand";
import { Button } from "@/ui";
import { maybeEditorService, notifications, registerToolWindow } from "@/workbench/contributions";
import { showToolWindow } from "@/workbench/toolwindows/store";
import { openVcsDiff, type DiffData } from "./diffInput";
import { ChangesBetweenDialog, type ComparisonFile, type Revision } from "./operations";
import { repositoryPath } from "./repositoryPaths";
import styles from "./common.module.css";

interface CompareToolState {
  target: { from: Revision; to: Revision | null } | null;
  swapped: boolean;
  current: ComparisonFile | null;
  show: (from: Revision, to: Revision | null) => void;
  close: () => void;
  toggleSwapped: () => void;
  select: (file: ComparisonFile | null) => void;
}

export const useCompareTool = create<CompareToolState>()((set) => ({
  target: null,
  swapped: false,
  current: null,
  show: (from, to) => set({ target: { from, to }, swapped: false, current: null }),
  close: () => set({ target: null, swapped: false, current: null }),
  toggleSwapped: () => set((s) => ({ swapped: !s.swapped })),
  select: (current) => set({ current }),
}));

let disposeCompareWindow: (() => void) | null = null;

function ensureCompareWindow() {
  disposeCompareWindow ??= registerToolWindow({
    id: "compare",
    title: "Compare",
    icon: "diff",
    anchor: "left",
    order: 2,
    component: CompareToolWindow,
  });
}

function disposeCompareWindowNow() {
  disposeCompareWindow?.();
  disposeCompareWindow = null;
}

/** Worktree diff of `rev` in the sidebar's Compare tool window (no dialog). */
export function showWorktreeComparison(rev: string, label: string) {
  useCompareTool.getState().show({ rev, label }, null);
  ensureCompareWindow();
  showToolWindow("compare", true);
}

export function CompareToolWindow() {
  const target = useCompareTool((s) => s.target);
  const swapped = useCompareTool((s) => s.swapped);
  const current = useCompareTool((s) => s.current);
  const toggleSwapped = useCompareTool((s) => s.toggleSwapped);
  const select = useCompareTool((s) => s.select);
  const close = useCompareTool((s) => s.close);
  if (!target) return null;
  const jumpToSource = () => {
    if (!current || current.kind === "deleted") return;
    void maybeEditorService()?.openFile(repositoryPath(current.root, current.path), { focus: true });
  };
  const showDiff = (data: DiffData) => {
    void openVcsDiff(data).catch((error) =>
      notifications().notify({ level: "error", title: "Could not show diff", body: String(error) }),
    );
  };
  const handleClose = () => {
    close();
    disposeCompareWindowNow();
  };
  return (
    <div className={styles.comparisonWindow}>
      <div className={styles.compareToolbar}>
        <Button size="small" onClick={jumpToSource} disabled={!current || current.kind === "deleted"}>
          Jump to Source
        </Button>
        <Button size="small" variant={swapped ? "primary" : "secondary"} onClick={toggleSwapped}>
          Swap Sides
        </Button>
      </div>
      <div className={styles.comparisonWindowBody}>
        <ChangesBetweenDialog
          key={target.from.rev}
          from={target.from}
          to={target.to}
          native
          listOnly
          swapped={swapped}
          onSelect={select}
          onShowDiff={showDiff}
          onClose={handleClose}
        />
      </div>
    </div>
  );
}
