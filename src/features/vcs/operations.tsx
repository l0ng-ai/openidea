import { commitKey, commitRepo, type RepoCommit } from "./multiRoot";
/**
 * Operations on history: Continue / Abort / Skip of a stopped merge, rebase,
 * cherry-pick or revert, and the Git Log commit actions (Cherry-Pick, Revert
 * Commit, Reset Current Branch to Here, New Tag, Compare with Local).
 */
import { useEffect, useId, useMemo, useState } from "react";
import type {
  ApplyCommitOptions,
  ChangedFile,
  Commit,
  CompareResult,
  GitOperation,
  HistoryTip,
  ResetMode,
} from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands, IpcError, isCancelled, isTauri, nextRequestId } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { workflowSettings } from "@/platform/workflowSettings";
import { Button, Checkbox, Dialog, Icon, Input, Radio, Select, Spinner, T, Toolbar } from "@/ui";
import { useFilePresentation } from "@/ui/filePresentation";
import { notifications } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";
import { windowBackgroundHex } from "@/workbench/theme";
import { diffInput, openVcsDiff, vcsDiffInFront, type DiffData, type DiffSide } from "./diffInput";
import { confirmDialog, openDialog, promptText } from "./dialogs";
import { KIND_COLOR, fileCount } from "./model";
import {
  describeOperation,
  emptyCherryPickFeedback,
  errorMessage,
  logConsole,
  runGitOperation,
  runGitOperationWith,
  runOp,
  type GitOperationOptions,
} from "./ops";
import { resumeRebaseWithEditor } from "./rebaseEditor";
import { pausedBranchRebase } from "./branchRebase";
import { loadLogDetails } from "./logDetails";
import { isProtectedRemoteBranch } from "./branches";
import { showLocalChanges } from "./commitUi";
import { checkReviewedApply, modifyReviewedApply } from "./applyCommitChecks";
import { ensureCommitIdentity } from "./commitIdentity";
import { promptApplyCommitMessage } from "./CommitMessageDialog";
import { reloadLog, useGitLog } from "./logStore";
import {
  conflictedFiles,
  currentRepo,
  currentRepoRoot,
  refreshNow,
  repoName,
  repoOf,
  selectRepo,
  useVcs,
} from "./store";
import styles from "./common.module.css";
import resetStyles from "./ResetDialog.module.css";
import tagStyles from "./TagDialog.module.css";
import { ComparisonTree } from "./ComparisonTree";
import { showWorktreeComparison } from "./compareTool";
import { buildFileTree, type FileTreeNode } from "./fileTree";
import { tx, txPart } from "@/platform/i18n";
import { displayPath } from "./compareData";
import { repositoryPath } from "./repositoryPaths";
import { RepoPicker } from "./RepoPicker";
import { openRevisionFile } from "./revisionInput";
import { ipcPath } from "@/platform/paths";

// ---------------------------------------------------------------------------
// Operation in progress

export type InProgress = "rebase" | "merge" | "cherry-pick" | "revert" | "am";

const OP_NOUN: Record<InProgress, string> = {
  rebase: "Rebase",
  merge: "Merge",
  "cherry-pick": "Cherry-Pick",
  revert: "Revert",
  am: "Patch Application",
};

const IN_PROGRESS: Record<InProgress, string> = {
  rebase: "Rebase in progress",
  merge: "Merge in progress",
  "cherry-pick": "Cherry-pick in progress",
  revert: "Revert in progress",
  am: "Patch application in progress",
};

export function inProgress(op: string | null | undefined = useVcs.getState().branch?.operation): InProgress | null {
  return op === "rebase" || op === "merge" || op === "cherry-pick" || op === "revert" || op === "am" ? op : null;
}

function operationInRepo(repo: string): InProgress | null {
  return inProgress(useVcs.getState().operations[repo] ?? null);
}

const pausedRebases = new Map<string, symbol>();
const rebasePauseKey = (repo: string) => `vcs.rebasePaused:${repo}`;

function expireRebasePause(repo: string) {
  if (pausedRebases.delete(repo)) notifications().expire?.(rebasePauseKey(repo));
}

/**
 * Expires the conflict notices (key `vcs.conflicts`: Merge conflicts, All conflicts resolved) once
 * the merge / rebase / cherry-pick they offer to continue or abort is over, however it ended.
 */
export function installOperationNoticeExpiry(resolvedRepo: () => string | null): () => void {
  return useVcs.subscribe((s, prev) => {
    const repo = resolvedRepo();
    const before = inProgress((repo ? prev.operations[repo] : prev.branch?.operation) ?? null);
    const now = inProgress((repo ? s.operations[repo] : s.branch?.operation) ?? null);
    if (before && (repo ? before !== now : !now)) notifications().expire?.("vcs.conflicts");
    if (pausedRebases.size) {
      const conflicts = s.status === prev.status ? [] : conflictedFiles(s.status);
      for (const root of pausedRebases.keys()) {
        if (s.operations[root] !== "rebase" || conflicts.some((file) => repoOf(file.path, s.roots) === root)) {
          expireRebasePause(root);
        }
      }
    }
  });
}

/** A rebase may return successfully at an edit step, or remain paused when its editor is cancelled. */
export function rebaseFeedback(repo: string | null, options: GitOperationOptions): GitOperationOptions {
  const { roots, root } = useVcs.getState();
  const target = repo ?? roots[0] ?? root;
  return {
    ...options,
    onError: options.onError ?? (() => conflictsInstead(target)),
    reportPause(cancelled) {
      if (
        !target ||
        operationInRepo(target) !== "rebase" ||
        conflictedFiles().some((file) => repoOf(file.path) === target)
      ) {
        return false;
      }
      const pause = Symbol();
      pausedRebases.set(target, pause);
      const run = (control: "continue" | "abort") => () => {
        // The Notifications log can retain older notices after their balloon expires.
        if (pausedRebases.get(target) === pause) void controlOperation(control, "rebase", target);
      };
      notifications().notify({
        group: "vcs",
        key: rebasePauseKey(target),
        level: "info",
        title: cancelled ? "Rebase paused" : "Rebase stopped for editing",
        body: useVcs.getState().roots.length > 1 ? repoName(target) : undefined,
        userInitiated: true,
        sticky: true,
        actions: [
          { label: "Continue", run: run("continue") },
          { label: "Abort", run: run("abort") },
        ],
      });
      return true;
    },
  };
}

/** "Rebasing main", "Merging", "Cherry-picking"… for the branch widget and banner. */
export function operationTitle(op: InProgress, head: string | null): string {
  if (!head)
    return {
      rebase: tx("Rebasing"),
      merge: tx("Merging"),
      "cherry-pick": tx("Cherry-picking"),
      revert: tx("Reverting"),
      am: tx("Applying patches"),
    }[op];
  return {
    rebase: tx`Rebasing ${head}`,
    merge: tx`Merging ${head}`,
    "cherry-pick": tx`Cherry-picking ${head}`,
    revert: tx`Reverting ${head}`,
    am: tx`Applying patches to ${head}`,
  }[op];
}

/** What a stopped operation offers, in IDEA's order. A merge is concluded by committing. */
export function operationControls(op: InProgress): Array<"continue" | "skip" | "abort"> {
  if (op === "merge") return ["abort"];
  if (op === "rebase" || op === "am") return ["continue", "skip", "abort"];
  return ["continue", "abort"];
}

export function controlLabel(op: InProgress, control: "continue" | "skip" | "abort"): string {
  if (control === "skip") return "Skip Commit";
  return `${control === "continue" ? "Continue" : "Abort"} ${OP_NOUN[op]}`;
}

/** Why `git rebase --continue` refused (see the backend's UNSTAGED_CHANGES_PREVENT_REBASE). */
const UNSTAGED_CHANGES_PREVENT_REBASE = "There are unstaged changes in tracked files preventing rebase from continuing";

/**
 * Links of the balloon of an operation that failed and is still stopped: Abort, and for
 * a rebase held up by unstaged changes, Stage and Retry (stages the tracked files'
 * changes and continues) and Show Files.
 */
function stoppedActions(repo: string, op: InProgress, message: string): Array<{ label: string; run: () => void }> {
  if (operationInRepo(repo) !== op) return [];
  const abort = { label: "Abort", run: () => void controlOperation("abort", op, repo) };
  if (op !== "rebase" || !message.includes(UNSTAGED_CHANGES_PREVENT_REBASE)) return [abort];
  return [
    {
      label: "Stage and Retry",
      run: () =>
        void resumeScopedRebase(
          "stageAndContinue",
          {
            progress: "Continuing rebase",
            success: "Rebase continued",
            failure: tx`${txPart(controlLabel(op, "continue"))} failed`,
            errorActions: (m) => stoppedActions(repo, op, m),
          },
          repo,
        ),
    },
    { label: "Show Files", run: () => showLocalChanges() },
    abort,
  ];
}

async function resumeScopedRebase(
  control: "continue" | "skip" | "stageAndContinue",
  options: GitOperationOptions,
  repo: string,
) {
  const scope = await pausedBranchRebase(repo);
  let head: HistoryTip | undefined;
  const session = scope
    ? {
        state: scope.state,
        record: (result: HistoryTip) => {
          head = result;
        },
      }
    : undefined;
  if (!useVcs.getState().remoteBusy) expireRebasePause(repo);
  const result = await resumeRebaseWithEditor(
    control,
    rebaseFeedback(repo, scope ? { ...options, success: null } : options),
    repo,
    session,
  );
  if (result && head && scope) await scope.resume(head);
}

/** Opens the conflicts dialog instead of an error balloon when the operation stopped on conflicts. */
export async function conflictsInstead(repo: string | null = null): Promise<boolean> {
  await refreshNow();
  if (!conflictedFiles().some((file) => !repo || repoOf(file.path) === repo)) return false;
  if (repo) await selectRepo(repo);
  void executeAction("vcs.resolveConflicts");
  return true;
}

function notInProgress(expected: InProgress | null) {
  notifications().notify({
    group: "vcs",
    level: "info",
    title: expected ? noneInProgress(expected) : "No merge, rebase, cherry-pick or revert in progress",
  });
}

function noneInProgress(op: InProgress): string {
  switch (op) {
    case "rebase":
      return tx("No rebase in progress");
    case "merge":
      return tx("No merge in progress");
    case "cherry-pick":
      return tx("No cherry-pick in progress");
    case "revert":
      return tx("No revert in progress");
    case "am":
      return tx("No patch application in progress");
  }
}

const applyReviews = new Set<string>();
type ReviewedApplyOperation = Extract<GitOperation, { op: "continueReviewedApply" }>;
const applyRetryDrafts = new Map<string, ReviewedApplyOperation>();
useProject.subscribe((current, previous) => {
  if (current.project !== previous.project) applyRetryDrafts.clear();
});

interface ApplyCommitDraft {
  message: string;
  paths: ReadonlySet<string>;
  options: ApplyCommitOptions;
}

interface ReviewedApply {
  operation: GitOperation;
  draftMessage?: string;
}

async function reviewApplyContinuation(
  repo: string,
  op: "cherry-pick" | "revert",
  draft?: ApplyCommitDraft,
): Promise<ReviewedApply | undefined> {
  if (applyReviews.has(repo)) return;
  const project = useProject.getState().project;
  applyReviews.add(repo);
  try {
    const review = await runOp(
      "Review staged changes",
      () => call(commands.vcsReviewApplyCommit(repo, nextRequestId())),
      { refresh: false, onError: () => conflictsInstead(repo) },
    );
    if (review === undefined || useProject.getState().project !== project || operationInRepo(repo) !== op) return;
    const retry = applyRetryDrafts.get(repo);
    if (retry && retry.checkpoint !== review?.checkpoint) applyRetryDrafts.delete(repo);
    if (!review) return { operation: { op: "continue" } };
    if (review.kind !== op) return;
    const matchingDraft =
      draft && draft.paths.size === review.paths.length && review.paths.every((path) => draft.paths.has(path))
        ? draft
        : undefined;
    const draftMessage = matchingDraft?.message.trim() ? matchingDraft.message : undefined;
    const draftOptions = draft && {
      signOff: draft.options.signOff,
      runHooks: draft.options.runHooks,
      author: matchingDraft?.options.author,
      authorDate: matchingDraft?.options.authorDate,
    };
    const failed = retry?.checkpoint === review.checkpoint ? retry : undefined;
    const initial = failed?.message ?? draftMessage ?? review.message;
    const answer = await promptApplyCommitMessage(
      controlLabel(op, "continue"),
      repo,
      { ...review, message: initial },
      failed?.options ?? draftOptions,
    );
    if (!answer || useProject.getState().project !== project) return;
    const { message, options } = answer;
    const operation: ReviewedApplyOperation = {
      op: "continueReviewedApply",
      checkpoint: review.checkpoint,
      message,
      options,
    };
    applyRetryDrafts.set(repo, operation);
    const isCurrent = () => useProject.getState().project === project && operationInRepo(repo) === op;
    const updated = isCurrent() && (await modifyReviewedApply(repo, review, isCurrent));
    if (!updated || !isCurrent()) return;
    operation.checkpoint = updated.checkpoint;
    if (!(await checkReviewedApply(repo, updated, message, options, isCurrent))) return;
    if (!(await ensureCommitIdentity([repo], false)) || !isCurrent()) return;
    return {
      operation,
      ...(draftMessage !== undefined && { draftMessage: message }),
    };
  } finally {
    applyReviews.delete(repo);
  }
}

/**
 * Continue / Skip / Abort of the operation in progress. `expected` restricts the
 * action to one kind (e.g. Git › Continue Rebase).
 */
export async function controlOperation(
  control: "continue" | "skip" | "abort",
  expected: InProgress | null = null,
  repo = currentRepoRoot(),
  draft?: ApplyCommitDraft,
) {
  const project = useProject.getState().project;
  await refreshNow();
  if (useProject.getState().project !== project) return;
  repo ??= currentRepoRoot();
  if (!repo) return notInProgress(expected);
  const op = operationInRepo(repo);
  if (!op || (expected && op !== expected)) return notInProgress(expected);
  if (control === "continue" && conflictedFiles().some((file) => repoOf(file.path) === repo)) {
    notifications().notify({ group: "vcs", level: "warning", title: "Resolve all conflicts before continuing" });
    void executeAction("vcs.resolveConflicts");
    return;
  }
  let reviewed: ReviewedApply | undefined;
  if (control === "continue" && (op === "cherry-pick" || op === "revert")) {
    reviewed = await reviewApplyContinuation(repo, op, draft);
    if (!reviewed) return;
  }
  const abortScope = control === "abort" && op === "rebase" ? await pausedBranchRebase(repo) : undefined;
  let rollback = false;
  if (control === "abort" && op === "rebase") {
    if (abortScope?.completedRoots.length) {
      const repository = repoName(repo);
      const completed = abortScope.completedRoots.map(repoName).join(", ");
      const choice = await ask({
        title: "Abort Rebase",
        body: tx`Abort rebase in ${repository}? You can also roll back the completed rebase in ${completed}.`,
        icon: "warning",
        buttons: [
          { id: "rollback", label: "Abort and Roll Back", primary: true },
          { id: "abort", label: "Abort" },
          { id: "cancel", label: "Cancel" },
        ],
      });
      if (choice.button !== "abort" && choice.button !== "rollback") return;
      rollback = choice.button === "rollback";
    } else {
      const proceed = await confirmDialog({
        title: "Abort Rebase",
        message: tx`Abort rebase in ${repoName(repo)}?`,
        okLabel: "Abort",
        danger: true,
      });
      if (!proceed) return;
    }
    await refreshNow();
    if (useProject.getState().project !== project || (abortScope && !abortScope.active())) return;
    if (operationInRepo(repo) !== op) return notInProgress(op);
  }
  const progress = {
    continue: {
      rebase: "Continuing rebase",
      merge: "Continuing merge",
      "cherry-pick": "Continuing cherry-pick",
      revert: "Continuing revert",
      am: "Continuing patch application",
    }[op],
    skip: "Skipping commit",
    abort: {
      rebase: "Aborting rebase",
      merge: "Aborting merge",
      "cherry-pick": "Aborting cherry-pick",
      revert: "Aborting revert",
      am: "Aborting patch application",
    }[op],
  }[control];
  const success = {
    continue: {
      rebase: "Rebase continued",
      merge: "Merge continued",
      "cherry-pick": "Cherry-pick continued",
      revert: "Revert continued",
      am: "Patch application continued",
    }[op],
    skip: "Commit skipped",
    abort: {
      rebase: "Rebase aborted",
      merge: "Merge aborted",
      "cherry-pick": "Cherry-pick aborted",
      revert: "Revert aborted",
      am: "Patch application aborted",
    }[op],
  }[control];
  const options: GitOperationOptions = {
    progress,
    success,
    failure: tx`${txPart(controlLabel(op, control))} failed`,
    onError: control === "abort" ? undefined : () => conflictsInstead(repo),
    errorActions: control === "abort" ? undefined : (message) => stoppedActions(repo, op, message),
  };
  let finished: boolean | undefined;
  if (op === "rebase" && control !== "abort") {
    await resumeScopedRebase(control, options, repo);
  } else {
    finished = await runGitOperation(
      control === "abort"
        ? { op: "abort", expected: op, ...(abortScope && { expectedRebase: abortScope.state }) }
        : (reviewed?.operation ?? { op: control }),
      options,
      repo,
    );
    if (
      finished &&
      useProject.getState().project === project &&
      (control !== "continue" || applyRetryDrafts.get(repo) === reviewed?.operation)
    )
      applyRetryDrafts.delete(repo);
    if (finished && abortScope) await abortScope.abort(rollback);
  }
  // A rebase that continued and stopped again (next conflict) is reported by the conflicts listener.
  await refreshNow();
  return finished ? { draftMessage: reviewed?.draftMessage } : undefined;
}

/** Banner above the Commit tool window's changes while an operation is stopped. */
export function OperationBanner() {
  const branch = useVcs((s) => s.branch);
  const conflicts = useVcs((s) => s.status.filter((f) => f.unstaged === "conflicted").length);
  const busy = useVcs((s) => s.remoteBusy);
  const resolved = useVcs((s) => s.resolvedConflicts.size > 0);
  const op = inProgress(branch?.operation);
  // Conflicts need a notice with no operation in progress too (applying a stash leaves them).
  if (!op && !conflicts) return null;
  const count = conflicts === 1 ? tx`${conflicts} conflict` : tx`${conflicts} conflicts`;
  return (
    <div className={styles.banner} role="status" aria-label={tx(op ? IN_PROGRESS[op] : "Merge conflicts")}>
      <Icon name={conflicts ? "warning" : "branch"} size={14} />
      <span className={styles.bannerText}>
        {op ? operationTitle(op, branch?.head ?? null) : tx("Unresolved merge conflicts")}
        {conflicts ? ` · ${count}` : op === "merge" ? tx(" · commit to conclude") : ""}
      </span>
      {(conflicts > 0 || resolved) && (
        <button type="button" className={styles.linkButton} onClick={() => void executeAction("vcs.resolveConflicts")}>
          {conflicts ? tx("Resolve…") : tx("Review Resolved Conflicts…")}
        </button>
      )}
      {(op ? operationControls(op) : []).map((c) => (
        <button
          key={c}
          type="button"
          className={styles.linkButton}
          disabled={!!busy || (c === "continue" && conflicts > 0)}
          onClick={() => void controlOperation(c, op)}
        >
          {c === "continue" ? tx("Continue") : c === "skip" ? tx("Skip") : tx("Abort")}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Git Log commit actions

const short = (id: string) => id.slice(0, 8);

/**
 * Commits newest first in the log's topological order (author dates lie after
 * rebases and cherry-picks); commits not loaded in the log fall back to their date.
 */
export function newestFirst(
  commits: readonly Commit[],
  log: readonly Commit[] = useGitLog.getState().commits,
): Commit[] {
  const pos = new Map(log.map((c, i) => [commitKey(c), i]));
  return [...commits].sort((a, b) => {
    const pa = pos.get(commitKey(a));
    const pb = pos.get(commitKey(b));
    if (pa !== undefined && pb !== undefined) return pa - pb;
    return (b.timeMs ?? 0) - (a.timeMs ?? 0);
  });
}

async function cherryPickOrigins(repo: string | null, commits: readonly RepoCommit[]): Promise<string[]> {
  const state = useVcs.getState();
  const branches =
    repo === currentRepo() && state.branchesLoaded
      ? state.branches
      : await call(commands.vcsBranches(repo)).catch(() => []);
  const protectedRefs = new Set(branches.filter(isProtectedRemoteBranch).map((branch) => branch.name));
  if (!protectedRefs.size) return [];
  const origins = await Promise.all(
    commits.map(async (commit) => {
      const detail = await loadLogDetails(commit).catch(() => null);
      return detail?.containingBranches.some((branch) => protectedRefs.has(branch)) ? [commit.id] : [];
    }),
  );
  return origins.flat();
}

async function applyCommitSelection(commits: Commit[], kind: "cherryPick" | "revert") {
  if (!commits.length) return;
  const pick = kind === "cherryPick";
  const addOrigin = pick && workflowSettings().vcs.git.addCherryPickOrigin;
  const failure = tx(pick ? "Cherry-pick failed" : "Revert failed");
  if (commits.some((commit) => commit.parents.length > 1)) {
    notifications().notify({
      group: "vcs",
      userInitiated: true,
      level: "warning",
      title: failure,
      body: tx("Merge commits require a mainline parent"),
    });
    return;
  }
  const ordered = newestFirst(commits);
  const label =
    ordered.length === 1 ? `${short(ordered[0]!.id)} “${ordered[0]!.summary}”` : `${ordered.length} commits`;
  const fallback = currentRepoRoot();
  const groups = new Map<string | null, RepoCommit[]>();
  for (const commit of ordered) {
    const repo = commitRepo(commit) ?? fallback;
    const group = groups.get(repo) ?? [];
    group.push({ ...commit, repo });
    groups.set(repo, group);
  }

  const multiple = groups.size > 1;
  const completed: string[] = [];
  const completedText = () => {
    const repositories = completed.join(", ");
    return completed.length ? tx`Completed in ${repositories}.` : "";
  };
  const stoppedText = (repo: string) => {
    const name = repoName(repo);
    return [tx`Stopped in ${name}.`, completedText()].filter(Boolean).join("\n");
  };
  let activeRepo: string | null = null;
  let cancelled = false;
  const empty = { skip: 0, createEmpty: 0 };
  await runGitOperationWith(
    null,
    {
      progress: pick ? "Cherry-picking" : "Reverting",
      success: pick
        ? () => {
            if (!empty.skip) return tx`Cherry-picked ${label}`;
            const count = ordered.length - empty.skip;
            if (count === 0) return tx("Cherry-pick completed");
            const applied = count === 1 ? tx("1 commit") : tx`${count} commits`;
            return tx`Cherry-picked ${applied}`;
          }
        : tx`Reverted ${label}`,
      successBody: () => emptyCherryPickFeedback(empty.skip, empty.createEmpty),
      failure,
      onError: async () => {
        const repo = activeRepo;
        const conflicts = await conflictsInstead(repo);
        if (conflicts && multiple && repo) {
          notifications().notify({
            group: "vcs",
            key: "vcs.conflicts",
            userInitiated: true,
            level: "warning",
            sticky: true,
            title: pick ? "Cherry-pick has conflicts" : "Revert has conflicts",
            body: stoppedText(repo),
            actions: [
              { label: "Resolve…", run: () => void conflictsInstead(repo) },
              ...stoppedActions(repo, pick ? "cherry-pick" : "revert", ""),
            ],
          });
        }
        return conflicts;
      },
      errorActions: (message) =>
        activeRepo ? stoppedActions(activeRepo, pick ? "cherry-pick" : "revert", message) : [],
    },
    async ({ request, output, cancelled: cancelRequested }) => {
      try {
        for (const [repo, group] of groups) {
          if (cancelRequested()) throw new IpcError({ kind: "cancelled", message: "cancelled" });
          activeRepo = repo;
          const revisions = (pick ? group.reverse() : group).map((commit) => commit.id);
          const origins = addOrigin ? await cherryPickOrigins(repo, group) : [];
          const op: GitOperation = pick
            ? {
                op: kind,
                commits: revisions,
                recordOrigin: origins.length === revisions.length,
                ...(origins.length > 0 && origins.length < revisions.length ? { recordOriginFor: origins } : {}),
              }
            : { op: kind, commits: revisions };
          if (cancelRequested()) throw new IpcError({ kind: "cancelled", message: "cancelled" });
          const name = repo ? repoName(repo) : "";
          logConsole("cmd", `git ${describeOperation(op, repo)}${multiple && name ? ` (${name})` : ""}`);
          const result = await call(commands.vcsOperation(repo, request, op, output()));
          if (result && "emptyCherryPicks" in result && result.emptyCherryPicks !== undefined) {
            empty[result.action] += result.emptyCherryPicks;
          }
          if (name) completed.push(name);
        }
      } catch (error) {
        cancelled = isCancelled(error);
        if (cancelled || !multiple || !activeRepo) throw error;
        throw new Error([stoppedText(activeRepo), tx(errorMessage(error))].join("\n\n"), {
          cause: error,
        });
      }
      return null;
    },
  );
  if (cancelled && multiple && completed.length) {
    notifications().notify({
      group: "vcs",
      userInitiated: true,
      level: "info",
      title: "Git operation cancelled",
      body: completedText(),
    });
  }
}

export function cherryPick(commits: Commit[]) {
  return applyCommitSelection(commits, "cherryPick");
}

export function revertCommits(commits: Commit[]) {
  return applyCommitSelection(commits, "revert");
}

const RESET_MODES: Array<{ mode: ResetMode; label: string; hint: string }> = [
  { mode: "soft", label: "Soft", hint: "Files won't change, differences will be staged for commit." },
  { mode: "mixed", label: "Mixed", hint: "Files won't change, differences won't be staged." },
  {
    mode: "hard",
    label: "Hard",
    hint: "Files will be reverted to the state of the selected commit. Warning: any local changes will be lost.",
  },
  {
    mode: "keep",
    label: "Keep",
    hint: "Files will be reverted to the state of the selected commit, but local changes will be kept intact.",
  },
];
const RESET_CHOICES = RESET_MODES.map(({ mode, label }) => ({ value: mode, label }));

function useRepoHead(root: string | null) {
  return useVcs(
    (s) => (root ? s.heads[root] : undefined) ?? ((s.repo ?? s.roots[0] ?? s.root) === root ? s.branch : null),
  );
}

/** Git Reset dialog: Reset Current Branch to Here… (log) and Git › Reset HEAD… (`commit` omitted). */
export function showResetDialog(commit?: Commit) {
  openDialog((close) => <ResetDialog commit={commit} onClose={close} />);
}

function ResetDialog({ commit, onClose }: { commit?: Commit; onClose: () => void }) {
  const id = useId();
  const [repo, setRepo] = useState(() => commitRepo(commit) ?? currentRepo());
  const roots = useVcs((s) => s.roots);
  const projectRoot = useVcs((s) => s.root);
  const root = repo ?? roots[0] ?? projectRoot;
  const head = useRepoHead(root);
  const branch = head?.head ?? (head?.headCommit ? tx("Detached HEAD") : "—");
  const [mode, setMode] = useState<ResetMode>("mixed");
  const [target, setTarget] = useState(commit?.id ?? "HEAD");
  const currentMode = RESET_MODES.find((m) => m.mode === mode);
  const chooseRepo = (next: string) => {
    if (next === root) return;
    setRepo(next);
    setTarget("HEAD");
  };
  const run = async () => {
    const rev = target.trim();
    if (!rev) return;
    onClose();
    await runGitOperation(
      { op: "reset", commit: rev, mode },
      {
        progress: "Resetting",
        success: tx`Reset ${head?.head ?? "HEAD"} to ${commit ? short(commit.id) : rev} (${mode})`,
        failure: tx("Reset failed"),
      },
      repo,
    );
  };
  return (
    <Dialog
      open
      title="Git Reset"
      onClose={onClose}
      width={520}
      buttons={[
        { label: "Reset", role: "default", autoFocus: !!commit, disabled: !target.trim(), onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={resetStyles.form}>
        {commit ? (
          <div className={resetStyles.confirmation}>
            <div className={resetStyles.summary}>
              <span className={resetStyles.source}>
                <strong>{branch}</strong>
                {root && roots.length > 1 && <span className={resetStyles.repository}>{repoName(root)}</span>}
              </span>
              <Icon name="arrow-right" size={14} />
              <span className={resetStyles.destination} title={commit.id}>
                <strong>{short(commit.id)}</strong> <span>{commit.summary}</span>
                {commit.author && (
                  <>
                    {" "}
                    · <span className={resetStyles.repository}>{commit.author}</span>
                  </>
                )}
              </span>
            </div>
            <p className={resetStyles.description}>
              <T>
                {
                  "This will reset the current branch head to the selected commit, and update the working tree and the index according to the selected mode:"
                }
              </T>
            </p>
            <div className={resetStyles.modes} role="radiogroup" aria-label={tx("Reset type")}>
              {RESET_MODES.map((m) => (
                <Radio
                  key={m.mode}
                  className={resetStyles.choice}
                  name={`${id}-mode`}
                  checked={mode === m.mode}
                  onChange={() => setMode(m.mode)}
                  label={
                    <span className={resetStyles.modeText}>
                      <T>{m.label}</T>
                      <span className={resetStyles.hint}>
                        <T>{m.hint}</T>
                      </span>
                    </span>
                  }
                />
              ))}
            </div>
          </div>
        ) : (
          <div className={resetStyles.fields}>
            {roots.length > 1 ? (
              <>
                <label className={resetStyles.label} htmlFor={`${id}-repo`}>
                  <T>Repository:</T>
                </label>
                <RepoPicker id={`${id}-repo`} repo={repo} onChange={chooseRepo} />
              </>
            ) : (
              <>
                <span className={resetStyles.label}>
                  <T>Repository:</T>
                </span>
                <span className={resetStyles.fact}>{root ? repoName(root) : "—"}</span>
              </>
            )}
            <span className={resetStyles.label}>
              <T>Current branch:</T>
            </span>
            <span className={resetStyles.fact} title={branch}>
              {branch}
            </span>
            <label className={`${resetStyles.label} ${resetStyles.modeLabel}`} htmlFor={`${id}-mode`}>
              <T>Reset type:</T>
            </label>
            <div className={resetStyles.modeField}>
              <Select
                id={`${id}-mode`}
                className={resetStyles.modePicker}
                aria-label="Reset type"
                value={mode}
                options={RESET_CHOICES}
                onChange={setMode}
              />
              {currentMode && (
                <span className={resetStyles.hint}>
                  <T>{currentMode.hint}</T>
                </span>
              )}
            </div>
            <label className={resetStyles.label} htmlFor={`${id}-target`}>
              <T>To commit:</T>
            </label>
            <Input id={`${id}-target`} data-autofocus value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function validateTagName(name: string, existing: readonly string[] = []): string | null {
  const n = name.trim();
  if (!n) return "Tag name must not be empty";
  if (/[\s~^:?*[\\\p{Cc}]/u.test(n) || n.startsWith("-") || n.endsWith(".") || n.endsWith("/") || n.endsWith(".lock"))
    return "Invalid tag name";
  if (n.includes("..") || n.includes("//") || n.includes("@{") || n === "@") return "Invalid tag name";
  if (existing.includes(n)) return `Tag '${n}' already exists`;
  return null;
}

/** Log › New Tag…: a lightweight tag on the selected commit. */
export async function newTagOn(commit: Commit) {
  const repo = commitRepo(commit) ?? currentRepo();
  const existing = await call(commands.vcsTags(repo)).catch(() => [] as string[]);
  const r = await promptText({
    title: tx`Create New Tag On ${short(commit.id)}`,
    label: "Enter the name of new tag:",
    mono: true,
    okLabel: "Create",
    validate: (v) => validateTagName(v, existing),
  });
  if (!r) return;
  const create = () => call(commands.vcsCreateTag(repo, r.value, commit.id, null, false));
  const ok = await runOp(tx`Create tag ${r.value}`, create, {
    success: tx`Created tag ${r.value} on ${short(commit.id)}`,
  });
  // Tags are not part of the refs signature that reloads the log.
  if (ok !== undefined) void reloadLog();
}

/** Git › New Tag…: IDEA's Tag dialog (name, force, commit, message). */
export function showTagDialog() {
  openDialog((close) => <TagDialog onClose={close} />);
}

function TagDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [repo, setRepo] = useState(currentRepo);
  const roots = useVcs((s) => s.roots);
  const projectRoot = useVcs((s) => s.root);
  const root = repo ?? roots[0] ?? projectRoot;
  const head = useRepoHead(root);
  const branch = head?.head ?? (head?.headCommit ? tx("Detached HEAD") : "—");
  const [name, setName] = useState("");
  const [commit, setCommit] = useState("HEAD");
  const [message, setMessage] = useState("");
  const [force, setForce] = useState(false);
  const [existing, setExisting] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void call(commands.vcsTags(repo)).then(
      (tags) => live && setExisting(tags),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [repo]);
  const chooseRepo = (root: string) => {
    if (root === repo) return;
    setRepo(root);
    setExisting([]);
  };
  const error = validateTagName(name, force ? [] : existing);
  const errorId = name && error ? `${id}-error` : undefined;
  const run = async () => {
    if (error) return;
    onClose();
    const tag = name.trim();
    const ok = await runOp(
      tx`Create tag ${tag}`,
      () => call(commands.vcsCreateTag(repo, tag, commit.trim() || "HEAD", message || null, force)),
      { success: tx`Created tag ${tag}` },
    );
    if (ok !== undefined && useGitLog.getState().commits.length) void reloadLog();
  };
  return (
    <Dialog
      open
      title="Tag"
      onClose={onClose}
      width={500}
      buttons={[
        { label: "Create Tag", role: "default", disabled: !!error, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={tagStyles.form}>
        {roots.length > 1 ? (
          <>
            <label className={tagStyles.label} htmlFor={`${id}-repository`}>
              <T>Repository:</T>
            </label>
            <RepoPicker id={`${id}-repository`} repo={repo} onChange={chooseRepo} />
          </>
        ) : (
          <>
            <span className={tagStyles.label}>
              <T>Repository:</T>
            </span>
            <span className={tagStyles.context}>{root ? repoName(root) : "—"}</span>
          </>
        )}
        <span className={tagStyles.label}>
          <T>Current branch:</T>
        </span>
        <span className={tagStyles.context} title={branch}>
          {branch}
        </span>
        <label className={tagStyles.nameLabel} htmlFor={`${id}-name`}>
          <T>Tag name:</T>
        </label>
        <div className={tagStyles.nameField}>
          <Input
            id={`${id}-name`}
            data-autofocus
            value={name}
            invalid={!!errorId}
            aria-describedby={errorId}
            onChange={(e) => setName(e.target.value)}
          />
          {errorId && (
            <div className={styles.error} id={errorId}>
              {error}
            </div>
          )}
        </div>
        <Checkbox className={tagStyles.force} checked={force} onChange={setForce} label="Force" />
        <label className={tagStyles.label} htmlFor={`${id}-commit`}>
          <T>Commit:</T>
        </label>
        <Input id={`${id}-commit`} value={commit} onChange={(e) => setCommit(e.target.value)} />
        <label className={tagStyles.messageLabel} htmlFor={`${id}-message`}>
          <T>Message:</T>
        </label>
        <textarea
          id={`${id}-message`}
          className={styles.textarea}
          rows={4}
          value={message}
          placeholder={tx("Optional; creates an annotated tag")}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

/** Compare with Local: files that differ between the commit and the working tree. */
export function showCompareWithLocal(commit: Commit, historyTarget?: string | null) {
  if (historyTarget) {
    const repo = commitRepo(commit) ?? repoOf(historyTarget) ?? currentRepoRoot();
    const historicalPath = commit.historyPath && repo ? repositoryPath(repo, commit.historyPath) : historyTarget;
    void openVcsDiff({
      path: historyTarget,
      left: { type: "rev", rev: commit.id, path: historicalPath, label: short(commit.id) },
      right: { type: "worktree" },
    });
    return;
  }
  showDiffWithWorkingTree(commit.id, short(commit.id));
}

/** Opens the selected File History entry's file exactly as it exists in that commit. */
export function showFileAtRevision(commit: Commit, target: string, external = false) {
  const repo = commitRepo(commit) ?? repoOf(target) ?? currentRepoRoot();
  if (!repo) return;
  const root = ipcPath(repo).replace(/\/$/, "");
  const file = ipcPath(target);
  const relative = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
  const path = commit.historyPath ?? relative;
  openRevisionFile(repo, commit.id, path, external);
}

/** Files that differ between `rev` (a commit or branch) and the working tree, in the Compare tool window. */
export function showDiffWithWorkingTree(rev: string, label = rev) {
  showWorktreeComparison(rev, label);
}

/** IDEA's Compare Versions of two Git Log commits: files that differ between them, older first. */
export function showCompareVersions(older: Commit, newer: Commit, historyTarget?: string | null) {
  if (historyTarget) {
    const repo = commitRepo(older) ?? commitRepo(newer) ?? repoOf(historyTarget) ?? currentRepoRoot();
    const olderPath = older.historyPath && repo ? repositoryPath(repo, older.historyPath) : historyTarget;
    const newerPath = newer.historyPath && repo ? repositoryPath(repo, newer.historyPath) : historyTarget;
    void openVcsDiff({
      path: historyTarget,
      left: { type: "rev", rev: older.id, path: olderPath, label: short(older.id) },
      right: { type: "rev", rev: newer.id, path: newerPath, label: short(newer.id) },
    });
    return;
  }
  showComparison({ rev: older.id, label: short(older.id) }, { rev: newer.id, label: short(newer.id) });
}

/** Files that differ between two revisions (e.g. two branches from Compare with Current) of `repo`. */
export function showCompareRevisions(from: string, to: string, fromLabel = from, toLabel = to, repo = currentRepo()) {
  showComparison({ rev: from, label: fromLabel }, { rev: to, label: toLabel }, undefined, repo);
}

export function showPathComparison(paths: string[], rev: string, repositories: string[] | null) {
  showComparison({ rev, label: rev }, null, { paths, repositories });
}

function showComparison(from: Revision, to: Revision | null, scope?: ScopedComparison, repo = currentRepo()) {
  if (!isTauri()) {
    openDialog((close) => <ChangesBetweenDialog from={from} to={to} scope={scope} repo={repo} onClose={close} />);
    return;
  }
  const comparison = { from, to, scope: scope ?? null, repo };
  void call(commands.windowOpenComparison(comparison, windowBackgroundHex())).catch((error) =>
    notifications().notify({ level: "error", title: "Could not open comparison", body: String(error) }),
  );
}

export interface Revision {
  rev: string;
  label: string;
}

interface ScopedComparison {
  paths: string[];
  repositories: string[] | null;
}

export interface ComparisonFile extends ChangedFile {
  root: string;
  revision: string;
  added?: number;
  removed?: number;
}

interface ComparisonResults {
  repositories: Array<Omit<CompareResult["repositories"][number], "files" | "revision"> & { files: ComparisonFile[] }>;
  skippedPaths: CompareResult["skippedPaths"];
}

function WorktreeFileIcon({ path }: { path: string }) {
  const { icon } = useFilePresentation(path);
  return <Icon name={icon} size={14} />;
}

/** A working-tree file shows the Project tree's icon (Java and Kotlin declarations, Spring config). */
function renderWorktreeFileIcon(file: ComparisonFile) {
  if (!file.root || file.kind === "deleted") return null;
  return <WorktreeFileIcon path={repositoryPath(file.root, file.path)} />;
}

/**
 * Diff content of one comparison file. `swapped` exchanges the two sides
 * (the Compare tool window's Swap Sides), for worktree and revision diffs alike.
 */
export function comparisonDiffData(
  file: ComparisonFile,
  from: Revision,
  to: Revision | null,
  swapped: boolean,
): DiffData {
  const missing = (label: string): DiffSide => ({ type: "text", text: "", label });
  const path = repositoryPath(file.root, file.path);
  const left: DiffSide =
    file.kind === "added" || file.kind === "untracked"
      ? missing("(does not exist)")
      : {
          type: "rev",
          rev: file.revision,
          label: from.label,
          path: file.oldPath ? repositoryPath(file.root, file.oldPath) : undefined,
        };
  const right: DiffSide =
    file.kind === "deleted"
      ? missing("(deleted)")
      : !to
        ? { type: "worktree" }
        : { type: "rev", rev: to.rev, label: to.label };
  return swapped ? { path, left: right, right: left } : { path, left, right };
}

export function comparisonEmpty(revision: string, repositories: number): string {
  return repositories === 1
    ? tx`No changes against ${revision} in 1 repository`
    : tx`No changes against ${revision} in ${repositories} repositories`;
}

/** Shared branch/commit comparison surface, also used for directory selections. */
export function ChangesBetweenDialog({
  from,
  to,
  scope,
  repositories,
  repo: givenRepo,
  onClose,
  native = false,
  onCaption,
  onShowDiff,
  swapped = false,
  onSelect,
  listOnly = false,
}: {
  from: Revision;
  to: Revision | null;
  scope?: ScopedComparison;
  repositories?: readonly string[];
  /** The repository compared (the selected one when omitted). */
  repo?: string | null;
  onClose: () => void;
  /** Content of the comparison window rather than a dialog: its caption goes to `onCaption`. */
  native?: boolean;
  onCaption?: (caption: string) => void;
  onShowDiff?: (data: DiffData) => void;
  /** Exchange the two sides (the Compare tool window's Swap Sides). */
  swapped?: boolean;
  /** Reports the selected file (the Compare tool window's Jump to Source / Swap Sides). */
  onSelect?: (file: ComparisonFile | null) => void;
  /** Files only, each diff opening in the editor (the Compare tool window's narrow sidebar). */
  listOnly?: boolean;
}) {
  const [repo] = useState(() => repositories?.[0] ?? (givenRepo === undefined ? currentRepo() : givenRepo));
  const [root] = useState(() => repo ?? currentRepoRoot());
  const [result, setResult] = useState<ComparisonResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrentState] = useState<ComparisonFile | null>(null);
  const setCurrent = (file: ComparisonFile | null) => {
    setCurrentState(file);
    onSelect?.(file);
  };
  const fromRev = from.rev;
  const toRev = to?.rev ?? null;
  const grouped = !!scope || (repositories?.length ?? 0) > 1;
  useEffect(() => {
    let alive = true;
    let pending = true;
    const request = nextRequestId();
    const compareRepo = async (repo: string | null, root: string) => {
      const changes = await call(
        toRev ? commands.vcsDiffRevisions(repo, fromRev, toRev) : commands.vcsDiffWithWorktree(repo, fromRev),
      );
      return {
        root,
        files: changes.map((f) => ({ ...f, root, revision: fromRev })),
        error: null,
        missingRevision: false,
      };
    };
    const load = async () => {
      if (scope) {
        const r = await call(commands.vcsComparePaths(scope.paths, fromRev, scope.repositories, request));
        if (!alive) return;
        setResult({
          skippedPaths: r.skippedPaths,
          repositories: r.repositories.map(({ revision, files, ...repo }) => ({
            ...repo,
            files: revision ? files.map((f) => ({ ...f, root: repo.root, revision })) : [],
          })),
        });
        return;
      }
      const results =
        repositories && repositories.length > 1
          ? await Promise.all(
              repositories.map((root) =>
                compareRepo(root, root).catch((error) => ({
                  root,
                  files: [],
                  error: errorMessage(error),
                  missingRevision: false,
                })),
              ),
            )
          : [await compareRepo(repo, root ?? "")];
      if (alive) setResult({ repositories: results, skippedPaths: [] });
    };
    void load()
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        pending = false;
      });
    return () => {
      alive = false;
      if (scope && pending) void commands.cancelRequest(request);
    };
  }, [fromRev, toRev, repo, root, scope, repositories]);
  const files = useMemo(() => result?.repositories.flatMap((repo) => repo.files) ?? null, [result]);
  const tree = useMemo(() => {
    if (!grouped) return buildFileTree(files ?? [], (f) => f.path);
    const results = result?.repositories ?? [];
    return (scope ? results : results.filter((r) => r.files.length)).map((r): FileTreeNode<ComparisonFile> => {
      const prefix = (nodes: FileTreeNode<ComparisonFile>[]): FileTreeNode<ComparisonFile>[] =>
        nodes.map((n) => ({ ...n, key: `${r.root}:${n.key}`, children: prefix(n.children) }));
      return {
        key: r.root,
        name: repoName(r.root),
        file: null,
        count: r.files.length,
        children: prefix(buildFileTree(r.files, (f) => f.path)),
      };
    });
  }, [files, result, grouped, scope]);
  const diffFor = (f: ComparisonFile): DiffData => comparisonDiffData(f, from, to, swapped);
  const input = current ? diffInput(diffFor(current)) : null;
  const title = to
    ? tx`Changes between ${from.label} and ${to.label}`
    : tx`Changes between ${from.label} and Local Working Tree`;
  const count = files ? fileCount(files.length) : "";
  const successful = result?.repositories.filter((r) => !r.error && !r.missingRevision).length ?? 1;
  const allMissing = !!result?.repositories.length && result.repositories.every((r) => r.missingRevision);
  const skipped = result?.skippedPaths.map((path) => displayPath(path)) ?? [];
  const skippedNames = skipped.slice(0, 5).join(", ");
  const skippedLabel = skipped.length > 5 ? tx`${skippedNames} and ${skipped.length - 5} more` : skippedNames;
  const caption = files ? `${title} — ${count}` : title;
  useEffect(() => {
    if (native) onCaption?.(caption);
  }, [native, onCaption, caption]);
  const showDiff = () => {
    if (!current) return;
    if (onShowDiff) onShowDiff(diffFor(current));
    else {
      void openVcsDiff(diffFor(current));
      // A diff window opens on top of this list (#1863); an editor tab would sit behind it.
      if (!vcsDiffInFront()) onClose();
    }
  };
  const contents = (
    <>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {result?.skippedPaths.length ? (
        <div className={styles.compareNotice}>{tx`Skipped content outside Git repositories: ${skippedLabel}`}</div>
      ) : null}
      {allMissing ? (
        <div className={styles.empty} role="status">
          {tx`No repository in the selection has revision ${from.label}`}
        </div>
      ) : (
        result?.repositories
          .filter((r) => r.error || r.missingRevision)
          .map((r) => (
            <div key={r.root} className={styles.compareNotice} role={r.missingRevision ? "status" : "alert"}>
              {r.missingRevision
                ? tx`${repoName(r.root)} has no revision ${from.label}`
                : tx`Cannot compare ${repoName(r.root)} against ${from.label}: ${r.error}`}
            </div>
          ))
      )}
      {!files && !error ? (
        <div className={styles.empty}>
          <Spinner size={14} />
        </div>
      ) : null}
      {files && !files.length && successful > 0 ? (
        <div className={styles.empty} role="status">
          {comparisonEmpty(from.label, successful)}
        </div>
      ) : null}
      {files && files.length > 0 ? (
        <ComparisonTree
          tree={tree}
          current={current}
          onSelect={setCurrent}
          diffFor={diffFor}
          renderFileIcon={listOnly && !to ? renderWorktreeFileIcon : undefined}
          getColor={(f) => KIND_COLOR[f.kind === "untracked" ? "added" : f.kind]}
          ariaLabel="Changed files"
          inlineDiff={!listOnly}
          openOnActivate={listOnly}
          renderDetails={(n) =>
            n.file ? (
              <>
                <span className={styles.fileDir}>{tx(n.file.kind)}</span>
                {n.file.added !== undefined && <span className={styles.compareAdded}>+{n.file.added}</span>}
                {n.file.removed !== undefined && <span className={styles.compareRemoved}>−{n.file.removed}</span>}
              </>
            ) : (
              <span className={styles.fileDir}>{n.count}</span>
            )
          }
        />
      ) : null}
    </>
  );
  if (native) {
    const diffButton = (
      <Button
        variant={listOnly ? "primary" : "ghost"}
        size={listOnly ? "normal" : "small"}
        icon={listOnly ? undefined : "diff"}
        disabled={!current}
        onClick={showDiff}
      >
        Show Diff
      </Button>
    );
    return (
      <div className={styles.comparisonWindow}>
        {!listOnly && (
          <Toolbar className={styles.comparisonWindowToolbar} aria-label="Comparison actions">
            {diffButton}
          </Toolbar>
        )}
        <div className={styles.comparisonWindowBody}>{contents}</div>
        <div className={styles.comparisonWindowFooter}>
          <Button onClick={onClose}>Close</Button>
          {listOnly && diffButton}
        </div>
      </div>
    );
  }
  return (
    <Dialog
      open
      title={caption}
      onClose={onClose}
      width={input ? 1100 : 680}
      resizable="both"
      className={styles.comparisonDialog}
      buttons={[
        { label: "Show Diff", role: "default", disabled: !current, onClick: showDiff },
        { label: "Close", role: "cancel" },
      ]}
    >
      {contents}
    </Dialog>
  );
}
