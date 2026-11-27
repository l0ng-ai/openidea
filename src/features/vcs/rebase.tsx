import { commitRepo } from "./multiRoot";
/**
 * Git Log history rewriting: Undo Commit, Edit Commit Message, Drop Commit and
 * Interactively Rebase from Here (IDEA's Git.Log.ContextMenu).
 */
import type { BranchInfo, Commit, RebaseEntry } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { ask, showError } from "@/workbench/messages";
import { chooseTargetChangelist, moveToChangelist } from "./changelistsUi";
import { setChangelistDraft, useCommit } from "./commitStore";
import { stripSlash } from "./model";
import { openCommit } from "./commitUi";
import { rememberSetting } from "./confirmations";
import { confirmDialog, openDialog } from "./dialogs";
import { loadLogDetails } from "./logDetails";
import { revealCommit, useGitLog } from "./logStore";
import type { LogChange } from "./logChanges";
import { conflictsInstead, inProgress, rebaseFeedback } from "./operations";
import { errorMessage, runGitOperation, runOp } from "./ops";
import { runRebaseWithEditor } from "./rebaseEditor";
import {
  headPushed,
  combinedCommitMessage,
  initialRows,
  isAutosquashSubject,
  planIsNoop,
  planProblem,
  rebaseRange,
  singleCommitPlan,
  squashPlan,
  toEntries,
  undoCommitProblem,
  type RebaseRange,
} from "./rebasePlan";
import { stagingAreaOn } from "./staging";
import { currentRepo, refreshNow, useVcs } from "./store";
import { RebasePlanDialog } from "./RebasePlanDialog";
import { isProtectedRemoteBranch } from "./branches";
import { notifications } from "@/workbench/contributions";
import { promptCommitMessage } from "./CommitMessageDialog";
import { tx } from "@/platform/i18n";

const short = (id: string) => id.slice(0, 8);

/** IDEA reports a refused history rewrite in an error dialog. */
function refuse(title: string, body: string) {
  void showError(title, body);
}

async function protectedHistoryProblem(repo: string | null, revision: string) {
  const branches = (await call(commands.vcsBranches(repo))).filter(isProtectedRemoteBranch);
  if (!branches.length) return null;
  const { containingBranches } = await call(commands.vcsLogDetails(repo, revision));
  const name = branches.find((branch) => containingBranches.includes(branch.name))?.name;
  return name ? tx`The commit has already been pushed to protected branch '${name}'.` : null;
}

const pushedWarning = (what: string, branch: BranchInfo | null) =>
  `The commit is already pushed to ${branch?.upstream ?? "the remote"}. ${what} rewrites published history; pushing afterwards needs a force push.`;

/**
 * Whether rewriting `range` (its oldest commit up to HEAD) touches history already
 * pushed to the branch's upstream. Every common ancestor of HEAD and the upstream is
 * an ancestor of their merge base, so the range is pushed iff its oldest commit is at
 * or below that merge base.
 */
async function rangeTouchesUpstream(
  branch: BranchInfo | null,
  range: RebaseRange,
  repo: string | null,
): Promise<boolean> {
  if (!branch?.upstream) return false;
  if (headPushed(branch)) return true;
  const base = await call(commands.vcsMergeBase(repo, "HEAD", branch.upstream)).catch(() => null);
  if (!base) return false;
  const oldest = range.commits[0]!.id;
  const below = await call(
    commands.vcsLog(repo, {
      branch: null,
      path: null,
      author: null,
      text: null,
      range: `${base}..${oldest}`,
      skip: 0,
      limit: 1,
    }),
  ).catch(() => null);
  return below !== null && below.length === 0;
}

// ---------------------------------------------------------------------------
// Undo Commit

export async function undoCommit(commit: Commit) {
  const repo = commitRepo(commit) ?? currentRepo();
  try {
    const branch = await call(commands.vcsBranchInfo(repo));
    const problem = undoCommitProblem(commit, branch);
    if (problem) return refuse("Cannot undo commit", problem);

    const published = await protectedHistoryProblem(repo, commit.id);
    if (published) return refuse("Cannot undo commit", published);

    const warnings = [
      headPushed(branch) && pushedWarning("Undoing it", branch),
      !commit.parents.length && tx("The initial commit will be undone and its changes will stay staged."),
    ].filter(Boolean);
    if (warnings.length) {
      const ok = await confirmDialog({
        title: "Undo Commit",
        message: warnings.join("\n\n"),
        okLabel: "Undo Commit",
        danger: true,
      });
      if (!ok) return;
    }

    const staging = stagingAreaOn();
    const files = staging ? [] : await call(commands.vcsCommitFiles(repo, commit.id));
    const target = staging ? null : await chooseTargetChangelist(commit.summary);
    if (!staging && target === null) return;
    const message = await runOp(
      tx`Undo commit ${short(commit.id)}`,
      () => call(commands.vcsUndoCommit(repo, commit.id)),
      {
        success: tx`Undid commit ${short(commit.id)} “${commit.summary}”`,
      },
    );
    if (message === undefined) return;
    if (target !== null) {
      const root = repo ?? useVcs.getState().root ?? "";
      const paths = files.flatMap((f) =>
        [f.path, f.oldPath].filter((path): path is string => !!path).map((path) => `${stripSlash(root)}/${path}`),
      );
      moveToChangelist(paths, target);
      setChangelistDraft(target, message);
    } else {
      useCommit.setState({ message });
    }
  } catch (error) {
    refuse("Cannot undo commit", errorMessage(error));
  }
}

// ---------------------------------------------------------------------------
// Rebase-based actions

type RewriteRange = RebaseRange & { repo: string | null; branch: string | null; refusal: string };

const rewriteRefusals = {
  "edit commit message": "Cannot edit commit message",
  "extract changes": "Cannot extract changes",
  "drop selected changes": "Cannot drop selected changes",
  "drop commit": "Cannot drop commit",
  "drop commits": "Cannot drop commits",
  "squash commits": "Cannot squash commits",
  rebase: "Cannot rebase",
} as const;

function rewriteHistory(repo: string | null, tip: string, base: string | null) {
  return call(
    commands.vcsLog(repo, {
      branch: tip,
      path: null,
      author: null,
      text: null,
      range: base ? `${base}..${tip}` : null,
      skip: 0,
      limit: 0,
    }),
  );
}

/** The commits from `target` to HEAD, or a warning when they cannot be rewritten. */
async function rangeFrom(
  target: Commit,
  verb: keyof typeof rewriteRefusals,
  labels?: { title: string; published: string },
): Promise<RewriteRange | null> {
  const repo = commitRepo(target) ?? currentRepo();
  const refusal = tx(rewriteRefusals[verb]);
  await refreshNow();
  try {
    const branch = await call(commands.vcsBranchInfo(repo));
    const op = inProgress(branch.operation);
    if (op) {
      refuse(refusal, `A ${op} is in progress`);
      return null;
    }
    const history = await rewriteHistory(repo, branch.headCommit ?? "HEAD", target.parents[0] ?? null);
    const range = rebaseRange(target, history);
    if ("error" in range) {
      refuse(refusal, range.error);
      return null;
    }
    // On a linear range, any branch containing a newer commit also contains its oldest commit.
    const protectedProblem = await protectedHistoryProblem(repo, range.commits[0]!.id);
    if (protectedProblem) {
      refuse(refusal, protectedProblem);
      return null;
    }
    if (await rangeTouchesUpstream(branch, range, repo)) {
      const title = labels?.title ?? verb.replace(/^\w/, (c) => c.toUpperCase());
      const ok = await confirmDialog({
        title,
        message: labels?.published ?? pushedWarning(title, branch),
        okLabel: "Continue",
        danger: true,
      });
      if (!ok) return null;
    }
    return { ...range, repo, branch: branch.head, refusal };
  } catch (e) {
    refuse(refusal, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Recheck the snapshot and protected refs just before applying a plan or a dialog's edits. */
async function canApplyRewrite(range: RewriteRange): Promise<boolean> {
  const { repo, refusal } = range;
  try {
    const branch = await call(commands.vcsBranchInfo(repo));
    if (branch.head !== range.branch || branch.headCommit !== range.commits.at(-1)!.id || branch.operation) {
      refuse(refusal, tx("The branch changed while this history rewrite was being prepared."));
      return false;
    }
    const problem = await protectedHistoryProblem(repo, range.commits[0]!.id);
    if (!problem) return true;
    refuse(refusal, problem);
  } catch (error) {
    refuse(refusal, errorMessage(error));
  }
  return false;
}

async function headOf(repo: string | null): Promise<string | null> {
  return (await call(commands.vcsBranchInfo(repo)).catch(() => null))?.headCommit ?? null;
}

/**
 * The Undo link of a history rewrite's balloon (keyed `key`): back to `before` while HEAD
 * is still `after`. Once undone, the balloon is replaced by one without the link.
 */
function undoLink(repo: string | null, before: string | null, after: string | null, undone: string, key: string) {
  if (!before || !after || before === after) return [];
  return [
    {
      label: "Undo",
      run: () =>
        void runOp(
          tx("Undo"),
          async () => {
            const firstNew = (await rewriteHistory(repo, after, before)).at(-1);
            const problem = firstNew && (await protectedHistoryProblem(repo, firstNew.id));
            if (problem) throw new Error(problem);
            return call(commands.vcsRestoreHead(repo, before, after, null, null));
          },
          { onError: () => conflictsInstead(repo) },
        ).then((done) => {
          if (done === undefined) return;
          notifications().notify({ group: "vcs", level: "info", key, title: undone });
        }),
    },
  ];
}

/** Rewrites the branch with `entries`; a finished rewrite can be undone from its balloon. */
async function runRebase(range: RewriteRange, entries: RebaseEntry[], done: string, undone = tx("Rebase undone")) {
  if (!(await canApplyRewrite(range))) return;
  const { repo, base, commits } = range;
  const before = commits.at(-1)!.id;
  await runGitOperation(
    { op: "interactiveRebase", base, entries },
    rebaseFeedback(repo, {
      progress: "Rebasing",
      success: done,
      failure: tx("Rebase failed"),
      successActions: async () => undoLink(repo, before, await headOf(repo), undone, "vcs.operation"),
    }),
    repo,
  );
}

/** Edit Commit Message…: rewords one commit of the current branch. */
export async function editCommitMessage(commit: Commit) {
  const range = await rangeFrom(commit, "edit commit message");
  if (!range) return;
  // A paged log only carries the summary line: load the full message so the
  // dialog edits subject and body, not the subject alone (#2238).
  const initial = commit.messageTruncated ? (await loadLogDetails(commit)).message : commit.message;
  const hash = short(commit.id);
  const author = commit.author || commit.email;
  const label = author ? tx`Edit message for commit ${hash} by ${author}` : tx`Edit message for commit ${hash}`;
  const message = await promptCommitMessage("Edit Commit Message", label, initial);
  if (message === null || message.trim() === initial.trim()) return;
  if (!(await canApplyRewrite(range))) return;
  // Written without a rebase: the index and the working tree (local changes) stay as they are.
  const change = await runOp(tx`Edit commit message of ${short(commit.id)}`, () =>
    call(commands.vcsReword(range.repo, commit.id, message)),
  );
  if (!change) return;
  await refreshNow();
  const key = `vcs.reword:${change.after}`;
  notifications().notify({
    group: "vcs",
    level: "info",
    key,
    title: tx`Commit message of ${short(commit.id)} changed`,
    actions: undoLink(range.repo, change.before, change.after, tx("Commit message change undone"), key),
  });
}

function selectedCommitPaths(commit: Commit, changes: LogChange[]): string[] | null {
  if (
    !changes.length ||
    commit.parents.length > 1 ||
    changes.some((change) => change.readOnly || change.statsTo !== commit.id || change.repo !== commitRepo(commit))
  ) {
    return null;
  }
  return [...new Set(changes.flatMap(({ path, oldPath }) => (oldPath ? [path, oldPath] : [path])))];
}

export async function extractSelectedChanges(commit: Commit, changes: LogChange[]) {
  const paths = selectedCommitPaths(commit, changes);
  if (!paths) return;
  const tab = useGitLog.getState().shownLog;
  const root = useVcs.getState().root;
  const title = tx("Extract Selected Changes");
  const range = await rangeFrom(commit, "extract changes", {
    title,
    published: tx("Extracting these changes rewrites published history. Pushing afterward requires a force push."),
  });
  if (!range) return;
  const initial = commit.messageTruncated ? (await loadLogDetails(commit)).message : commit.message;
  const message = await promptCommitMessage(title, tx("Edit Commit Message"), initial, "Extract");
  if (message === null) return;
  if (!(await canApplyRewrite(range))) return;
  const expectedHead = { branch: range.branch, commit: range.commits.at(-1)!.id };
  const result = await runOp(
    tx("Extracting selected changes"),
    () => call(commands.vcsExtractCommitChanges(range.repo, commit.id, expectedHead, paths, message)),
    { refresh: false },
  );
  if (!result) return;
  await refreshNow();
  const key = `vcs.extract:${result.head.after}`;
  notifications().notify({
    group: "vcs",
    level: "info",
    key,
    title: tx("Selected changes extracted to a new commit"),
    userInitiated: true,
    actions: undoLink(range.repo, result.head.before, result.head.after, tx("Extraction undone"), key),
  });
  if (useVcs.getState().root === root && useGitLog.getState().shownLog === tab) {
    await revealCommit(result.commit, range.repo, tab);
  }
}

export async function dropSelectedChanges(commit: Commit, changes: LogChange[]) {
  const paths = selectedCommitPaths(commit, changes);
  if (!paths) return;
  const tab = useGitLog.getState().shownLog;
  const root = useVcs.getState().root;
  const range = await rangeFrom(commit, "drop selected changes", {
    title: tx("Drop Selected Changes"),
    published: tx("Dropping these changes rewrites published history. Pushing afterward requires a force push."),
  });
  if (!range) return;
  if (!(await canApplyRewrite(range))) return;
  const expectedHead = { branch: range.branch, commit: range.commits.at(-1)!.id };
  await runGitOperation(
    { op: "dropCommitChanges", commit: commit.id, expectedHead, paths },
    {
      progress: "Dropping selected changes",
      success: () => tx("Selected changes dropped"),
      failure: tx("Failed to drop selected changes"),
      onError: () => conflictsInstead(range.repo),
      successActions: async (rewrite) => {
        if (!rewrite) return [];
        if (useVcs.getState().root === root && useGitLog.getState().shownLog === tab) {
          void revealCommit(rewrite.commit, range.repo, tab);
        }
        const { before, after } = rewrite.head;
        return undoLink(range.repo, before, after, tx("Drop undone"), "vcs.operation");
      },
    },
    range.repo,
  );
}

/** Drop Commit(s): removes commits from the current branch. */
export async function dropCommits(commits: Commit[]) {
  if (commits.length === 1) return dropCommit(commits[0]!);
  const verb = "drop commits";
  const range = await rangeFor(commits, verb);
  if (!range) return;
  const ids = new Set(commits.map((c) => c.id));
  if (range.commits.every((c) => ids.has(c.id)) && !range.base)
    return refuse("Cannot drop commits", "At least one commit of the branch must be kept");
  const ok = await confirmDrop(
    "Drop Commits",
    tx`Drop ${commits.length} commits from the current branch? Their changes are removed.`,
  );
  if (!ok) return;
  const plan = range.commits.map((c) => ({
    commit: c.id,
    action: ids.has(c.id) ? ("drop" as const) : ("pick" as const),
    message: null,
  }));
  await runRebase(range, plan, `Dropped ${commits.length} commits`, tx("Drop undone"));
}

async function dropCommit(commit: Commit) {
  const range = await rangeFrom(commit, "drop commit");
  if (!range) return;
  if (range.commits.length === 1 && !range.base)
    return refuse("Cannot drop commit", "It is the only commit of the branch");
  const ok = await confirmDrop(
    "Drop Commit",
    tx`Drop commit ${short(commit.id)} “${commit.summary}” from the current branch? Its changes are removed.`,
  );
  if (!ok) return;
  await runRebase(
    range,
    singleCommitPlan(range, commit.id, "drop"),
    `Dropped commit ${short(commit.id)}`,
    tx("Drop undone"),
  );
}

/** Settings › Version Control › Confirmation › Ask for confirmation to drop commits, with "Don't ask again". */
async function confirmDrop(title: string, body: string): Promise<boolean> {
  if (!workflowSettings().vcs.confirmation.confirmDropCommits) return true;
  const r = await ask({
    title,
    body,
    icon: "warning",
    checkbox: "Don't ask again",
    buttons: [{ id: "drop", label: "Drop", primary: true }],
  });
  if (r.button !== "drop") return false;
  if (r.checked) await rememberSetting("vcs.confirmation.confirmDropCommits", false);
  return true;
}

/** The range from the oldest of `commits`, when all of them are on the current branch. */
async function rangeFor(commits: Commit[], verb: "drop commits" | "squash commits"): Promise<RewriteRange | null> {
  // Log order is newest first: the last selected row is the oldest commit.
  const oldest = commits[commits.length - 1]!;
  const range = await rangeFrom(oldest, verb);
  if (!range) return null;
  const inRange = new Set(range.commits.map((c) => c.id));
  if (!commits.every((c) => inRange.has(c.id))) {
    refuse(range.refusal, "All selected commits must be on the current branch");
    return null;
  }
  return range;
}

/** Squash Commits…: melds the selected commits into one, at the position of the oldest. */
export async function squashCommits(commits: Commit[]) {
  if (commits.length < 2) return;
  const range = await rangeFor(commits, "squash commits");
  if (!range) return;
  const ids = new Set(commits.map((c) => c.id));
  const oldestFirst = range.commits.filter((c) => ids.has(c.id));
  const message = await promptCommitMessage(
    "Squashed Commit Message",
    tx("Edit message for squashed commit"),
    combinedCommitMessage(oldestFirst.map((c) => c.message)),
  );
  if (message === null || !message.trim()) return;
  await runRebase(range, squashPlan(range, ids, message), `Squashed ${commits.length} commits`, tx("Squash undone"));
}

/**
 * Fixup… / Squash Into…: prepares a `fixup!` / `squash!` commit of the local changes
 * for `target` in the commit interface; the next interactive rebase autosquashes it.
 */
export function prepareFixup(target: Commit, kind: "fixup" | "squash") {
  useCommit.setState({ message: `${kind}! ${target.summary}`, fixupTarget: target });
  openCommit();
}

/** Commit and Rebase (after Fixup… / Squash Into…): autosquashes the new commit into `target`. */
export async function rebaseAfterFixup(target: Commit) {
  useCommit.setState({ fixupTarget: null });
  const range = await rangeFrom(target, "rebase");
  if (!range) return;
  await runRebase(range, toEntries(initialRows(range.commits)), tx("Rebased"));
}

/** Interactively Rebase from Here…: IDEA's rebase dialog for `target..HEAD`. */
export async function interactivelyRebaseFrom(target: Commit) {
  const range = await rangeFrom(target, "rebase");
  if (!range) return;
  let gitPlan = range.commits.some((commit) => isAutosquashSubject(commit.summary));
  try {
    gitPlan ||= Boolean(await call(commands.vcsConfigGetBool(range.repo, "rebase.updateRefs")));
  } catch (e) {
    refuse(tx("Rebase failed"), errorMessage(e));
    return;
  }
  if (gitPlan) {
    if (!(await canApplyRewrite(range))) return;
    // Git owns autosquash matching and ref updates in the rebase todo.
    await runRebaseWithEditor(
      range.repo,
      range.base,
      {},
      rebaseFeedback(range.repo, {
        progress: tx("Rebasing"),
        success: "Rebase finished",
        failure: tx("Rebase failed"),
      }),
    );
    return;
  }
  openDialog((close) => (
    <RebasePlanDialog
      repo={range.repo}
      title={rebaseTitle(range.commits.length, range.base && short(range.base))}
      initial={initialRows(range.commits)}
      validate={planProblem}
      disableStart={(rows) => planIsNoop(rows, range.commits)}
      onClose={close}
      onStart={(rows) => {
        close();
        void runRebase(range, toEntries(rows), "Rebase finished");
      }}
    />
  ));
}

function rebaseTitle(n: number, onto: string | null): string {
  if (onto) return n === 1 ? tx`Rebasing ${n} commit onto ${onto}` : tx`Rebasing ${n} commits onto ${onto}`;
  return n === 1 ? tx`Rebasing ${n} commit from the root` : tx`Rebasing ${n} commits from the root`;
}
