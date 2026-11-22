/**
 * Version control (Git) feature: status decorations, title bar branch widget,
 * editor change markers / annotations, Commit and Git tool windows, diff,
 * merge and Local History editors, remote operations.
 */
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { useTodoSettings } from "@/platform/todo";
import { editorsFor, registerEditorContribution } from "@/editor/api";
import {
  notifications,
  provideChangesViewSelection,
  registerEditorKind,
  registerMenuGroup,
  registerOverlay,
  registerTitleItem,
  registerToolWindow,
} from "@/workbench/contributions";
import { executeAction, registerActions } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { lazyComponent } from "@/ui";
import { commitWindowFocused, registerVcsActions } from "./actions";
import { installChangelists } from "./changelists";
import { registerHistoryActions, trackOperationContext } from "./historyActions";
import { registerLogPaneActions } from "./logPaneActions";
import {
  BRANCH_COMPARISON_KIND,
  branchComparisonTitle,
  comparisonPaneIds,
  type BranchComparisonData,
} from "./CompareBranches";
import { controlLabel, controlOperation, inProgress, installOperationNoticeExpiry } from "./operations";
import { annotationsShown, blameSlot } from "./blame";
import { activateRevisionAnnotations } from "./annotateRevisionProvider";
import { inlineBlame } from "./inlineBlame";
import { BranchWidget, BranchesPopupHost, useBranchesPopup } from "./BranchWidget";
import { SyncCommitsPopupHost } from "./SyncCommitsPopup";
import { clearUnstashConflictNotices, showConflictsDialog } from "./conflictsUi";
import { registerCompareActions } from "./compare";
import { activateDiffViewer } from "./diffViewer";
import { installDiffEditorHost } from "./DiffWindow";
import { VcsDialogHost } from "./dialogs";
import { changeMarkers } from "./gutter";
import { installHunkPopup } from "./HunkPopup";
import { LOCAL_HISTORY_KIND } from "./localHistoryKind";
import { DIRECTORY_COMPARE_KIND, directoryCompareTitle, type DirectoryCompareData } from "./directoryCompareKind";
import { SELECTION_HISTORY_KIND, type SelectionHistoryData } from "./selectionHistoryKind";
import { registerLocalHistoryActions } from "./localHistoryActions";
import { MERGE_KIND, type MergeData } from "./mergeKind";
import { registerMergeActions } from "./mergeActions";
import { baseName, stripSlash } from "./model";
import { installCommitChecks } from "./commitChecks";
import { installDiagnosticsTracking } from "./commitAnalysis";
import { installPostCommitChecks } from "./postCommitChecks";
import { installCommitMessages, useCommit } from "./commitStore";
import { installDraftRevision, provideCommit } from "./commitSelection";
import { activate as activateConflictBanner } from "./conflictBanner";
import { registerWorktreeIncludeEditor } from "./worktreeInclude";
import { activate as activateConflictMarkers } from "./conflictMarkers";
import { MergeRebaseWidget } from "./MergeRebaseWidget";
import { installFileConfirmations } from "./confirmations";
import { installIncomingCheck } from "./incoming";
import { closeLogTab, installGitLog, selectGitTab, useGitLog } from "./logStore";
import {
  currentRepoRoot,
  existsOnDisk,
  installVcsStore,
  onConflictsChanged,
  onConflictsCleared,
  repoOf,
  selectRepo,
  useVcs,
} from "./store";
import { installRootSync } from "./rootSync";
import { tx } from "@/platform/i18n";
import { openOnRemoteActions, registerOpenOnRemote } from "./openOnRemote";
import { copyRepositoryPathActions, registerCopyRepositoryPath } from "./copyRepositoryPath";
import { activateSettingsPages } from "./settingsPages";
import { registerStagedEditor } from "./StagedEditor";

/** The Resolve/Continue/Abort buttons exist in the title bar only while there is something to resolve. */
function trackMergeRebaseItem(): () => void {
  let dispose: (() => void) | null = null;
  const sync = () => {
    const s = useVcs.getState();
    const needed =
      s.available && (!!inProgress(s.branch?.operation) || s.status.some((f) => f.unstaged === "conflicted"));
    if (needed && !dispose) {
      dispose = registerTitleItem({
        id: "vcs.mergeRebase",
        title: "Merge/Rebase Widget",
        align: "left",
        priority: 11,
        component: MergeRebaseWidget,
      });
    } else if (!needed && dispose) {
      dispose();
      dispose = null;
    }
  };
  sync();
  const unsub = useVcs.subscribe(sync);
  return () => {
    unsub();
    dispose?.();
  };
}

function trackTitleItem(): () => void {
  let dispose: (() => void) | null = null;
  const sync = (available: boolean) => {
    if (available && !dispose) {
      dispose = registerTitleItem({
        id: "vcs.branch",
        title: "VCS Widget",
        align: "left",
        priority: 10,
        component: BranchWidget,
      });
    } else if (!available && dispose) {
      dispose();
      dispose = null;
      useBranchesPopup.setState({ open: false });
    }
  };
  sync(useVcs.getState().available);
  const unsub = useVcs.subscribe((s, p) => {
    if (s.available !== p.available) sync(s.available);
  });
  return () => {
    unsub();
    dispose?.();
  };
}

/**
 * The Commit tool window exists with the non-modal commit interface only; with the
 * modal one its tabs move to the Git tool window (and Commit… opens a dialog).
 */
function trackCommitWindow(): () => void {
  let dispose: (() => void) | null = null;
  const sync = (nonModal: boolean) => {
    if (nonModal && !dispose) {
      dispose = registerToolWindow({
        id: "commit",
        title: "Commit",
        icon: "toolwindow-commit",
        anchor: "left",
        order: 1,
        component: lazyComponent(() => import("./CommitView").then((m) => m.CommitToolWindow)),
        headerContent: lazyComponent(() => import("./CommitView").then((m) => m.CommitTabs)),
        tabsReplaceTitle: true,
        useBadge: () => {
          const n = useVcs((s) => s.status.length);
          return n || null;
        },
      });
      // The Git window's Local Changes / Shelf / Stash tabs are gone: back to its Log.
      if (["changes", "shelf", "stashes"].includes(useGitLog.getState().tab)) selectGitTab("log");
    } else if (!nonModal && dispose) {
      dispose();
      dispose = null;
    }
  };
  sync(workflowSettings().vcs.commit.nonModal);
  const unsub = onWorkflowSettingsChange((w) => w.vcs.commit.nonModal, sync);
  return () => {
    unsub();
    dispose?.();
  };
}

function conflictsBody(names: string[]): string {
  const list = names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "");
  return names.length === 1
    ? tx`${names.length} file has conflicts: ${list}`
    : tx`${names.length} files have conflicts: ${list}`;
}

export function activate(): () => void {
  let resolvedNoticeRepo: string | null = null;
  onConflictsChanged((files) => {
    resolvedNoticeRepo = null;
    notifications().notify({
      group: "vcs",
      level: "warning",
      key: "vcs.conflicts",
      title: "Merge conflicts",
      body: conflictsBody(files.map((f) => baseName(f.path))),
      sticky: true,
      actions: [{ label: "Resolve…", run: showConflictsDialog }],
    });
  });

  onConflictsCleared((files) => {
    notifications().expire?.("vcs.conflicts");
    const { operations, resolvedConflicts } = useVcs.getState();
    const roots = files.map((file) => repoOf(file.path)).filter((root) => root && inProgress(operations[root] ?? null));
    const selected = currentRepoRoot();
    const repo = selected && roots.includes(selected) ? selected : (roots[0] ?? null);
    const op = repo && inProgress(operations[repo] ?? null);
    resolvedNoticeRepo = op ? repo : null;
    if (op && repo)
      notifications().notify({
        group: "vcs",
        level: "info",
        key: "vcs.conflicts",
        title: "All conflicts resolved",
        sticky: true,
        actions: [
          ...(resolvedConflicts.size ? [{ label: "Review Resolved Conflicts…", run: showConflictsDialog }] : []),
          op === "merge"
            ? { label: "Commit…", run: () => void selectRepo(repo).then(() => executeAction("vcs.commit")) }
            : { label: controlLabel(op, "continue"), run: () => void controlOperation("continue", op, repo) },
          { label: controlLabel(op, "abort"), run: () => void controlOperation("abort", op, repo) },
        ],
      });
  });

  useCommit.setState({ signOff: workflowSettings().vcs.git.signOff });
  const disposers = [
    installVcsStore(),
    clearUnstashConflictNotices,
    installOperationNoticeExpiry(() => resolvedNoticeRepo),
    installRootSync(),
    installGitLog(),
    installDiagnosticsTracking(),
    installCommitChecks(),
    useTodoSettings.subscribe(() => {
      if (workflowSettings().vcs.commit.checkTodo) useCommit.setState({ checkResult: null });
    }),
    installPostCommitChecks(),
    installCommitMessages(),
    installDraftRevision(),
    provideCommit(),
    // Deployment shortcuts (and similar) use this while Commit / Local Changes is focused.
    provideChangesViewSelection(() => {
      if (!commitWindowFocused()) return [];
      // As the context menu: deleted files have nothing to upload.
      const deleted = new Set(
        useVcs
          .getState()
          .status.filter((f) => !existsOnDisk(f))
          .map((f) => f.path),
      );
      return useCommit
        .getState()
        .selection.filter((p) => !deleted.has(p))
        .map(stripSlash);
    }),
    installIncomingCheck(),
    installFileConfirmations(),
    installDiffEditorHost(),
    // Settings › Git › Sign-off commit: the default of Commit Options › Sign-off Commit.
    onWorkflowSettingsChange(
      (w) => w.vcs.git.signOff,
      (signOff) => useCommit.setState({ signOff }),
    ),
    registerVcsActions(),
    registerActions(openOnRemoteActions),
    registerOpenOnRemote(),
    registerActions(copyRepositoryPathActions),
    registerCopyRepositoryPath(),
    registerHistoryActions(),
    registerLogPaneActions(),
    activateSettingsPages(),
    registerLocalHistoryActions(),
    installChangelists(),
    trackOperationContext(),
    registerCompareActions(),
    registerMergeActions(),
    trackTitleItem(),
    trackMergeRebaseItem(),
    installHunkPopup(),
    registerOverlay({ id: "vcs.dialogs", component: VcsDialogHost }),
    registerOverlay({ id: "vcs.branches", component: BranchesPopupHost }),
    registerOverlay({ id: "vcs.syncCommits", component: SyncCommitsPopupHost }),
    activateConflictBanner(),
    registerWorktreeIncludeEditor(),
    activateConflictMarkers(),
    trackCommitWindow(),
    registerToolWindow({
      id: "git",
      title: "Git",
      icon: "toolwindow-git",
      anchor: "bottom",
      order: 5,
      component: lazyComponent(() => import("./GitLog").then((m) => m.GitToolWindow)),
      headerContent: lazyComponent(() => import("./GitLog").then((m) => m.GitTabs)),
    }),
    registerEditorKind({
      kind: "git-revision",
      standalone: true,
      component: lazyComponent(() => import("./RevisionBrowser").then((m) => m.GitRevisionEditor)),
      title: (input) => {
        const data = input.data as { path: string; revision: string };
        return `${baseName(data.path)} (${data.revision.slice(0, 8)})`;
      },
      icon: () => "file",
      restorable: true,
    }),
    registerEditorKind({
      kind: "git-log",
      standalone: true,
      component: lazyComponent(() => import("./LogScope").then((m) => m.GitLogEditor)),
      title: (input) => (input.data as { label: string }).label,
      icon: () => "toolwindow-git",
      restorable: true,
      onClose: (input) => closeLogTab((input.data as { id: string }).id),
    }),
    registerEditorKind({
      kind: BRANCH_COMPARISON_KIND,
      component: lazyComponent(() => import("./BranchComparisonEditor").then((m) => m.BranchComparisonEditor)),
      title: (input) => branchComparisonTitle(input.data as BranchComparisonData),
      icon: () => "diff",
      restorable: true,
      onClose: (input) => comparisonPaneIds(input.key).forEach(closeLogTab),
    }),
    registerEditorKind({
      kind: "git-merge-diff",
      standalone: true,
      component: lazyComponent(() => import("./GitMergeDiff").then((m) => m.GitMergeDiff)),
      title: (input) => (input.data as { path: string }).path,
      icon: () => "diff",
      restorable: true,
    }),
    activateDiffViewer(),
    registerStagedEditor(),
    activateRevisionAnnotations(),
    registerEditorKind({
      kind: MERGE_KIND,
      component: lazyComponent(() => import("./MergeEditor").then((m) => m.MergeEditor)),
      title: (input) => `Merge: ${baseName((input.data as MergeData).path)}`,
      icon: () => "branch",
    }),
    registerEditorKind({
      kind: DIRECTORY_COMPARE_KIND,
      component: lazyComponent(() => import("./DirectoryCompare").then((m) => m.DirectoryCompareEditor)),
      title: (input) => directoryCompareTitle(input.data as DirectoryCompareData),
      icon: () => "diff",
      restorable: true,
    }),
    registerEditorKind({
      kind: LOCAL_HISTORY_KIND,
      component: lazyComponent(() => import("./LocalHistory").then((m) => m.LocalHistoryEditor)),
      title: (input) => `Local History: ${baseName((input.data as { path: string }).path)}`,
      icon: () => "clock",
    }),
    registerEditorKind({
      kind: SELECTION_HISTORY_KIND,
      component: lazyComponent(() => import("./SelectionHistory").then((m) => m.SelectionHistoryEditor)),
      title: (input) => {
        const { path, lines } = input.data as SelectionHistoryData;
        return `History: ${baseName(path)}:${lines[0] + 1}-${lines[1] + 1}`;
      },
      icon: () => "history",
    }),
    registerEditorContribution({
      id: "vcs.changeMarkers",
      order: 60,
      extensions: (ctx) => [changeMarkers(ctx), blameSlot(), inlineBlame(ctx)],
    }),
    registerMenuGroup({
      id: "vcs.gutter",
      menus: ["editorGutter"],
      order: 10,
      items: (_menu, { paths: [path] }) => {
        if (!path || !getContext().vcsAvailable) return [];
        const shown = editorsFor(path).some((h) => annotationsShown(h.view));
        return [
          {
            label: shown ? "Close Annotations" : "Annotate with Git Blame",
            run: () => void executeAction("vcs.annotate", path),
          },
        ];
      },
    }),
  ];
  return () => {
    onConflictsChanged(() => undefined);
    disposers.reverse().forEach((d) => d());
  };
}
