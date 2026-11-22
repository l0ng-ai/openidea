/** Local change operations: commit, rollback, add, stash. */
import { useEffect, useId, useState } from "react";
import type { CommitApplyKind, CommitSelection, FileStatus, Stash } from "@/bindings";
import { attachDocument } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { call, commands, IpcError, isTauri } from "@/platform/ipc";
import { Button, Checkbox, Dialog, Input, Radio, T } from "@/ui";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { groupOf, remainingOverrides, renamedFromPath } from "./changes";
import { runCommitChecks, runCommitModifications, syncCommitEdits } from "./commitChecks";
import { contributedCheckProblems, currentPlan, selectionOf } from "./commitSelection";
import {
  captureCommitDraft,
  keepMessageAfterCommit,
  rememberMessage,
  sameCommitDraft,
  setAmend,
  useCommit,
} from "./commitStore";
import type { UnstashConflictContext } from "./conflictsUi";
import { workflowSettings } from "@/platform/workflowSettings";
import { useTodoSettings } from "@/platform/todo";
import { todoFilterSelection } from "@/platform/todoFilterSelection";
import { notifyFileOperation } from "@/platform/fileOps";
import { useProject } from "@/platform/project";
import { confirmDialog, openDialog } from "./dialogs";
import { validateBranchName } from "./branchOps";
import { useBranches, useBranchInfo } from "./gitMenuDialogs";
import { RepoPicker } from "./RepoPicker";
import { baseName, effectiveKind, stripSlash } from "./model";
import { errorMessage, logConsole, runOp, saveAll } from "./ops";
import { ensureCommitIdentity } from "./commitIdentity";
import { startPostCommitChecks, startPostCommitTests } from "./postCommitChecks";
import { commitTestSelection } from "./commitTests";
import { commitTodoRules } from "./commitTodo";
import { controlLabel, controlOperation } from "./operations";
import { FileChecklist } from "./shelf";
import { currentRepo, loadStashes, refreshNow, repoName, useVcs } from "./store";
import styles from "./common.module.css";
import rollbackStyles from "./RollbackDialog.module.css";
import unstashStyles from "./UnstashDialog.module.css";
import { tx, txTemplate } from "@/platform/i18n";
import type { EarlierAmend } from "./amendTargets";
import { inspectSubmoduleRollback } from "./submoduleRollback";
import { bulkStagePaths, stashableRoots, stagingAreaOn } from "./staging";

export function firstLine(message: string): string {
  return (
    message
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? ""
  );
}

export interface CommittedRepository {
  repo: string | null;
  id: string;
  continuedApply?: true;
}

export const KEEP_AMEND_COMMIT = "vcs.keepAmendCommit";
const AMEND_CONFLICT_NOTICE = "vcs.amendConflict";
const KEEP_AMEND_LABEL = "Create Amend Commit Anyway";

interface AmendRecovery {
  commit: string;
  root: string;
  projectIsOpen: () => boolean;
  finish: () => void;
  unsubscribe: () => void;
}

let amendRecovery: AmendRecovery | null = null;

function expireAmendRecovery() {
  if (!amendRecovery) return;
  amendRecovery.unsubscribe();
  amendRecovery = null;
  notifications().expire?.(AMEND_CONFLICT_NOTICE);
}

function offerAmendRecovery(commit: string, target: EarlierAmend, projectIsOpen: () => boolean, finish: () => void) {
  expireAmendRecovery();
  const { root } = target;
  const unsubscribe = useVcs.subscribe((state) => {
    const head = state.heads[root];
    if (
      !projectIsOpen() ||
      !state.roots.includes(root) ||
      (head && (head.headCommit !== target.head.commit || head.head !== target.head.branch))
    )
      expireAmendRecovery();
  });
  amendRecovery = { root, commit, finish, unsubscribe, projectIsOpen };
  notifications().notify({
    key: AMEND_CONFLICT_NOTICE,
    group: "vcs",
    level: "error",
    title: "Amend commit failed",
    body: (
      <T>Amending this commit would cause a conflict. You can keep the prepared changes as a separate amend commit.</T>
    ),
    actions: [{ label: KEEP_AMEND_LABEL, run: () => void executeAction(KEEP_AMEND_COMMIT, commit) }],
    userInitiated: true,
  });
}

export async function keepPreparedAmend(commit: unknown): Promise<void> {
  const recovery = amendRecovery;
  if (!recovery || recovery.commit !== commit || !recovery.projectIsOpen() || useCommit.getState().operation) return;
  useCommit.setState({ operation: "commit" });
  try {
    const kept = await runOp(
      KEEP_AMEND_LABEL,
      () => call(commands.vcsKeepAmendCommit(recovery.root, recovery.commit)),
      {
        success: "Amend commit created",
        onError: (message) => {
          notifications().notify({
            group: "vcs",
            level: "error",
            title: "Could not keep the prepared amend commit",
            body: txTemplate(message),
            userInitiated: true,
          });
          return true;
        },
      },
    );
    if (kept !== undefined) {
      if (amendRecovery === recovery) expireAmendRecovery();
      recovery.finish();
    }
  } finally {
    useCommit.setState({ operation: null });
  }
}

/** Stages the included changes and returns the commit made in each repository. */
export function commitChanges(
  onEmpty?: () => void,
  { requireSyncChecks = false } = {},
): Promise<CommittedRepository[] | undefined> {
  return runCommitOperation("commit", onEmpty, requireSyncChecks);
}

export async function checkCommitChanges(): Promise<void> {
  await runCommitOperation("check");
}

async function runCommitOperation(
  operation: "commit" | "check",
  onEmpty?: () => void,
  requireSyncChecks = false,
): Promise<CommittedRepository[] | undefined> {
  const { amend, amendPreview, operation: active } = useCommit.getState();
  if (active || (amend && amendPreview?.status === "loading")) return;
  useCommit.setState({ operation });
  try {
    return await prepareAndCommit(operation === "check", onEmpty, requireSyncChecks);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    const message = errorMessage(error);
    logConsole("err", message);
    notifications().notify({ group: "vcs", level: "error", title: message });
    return undefined;
  } finally {
    useCommit.setState({ operation: null });
  }
}

function selectedApplyOperations(repositories: readonly (string | null)[]) {
  const { root, roots, operations } = useVcs.getState();
  return repositories.flatMap<{ repo: string; op: CommitApplyKind }>((target) => {
    const repo = target ?? roots[0] ?? root;
    const op = repo ? operations[repo] : null;
    return repo && (op === "cherry-pick" || op === "revert") ? [{ repo, op }] : [];
  });
}

export function hasSelectedApplyOperation(): boolean {
  return selectedApplyOperations(currentPlan().repositories).length > 0;
}

async function prepareAndCommit(
  onlyChecks: boolean,
  onEmpty: (() => void) | undefined,
  requireSyncChecks: boolean,
): Promise<CommittedRepository[] | undefined> {
  const draft = useCommit.getState();
  const messageDraft = captureCommitDraft();
  const commitSettings = workflowSettings().vcs.commit;
  const todoSettings = useTodoSettings.getState();
  const todoFilter = todoFilterSelection("commit");
  const todoRules = commitSettings.checkTodo ? commitTodoRules(todoSettings, todoFilter) : null;
  const clearMessage = commitSettings.clearInitialMessage;
  const { message, amend } = draft;
  const { project, settings } = useProject.getState();
  const projectIsOpen = () => useProject.getState().project === project;
  const current = () => {
    const active = useProject.getState();
    return (
      project === active.project &&
      settings === active.settings &&
      (!todoRules || (todoSettings === useTodoSettings.getState() && todoFilter === todoFilterSelection("commit"))) &&
      sameCommitDraft(draft, useCommit.getState())
    );
  };
  const requested = stagingAreaOn() ? currentPlan() : null;
  await saveAll();
  await refreshNow();
  if (!current()) return;
  const plan = currentPlan();
  if (
    requested?.stagedRepositorySelection &&
    (requested.repositories.length !== plan.repositories.length ||
      plan.repositories.some((repo) => !requested.repositories.includes(repo)))
  ) {
    notifications().notify({
      group: "vcs",
      level: "warning",
      title: "Staged repositories changed. Review the commit selection and try again.",
    });
    return undefined;
  }
  const apply = onlyChecks ? [] : selectedApplyOperations(plan.repositories);
  if (apply.length) {
    if (plan.repositories.length > 1) {
      notifications().notify({
        group: "vcs",
        level: "warning",
        title: "Review paused Git operations separately",
        userInitiated: true,
        actions: apply.map(({ repo, op }) => ({
          label: `${controlLabel(op, "continue")} · ${repoName(repo)}`,
          run: () => void controlOperation("continue", op, repo),
        })),
      });
      return undefined;
    }
    const { repo, op } = apply[0]!;
    const before = useVcs.getState().heads[repo]?.headCommit;
    const useDraft = !amend && !plan.partial.length;
    const finished = await controlOperation("continue", op, repo, {
      message: useDraft ? message : "",
      paths: new Set(plan.included.map((file) => stripSlash(file.path))),
      options: {
        author: useDraft ? draft.author : null,
        authorDate: useDraft ? draft.authorDate : null,
        signOff: draft.signOff,
        runHooks: draft.runHooks,
      },
    });
    if (!finished || !projectIsOpen()) return undefined;
    const { heads, operations } = useVcs.getState();
    const head = heads[repo]?.headCommit;
    if (!head || head === before || operations[repo]) return undefined;
    if (finished.draftMessage !== undefined)
      finishCommitDraft(messageDraft, plan.included, clearMessage, finished.draftMessage);
    return [{ repo, id: head, continuedApply: true }];
  }
  if (!message.trim() && !amend) {
    useCommit.setState((s) => ({ focusTick: s.focusTick + 1 }));
    if (onEmpty) onEmpty();
    else notifications().notify({ group: "vcs", level: "warning", title: "Commit message is empty" });
    return undefined;
  }
  const preview = draft.amendPreview;
  const amended =
    draft.amendTarget ??
    (preview?.status === "ready" ? { root: preview.root, head: { commit: preview.expectedHead } } : null);
  if (amend && amended) {
    const { heads, roots } = useVcs.getState();
    const head = heads[amended.root]?.headCommit;
    if (roots.length !== 1 || roots[0] !== amended.root || (head !== undefined && head !== amended.head.commit)) {
      notifications().notify({
        group: "vcs",
        level: "warning",
        title: "HEAD changed. Reopen Amend to review the new commit.",
      });
      return undefined;
    }
  }
  // Concluding a merge needs no further changes (e.g. every conflict resolved as "yours").
  const merging = useVcs.getState().branch?.operation === "merge";
  if (!plan.repositories.length || (!plan.included.length && !amend && !merging)) {
    notifications().notify({ group: "vcs", level: "warning", title: "No changes selected for commit" });
    return undefined;
  }
  const unresolved = plan.included.filter((f) => effectiveKind(f) === "conflicted");
  if (unresolved.length) {
    notifications().notify({
      group: "vcs",
      level: "warning",
      title: "Resolve merge conflicts before committing",
      body: unresolved.map((f) => baseName(f.path)).join(", "),
    });
    return undefined;
  }
  // IDEA: failed checks show in the commit panel; the next Commit ("Commit Anyway") skips them.
  const previous = useCommit.getState().checkResult;
  const checked = onlyChecks || !previous?.blocked || previous.stale;
  const staticChecks = commitSettings.analyzeCode || commitSettings.checkTodo;
  const testSelection = commitSettings.nonModal ? commitTestSelection() : null;
  const postpone =
    !!project &&
    isTauri() &&
    !onlyChecks &&
    !requireSyncChecks &&
    !draft.amendTarget &&
    commitSettings.nonModal &&
    (staticChecks || testSelection?.enabled) &&
    commitSettings.postponeSlowChecks &&
    (checked || previous?.deferredAdvancedChecks === true);
  let partialModifications = checked ? [] : (previous.partialModifications ?? []);
  let pending: Promise<CommitSelection> | undefined;
  const prepareSelection = () =>
    (pending ??= selectionOf(plan).then((selection) => {
      if (!partialModifications.length) return selection;
      const modified = new Map(partialModifications.map(({ path, prepared }) => [path, prepared]));
      for (const { options } of selection.repositories) {
        options.partial = options.partial?.map((file) => {
          const prepared = modified.get(stripSlash(file.path));
          return prepared ? { ...file, prepared } : file;
        });
      }
      return selection;
    }));
  let review = null;
  if (checked) {
    useCommit.setState({ checkResult: null });
    partialModifications = await runCommitModifications(plan.included, () => selectionOf(plan));
    if (!current()) return;
    const result = await runCommitChecks(
      plan.included,
      amend,
      prepareSelection,
      postpone ? { advancedChecks: "omit" } : undefined,
    );
    review = {
      ...result,
      ...(partialModifications.length ? { partialModifications } : {}),
      ...(postpone ? { deferredAdvancedChecks: true as const } : {}),
    };
    if (!current()) return;
    if (review.blocked) {
      useCommit.setState({ checkResult: review });
      return;
    }
  } else if (previous.deferredAdvancedChecks && !postpone) {
    const result = await runCommitChecks(plan.included, amend, prepareSelection, { advancedChecks: "only" });
    if (!current()) return;
    if (result.blocked) {
      useCommit.setState({ checkResult: { ...result, partialModifications } });
      return;
    }
  }
  // After the checks: their modifications (reformat…) are part of the commit.
  const selection = await prepareSelection();
  if (review) {
    const problems = await contributedCheckProblems(selection);
    if (!current()) return;
    if (problems.length) {
      useCommit.setState({ checkResult: { ...review, problems: [...review.problems, ...problems], blocked: true } });
      return;
    }
    if (onlyChecks || review.problems.length) useCommit.setState({ checkResult: review });
  }
  if (onlyChecks || !current()) return;
  if (
    !(await ensureCommitIdentity(
      selection.repositories.map((r) => r.root || null),
      amend,
    ))
  )
    return undefined;
  if (!current()) return;
  const testTargets: { repo: string; id: string; replaced: string | null }[] = [];
  const committed = await runOp(
    amend ? "Amend commit" : "Commit",
    async () => {
      const commits: CommittedRepository[] = [];
      for (const repo of selection.repositories) {
        const root = repo.root || null;
        const checkRoot = root ?? useVcs.getState().root;
        const replaced = amend && checkRoot ? (useVcs.getState().heads[checkRoot]?.headCommit ?? null) : null;
        const id = await call(commands.vcsCommit(root, message.trim(), repo.options));
        commits.push({ repo: root, id });
        if (postpone && checkRoot && projectIsOpen()) {
          if (staticChecks)
            void startPostCommitChecks(
              checkRoot,
              id,
              { analyzeCode: commitSettings.analyzeCode, todo: todoRules },
              replaced,
            );
          if (testSelection?.enabled) testTargets.push({ repo: checkRoot, id, replaced });
        }
        for (const file of repo.options.partial ?? []) {
          if (!file.prepared || !projectIsOpen()) continue;
          const modification = partialModifications.find((item) => item.prepared === file.prepared);
          if (!modification) continue;
          const { path, workingBefore, workingEdits } = modification;
          try {
            const committedText = await call(commands.vcsFileAt(path, id));
            if (committedText?.replace(/\r\n?/g, "\n") !== file.prepared.text) continue;
            await syncCommitEdits(path, workingBefore, workingEdits, projectIsOpen);
          } catch (error) {
            logConsole("info", `Before-commit edits skipped for ${baseName(path)}: ${errorMessage(error)}`);
          }
        }
      }
      return commits;
    },
    {
      onError: (_message, error) => {
        const data = error instanceof IpcError ? error.data : null;
        if (draft.amendTarget && data?.type === "amendConflict" && projectIsOpen()) {
          offerAmendRecovery(data.commit, draft.amendTarget, projectIsOpen, () => {
            if (current()) finishCommitDraft(messageDraft, plan.included, clearMessage);
            else if (projectIsOpen() && useCommit.getState().amendTarget === draft.amendTarget) void setAmend(false);
          });
          return true;
        }
        return false;
      },
      success: () => {
        const n = plan.included.length;
        const summary = firstLine(message);
        const several = selection.repositories.length;
        const done = amend
          ? several > 1
            ? n === 1
              ? tx`1 file amended in ${several} repositories`
              : tx`${n} files amended in ${several} repositories`
            : n === 1
              ? tx("1 file amended")
              : tx`${n} files amended`
          : several > 1
            ? n === 1
              ? tx`1 file committed in ${several} repositories`
              : tx`${n} files committed in ${several} repositories`
            : n === 1
              ? tx("1 file committed")
              : tx`${n} files committed`;
        return summary ? `${done}: ${summary}` : done;
      },
    },
  );
  if (testSelection?.enabled && testTargets.length && projectIsOpen()) startPostCommitTests(testTargets, testSelection);
  if (committed !== undefined) finishCommitDraft(messageDraft, plan.included, clearMessage);
  return committed;
}

function finishCommitDraft(
  draft: ReturnType<typeof captureCommitDraft>,
  included: readonly FileStatus[],
  clear: boolean,
  message = draft.message,
) {
  rememberMessage(message, draft.root);
  keepMessageAfterCommit(message, clear, draft);
  if (useVcs.getState().root !== draft.root) return;
  // What the user left out of this commit stays left out; only the committed changes start over.
  const { checks: userChecks, excludedHunks, excludedHunkLines } = useCommit.getState();
  useCommit.setState({
    checks: remainingOverrides(userChecks, included),
    excludedHunks: remainingOverrides(excludedHunks, included),
    excludedHunkLines: remainingOverrides(excludedHunkLines, included),
    checkResult: null,
  });
}

/** Delete… on unversioned files in the Changes view, as in IDEA: they move to the Trash. */
/** Delete… in the Changes view: moves the files to the Trash (a tracked file then shows as deleted). */
export async function deleteFiles(paths: readonly string[]) {
  if (!paths.length) return;
  const question = paths.length === 1 ? tx`Delete '${baseName(paths[0]!)}'?` : tx`Delete ${paths.length} items?`;
  const ok = await confirmDialog({
    title: "Delete",
    okLabel: "Delete",
    danger: true,
    message: (
      <>
        {question}
        <br />
        <T>Items are moved to the Trash.</T>
      </>
    ),
  });
  if (!ok) return;
  await runOp("Delete", async () => {
    for (const path of paths) {
      await call(commands.fsDelete(path));
      notifyFileOperation({ kind: "deleted", paths: [path] });
    }
  });
}

/** Files the Rollback action applies to by default. */
export function rollbackCandidates(
  paths?: readonly string[],
  status: readonly FileStatus[] = useVcs.getState().status,
): FileStatus[] {
  const changed = status.filter((f) => {
    const g = groupOf(f);
    return g === "changes" || g === "conflicts";
  });
  if (!paths?.length) return changed;
  const set = new Set(paths.map(stripSlash));
  // A selected change is just that change; other paths are folders and take the changes below them.
  const entries = new Set(status.map((f) => stripSlash(f.path)));
  const folders = [...set].filter((s) => !entries.has(s));
  return changed.filter((f) => {
    const p = stripSlash(f.path);
    return set.has(p) || folders.some((s) => p.startsWith(s + "/"));
  });
}

/**
 * Paths to unstage and to discard for Rollback. A staged rename rolls back both
 * sides (the old file is restored); added files become unversioned after
 * unstaging and are only deleted when asked to.
 */
export function rollbackPlan(
  files: readonly FileStatus[],
  deleteAdded: boolean,
): { unstage: string[]; discard: string[] } {
  const unstage: string[] = [];
  const discard: string[] = [];
  for (const f of files) {
    const path = stripSlash(f.path);
    const from = f.staged === "renamed" ? renamedFromPath(f) : null;
    if (f.staged) unstage.push(path, ...(from ? [from] : []));
    if (from) discard.push(path, from);
    else if (f.staged !== "added" || deleteAdded) discard.push(path);
  }
  return { unstage, discard };
}

export function showRollbackDialog(files: FileStatus[], onDone?: () => void, scope: "all" | "unstaged" = "all") {
  if (!files.length) {
    notifications().notify({ group: "vcs", level: "info", title: "No changes to roll back" });
    onDone?.();
    return;
  }
  openDialog((close) => <RollbackDialog files={files} onClose={close} onDone={onDone} scope={scope} />);
}

function RollbackDialog({
  files,
  onClose,
  onDone,
  scope,
}: {
  files: FileStatus[];
  onClose: () => void;
  onDone?: () => void;
  scope: "all" | "unstaged";
}) {
  const [selected, setSelected] = useState(() => new Set(files.map((f) => f.path)));
  const [deleteAdded, setDeleteAdded] = useState(false);
  const [restoreCheckouts, setRestoreCheckouts] = useState(true);
  const [submodules, setSubmodules] = useState<Awaited<ReturnType<typeof inspectSubmoduleRollback>> | null>(null);
  useEffect(() => {
    let live = true;
    void inspectSubmoduleRollback(files, useVcs.getState().roots, scope).then((plans) => {
      if (live) setSubmodules(plans);
    });
    return () => {
      live = false;
    };
  }, [files, scope]);
  const visible = files.filter((file) => {
    const plan = submodules?.get(file.path);
    return !plan || plan.indexPaths.length || plan.worktree.length;
  });
  const selectedFiles = visible.filter((file) => selected.has(file.path));
  const checkout = restoreCheckouts || scope === "unstaged";
  const selectedWorktrees = selectedFiles.flatMap((file) => submodules?.get(file.path)?.worktree ?? []);
  const selectedCheckouts = selectedWorktrees.filter((worktree) => !worktree.missing).map((worktree) => worktree.path);
  const chosen = selectedFiles.filter((file) => {
    const plan = submodules?.get(file.path);
    return !plan || plan.indexPaths.length || (checkout && plan.worktree.length);
  });
  const normal = chosen.filter((file) => !submodules?.has(file.path));
  const addedFiles = normal.some((file) => effectiveKind(file) === "added");
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const file of chosen) {
    const kind = scope === "unstaged" ? file.unstaged : effectiveKind(file);
    counts[kind === "added" || kind === "deleted" ? kind : "modified"]++;
  }
  const { added, modified, deleted } = counts;
  const cancel = () => {
    onClose();
    onDone?.();
  };
  const run = async () => {
    if (!submodules || !chosen.length) return;
    onClose();
    try {
      await runOp(
        tx("Rollback"),
        async () => {
          const gitlinks = new Set<string>();
          for (const file of chosen) {
            const plan = submodules.get(file.path);
            if (!plan) continue;
            for (const path of plan.indexPaths) gitlinks.add(path);
            if (checkout) for (const { path } of plan.worktree) gitlinks.add(path);
          }
          const savePaths = new Set(
            scope === "unstaged" ? normal.filter((file) => file.unstaged !== "deleted").map((file) => file.path) : [],
          );
          if (checkout && selectedCheckouts.length) {
            const open = maybeEditorService()?.openPaths?.() ?? [];
            for (const path of open) {
              if (selectedCheckouts.some((root) => path.startsWith(root + "/"))) savePaths.add(path);
            }
          }
          for (const path of savePaths) {
            const document = await attachDocument(path).catch(() => null);
            try {
              if (document?.dirty()) await document.save({ exact: true });
            } finally {
              document?.release();
            }
          }
          if (scope === "unstaged") {
            if (normal.length) await call(commands.vcsRestoreUnstaged(normal.map((file) => stripSlash(file.path))));
          } else if (normal.length) {
            const { unstage, discard } = rollbackPlan(normal, deleteAdded);
            await saveAll();
            if (unstage.length) await call(commands.vcsUnstage(unstage));
            if (discard.length) await call(commands.vcsDiscard(discard));
          }
          if (gitlinks.size) {
            await call(commands.vcsRollbackSubmodules([...gitlinks], scope === "all" ? "head" : "index", checkout));
          }
        },
        {
          refresh: false,
          success: chosen.length === 1 ? tx("Rolled back 1 file") : tx`Rolled back ${chosen.length} files`,
        },
      );
      await refreshNow();
    } finally {
      onDone?.();
    }
  };
  return (
    <Dialog
      open
      title={scope === "unstaged" ? "Rollback Unstaged Changes" : "Rollback Changes"}
      onClose={cancel}
      className={rollbackStyles.dialog}
      width={540}
      minWidth={320}
      minHeight={240}
      resizable="both"
      buttons={[
        { label: "Rollback", role: "default", disabled: !submodules || !chosen.length, onClick: () => void run() },
        { label: "Close", role: "cancel" },
      ]}
    >
      <div className={rollbackStyles.content}>
        <FileChecklist
          files={visible}
          selected={selected}
          onChange={setSelected}
          label="Files to roll back"
          className={rollbackStyles.tree}
        />
        <div className={rollbackStyles.summary} role="status">
          {!chosen.length && <T>No files selected</T>}
          {added > 0 && <span className={rollbackStyles.added}>{tx`${added} added`}</span>}
          {modified > 0 && <span className={rollbackStyles.modified}>{tx`${modified} modified`}</span>}
          {deleted > 0 && <span className={rollbackStyles.deleted}>{tx`${deleted} deleted`}</span>}
        </div>
        {scope === "all" && (
          <Checkbox
            checked={addedFiles && deleteAdded}
            disabled={!addedFiles}
            onChange={setDeleteAdded}
            label="Delete local copies of added files"
          />
        )}
        {scope === "all" && selectedWorktrees.length > 0 && (
          <Checkbox
            checked={restoreCheckouts}
            onChange={setRestoreCheckouts}
            label="Restore selected submodule checkouts"
          />
        )}
        {visible.length < files.length && (
          <p className={rollbackStyles.warning}>
            <T>Select changed files inside a submodule to roll back its local edits.</T>
          </p>
        )}
        {normal.length > 0 && (
          <p className={rollbackStyles.warning}>
            {scope === "unstaged" ? (
              <T>Rollback replaces the selected files with their staged versions.</T>
            ) : (
              <T>Rollback discards uncommitted changes in the selected files.</T>
            )}
          </p>
        )}
        {checkout && selectedCheckouts.length > 0 && (
          <p className={rollbackStyles.warning}>
            <T>Restoring a submodule checkout may detach its HEAD. Git preserves conflicting local edits.</T>
          </p>
        )}
        {checkout && selectedWorktrees.some((worktree) => worktree.missing) && (
          <p className={rollbackStyles.warning}>
            <T>
              Rollback recreates missing submodule directories. Initialize those submodules to populate their files.
            </T>
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Add to VCS targets: the unversioned files among `paths` or below a selected
 * directory. Tracked changes inside a directory are not staged (unlike `git add -A dir`).
 */
export function addToVcsTargets(paths: readonly string[], status: readonly FileStatus[]): string[] {
  const untracked = status.filter((f) => effectiveKind(f) === "untracked").map((f) => stripSlash(f.path));
  const out = new Set<string>();
  for (const raw of paths) {
    const p = stripSlash(raw);
    for (const u of untracked) if (u === p || u.startsWith(`${p}/`)) out.add(u);
  }
  return [...out];
}

/** Stages unversioned files (`git add`). */
export async function addToVcs(paths: readonly string[]) {
  const targets = addToVcsTargets(paths, useVcs.getState().status);
  if (!targets.length) {
    notifications().notify({
      group: "vcs",
      level: "info",
      title: "Nothing to add: the files are already under version control",
    });
    return;
  }
  await runOp(targets.length === 1 ? tx("Add 1 file to Git") : tx`Add ${targets.length} files to Git`, () =>
    call(commands.vcsStage(targets.map(stripSlash))),
  );
}

export async function stageWithoutContent(paths: readonly string[]) {
  const targets = addToVcsTargets(paths, useVcs.getState().status);
  if (targets.length) await runOp(tx("Stage Without Content"), () => call(commands.vcsStageWithoutContent(targets)));
}

export async function stageAllChanges(includeUntracked: boolean) {
  const project = useProject.getState().project;
  await runOp(includeUntracked ? tx("Stage All") : tx("Stage All Tracked"), async () => {
    await saveAll();
    if (useProject.getState().project !== project) return;
    const status = await call(commands.vcsStatus());
    if (useProject.getState().project !== project) return;
    const paths = bulkStagePaths(status, includeUntracked);
    if (paths.length) await call(commands.vcsStage(paths));
  });
}

export async function stashSilently() {
  const project = useProject.getState().project;
  await runOp(tx("Stash Silently"), async () => {
    await saveAll();
    if (useProject.getState().project !== project) return;
    const status = await call(commands.vcsStatus());
    const stashed: string[] = [];
    for (const root of stashableRoots(status, useVcs.getState().roots)) {
      if (useProject.getState().project !== project) return;
      const name = repoName(root);
      const result = await runOp(
        tx`Stash changes in ${name}`,
        () => call(commands.vcsStashPush(root, null, false, false, null)),
        { refresh: false },
      );
      if (result !== undefined) stashed.push(name);
    }
    if (!stashed.length || useProject.getState().project !== project) return;
    void loadStashes().catch(() => undefined);
    notifications().notify({
      group: "vcs",
      userInitiated: true,
      level: "info",
      title: tx("Changes stashed"),
      body: stashed.join(", "),
      actions: [{ label: tx("Show Stashes"), run: () => void executeAction("vcs.showStashes") }],
    });
  });
}

/**
 * Stash Changes dialog: message, Keep index (staged changes stay), include untracked files.
 * `repo`: the repository it starts on; selected `paths` stash in the repositories holding them.
 */
export function stashChanges(paths: readonly string[] = [], repo = currentRepo()): Promise<void> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <StashDialog
        initialRepo={repo}
        pickRepo={!paths.length}
        onDone={async (r) => {
          close();
          if (r) {
            await saveAll();
            await runOp(
              tx("Stash changes"),
              () =>
                call(
                  commands.vcsStashPush(
                    r.repo,
                    r.message || null,
                    r.includeUntracked,
                    r.keepIndex,
                    paths.length ? [...paths] : null,
                  ),
                ),
              { success: tx("Changes stashed") },
            );
            void loadStashes().catch(() => undefined);
          }
          resolve();
        }}
      />
    ));
  });
}

function StashDialog({
  initialRepo,
  pickRepo,
  onDone,
}: {
  initialRepo: string | null;
  pickRepo: boolean;
  onDone: (r: { repo: string | null; message: string; keepIndex: boolean; includeUntracked: boolean } | null) => void;
}) {
  const [repo, setRepo] = useState(initialRepo);
  const [message, setMessage] = useState("");
  const [keepIndex, setKeepIndex] = useState(false);
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const showRepo = useVcs((s) => pickRepo && s.roots.length > 1);
  const branch = useBranchInfo(repo)?.head ?? null;
  const messageId = useId();
  const submit = () => onDone({ repo, message: message.trim(), keepIndex, includeUntracked });
  return (
    <Dialog
      open
      title="Stash"
      onClose={() => onDone(null)}
      width={440}
      buttons={[
        { label: "Create Stash", role: "default", onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={`${styles.form} ${styles.stashForm}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {showRepo && (
          <div className={styles.stashRepo}>
            <T>Repository:</T>
            <RepoPicker repo={repo} onChange={setRepo} />
          </div>
        )}
        {branch && <div className={styles.stashBranch}>{tx`Current branch: ${branch}`}</div>}
        <div className={styles.stashMessage}>
          <label htmlFor={messageId}>
            <T>Message:</T>
          </label>
          <textarea
            id={messageId}
            className={styles.textarea}
            data-autofocus
            aria-label={tx("Message")}
            placeholder={tx("WIP")}
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        <div className={styles.stashOptions}>
          <Checkbox checked={keepIndex} onChange={setKeepIndex} label="Keep index" />
          <Checkbox checked={includeUntracked} onChange={setIncludeUntracked} label="Include untracked files" />
        </div>
      </form>
    </Dialog>
  );
}

export interface UnstashOptions {
  index: number;
  /** Drop the stash after applying it. */
  pop: boolean;
  /** Also restore what was staged. */
  reinstateIndex: boolean;
  /** Apply on a new branch created at the stash's base commit (implies pop and reinstate index). */
  branch: string | null;
}

/** What an unstash does, for its progress title and success message. */
export function unstashTitles(o: UnstashOptions): { title: string; success: string } {
  const ref = `stash@{${o.index}}`;
  if (o.branch)
    return { title: tx`Unstash ${ref} as branch ${o.branch}`, success: tx`Unstashed ${ref} on branch ${o.branch}` };
  return o.pop
    ? { title: tx`Pop ${ref}`, success: tx`Unstashed ${ref}` }
    : { title: tx`Apply ${ref}`, success: tx`Applied ${ref}` };
}

async function unstash(stash: Stash, options: Omit<UnstashOptions, "index">, repo: string | null) {
  const project = useProject.getState().project?.root;
  await saveAll();
  if (project !== useProject.getState().project?.root) return;
  const completed = await runOp(
    unstashTitles({ ...options, index: stash.index }).title,
    () => call(commands.vcsStashApply(repo, stash, options.pop, options.reinstateIndex, options.branch)),
    {
      success: ({ outcome, index }) => (outcome.kind === "done" ? unstashTitles({ ...options, index }).success : ""),
    },
  );
  if (completed?.outcome.kind === "conflicts") {
    await refreshNow();
    if (project !== useProject.getState().project?.root) return;
    void executeAction("vcs.resolveConflicts", {
      repo: completed.outcome.repository,
      index: completed.index,
      message: stash.message,
    } satisfies UnstashConflictContext);
  }
  void loadStashes().catch((e) => logConsole("err", String(e)));
}

export function applyStash(stash: Stash, pop: boolean, repo = currentRepo()) {
  return unstash(stash, { pop, reinstateIndex: false, branch: null }, repo);
}

/** Unstash Changes dialog: pick a stash; Pop, Reinstate index, or As new branch; view or drop it. */
export function showUnstashDialog(index = 0, repo = currentRepo()) {
  openDialog((close) => <UnstashDialog initial={index} repo={repo} onClose={close} />);
}

export function showUnstashAsDialog(stash: Stash, repo: string | null) {
  openDialog((close) => <UnstashDialog initial={stash.index} repo={repo} fixed={stash} onClose={close} />);
}

function UnstashDialog({
  initial,
  repo: initialRepo,
  fixed,
  onClose,
}: {
  initial: number;
  repo: string | null;
  fixed?: Stash;
  onClose: () => void;
}) {
  const id = useId();
  const [{ repo, index }, setSelection] = useState({ repo: initialRepo, index: initial });
  const roots = useVcs((s) => s.roots);
  const projectRoot = useVcs((s) => s.root);
  const root = repo ?? roots[0] ?? projectRoot;
  const head = useBranchInfo(repo);
  const branches = useBranches(repo);
  const currentBranch = head?.head ?? (head?.headCommit ? tx("Detached HEAD") : "—");
  const [loaded, setLoaded] = useState<{ repo: string | null; tick: number; stashes: Stash[] } | null>(null);
  const [tick, setTick] = useState(0);
  const [dropping, setDropping] = useState(false);
  const stashes = loaded?.repo === repo ? loaded.stashes : null;
  const loading = !fixed && (stashes === null || loaded?.tick !== tick);
  useEffect(() => {
    if (fixed) return;
    let live = true;
    void call(commands.vcsStashes(repo))
      .then((stashes) => live && setLoaded({ repo, tick, stashes }))
      .catch((e) => {
        if (live) setLoaded({ repo, tick, stashes: [] });
        logConsole("err", String(e));
      });
    return () => {
      live = false;
    };
  }, [repo, tick, fixed]);
  const [pop, setPop] = useState(false);
  const [reinstateIndex, setReinstateIndex] = useState(false);
  const [branch, setBranch] = useState("");
  const asBranch = branch.trim();
  const branchError = asBranch ? validateBranchName(asBranch, false, branches) : null;
  const chosen = fixed ?? stashes?.find((s) => s.index === index) ?? stashes?.[0];
  const ready = !!chosen && !loading && !dropping;
  const chooseRepo = (next: string) => {
    if (root === next || dropping) return;
    setSelection({ repo: next, index: 0 });
    setLoaded(null);
    setBranch("");
  };
  const view = () => {
    if (!ready || !chosen) return;
    void executeAction("vcs.stash.showChanges", { ...chosen, repo });
  };
  const drop = async () => {
    if (!ready || !chosen || !stashes) return;
    setDropping(true);
    try {
      const next = await dropStash(chosen, repo);
      if (next === undefined) return;
      if (next !== null) {
        setSelection((selection) => (selection.repo === repo ? { repo, index: next } : selection));
      }
      setTick((n) => n + 1);
    } finally {
      setDropping(false);
    }
  };
  const clear = async () => {
    if (loading || dropping || !stashes?.length) return;
    setDropping(true);
    try {
      if (!(await clearStashes(repo))) return;
      setSelection((selection) => (selection.repo === repo ? { repo, index: 0 } : selection));
      setTick((n) => n + 1);
    } finally {
      setDropping(false);
    }
  };
  const submit = () => {
    if (!ready || !chosen || branchError) return;
    onClose();
    void unstash(chosen, { pop, reinstateIndex, branch: asBranch || null }, repo);
  };
  return (
    <Dialog
      open
      title={fixed && repo ? tx`Unstash Changes in ${repoName(repo)}` : "Unstash Changes"}
      onClose={onClose}
      width={600}
      buttons={[
        {
          label: asBranch ? "Create Branch" : pop ? "Pop Stash" : "Apply Stash",
          role: "default",
          disabled: !ready || !!branchError,
          onClick: submit,
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={unstashStyles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {roots.length > 1 && !fixed ? (
          <>
            <label className={unstashStyles.label} htmlFor={`${id}-repo`}>
              <T>Repository:</T>
            </label>
            <RepoPicker id={`${id}-repo`} repo={repo} onChange={chooseRepo} />
          </>
        ) : (
          <>
            <span className={unstashStyles.label}>
              <T>Repository:</T>
            </span>
            <span className={unstashStyles.fact}>{root ? repoName(root) : "—"}</span>
          </>
        )}
        <span className={unstashStyles.label}>
          <T>Current branch:</T>
        </span>
        <span className={unstashStyles.fact} title={currentBranch}>
          {currentBranch}
        </span>
        {fixed ? (
          <div className={unstashStyles.options}>{fixed.message}</div>
        ) : (
          <>
            <span className={unstashStyles.listLabel} id={`${id}-stashes`}>
              <T>Stashes:</T>
            </span>
            <div className={unstashStyles.stashPanel}>
              <div
                className={unstashStyles.stashes}
                role="radiogroup"
                aria-labelledby={`${id}-stashes`}
                aria-busy={loading || dropping}
              >
                {stashes?.length ? (
                  stashes.map((stash) => {
                    const name = `stash@{${stash.index}}: ${stash.message}`;
                    return (
                      <Radio
                        key={stash.index}
                        className={unstashStyles.stash}
                        name={`${id}-stash`}
                        checked={chosen?.index === stash.index}
                        disabled={loading || dropping}
                        onChange={() => setSelection({ repo, index: stash.index })}
                        label={
                          <span className={unstashStyles.stashText} title={name}>
                            {name}
                          </span>
                        }
                      />
                    );
                  })
                ) : (
                  <div className={unstashStyles.status}>
                    <T>{stashes === null ? "Loading…" : "No stashes"}</T>
                  </div>
                )}
              </div>
              <div className={unstashStyles.actions}>
                <Button disabled={!ready} onClick={view}>
                  Show Changes
                </Button>
                <Button disabled={!ready} onClick={() => void drop()}>
                  Drop Stash
                </Button>
                <Button disabled={!ready} onClick={() => void clear()}>
                  Clear Stashes…
                </Button>
              </div>
            </div>
          </>
        )}
        <div className={unstashStyles.options}>
          <Checkbox checked={pop || !!asBranch} disabled={!!asBranch} onChange={setPop} label="Pop stash" />
          <Checkbox
            checked={reinstateIndex || !!asBranch}
            disabled={!!asBranch}
            onChange={setReinstateIndex}
            label="Reinstate index"
          />
        </div>
        <label className={unstashStyles.label} htmlFor={`${id}-branch`}>
          <T>As new branch:</T>
        </label>
        <Input
          id={`${id}-branch`}
          mono
          aria-invalid={!!branchError}
          aria-describedby={branchError ? `${id}-branch-error` : undefined}
          aria-label={tx("As new branch")}
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
        {branchError && (
          <div id={`${id}-branch-error`} className={`${unstashStyles.options} ${styles.error}`} role="alert">
            {tx(branchError)}
          </div>
        )}
      </form>
    </Dialog>
  );
}

/** Returns the removed index, null after a failed drop, or undefined on cancellation. */
export async function dropStash(stash: Stash, repo = currentRepo()): Promise<number | null | undefined> {
  const project = useProject.getState().project?.root;
  const ref = `stash@{${stash.index}}`;
  const { message } = stash;
  const ok = await confirmDialog({
    title: "Drop Stash",
    message: message ? tx`Drop ${ref} “${message}”? This cannot be undone.` : tx`Drop ${ref}? This cannot be undone.`,
    okLabel: "Drop",
    danger: true,
  });
  if (!ok || project !== useProject.getState().project?.root) return;
  const removed = await runOp(tx`Drop ${ref}`, () => call(commands.vcsStashDrop(repo, stash)), {
    success: (index) => tx`Dropped ${`stash@{${index}}`}`,
  });
  void loadStashes().catch((e) => logConsole("err", String(e)));
  return removed ?? null;
}

export async function clearStashes(repo: string | null): Promise<boolean> {
  const project = useProject.getState().project?.root;
  const repository = repo ? repoName(repo) : null;
  const confirmed = await confirmDialog({
    title: "Clear Stashes",
    message: repository
      ? tx`Clear all stashes in ${repository}? This cannot be undone.`
      : tx("Clear all stashes in this repository? This cannot be undone."),
    okLabel: "Clear",
    danger: true,
  });
  if (!confirmed || project !== useProject.getState().project?.root) return false;
  const result = await runOp(tx("Clear Stashes"), () => call(commands.vcsStashClear(repo)), {
    success: tx("Stashes cleared"),
  });
  if (result === undefined) return false;
  void loadStashes().catch((e) => logConsole("err", String(e)));
  return true;
}
