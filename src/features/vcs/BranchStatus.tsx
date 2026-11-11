/**
 * Status bar Git branch widget: current head (and ahead/behind markers), click
 * opens the same Branches popup as the title bar. Visibility is the status bar
 * context menu / View › Appearance › Status Bar Widgets (`title` below).
 */
import { BarButton, Icon } from "@/ui";
import { branchPresentation, useBranchWidgetExtensions } from "./branchWidgetExtensions";
import { BranchSync } from "./BranchSync";
import { headLabel, showBranchesPopup, useBranchesPopup } from "./BranchWidget";
import { inProgress, operationTitle } from "./operations";
import { currentRepoFor, widgetShowsRepo } from "./repoBranches";
import { repoName, useVcs } from "./store";
import { useEditorRegistry } from "@/editor/api";
import type { BranchInfo } from "@/bindings";
import { tx } from "@/platform/i18n";
import styles from "./BranchWidget.module.css";

/** Status bar widget id (toggleable via the status bar widgets menu). */
export const GIT_BRANCH_STATUS = { id: "vcs.gitBranch", title: "Git Branch" } as const;

export function BranchStatus() {
  const available = useVcs((s) => s.available);
  const selected = useVcs((s) => s.branch);
  const path = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  const current = useVcs((s) => currentRepoFor(path, s.roots, s.repo));
  const diverged = useVcs((s) => widgetShowsRepo(s.roots.map((r) => ({ head: s.heads[r]?.head ?? null }))));
  const other = useVcs((s) => (diverged && current && current !== s.repo ? (s.heads[current] ?? null) : null));
  const otherOp = useVcs((s) => (current ? (s.operations[current] ?? null) : null));
  const open = useBranchesPopup((s) => s.open);
  const extensions = useBranchWidgetExtensions((s) => s.extensions);
  if (!available || !selected) return null;
  const presented = other ? null : branchPresentation(extensions);
  const repo = diverged && current ? repoName(current) : null;
  const branch: BranchInfo = other
    ? { head: other.head, headCommit: other.headCommit, upstream: null, ahead: 0, behind: 0, operation: otherOp }
    : selected;
  const head = branch.operation ? `${headLabel(branch)} (${branch.operation})` : headLabel(branch);
  const label = inProgress(branch.operation)
    ? operationTitle(inProgress(branch.operation)!, branch.head)
    : (presented?.text ?? headLabel(branch));
  const tooltip = [
    presented?.tooltip ?? "",
    repo ? tx`Repository: ${repo}` : "",
    tx`Git branch: ${head}`,
    branch.upstream ? tx`Tracking ${branch.upstream}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <BarButton
      className={styles.status}
      tooltip={tooltip}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={tx`Git branch: ${head}`}
      onClick={(e) => showBranchesPopup(e.currentTarget)}
    >
      <Icon name={presented?.icon ?? (branch.head ? "branch" : "commit")} size={14} className={styles.icon} />
      {repo && <span className={styles.repo}>{repo}</span>}
      <span className={styles.name}>{label}</span>
      <BranchSync behind={branch.behind} ahead={branch.ahead} showCounts={false} />
    </BarButton>
  );
}
