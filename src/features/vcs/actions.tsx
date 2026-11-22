import { showShelfDiff } from "./shelf";
import type { Stash } from "@/bindings";
import { commitRepo } from "./multiRoot";
/** VCS actions (ids match keymaps/intellij-macos.ts where bound). */
import { executeAction, registerActions, useRunningActions, type Action } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { loadSettings, useProject } from "@/platform/project";
import { call, commands } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { activeEditor, editorsFor } from "@/editor/api";
import { Menu, type MenuItem } from "@/ui";
import {
  editorService,
  maybeEditorService,
  notifications,
  projectViewSelection,
  toolWindowService,
  type WorktreeReview,
} from "@/workbench/contributions";
import { annotationsShown, toggleAnnotations } from "./blame";
import { showBranchesPopup } from "./BranchWidget";
import { rebaseOntoBranch, type BranchRebaseTarget } from "./branchRebase";
import {
  canCheckoutRevision,
  checkoutAndRebase,
  checkoutRevision,
  deleteTag,
  mergeIntoCurrent,
  newBranch,
  newBranchInRepos,
  pullRemoteBranch,
  pushTag,
  type CheckoutRebaseTarget,
  type CheckoutRevisionScope,
  type RemoteBranchPull,
} from "./branchOps";
import {
  addToVcs,
  addToVcsTargets,
  checkCommitChanges,
  clearStashes,
  commitChanges,
  hasSelectedApplyOperation,
  KEEP_AMEND_COMMIT,
  keepPreparedAmend,
  rollbackCandidates,
  showRollbackDialog,
  stageAllChanges,
  stageWithoutContent,
  stashChanges,
  stashSilently,
  showUnstashAsDialog,
  showUnstashDialog,
} from "./changeOps";
import { setAmend, showsIgnoredFiles, toggleIgnoredFiles, useCommit } from "./commitStore";
import { amendPreviewNode } from "./amendPreview";
import { SELECT_AMEND_TARGET, type EarlierAmend } from "./amendTargets";
import { TOGGLE_IGNORED_FILES } from "./ignoredFiles";
import { currentPlan } from "./commitSelection";
import { canRevertResolved, gotoConflict, resolveAtCaret, revertResolved, showConflictsDialog } from "./conflictsUi";
import { focusedDiffNavigator } from "./diffNavigator";
import { showDiffWindow } from "./DiffWindow";
import {
  changeNodeDiff,
  changeNodeDiffData,
  openDiff,
  openVcsDiff,
  stagingGutterDiffData,
  withChain,
  workingDiffData,
  type DiffData,
} from "./diffInput";
import { buildChangeTree, changeFileNodes, changeGroupPaths, selectedChangeNodes, type ChangeNode } from "./changes";
import { useChangelists } from "./changelists";
import { openDialog } from "./dialogs";
import {
  editableHunk,
  equivalentStagingHunk,
  gotoChange,
  hunksInSelection,
  rollbackSelectedLines,
  updateStagedLines,
  type GutterChangeTarget,
} from "./gutter";
import { openLocalHistory } from "./localHistoryKind";
import { showSelectionHistory } from "./selectionHistoryKind";
import { openLogTab, revealCommit, selectGitTab, useGitLog } from "./logStore";
import { commitFromContext, isModalCommit, openCommit, pushAfterCommit, showLocalChanges } from "./commitUi";
import { allRepos, errorMessage, runRemote, saveAll } from "./ops";
import { showWorktreeComparison } from "./compareTool";
import {
  fetchAndReviewPush,
  showPushDialog,
  showUpdateDialog,
  type PushReviewTarget,
  type PushTarget,
  type UpdateTarget,
} from "./remoteUi";
import { comparePathsWithRevision, showDirectoryWorkingDiff } from "./comparePaths";
import { showCloneDialog } from "./clone";
import { createRepository } from "./createRepository";
import {
  showDefineRemote,
  showManageRemotes,
  showMergeDialog,
  showPullDialog,
  showRebaseDialog,
  type DefineRemoteTarget,
} from "./gitMenuDialogs";
import { showNewWorktree } from "./NewWorktreeDialog";
import { OPEN_WORKTREE_REVIEW } from "./worktreeReviews";
import { currentRepo, currentRepoRoot, refreshNow, repoName, repoOf, statusOf, useVcs } from "./store";
import {
  bulkStagePaths,
  canRestoreUnstaged,
  ROLLBACK_UNSTAGED,
  STAGE_ALL_TRACKED,
  STAGE_WITHOUT_CONTENT,
  STASH_SILENTLY,
  TOGGLE_STAGED_REPOSITORIES,
  stashableRoots,
  stagedRepositoryScope,
  stagingAreaOn,
} from "./staging";
import { stagingRange } from "./stagingRange";
import { focusedStashDiff, showStashDiff, type StashDiffRequest } from "./stashDiff";
import { showStashChanges, type StashEntry } from "./StashChanges";
import { showSyncCommitsForCurrent } from "./SyncCommitsPopup";
import { tx } from "@/platform/i18n";

import { addToIgnore } from "./ignore";
import { hasFileHistory, showCurrentRevision, trackFileHistory } from "./fileRevisions";

const VCS = "vcsAvailable";
const IN_COMMIT_WINDOW = "vcsAvailable && activeToolWindow == commit";

function canStageAll(includeUntracked: boolean): boolean {
  const { running } = useRunningActions.getState();
  return (
    stagingAreaOn() &&
    !useCommit.getState().operation &&
    !running.has(STAGE_ALL_TRACKED) &&
    !running.has("vcs.stageAll") &&
    bulkStagePaths(useVcs.getState().status, includeUntracked).length > 0
  );
}

function argPath(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "path" in arg && typeof (arg as { path: unknown }).path === "string")
    return (arg as { path: string }).path;
  return undefined;
}

/** Whether Git has no commit of the file: unversioned, ignored, or added and not committed yet. */
function hasNoCommits(status: { staged: string | null; unstaged: string | null }): boolean {
  return (
    status.staged === "added" ||
    status.unstaged === "untracked" ||
    status.unstaged === "ignored" ||
    status.staged === "ignored"
  );
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

/** The same grouping the Changes tree uses, for actions invoked outside its row menu. */
export function currentChangeTree(): ChangeNode[] {
  const state = useVcs.getState();
  const commit = useCommit.getState();
  const staging = stagingAreaOn();
  return buildChangeTree(
    state.status,
    state.root ?? "",
    commit.groupByDir,
    staging ? undefined : useChangelists.getState().state,
    state.roots,
    commit.groupByStaging || staging,
    undefined,
    commit.groupByRepo,
    commit.showUnversionedSeparately,
  );
}

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

function unstagedRollbackFiles(arg: unknown) {
  if (!stagingAreaOn()) return [];
  const paths = argPaths(arg) ?? (commitWindowFocused() ? useCommit.getState().unstagedSelection : []);
  return [...new Set(paths)].flatMap((path) => {
    const file = statusOf(path);
    return file && canRestoreUnstaged(file) ? [file] : [];
  });
}

function gutterSelection(arg: unknown): GutterChangeTarget | undefined {
  if (arg && typeof arg === "object" && "view" in arg && "hunks" in arg && "path" in arg) {
    return arg as GutterChangeTarget;
  }
  const editor = activeEditor();
  if (editor) return { view: editor.view, path: editor.ctx.path, hunks: hunksInSelection(editor.view.state) };
}

function gutterTarget(arg: unknown, flag: "staged" | "unstaged"): GutterChangeTarget | undefined {
  const target = gutterSelection(arg);
  if (!target) return;
  const { view, path } = target;
  const hunks = target.hunks.flatMap((hunk) => {
    const live = equivalentStagingHunk(view, hunk);
    return live?.staging?.[flag] && editableHunk(view, live) ? [live] : [];
  });
  return hunks.length ? { view, path, hunks } : undefined;
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
  if (commitWindowFocused() && useCommit.getState().selectionKeys.some((key) => key.startsWith("amend:"))) return [];
  if (commitWindowFocused() && stagingAreaOn() && showsIgnoredFiles(useVcs.getState().root ?? "")) {
    const { selectionKeys } = useCommit.getState();
    if (selectionKeys.length && selectionKeys.every((key) => key === "group:ignored" || key.startsWith("ignored:")))
      return [];
  }
  const project = projectViewSelection();
  return project.length ? project : contextPaths(arg);
}

/** Paths a file action targets: the Project view's selection while it has focus, else the open file. */
function focusedPaths(arg: unknown, ctx: { projectViewFocus?: unknown }): string[] {
  return ctx.projectViewFocus ? selectedPaths(arg) : contextPaths(arg);
}

/**
 * The repository a repository-wide dialog (Pull, Merge, Rebase) starts on: the one holding the
 * action's file, else the Project view's selection while it has focus, else the active editor's
 * file, else the selected repository.
 */
export function operationRepo(arg: unknown): string | null {
  const roots = useVcs.getState().roots;
  if (arg && typeof arg === "object" && "repo" in arg) return (arg as { repo: string | null }).repo;
  const inContext = (paths: readonly string[] | undefined) =>
    paths?.map((p) => repoOf(p, roots)).find((r) => r != null) ?? null;
  const fromProject = getContext().activeToolWindow === "project" ? projectViewSelection() : undefined;
  const active = maybeEditorService()?.activePath();
  return inContext(argPaths(arg)) ?? inContext(fromProject) ?? inContext(active ? [active] : []) ?? currentRepo();
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
  { kind: "action", action: "vcs.revertResolved" },
  { kind: "separator" },
  { kind: "action", action: "vcs.localHistory" },
];

const OPERATIONS_WITHOUT_VCS: MenuItem[] = [
  { kind: "action", action: "vcs.createRepository" },
  { kind: "separator" },
  { kind: "action", action: "vcs.localHistory" },
];

function showOperations() {
  const items = getContext().vcsAvailable ? OPERATIONS : OPERATIONS_WITHOUT_VCS;
  openDialog((close) => <Menu open onClose={close} anchor="center" items={items} title="VCS Operations" numbers />);
}

interface TagTarget {
  tag: string;
  repo: string | null;
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
      run: commitFromContext,
    },
    {
      id: "vcs.runCommitChecks",
      title: "Run Commit Checks",
      category: "Git",
      icon: "check",
      when: VCS,
      enabled: () => !useCommit.getState().operation,
      run: ({ arg }) => {
        if (arg !== "current") openCommit();
        return checkCommitChanges();
      },
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
        if (isModalCommit() || (!message.trim() && !amend && !hasSelectedApplyOperation())) return commitFromContext();
        const committed = await commitChanges(undefined, { requireSyncChecks: true });
        if (committed) await pushAfterCommit(committed);
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
      id: SELECT_AMEND_TARGET,
      title: "Choose Commit to Amend",
      category: "Git",
      enabled: () => useVcs.getState().roots.length === 1 && !useCommit.getState().operation,
      hidden: true,
      run: ({ arg }) => setAmend(true, arg ? (arg as EarlierAmend) : null),
    },
    {
      id: KEEP_AMEND_COMMIT,
      title: "Create Amend Commit Anyway",
      category: "Git",
      hidden: true,
      run: ({ arg }) => keepPreparedAmend(arg),
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
      id: "vcs.createRepository",
      title: "Create Git Repository…",
      category: "Git",
      icon: "branch",
      when: "projectOpen && projectLocal",
      keywords: ["init", "git", "enable version control"],
      run: () => createRepository(),
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
      // File › New › Project from Version Control: the same dialog, under the name the File menu uses.
      id: "vcs.cloneProject",
      title: "Project from Version Control…",
      category: "File",
      icon: "git-pull",
      keywords: ["clone", "checkout", "git", "new project"],
      run: () => showCloneDialog(""),
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
      id: "vcs.push.fetchAndReview",
      title: "Fetch and Review…",
      category: "Git",
      when: VCS,
      enabled: ({ arg }) => Array.isArray(arg) && arg.length > 0,
      run: ({ arg }) => fetchAndReviewPush(arg as PushReviewTarget[]),
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
      run: ({ arg }) => showPullDialog(operationRepo(arg)),
    },
    {
      id: "vcs.pullRemoteBranch",
      title: "Pull…",
      category: "Git",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        const target = arg as RemoteBranchPull | undefined;
        if (target && typeof target.branch === "string" && typeof target.rebase === "boolean")
          return pullRemoteBranch(target);
      },
    },
    {
      id: "vcs.merge",
      title: "Merge…",
      category: "Git",
      when: VCS,
      keywords: ["merge branch"],
      run: ({ arg }) => showMergeDialog(operationRepo(arg)),
    },
    {
      id: "vcs.rebase",
      title: "Rebase…",
      category: "Git",
      when: VCS,
      keywords: ["rebase branch"],
      run: ({ arg }) => showRebaseDialog(operationRepo(arg)),
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
      id: "vcs.defineRemote",
      title: "Define Remote",
      category: "Git",
      when: VCS,
      run: ({ arg }) => showDefineRemote(arg as DefineRemoteTarget | undefined),
    },
    {
      id: "vcs.newWorktree",
      title: "New Worktree…",
      category: "Git",
      when: VCS,
      keywords: ["worktree"],
      run: ({ arg }) =>
        showNewWorktree({
          repo: operationRepo(arg),
          source:
            arg && typeof arg === "object" && "source" in arg && typeof arg.source === "string"
              ? arg.source
              : undefined,
        }),
    },
    {
      id: OPEN_WORKTREE_REVIEW,
      title: "Open Review",
      category: "Git",
      icon: "toolwindow-pull-requests",
      when: VCS,
      hidden: true,
      run: ({ arg }) => (arg as WorktreeReview | undefined)?.open?.(),
    },
    {
      id: "vcs.worktrees",
      title: "Worktrees…",
      category: "Git",
      when: VCS,
      keywords: ["worktree"],
      run: () => {
        selectGitTab("worktrees");
        showGitWindow();
      },
    },
    {
      id: "vcs.fetch",
      title: "Fetch",
      category: "Git",
      icon: "git-fetch",
      when: `${VCS} && !vcsFetchDisabled`,
      enabled: () => !useRunningActions.getState().running.has("vcs.fetch"),
      indicatesRunning: true,
      run: async ({ arg }) => {
        if (arg && typeof arg === "object" && "remote" in arg && typeof arg.remote === "string") {
          await runRemote({ op: "fetchRemote", remote: arg.remote }, arg.remote, [operationRepo(arg)]);
        } else {
          await runRemote({ op: "fetch" }, undefined, allRepos());
        }
      },
    },
    {
      id: "vcs.unshallow",
      title: "Fetch Full History",
      category: "Git",
      icon: "git-fetch",
      when: "vcsAvailable && vcsShallowRepositories",
      keywords: ["shallow clone", "unshallow", "download history"],
      enabled: ({ arg }) => !!useVcs.getState().heads[operationRepo(arg) ?? currentRepoRoot() ?? ""]?.shallow,
      run: async ({ arg }) => {
        const repo = operationRepo(arg) ?? currentRepoRoot();
        if (repo) await runRemote({ op: "unshallow" }, repoName(repo), [repo]);
      },
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
      id: TOGGLE_IGNORED_FILES,
      title: "Show Ignored Files",
      category: "Git",
      when: VCS,
      enabled: () => stagingAreaOn() && !!useVcs.getState().root,
      toggled: () => showsIgnoredFiles(useVcs.getState().root ?? ""),
      run: () => {
        const root = useVcs.getState().root;
        if (root) toggleIgnoredFiles(root);
      },
    },
    {
      id: TOGGLE_STAGED_REPOSITORIES,
      title: "Toggle Repository Inclusion",
      category: "Git",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        const { status, roots } = useVcs.getState();
        const { groupByRepo, excludedStagedRepos } = useCommit.getState();
        const scope = stagedRepositoryScope(status, roots, stagingAreaOn() && groupByRepo);
        if (!scope) return;
        const repos = (argPaths(arg) ?? []).filter((repo) => scope.has(repo));
        if (!repos.length) return;
        const include = repos.some((repo) => excludedStagedRepos.has(repo));
        const next = new Set(excludedStagedRepos);
        for (const repo of repos) {
          if (include) next.delete(repo);
          else next.add(repo);
        }
        useCommit.setState({ excludedStagedRepos: next });
      },
    },
    {
      id: STAGE_ALL_TRACKED,
      title: "Stage All Tracked",
      category: "Git",
      icon: "plus",
      when: VCS,
      indicatesRunning: true,
      enabled: () => canStageAll(false),
      run: () => stageAllChanges(false),
    },
    {
      id: "vcs.stageAll",
      title: "Stage All",
      category: "Git",
      icon: "plus",
      when: VCS,
      indicatesRunning: true,
      enabled: () => canStageAll(true),
      run: () => stageAllChanges(true),
    },
    {
      id: "vcs.toggleCommitAllWhenNothingStaged",
      title: "Commit All when Nothing Is Staged",
      category: "Git",
      when: VCS,
      indicatesRunning: true,
      enabled: () =>
        stagingAreaOn() && !useRunningActions.getState().running.has("vcs.toggleCommitAllWhenNothingStaged"),
      toggled: () => workflowSettings().vcs.commit.commitAllWhenNothingStaged,
      run: async () => {
        const value = !workflowSettings().vcs.commit.commitAllWhenNothingStaged;
        try {
          await call(commands.settingsSet("global", "vcs.commit.commitAllWhenNothingStaged", JSON.stringify(value)));
          await loadSettings();
        } catch (error) {
          notifications().notify({
            group: "vcs",
            level: "error",
            title: "Could not save settings",
            body: errorMessage(error),
          });
        }
      },
    },
    {
      id: STAGE_WITHOUT_CONTENT,
      title: "Stage Without Content",
      category: "Git",
      when: VCS,
      enabled: ({ arg }) => stagingAreaOn() && addToVcsTargets(changedPaths(arg), useVcs.getState().status).length > 0,
      run: ({ arg }) => stageWithoutContent(changedPaths(arg)),
    },
    {
      id: ROLLBACK_UNSTAGED,
      title: "Rollback Unstaged Changes",
      category: "Git",
      icon: "undo",
      when: VCS,
      enabled: ({ arg }) => unstagedRollbackFiles(arg).length > 0,
      run: ({ arg }) => {
        const files = unstagedRollbackFiles(arg);
        if (files.length) showRollbackDialog(files, undefined, "unstaged");
      },
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
        if (!explicit?.length && ed?.view.hasFocus) {
          if (rollbackSelectedLines(ed.view, ed.ctx.path) || stagingAreaOn()) return;
        }
        // The Commit window's subject is its tree selection; when the selection holds
        // nothing rollbackable (unversioned files, stale paths), the checked changes are
        // instead — as IDEA's toolbar Rollback acts on the checked changes there.
        const focused = commitWindowFocused();
        if (focused && stagingAreaOn() && !explicit?.length) {
          void executeAction(ROLLBACK_UNSTAGED, useCommit.getState().unstagedSelection);
          return;
        }
        const sel = useCommit.getState().selection;
        const fromSel = focused && sel.length ? rollbackCandidates(sel) : null;
        const paths = explicit?.length
          ? explicit
          : fromSel?.length
            ? sel
            : focused
              ? currentPlan().included.map((f) => f.path)
              : undefined;
        if (paths?.length) return showRollbackDialog(rollbackCandidates(paths));
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
      // In the Git Log's changed files it shows the commit's diff instead.
      keyWhen: "!editorTextFocus && !diffEditorFocus && !vcsLogChangesFocus && !vcsLogRevisionFocus",
      run: async ({ arg, ctx }) => {
        if (ctx.shelfFocus && arg === undefined) return showShelfDiff();
        const stash = arg === undefined ? focusedStashDiff() : null;
        if (stash) return showStashDiff(stash, workflowSettings().vcs.git.stashDiffTarget);
        if (arg === undefined && getContext().activeToolWindow === "commit") {
          const { amend, amendPreview, groupByDir, selectionKeys } = useCommit.getState();
          if (amend && amendPreview && selectionKeys.some((key) => key.startsWith("amend:"))) {
            const { roots, heads } = useVcs.getState();
            const node = amendPreviewNode(amendPreview, groupByDir, roots, heads[amendPreview.root]?.headCommit);
            const file = node && changeFileNodes(selectedChangeNodes([node], new Set(selectionKeys)))[0];
            if (node && file) return openVcsDiff(changeNodeDiffData([node], file), { preview: true });
          }
        }
        const line =
          arg && typeof arg === "object" && "line" in arg ? Number((arg as { line: unknown }).line) : undefined;
        const paths = selectedPaths(arg);
        if (!paths.length) {
          notifications().notify({ group: "vcs", level: "info", title: "Select a changed file to show its diff" });
          return;
        }
        if (await showDirectoryWorkingDiff(paths)) return;
        const tree = currentChangeTree();
        // The selected rows while the tree has focus: a file under Staged or Unstaged diffs that side.
        const targets = showDiffTargets(tree, paths, !argPaths(arg)?.length && commitWindowFocused());
        // The modal interface has one front diff window (#1863): a file with its group
        // as the F7 chain, or several selected files as the chain.
        if (isModalCommit()) {
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
        for (const target of targets.slice(0, 5)) {
          const data = typeof target === "string" ? groupDiffData(tree, target) : changeNodeDiffData(tree, target);
          await openVcsDiff({ ...data, line }, { preview: targets.length === 1 });
        }
      },
    },
    {
      id: "vcs.showDiffInNewWindow",
      title: "Show Diff in New Window",
      category: "Git",
      icon: "diff",
      when: VCS,
      keyWhen: "!editorTextFocus",
      run: ({ arg }) => {
        const requested = arg && typeof arg === "object" && "left" in arg && "right" in arg ? (arg as DiffData) : null;
        const path = selectedPaths(arg)[0];
        const data = requested ?? focusedDiffNavigator()?.viewer?.()?.data ?? (path ? workingDiffData(path) : null);
        if (!data) {
          notifications().notify({ group: "vcs", level: "info", title: "Select a changed file to show its diff" });
          return;
        }
        showDiffWindow(data, () => void openDiff(data, { preview: true }));
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
      id: "vcs.diffWithWorkingTree",
      title: "Show Diff with Working Tree",
      category: "Git",
      when: VCS,
      hidden: true,
      run: async ({ arg }) => {
        const target = arg as { rev?: string; label?: string; repositories?: readonly string[] } | undefined;
        if (!target?.rev) return;
        const project = useProject.getState().project;
        const repo = currentRepoRoot();
        const repositories = target.repositories ?? (repo ? [repo] : undefined);
        await saveAll();
        if (useProject.getState().project !== project) return;
        showWorktreeComparison(target.rev, target.label ?? target.rev, repositories);
      },
    },
    {
      id: "vcs.compareWithRevision",
      title: "Compare with Revision…",
      category: "Git",
      icon: "diff",
      when: VCS,
      enabled: ({ arg }) => hasFileHistory(argPath(arg) ?? maybeEditorService()?.activePath()),
      run: ({ arg }) => {
        const path = argPath(arg) ?? maybeEditorService()?.activePath();
        void import("./FileRevisionChooser").then((m) => m.compareWithFileRevision(path));
      },
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
      id: "vcs.stageGutterChange",
      title: "Stage Change",
      category: "Git",
      icon: "plus",
      when: VCS,
      enabled: ({ arg }) => !!gutterTarget(arg, "unstaged"),
      run: ({ arg }) => {
        const target = gutterTarget(arg, "unstaged");
        if (target) return updateStagedLines(target, "stage");
      },
    },
    {
      id: "vcs.unstageGutterChange",
      title: "Unstage Change",
      category: "Git",
      icon: "minus",
      when: VCS,
      enabled: ({ arg }) => !!gutterTarget(arg, "staged"),
      run: ({ arg }) => {
        const target = gutterTarget(arg, "staged");
        if (target) return updateStagedLines(target, "unstage");
      },
    },
    {
      // The diff of the file at the changed lines under the caret or selection (the change marker popup's Show Diff).
      id: "vcs.showDiffForLines",
      title: "Show Diff for Lines",
      category: "Git",
      icon: "diff",
      when: VCS,
      enabled: ({ arg }) => !!gutterSelection(arg)?.hunks.length,
      run: async ({ arg }) => {
        const target = gutterSelection(arg);
        const hunk = target?.hunks[0];
        if (!target || !hunk) return;
        const { view, path } = target;
        const { state } = view;
        const head = state.selection.main.head;
        const line = hunk.from <= head && head <= hunk.to ? state.doc.lineAt(head).number - 1 : hunk.start;
        if (!hunk.staging) return executeAction("vcs.showDiff", { path, line });
        const live = equivalentStagingHunk(view, hunk);
        const range = live && editableHunk(view, live) && stagingRange(live, state.doc);
        if (!range) return;
        const { openDiffDialog } = await import("./diffDialog");
        openDiffDialog(stagingGutterDiffData(path, line, range));
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
      // As in IDEA, a file Git has no commit of (unversioned, ignored, or added and not yet
      // committed) has nothing to annotate; shown annotations can always be closed.
      enabled: ({ arg }) => {
        const ed = activeEditor();
        const path = argPath(arg) ?? ed?.ctx.path;
        if (!path || (ed?.ctx.path === path && annotationsShown(ed.view))) return true;
        const status = statusOf(path);
        return !status || !hasNoCommits(status);
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
      id: "vcs.rebaseOntoBranch",
      title: "Rebase Current Branch",
      category: "Git",
      when: VCS,
      hidden: true,
      enabled: ({ arg }) => !!(arg as BranchRebaseTarget | undefined)?.branch,
      run: ({ arg }) => rebaseOntoBranch(arg as BranchRebaseTarget),
    },
    {
      id: "vcs.checkoutAndRebase",
      title: "Checkout and Rebase",
      category: "Git",
      when: VCS,
      hidden: true,
      enabled: ({ arg }) => !!(arg as CheckoutRebaseTarget | undefined)?.branch,
      run: ({ arg }) => void checkoutAndRebase(arg as CheckoutRebaseTarget),
    },
    {
      id: "vcs.checkoutRevision",
      title: "Checkout Tag or Revision…",
      category: "Git",
      when: VCS,
      enabled: ({ arg }) => canCheckoutRevision(arg as CheckoutRevisionScope | undefined),
      run: ({ arg }) => checkoutRevision(arg as CheckoutRevisionScope | undefined),
    },
    {
      id: "vcs.mergeTag",
      title: "Merge Tag",
      category: "Git",
      when: VCS,
      hidden: true,
      enabled: ({ arg }) => typeof (arg as TagTarget | undefined)?.tag === "string",
      run: ({ arg }) => {
        const { tag, repo } = arg as TagTarget;
        return mergeIntoCurrent(tag, repo, `refs/tags/${tag}`);
      },
    },
    {
      id: "vcs.pushTag",
      title: "Push Tag",
      category: "Git",
      when: VCS,
      hidden: true,
      enabled: ({ arg }) => typeof (arg as { remote?: string } | undefined)?.remote === "string",
      run: ({ arg }) => {
        const { tag, repo, remote } = arg as TagTarget & { remote: string };
        return pushTag(tag, remote, repo);
      },
    },
    {
      id: "vcs.deleteTag",
      title: "Delete Tag",
      category: "Git",
      when: VCS,
      hidden: true,
      enabled: ({ arg }) => typeof (arg as TagTarget | undefined)?.tag === "string",
      run: ({ arg }) => {
        const { tag, repo } = arg as TagTarget;
        return deleteTag(tag, repo);
      },
    },
    {
      id: "vcs.showConsole",
      title: "Show Git Console",
      category: "Git",
      icon: "terminal",
      when: VCS,
      run: () => {
        selectGitTab("console");
        showGitWindow();
      },
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
      run: ({ arg, ctx }) => {
        const path = focusedPaths(arg, ctx)[0];
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
    {
      id: "vcs.syncCommits",
      title: "Show Incoming and Outgoing Commits",
      category: "Git",
      icon: "history",
      when: VCS,
      keywords: ["incoming", "outgoing", "ahead", "behind", "unpushed", "unpulled"],
      run: ({ arg }) => showSyncCommitsForCurrent(arg === "incoming" || arg === "outgoing" ? arg : undefined),
    },
    ...(["gitignore", "localExclude"] as const).map((destination): Action => ({
      id: destination === "gitignore" ? "vcs.ignoreShared" : "vcs.ignoreLocal",
      title: destination === "gitignore" ? "Add to .gitignore" : "Add to .git/info/exclude",
      category: "Git",
      when: VCS,
      keywords: ["ignore", "unversioned", "exclude"],
      run: ({ arg, ctx }) => addToIgnore(focusedPaths(arg, ctx), destination),
    })),
    {
      id: "vcs.addToVcs",
      title: "Add to VCS",
      category: "Git",
      icon: "plus",
      when: VCS,
      keywords: ["git add", "stage"],
      run: ({ arg, ctx }) => addToVcs(focusedPaths(arg, ctx)),
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
      id: STASH_SILENTLY,
      title: "Stash Silently",
      category: "Git",
      icon: "stash",
      when: VCS,
      indicatesRunning: true,
      enabled: () => {
        const { status, roots } = useVcs.getState();
        return (
          stagingAreaOn() &&
          !useRunningActions.getState().running.has(STASH_SILENTLY) &&
          stashableRoots(status, roots).length > 0
        );
      },
      run: () => stashSilently(),
    },
    {
      id: "vcs.stashSelected",
      title: "Stash Selected Files…",
      category: "Git",
      icon: "stash",
      when: VCS,
      run: ({ arg }) => {
        const paths = changedPaths(arg);
        if (!paths.length) {
          notifications().notify({
            group: "vcs",
            level: "info",
            title: tx("Select the files to stash in the Commit view first"),
          });
          return;
        }
        void stashChanges(paths);
      },
    },
    {
      id: "vcs.stash.showChanges",
      title: "Show Changes",
      category: "Git",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        if (arg) showStashChanges(arg as StashEntry);
      },
    },
    {
      id: "vcs.stash.showDiff",
      title: "Show Diff",
      category: "Git",
      icon: "diff",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        if (arg) return showStashDiff(arg as StashDiffRequest, workflowSettings().vcs.git.stashDiffTarget);
      },
    },
    {
      id: "vcs.stash.compareWithLocal",
      title: "Compare with Local",
      category: "Git",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        if (arg) return showStashDiff(arg as StashDiffRequest, "local");
      },
    },
    {
      id: "vcs.showStashes",
      title: "Show Stash",
      category: "Git",
      when: VCS,
      run: () => showLocalChanges("stashes"),
    },
    {
      id: "vcs.clearStashes",
      title: "Clear Stashes…",
      category: "Git",
      when: VCS,
      hidden: true,
      run: async ({ arg }) => {
        if (arg === null || typeof arg === "string") await clearStashes(arg);
      },
    },
    {
      id: "vcs.unstashAs",
      title: "Unstash As…",
      category: "Git",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        const stash = arg as (Stash & { repo: string | null }) | undefined;
        if (stash?.id) showUnstashAsDialog(stash, stash.repo);
      },
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
      run: ({ arg }) => showConflictsDialog(arg),
    },
    {
      id: "vcs.revertResolved",
      title: "Revert Resolved",
      category: "Git",
      icon: "undo",
      when: VCS,
      enabled: ({ arg }) => canRevertResolved(selectedPaths(arg)),
      run: ({ arg }) => void revertResolved(selectedPaths(arg)),
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
