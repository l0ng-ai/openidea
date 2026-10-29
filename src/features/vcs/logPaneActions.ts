import { focusRepo } from "./store";
/**
 * Actions of the Git Log's inner panes: the Branches pane toolbar, Graph Options'
 * linear-branch actions and the changed-files pane (toolbar and context menu).
 */
import { create } from "zustand";
import type { Branch } from "@/bindings";
import { registerActions, type Action } from "@/platform/actions";
import { notifications, toolWindowService } from "@/workbench/contributions";
import { deleteBranch, deleteRemoteBranch, newBranch, toggleFavoriteBranch, updateBranch } from "./branchOps";
import {
  changesArg,
  compareChangeWithLocal,
  getFromRevision,
  openChangeSource,
  revertSelectedChanges,
  showChangesDiff,
  useLogChanges,
} from "./logChanges";
import { logOptions } from "./logOptions";
import { goToRef, updateLogOptions } from "./logStore";

const VCS = "vcsAvailable";

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

const withBranch =
  (fn: (b: Branch) => unknown): Action["run"] =>
  async ({ arg }) => {
    const target = branchArg(arg);
    if (target?.repo) await focusRepo(target.repo);
    const b = target?.branch;
    if (b) void fn(b);
  };

/** Delete is offered for branches other than the current one. */
export function canDeleteBranch(t: BranchTarget | null): boolean {
  return !!t?.branch && !t.branch.current;
}

/** Update fast-forwards a local branch with an upstream (or updates the project for the current one). */
export function canUpdateBranch(t: BranchTarget | null): boolean {
  return !!t?.branch && !t.branch.remote && (t.branch.current || !!t.branch.upstream);
}

export function registerLogPaneActions(): () => void {
  return registerActions([
    {
      id: "vcs.log.showBranches",
      title: "Show Branches",
      category: "Git Log",
      when: VCS,
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
      when: VCS,
      run: () => updateLogOptions({ collapseLinear: true }),
    },
    {
      id: "vcs.log.expandLinear",
      title: "Expand Linear Branches",
      category: "Git Log",
      icon: "expand-all",
      when: VCS,
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
      run: async ({ arg }) => {
        const t = branchArg(arg);
        if (t?.repo) await focusRepo(t.repo);
        void newBranch(t && t.ref !== "HEAD" && !t.branch?.current ? t.ref : undefined);
      },
    },
    {
      id: "vcs.log.branches.update",
      title: "Update Selected",
      category: "Git Log",
      icon: "git-pull",
      when: VCS,
      hidden: true,
      run: withBranch((b) => updateBranch(b.name)),
    },
    {
      id: "vcs.log.branches.delete",
      title: "Delete Branch",
      category: "Git Log",
      icon: "trash",
      when: VCS,
      hidden: true,
      run: withBranch((b) => {
        if (b.current) return;
        return b.remote ? deleteRemoteBranch(b.name) : deleteBranch(b.name);
      }),
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
      when: VCS,
      hidden: true,
      run: async ({ arg }) => {
        const t = branchArg(arg);
        if (t?.repo) await focusRepo(t.repo);
        if (t && !(await goToRef(t.ref)))
          notifications().notify({ group: "vcs", level: "warning", title: `'${t.ref}' was not found in the log` });
      },
    },

    // --- changed files ---
    {
      id: "vcs.log.changes.showDiff",
      title: "Show Diff",
      category: "Git Log",
      icon: "diff",
      when: VCS,
      hidden: true,
      run: ({ arg }) => void showChangesDiff(changesArg(arg)),
    },
    {
      id: "vcs.log.changes.compareWithLocal",
      title: "Compare with Local",
      category: "Git Log",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        const c = changesArg(arg)[0];
        if (c) void compareChangeWithLocal(c, "after");
      },
    },
    {
      id: "vcs.log.changes.compareBeforeWithLocal",
      title: "Compare Before with Local",
      category: "Git Log",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        const c = changesArg(arg)[0];
        if (c) void compareChangeWithLocal(c, "before");
      },
    },
    {
      id: "vcs.log.changes.jumpToSource",
      title: "Jump to Source",
      category: "Git Log",
      icon: "edit",
      when: VCS,
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
      when: VCS,
      toggled: () => logOptions().groupByDirectory,
      run: () => updateLogOptions({ groupByDirectory: !logOptions().groupByDirectory }),
    },
    {
      id: "vcs.log.changes.diffPreview",
      title: "Show Diff Preview",
      category: "Git Log",
      description: "Selecting a changed file shows its diff in the editor's preview tab",
      when: VCS,
      toggled: () => logOptions().diffPreview,
      run: () => updateLogOptions({ diffPreview: !logOptions().diffPreview }),
    },
  ]);
}
