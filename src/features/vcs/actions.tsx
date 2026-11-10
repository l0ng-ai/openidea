import { showShelfDiff } from "./shelf";
import { commitRepo } from "./multiRoot";
/** VCS actions (ids match keymaps/intellij-macos.ts where bound). */
import { registerActions, type Action } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { activeEditor, editorsFor } from "@/editor/api";
import { Menu, type MenuItem } from "@/ui";
import {
  editorService,
  maybeEditorService,
  notifications,
  projectViewSelection,
  toolWindowService,
} from "@/workbench/contributions";
import { annotationsShown, toggleAnnotations } from "./blame";
import { showBranchesPopup } from "./BranchWidget";
import { checkoutRevision, newBranch, newBranchInRepos } from "./branchOps";
import {
  addToVcs,
  commitChanges,
  isNestedRepoEntry,
  rollbackCandidates,
  showRollbackDialog,
  stashChanges,
  showUnstashDialog,
} from "./changeOps";
import { setAmend, useCommit } from "./commitStore";
import { gotoConflict, resolveAtCaret, showConflictsDialog } from "./conflictsUi";
import { focusedDiffNavigator } from "./diffNavigator";
import {
  changeNodeDiff,
  changeNodeDiffData,
  openDiff,
  openVcsDiff,
  withChain,
  workingDiffData,
  type DiffData,
} from "./diffInput";
import { buildChangeTree, changeFileNodes, changeGroupPaths, type ChangeNode } from "./changes";
import { useChangelists } from "./changelists";
import { openDialog } from "./dialogs";
import { gotoChange, rollbackSelectedLines } from "./gutter";
import { openLocalHistory } from "./localHistoryKind";
import { showSelectionHistory } from "./selectionHistoryKind";
import { openLogTab, revealCommit, selectGitTab, useGitLog } from "./logStore";
import { isModalCommit, openCommit, pushAfterCommit } from "./commitUi";
import { allRepos, runRemote } from "./ops";
import { showPushDialog, showUpdateDialog, type PushTarget, type UpdateTarget } from "./remoteUi";
import { comparePathsWithRevision, showDirectoryWorkingDiff } from "./comparePaths";
import { showCloneDialog } from "./clone";
import {
  showManageRemotes,
  showMergeDialog,
  showNewWorktree,
  showPullDialog,
  showRebaseDialog,
  showWorktrees,
} from "./gitMenuDialogs";
import { currentRepo, refreshNow, repoName, repoOf, useVcs } from "./store";
import { tx } from "@/platform/i18n";

import { addToIgnore } from "./ignore";
import { hasFileHistory, showCurrentRevision, trackFileHistory } from "./fileRevisions";
import { compareWithFileRevision } from "./FileRevisionChooser";

const VCS = "vcsAvailable";
const IN_COMMIT_WINDOW = "vcsAvailable && activeToolWindow == commit";

function argPath(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "path" in arg && typeof (arg as { path: unknown }).path === "string")
    return (arg as { path: string }).path;
  return undefined;
}

function argPaths(arg: unknown): string[] | undefined {
  if (Array.isArray(arg)) return arg.filter((x): x is string => typeof x === "string");
  const p = argPath(arg);
  return p ? [p] : undefined;
}

/** The change tree is focused: the Commit window, or the Git window's Local Changes tab. */
export const commitWindowFocused = () => {
  const active = getContext().activeToolWindow;
  return active === "commit" || (active === "git" && useGitLog.getState().tab === "changes");
};

/** A changed file's working diff, with the other files of its group (in tree order) as the F7 chain. */
function groupDiffData(tree: readonly ChangeNode[], path: string): DiffData {
  const siblings = changeGroupPaths(tree, path);
  return withChain(
    siblings.map((p) => workingDiffData(p)),
    Math.max(0, siblings.indexOf(path)),
  );
}

/**
 * Show Diff's files as tree nodes where the side of the index is known: the changes
 * tree's selected file nodes, else the nodes of `paths` the tree lists once. A
 * partially staged file listed under both staging groups stays a path: its whole
 * working diff.
 */
function showDiffTargets(tree: readonly ChangeNode[], paths: readonly string[], fromTree: boolean) {
  const files = changeFileNodes(tree);
  if (fromTree) {
    const keys = new Set(useCommit.getState().selectionKeys);
    const selected = files.filter((n) => keys.has(n.key));
    if (selected.length && selected.length === keys.size) return selected;
  }
  return paths.map((path): ChangeNode | string => {
    const nodes = files.filter((n) => n.path === path);
    return nodes.length === 1 ? nodes[0]! : path;
  });
}

/** The action's own paths, or the changes tree's selection while the tree has focus. */
function changedPaths(arg: unknown): string[] {
  const explicit = argPaths(arg);
  if (explicit?.length) return explicit;
  const sel = useCommit.getState().selection;
  return commitWindowFocused() ? sel : [];
}

/** Files the current context refers to: argument, commit view selection, or the active file. */
function contextPaths(arg: unknown): string[] {
  const changed = changedPaths(arg);
  if (changed.length) return changed;
  const active = maybeEditorService()?.activePath();
  return active ? [active] : [];
}

/**
 * Paths a selection-based action targets: the argument, else the changes tree's selection,
 * else the Project view's — it keeps its selection while another view has focus — else the
 * active file.
 */
function selectedPaths(arg: unknown): string[] {
  const changed = changedPaths(arg);
  if (changed.length) return changed;
  const project = projectViewSelection();
  return project.length ? project : contextPaths(arg);
}

function showGitWindow() {
  toolWindowService().show("git", true);
}

async function annotate(arg: unknown) {
  const path = argPath(arg);
  let handle = activeEditor();
  if (path && handle?.ctx.path !== path) {
    await editorService().openFile(path, { focus: true });
    handle = editorsFor(path)[0] ?? activeEditor();
  }
  if (!handle) {
    notifications().notify({ group: "vcs", level: "info", title: "Open a file to annotate it" });
    return;
  }
  await toggleAnnotations(handle.view, handle.ctx.path);
}

/** VCS Operations popup: the change and file entries, then Git's own, then Local History. */
const OPERATIONS: MenuItem[] = [
  { kind: "header", label: "Git" },
  { kind: "action", action: "vcs.commit" },
  { kind: "action", action: "vcs.rollback" },
  { kind: "separator" },
  { kind: "action", action: "vcs.showHistory" },
  { kind: "action", action: "vcs.annotate" },
  { kind: "action", action: "vcs.showDiff" },
  { kind: "action", action: "vcs.compareWithBranch" },
  { kind: "separator" },
  { kind: "action", action: "vcs.branches" },
  { kind: "action", action: "vcs.push" },
  { kind: "action", action: "vcs.stash" },
  { kind: "action", action: "vcs.unstash" },
  { kind: "separator" },
  { kind: "action", action: "vcs.worktrees" },
  { kind: "action", action: "vcs.addToVcs" },
  { kind: "action", action: "vcs.resolveConflicts" },
  { kind: "separator" },
  { kind: "action", action: "vcs.localHistory" },
];

function showOperations() {
  openDialog((close) => (
    <Menu
      open
      onClose={close}
      anchor={{ x: Math.max(16, window.innerWidth / 2 - 140), y: Math.round(window.innerHeight * 0.18) }}
      items={OPERATIONS}
      aria-label="VCS Operations"
    />
  ));
}

export function registerVcsActions(): () => void {
  const actions: Action[] = [
    {
      id: "vcs.operations",
      title: "VCS Operations…",
      category: "Git",
      icon: "branch",
      when: "projectOpen",
      keywords: ["git", "quick list"],
      run: showOperations,
    },
    {
      id: "vcs.commit",
      title: "Commit…",
      category: "Git",
      icon: "commit",
      when: VCS,
      run: openCommit,
    },
    {
      id: "vcs.commitAndPush",
      title: "Commit and Push…",
      category: "Git",
      icon: "git-push",
      when: VCS,
      run: async () => {
        const { message, amend } = useCommit.getState();
        // Nothing to commit with yet (or the modal interface): IDEA shows where the message is typed.
        if (isModalCommit() || (!message.trim() && !amend)) return openCommit();
        const id = await commitChanges();
        if (id !== undefined) await pushAfterCommit();
      },
    },
    {
      id: "vcs.toggleAmend",
      title: "Amend Commit",
      category: "Git",
      when: VCS,
      keyWhen: IN_COMMIT_WINDOW,
      toggled: () => useCommit.getState().amend,
      run: () => void setAmend(!useCommit.getState().amend),
    },
    {
      id: "vcs.showMessageHistory",
      title: "Show Commit Message History",
      category: "Git",
      icon: "history",
      when: VCS,
      keyWhen: IN_COMMIT_WINDOW,
      run: () => useCommit.setState((s) => ({ historyTick: s.historyTick + 1 })),
    },
    {
      id: "vcs.clone",
      title: "Get from Version Control…",
      category: "Git",
      icon: "git-pull",
      keywords: ["clone", "checkout", "git"],
      run: (c) => showCloneDialog(typeof c.arg === "string" ? c.arg : ""),
    },
    {
      id: "vcs.push",
      title: "Push…",
      category: "Git",
      icon: "git-push",
      when: VCS,
      run: ({ arg }) => void showPushDialog(arg && typeof arg === "object" ? (arg as PushTarget) : {}),
    },
    {
      id: "vcs.update",
      title: "Update Project…",
      category: "Git",
      icon: "git-pull",
      when: VCS,
      keywords: ["pull"],
      run: ({ arg }) => showUpdateDialog(arg && typeof arg === "object" ? (arg as UpdateTarget) : {}),
    },
    {
      id: "vcs.pull",
      title: "Pull…",
      category: "Git",
      icon: "git-pull",
      when: VCS,
      run: showPullDialog,
    },
    {
      id: "vcs.merge",
      title: "Merge…",
      category: "Git",
      when: VCS,
      keywords: ["merge branch"],
      run: showMergeDialog,
    },
    {
      id: "vcs.rebase",
      title: "Rebase…",
      category: "Git",
      when: VCS,
      keywords: ["rebase branch"],
      run: showRebaseDialog,
    },
    {
      id: "vcs.manageRemotes",
      title: "Manage Remotes…",
      category: "Git",
      when: VCS,
      keywords: ["remote", "origin", "url"],
      run: showManageRemotes,
    },
    {
      id: "vcs.newWorktree",
      title: "New Worktree…",
      category: "Git",
      when: VCS,
      keywords: ["worktree"],
      run: () => showNewWorktree(),
    },
    {
      id: "vcs.worktrees",
      title: "Worktrees…",
      category: "Git",
      when: VCS,
      keywords: ["worktree"],
      run: showWorktrees,
    },
    {
      id: "vcs.fetch",
      title: "Fetch",
      category: "Git",
      icon: "git-fetch",
      when: VCS,
      run: () => void runRemote({ op: "fetch" }, undefined, allRepos()),
    },
    {
      id: "vcs.refresh",
      title: "Refresh VCS Status",
      category: "Git",
      icon: "refresh",
      when: VCS,
      run: () => void refreshNow(),
    },
    {
      id: "vcs.rollback",
      title: "Rollback…",
      category: "Git",
      icon: "undo",
      when: VCS,
      keywords: ["revert", "discard"],
      run: ({ arg }) => {
        const explicit = argPaths(arg);
        // IDEA: in the editor, with the caret on changed lines, ⌥⌘Z is Rollback Lines.
        const ed = activeEditor();
        if (!explicit?.length && ed?.view.hasFocus && rollbackSelectedLines(ed.view)) return;
        const sel = useCommit.getState().selection;
        const paths = explicit?.length ? explicit : commitWindowFocused() && sel.length ? sel : undefined;
        if (paths) {
          const candidates = rollbackCandidates(paths);
          const submodule = paths.find((p) => isNestedRepoEntry(p));
          if (!candidates.length && submodule)
            return notifications().notify({
              group: "vcs",
              level: "info",
              title: "Submodule changes cannot be rolled back here",
              body: tx`${repoName(submodule)} points to another commit. Check out the recorded commit in the submodule (git submodule update) to revert it.`,
            });
          return showRollbackDialog(candidates);
        }
        const active = maybeEditorService()?.activePath();
        const activeChanged = active ? rollbackCandidates([active]) : [];
        showRollbackDialog(activeChanged.length ? activeChanged : rollbackCandidates());
      },
    },
    {
      id: "vcs.showDiff",
      title: "Show Diff",
      category: "Git",
      icon: "diff",
      when: VCS,
      // ⌘D duplicates the line inside a text editor; Git › Show Diff still works there.
      keyWhen: "!editorTextFocus",
      run: async ({ arg, ctx }) => {
        if (ctx.shelfFocus && arg === undefined) return showShelfDiff();
        const line =
          arg && typeof arg === "object" && "line" in arg ? Number((arg as { line: unknown }).line) : undefined;
        const paths = selectedPaths(arg);
        if (!paths.length) {
          notifications().notify({ group: "vcs", level: "info", title: "Select a changed file to show its diff" });
          return;
        }
        if (await showDirectoryWorkingDiff(paths)) return;
        const state = useVcs.getState();
        const tree = buildChangeTree(
          state.status,
          state.root ?? "",
          useCommit.getState().groupByDir,
          useChangelists.getState().state,
          state.roots,
          useCommit.getState().groupByStaging,
        );
        // The modal interface has one front diff window (#1863): a file with its group
        // as the F7 chain, or several selected files as the chain.
        if (isModalCommit()) {
          const targets = showDiffTargets(tree, paths, !argPaths(arg)?.length && commitWindowFocused());
          const [first] = targets;
          const data =
            targets.length > 1
              ? withChain(
                  targets.map((t) => (typeof t === "string" ? workingDiffData(t) : changeNodeDiff(t))),
                  0,
                )
              : typeof first === "string"
                ? groupDiffData(tree, first)
                : changeNodeDiffData(tree, first!);
          await openVcsDiff({ ...data, line });
          return;
        }
        for (const path of paths.slice(0, 5)) {
          await openDiff({ ...groupDiffData(tree, path), line }, { preview: paths.length === 1 });
        }
      },
    },
    {
      id: "vcs.compareWithBranch",
      title: "Compare with Branch or Revision…",
      category: "Git",
      icon: "diff",
      when: VCS,
      run: async ({ arg }) => {
        const paths = selectedPaths(arg);
        if (!paths.length) {
          notifications().notify({ group: "vcs", level: "info", title: "Open or select a file or folder to compare" });
          return;
        }
        await comparePathsWithRevision(paths);
      },
    },
    {
      id: "vcs.compareWithRevision",
      title: "Compare with Revision…",
      category: "Git",
      icon: "diff",
      when: VCS,
      enabled: ({ arg }) => hasFileHistory(argPath(arg) ?? maybeEditorService()?.activePath()),
      run: ({ arg }) => compareWithFileRevision(argPath(arg) ?? maybeEditorService()?.activePath()),
    },
    {
      id: "vcs.nextChange",
      title: "Next Change",
      category: "Git",
      icon: "arrow-down",
      when: VCS,
      run: () => {
        const diff = focusedDiffNavigator();
        if (diff) return diff.next();
        const ed = activeEditor();
        if (ed) gotoChange(ed.view, 1);
      },
    },
    {
      id: "vcs.prevChange",
      title: "Previous Change",
      category: "Git",
      icon: "arrow-up",
      when: VCS,
      run: () => {
        const diff = focusedDiffNavigator();
        if (diff) return diff.prev();
        const ed = activeEditor();
        if (ed) gotoChange(ed.view, -1);
      },
    },
    {
      id: "vcs.annotate",
      title: "Annotate with Git Blame",
      category: "Git",
      icon: "history",
      when: VCS,
      keywords: ["blame", "annotations"],
      toggled: () => {
        const ed = activeEditor();
        return !!ed && annotationsShown(ed.view);
      },
      run: ({ arg }) => annotate(arg),
    },
    {
      id: "vcs.localHistory",
      title: "Show Local History",
      category: "Git",
      icon: "clock",
      when: "projectOpen",
      run: ({ arg }) => {
        const path = argPath(arg) ?? maybeEditorService()?.activePath();
        if (!path) {
          notifications().notify({ group: "vcs", level: "info", title: "Open a file to show its local history" });
          return;
        }
        openLocalHistory(path);
      },
    },
    {
      id: "vcs.branches",
      title: "Branches…",
      category: "Git",
      icon: "branch",
      when: VCS,
      keywords: ["checkout", "git branches"],
      run: showBranchesPopup,
    },
    {
      id: "vcs.newBranch",
      title: "New Branch…",
      category: "Git",
      icon: "plus",
      when: VCS,
      // `{ repos }` (Branches popup with several repositories): in each of them.
      run: ({ arg }) => {
        const repos = (arg as { repos?: unknown } | undefined)?.repos;
        void (Array.isArray(repos) && repos.length ? newBranchInRepos(repos as string[]) : newBranch());
      },
    },
    {
      id: "vcs.checkoutRevision",
      title: "Checkout Tag or Revision…",
      category: "Git",
      when: VCS,
      run: () => void checkoutRevision(),
    },
    {
      id: "vcs.showLog",
      title: "Show Git Log",
      category: "Git",
      icon: "branch",
      when: VCS,
      run: ({ arg }) => {
        const a = (arg ?? {}) as { branch?: string; path?: string };
        // A branch or a path gets a tab of its own; the main Log keeps its filters.
        if (a.path) openLogTab("history", a.path);
        else if (a.branch) openLogTab("branch", a.branch);
        else selectGitTab("log");
        showGitWindow();
      },
    },
    {
      id: "vcs.showHistory",
      title: "Show History for File",
      category: "Git",
      icon: "history",
      when: VCS,
      run: ({ arg }) => {
        const path = contextPaths(arg)[0];
        if (!path) return;
        openLogTab("history", path);
        showGitWindow();
      },
    },
    {
      id: "vcs.showCurrentRevision",
      title: "Show Current Revision",
      category: "Git",
      icon: "commit",
      when: VCS,
      enabled: ({ arg }) => hasFileHistory(argPath(arg) ?? maybeEditorService()?.activePath()),
      run: ({ arg }) => showCurrentRevision(argPath(arg) ?? maybeEditorService()?.activePath()),
    },
    {
      id: "vcs.showHistoryForSelection",
      title: "Show History for Selection",
      category: "Git",
      icon: "history",
      when: `${VCS} && textEditorActive`,
      keywords: ["line history", "block history", "git log -L"],
      run: () => showSelectionHistory(),
    },
    {
      id: "vcs.showCommit",
      title: "Show Commit in Git Log",
      category: "Git",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        const commit = arg && typeof arg === "object" && "id" in arg ? (arg as import("@/bindings").Commit) : null;
        const id = typeof arg === "string" ? arg : commit?.id;
        if (!id) return;
        const active = maybeEditorService()?.activePath();
        const repo = commit ? commitRepo(commit) : ((active ? repoOf(active) : null) ?? currentRepo());
        showGitWindow();
        void revealCommit(id, repo);
      },
    },
    ...(["gitignore", "localExclude"] as const).map((destination): Action => ({
      id: destination === "gitignore" ? "vcs.ignoreShared" : "vcs.ignoreLocal",
      title: destination === "gitignore" ? "Add to .gitignore" : "Add to .git/info/exclude",
      category: "Git",
      when: VCS,
      keywords: ["ignore", "unversioned", "exclude"],
      run: ({ arg }) => addToIgnore(contextPaths(arg), destination),
    })),
    {
      id: "vcs.addToVcs",
      title: "Add to VCS",
      category: "Git",
      icon: "plus",
      when: VCS,
      keywords: ["git add", "stage"],
      run: ({ arg }) => {
        return addToVcs(contextPaths(arg));
      },
    },
    {
      id: "vcs.stash",
      title: "Stash Changes…",
      category: "Git",
      icon: "stash",
      when: VCS,
      run: () => void stashChanges(),
    },
    {
      id: "vcs.unstash",
      title: "Unstash Changes…",
      category: "Git",
      when: VCS,
      run: () => showUnstashDialog(),
    },
    {
      id: "vcs.resolveConflicts",
      title: "Resolve Conflicts…",
      category: "Git",
      when: VCS,
      keywords: ["merge"],
      run: showConflictsDialog,
    },
    {
      id: "vcs.acceptYours",
      title: "Accept Yours (Conflict at Caret)",
      category: "Git",
      when: "editorTextFocus",
      run: () => void resolveAtCaret("ours"),
    },
    {
      id: "vcs.acceptTheirs",
      title: "Accept Theirs (Conflict at Caret)",
      category: "Git",
      when: "editorTextFocus",
      run: () => void resolveAtCaret("theirs"),
    },
    {
      id: "vcs.acceptBoth",
      title: "Accept Both (Conflict at Caret)",
      category: "Git",
      when: "editorTextFocus",
      run: () => void resolveAtCaret("both"),
    },
    {
      id: "vcs.nextConflict",
      title: "Next Conflict Marker",
      category: "Git",
      when: "editorTextFocus",
      run: () => void gotoConflict(1),
    },
    {
      id: "vcs.prevConflict",
      title: "Previous Conflict Marker",
      category: "Git",
      when: "editorTextFocus",
      run: () => void gotoConflict(-1),
    },
  ];
  const stopTracking = trackFileHistory();
  const unregister = registerActions(actions);
  return () => {
    unregister();
    stopTracking();
  };
}
