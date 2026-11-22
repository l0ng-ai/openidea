/**
 * Actions of the Git Log's inner panes: the Branches pane toolbar, Graph Options'
 * linear-branch actions and the changed-files pane (toolbar and context menu).
 */
import { create } from "zustand";
import type { Branch, Commit } from "@/bindings";
import { executeAction, registerActions, type Action } from "@/platform/actions";
import { relativePath } from "@/platform/project";
import { notifications, toolWindowService } from "@/workbench/contributions";
import { deleteBranches, newBranch, newBranchInRepos, toggleFavoriteBranch, updateBranches } from "./branchOps";
import {
  applySelectedChanges,
  changesArg,
  compareChangesWithLocal,
  getFromRevision,
  openChangeSource,
  revertSelectedChanges,
  showChangesDiff,
  useLogChanges,
  type LogChange,
} from "./logChanges";
import { logOptions } from "./logOptions";
import { goToRef, selectedCommits, toggleCherryHighlight, updateLogOptions, useGitLog } from "./logStore";
import { commitKey, commitRepo } from "./multiRoot";
import { dropSelectedChanges, extractSelectedChanges } from "./rebase";
import { currentRepoRoot, focusRepo } from "./store";
import { showCompareBranches, type BranchComparisonTarget, type BranchComparisonData } from "./CompareBranches";
import { showCompareRevisions } from "./operations";

const VCS = "vcsAvailable";
const LOG = "vcsAvailable || projectOpen || vcsLogFocus";

function editSelectedFiles(arg: unknown, edit: (commit: Commit, changes: LogChange[]) => Promise<void>) {
  const selection = arg as { commit?: Commit; changes?: unknown } | undefined;
  if (selection?.commit) void edit(selection.commit, changesArg(selection.changes));
}

function showFocusedHistoryDiff() {
  const selected = selectedCommits();
  if (selected.length === 2) {
    void executeAction("vcs.log.compareVersions");
    return;
  }
  if (selected.length !== 1) return;

  const state = useGitLog.getState();
  const tab = state.logTabs.find((item) => item.id === state.shownLog);
  if (tab?.kind !== "history") return;

  const commit = selected[0]!;
  const changes = useLogChanges.getState();
  // The details pane loads asynchronously after a row selection. Never diff a stale pane.
  if (changes.commits.length !== 1 || commitKey(changes.commits[0]!) !== commitKey(commit)) {
    notifications().notify({ group: "vcs", level: "info", title: "Revision changes are still loading" });
    return;
  }

  const root = commitRepo(commit) ?? currentRepoRoot();
  const targetPath = root ? relativePath(root, tab.target) : tab.target;
  const historyPath = "historyPath" in commit && typeof commit.historyPath === "string" ? commit.historyPath : null;
  const relevant = changes.all.filter(
    (change) =>
      change.path === targetPath ||
      change.oldPath === targetPath ||
      (historyPath !== null && (change.path === historyPath || change.oldPath === historyPath)),
  );
  if (relevant.length) void showChangesDiff(relevant, false, relevant);
}

/** A ref selected in the Branches pane. */
export interface BranchTarget {
  ref: string;
  repo?: string;
  branch?: Branch;
}

/** The Branches pane's selected refs (what its toolbar acts on without an argument). */
export const useBranchesPane = create<{ selected: BranchTarget[] }>(() => ({ selected: [] }));

function branchArg(arg: unknown): BranchTarget | null {
  if (arg && typeof arg === "object" && "ref" in arg) return arg as BranchTarget;
  return useBranchesPane.getState().selected[0] ?? null;
}

/** The action's branches: an array argument as a whole, otherwise the single one or the pane's selection. */
function branchTargets(arg: unknown): BranchTarget[] {
  if (Array.isArray(arg)) return arg.filter((t): t is BranchTarget => !!t && typeof t === "object" && "ref" in t);
  if (arg && typeof arg === "object" && "ref" in arg) return [arg as BranchTarget];
  return useBranchesPane.getState().selected;
}

const withBranch =
  (fn: (b: Branch) => unknown): Action["run"] =>
  async ({ arg }) => {
    const target = branchArg(arg);
    if (target?.repo) await focusRepo(target.repo);
    const b = target?.branch;
    if (b) void fn(b);
  };

export function canUpdateBranch(t: BranchTarget | null): boolean {
  return !!t?.branch && !t.branch.remote && !!t.branch.upstream;
}

export function registerLogPaneActions(): () => void {
  return registerActions([
    {
      id: "vcs.log.highlightNotCherryPicked",
      title: "Not Cherry-Picked Commits",
      description: "Highlight commits that have not been cherry-picked to the current branch",
      category: "Git Log",
      when: LOG,
      toggled: () => !!useGitLog.getState().cherryHighlight,
      run: toggleCherryHighlight,
    },
    {
      id: "vcs.log.compareBranches",
      title: "Compare with Current",
      category: "Git Log",
      when: LOG,
      hidden: true,
      enabled: ({ arg }) => typeof (arg as BranchComparisonTarget | undefined)?.rev === "string",
      run: ({ arg }) => showCompareBranches(arg as BranchComparisonTarget),
    },
    {
      id: "vcs.log.compareBranchTrees",
      title: "Show Branch Diff",
      category: "Git Log",
      when: LOG,
      hidden: true,
      enabled: ({ arg }) => typeof (arg as { repo?: string } | undefined)?.repo === "string",
      run: ({ arg }) => {
        const { branch, current, repo } = arg as BranchComparisonData & { repo: string };
        showCompareRevisions(branch.rev, current.rev, branch.name, current.name, repo);
      },
    },
    {
      id: "vcs.log.showBranches",
      title: "Show Branches",
      category: "Git Log",
      when: LOG,
      toggled: () => logOptions().showBranches,
      run: () => {
        updateLogOptions({ showBranches: !logOptions().showBranches });
        toolWindowService().show("git", true);
      },
    },
    {
      id: "vcs.log.collapseLinear",
      title: "Collapse Linear Branches",
      category: "Git Log",
      icon: "collapse-all",
      when: LOG,
      run: () => updateLogOptions({ collapseLinear: true }),
    },
    {
      id: "vcs.log.expandLinear",
      title: "Expand Linear Branches",
      category: "Git Log",
      icon: "expand-all",
      when: LOG,
      run: () => updateLogOptions({ collapseLinear: false }),
    },

    // --- Branches pane ---
    {
      id: "vcs.log.branches.new",
      title: "New Branch…",
      category: "Git Log",
      icon: "plus",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        const targets = branchTargets(arg);
        const target = targets[0];
        const source = target?.branch ?? (target && target.ref !== "HEAD" ? { tag: target.ref } : undefined);
        const roots = [
          ...new Set(
            targets.flatMap(({ ref, repo, branch }) =>
              repo && ref === target?.ref && branch?.remote === target.branch?.remote ? [repo] : [],
            ),
          ),
        ];
        if (roots.length) void newBranchInRepos(roots, source);
        else void newBranch(source);
      },
    },
    {
      id: "vcs.log.branches.update",
      title: "Update Selected",
      category: "Git Log",
      icon: "git-pull",
      when: VCS,
      hidden: true,
      run: ({ arg }) => updateBranches(branchTargets(arg)),
    },
    {
      id: "vcs.log.branches.delete",
      title: "Delete Branch",
      category: "Git Log",
      icon: "trash",
      when: VCS,
      hidden: true,
      run: ({ arg }) => deleteBranches(branchTargets(arg)),
    },
    {
      id: "vcs.log.branches.toggleFavorite",
      title: "Mark/Unmark As Favorite",
      category: "Git Log",
      icon: "star",
      when: VCS,
      hidden: true,
      run: withBranch(toggleFavoriteBranch),
    },
    {
      id: "vcs.log.branches.navigate",
      title: "Navigate Log to Selected Branch",
      category: "Git Log",
      icon: "locate",
      when: LOG,
      hidden: true,
      run: async ({ arg }) => {
        const t = branchArg(arg);
        if (t && !(await goToRef(t.ref, t.repo)))
          notifications().notify({ group: "vcs", level: "warning", title: `'${t.ref}' was not found in the log` });
      },
    },

    // --- changed files ---
    {
      id: "vcs.log.changes.showDiff",
      title: "Show Diff",
      category: "Git Log",
      icon: "diff",
      when: LOG,
      hidden: true,
      keyWhen: "vcsLogChangesFocus || vcsLogRevisionFocus",
      run: ({ arg, ctx }) => {
        const selection = arg as { changes?: LogChange[]; chain?: LogChange[] } | undefined;
        if (selection?.changes && selection.chain) {
          void showChangesDiff(selection.changes, false, selection.chain);
          return;
        }
        if (ctx.vcsLogRevisionFocus) {
          showFocusedHistoryDiff();
          return;
        }
        void showChangesDiff(changesArg(arg));
      },
    },
    {
      id: "vcs.log.changes.compareWithLocal",
      title: "Compare with Local",
      category: "Git Log",
      when: LOG,
      hidden: true,
      run: ({ arg }) => void compareChangesWithLocal(changesArg(arg), "after"),
    },
    {
      id: "vcs.log.changes.compareBeforeWithLocal",
      title: "Compare Before with Local",
      category: "Git Log",
      when: LOG,
      hidden: true,
      run: ({ arg }) => void compareChangesWithLocal(changesArg(arg), "before"),
    },
    {
      id: "vcs.log.changes.jumpToSource",
      title: "Jump to Source",
      category: "Git Log",
      icon: "edit",
      when: LOG,
      hidden: true,
      run: ({ arg }) => {
        for (const c of changesArg(arg)) if (c.after) void openChangeSource(c);
      },
    },
    {
      id: "vcs.log.changes.getFromRevision",
      title: "Get from Revision",
      category: "Git Log",
      when: VCS,
      hidden: true,
      run: ({ arg }) => void getFromRevision(changesArg(arg)),
    },
    {
      id: "vcs.log.changes.apply",
      title: "Apply Selected Changes",
      category: "Git Log",
      icon: "check",
      when: VCS,
      hidden: true,
      run: ({ arg }) => void applySelectedChanges(changesArg(arg)),
    },
    {
      id: "vcs.log.changes.extract",
      title: "Extract Selected Changes",
      category: "Git Log",
      when: VCS,
      hidden: true,
      run: ({ arg }) => editSelectedFiles(arg, extractSelectedChanges),
    },
    {
      id: "vcs.log.changes.drop",
      title: "Drop Selected Changes",
      category: "Git Log",
      when: VCS,
      hidden: true,
      run: ({ arg }) => editSelectedFiles(arg, dropSelectedChanges),
    },
    {
      id: "vcs.log.changes.revert",
      title: "Revert Selected Changes",
      category: "Git Log",
      icon: "revert",
      when: VCS,
      hidden: true,
      run: ({ arg }) => void revertSelectedChanges(changesArg(arg), useLogChanges.getState().commits),
    },
    {
      id: "vcs.log.changes.groupByDirectory",
      title: "Group by Directory",
      category: "Git Log",
      when: LOG,
      toggled: () => logOptions().groupByDirectory,
      run: () => updateLogOptions({ groupByDirectory: !logOptions().groupByDirectory }),
    },
    {
      id: "vcs.log.changes.showOnlyAffected",
      title: "Show Only Affected Changes",
      category: "Git Log",
      when: LOG,
      hidden: true,
      toggled: () => logOptions().showOnlyAffected,
      run: () => updateLogOptions({ showOnlyAffected: !logOptions().showOnlyAffected }),
    },
    {
      id: "vcs.log.changes.diffPreview",
      title: "Show Diff Preview",
      category: "Git Log",
      description: "Selecting a changed file shows its diff in the editor's preview tab",
      when: LOG,
      toggled: () => logOptions().diffPreview,
      run: () => updateLogOptions({ diffPreview: !logOptions().diffPreview }),
    },
  ]);
}
