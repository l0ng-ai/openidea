import { commitRepo } from "./multiRoot";
/**
 * Git Log history rewriting: Undo Commit, Edit Commit Message, Drop Commit and
 * Interactively Rebase from Here (IDEA's Git.Log.ContextMenu).
 */
import { useState } from "react";
import type { Commit, RebaseAction, RebaseEntry } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { Dialog, IconButton, Select, T } from "@/ui";
import { workflowSettings } from "@/platform/workflowSettings";
import { ask, showError } from "@/workbench/messages";
import { chooseTargetChangelist, moveToChangelist } from "./changelistsUi";
import { useCommit } from "./commitStore";
import { stripSlash } from "./model";
import { openCommit } from "./commitUi";
import { rememberSetting } from "./confirmations";
import { confirmDialog, openDialog } from "./dialogs";
import { loadLogDetails } from "./logDetails";
import { conflictsInstead, inProgress } from "./operations";
import { runGitOperation, runOp, saveAll } from "./ops";
import {
  headPushed,
  initialRows,
  moveRow,
  planIsNoop,
  planProblem,
  rebaseRange,
  singleCommitPlan,
  squashPlan,
  toEntries,
  undoCommitProblem,
  type RebaseRange,
  type RebaseRow,
} from "./rebasePlan";
import { currentRepo, refreshNow, useVcs } from "./store";
import { notifications } from "@/workbench/contributions";
import styles from "./common.module.css";
import { tx } from "@/platform/i18n";

const short = (id: string) => id.slice(0, 8);

/** IDEA reports a refused history rewrite in an error dialog. */
function refuse(title: string, body: string) {
  void showError(title, body);
}

const pushedWarning = (what: string) =>
  `The commit is already pushed to ${useVcs.getState().branch?.upstream ?? "the remote"}. ${what} rewrites published history; pushing afterwards needs a force push.`;

// ---------------------------------------------------------------------------
// Undo Commit

export async function undoCommit(commit: Commit) {
  const repo = commitRepo(commit) ?? currentRepo();
  await refreshNow();
  const branch = useVcs.getState().branch;
  const problem = undoCommitProblem(commit, branch);
  if (problem) return refuse("Cannot undo commit", problem);
  if (headPushed(branch)) {
    const ok = await confirmDialog({
      title: "Undo Commit",
      message: pushedWarning("Undoing it"),
      okLabel: "Undo Commit",
      danger: true,
    });
    if (!ok) return;
  }
  // The undone changes go to a change list the user picks (a new one is named after the commit).
  const target = await chooseTargetChangelist(commit.summary);
  if (target === null) return;
  const files = await call(commands.vcsCommitFiles(repo, commit.id)).catch(() => []);
  const undo = () => call(commands.vcsUndoCommit(repo, commit.id));
  const message = await runOp(tx`Undo commit ${short(commit.id)}`, undo, {
    success: tx`Undid commit ${short(commit.id)} “${commit.summary}”`,
  });
  if (message === undefined) return;
  const root = repo ?? useVcs.getState().root ?? "";
  moveToChangelist(
    files.flatMap((f) => [f.path, f.oldPath].filter((p): p is string => !!p).map((p) => `${stripSlash(root)}/${p}`)),
    target,
  );
  // The undone commit's message becomes the next commit's.
  useCommit.setState({ message });
}

// ---------------------------------------------------------------------------
// Rebase-based actions

/** The commits from `target` to HEAD, or a warning when they cannot be rewritten. */
async function rangeFrom(target: Commit, verb: string): Promise<(RebaseRange & { repo: string | null }) | null> {
  const repo = commitRepo(target) ?? currentRepo();
  await refreshNow();
  const branch = useVcs.getState().branch;
  const op = inProgress(branch?.operation);
  if (op) {
    refuse(`Cannot ${verb}`, `A ${op} is in progress`);
    return null;
  }
  const parent = target.parents[0];
  try {
    const history = await call(
      commands.vcsLog(repo, {
        branch: "HEAD",
        path: null,
        author: null,
        text: null,
        range: parent ? `${parent}..HEAD` : null,
        skip: 0,
        limit: 0,
      }),
    );
    const range = rebaseRange(target, history);
    if ("error" in range) {
      refuse(`Cannot ${verb}`, range.error);
      return null;
    }
    if (headPushed(branch)) {
      const ok = await confirmDialog({
        title: verb.replace(/^\w/, (c) => c.toUpperCase()),
        message: pushedWarning(verb.replace(/^\w/, (c) => c.toUpperCase())),
        okLabel: "Continue",
        danger: true,
      });
      if (!ok) return null;
    }
    return { ...range, repo };
  } catch (e) {
    refuse(`Cannot ${verb}`, e instanceof Error ? e.message : String(e));
    return null;
  }
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
        void runOp(tx("Undo"), () => call(commands.vcsRestoreHead(repo, before, after))).then((done) => {
          if (done === undefined) return;
          notifications().notify({ group: "vcs", level: "info", key, title: undone });
        }),
    },
  ];
}

/** Rewrites the branch with `entries`; a finished rewrite can be undone from its balloon. */
async function runRebase(
  base: string | null,
  entries: RebaseEntry[],
  done: string,
  repo: string | null,
  undone = tx("Rebase undone"),
) {
  await saveAll();
  const before = await headOf(repo);
  await runGitOperation(
    { op: "interactiveRebase", base, entries },
    {
      progress: "Rebasing",
      success: () => (inProgress() === "rebase" ? "Rebase stopped for editing; continue the rebase when done" : done),
      failure: tx("Rebase failed"),
      onError: conflictsInstead,
      successActions: async () =>
        inProgress() === "rebase" ? [] : undoLink(repo, before, await headOf(repo), undone, "vcs.operation"),
    },
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
  const message = await promptMessage(`Edit Commit Message (${short(commit.id)})`, initial);
  if (message === null || message.trim() === initial.trim()) return;
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
  await runRebase(range.base, plan, `Dropped ${commits.length} commits`, range.repo, tx("Drop undone"));
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
    range.base,
    singleCommitPlan(range, commit.id, "drop"),
    `Dropped commit ${short(commit.id)}`,
    range.repo,
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
async function rangeFor(commits: Commit[], verb: string): Promise<(RebaseRange & { repo: string | null }) | null> {
  // Log order is newest first: the last selected row is the oldest commit.
  const oldest = commits[commits.length - 1]!;
  const range = await rangeFrom(oldest, verb);
  if (!range) return null;
  const inRange = new Set(range.commits.map((c) => c.id));
  if (!commits.every((c) => inRange.has(c.id))) {
    refuse(`Cannot ${verb}`, "All selected commits must be on the current branch");
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
  const message = await promptMessage(
    `Squash ${commits.length} Commits`,
    oldestFirst.map((c) => c.message.trim()).join("\n\n"),
  );
  if (message === null || !message.trim()) return;
  await runRebase(
    range.base,
    squashPlan(range, ids, message),
    `Squashed ${commits.length} commits`,
    range.repo,
    tx("Squash undone"),
  );
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
  await runRebase(range.base, toEntries(initialRows(range.commits)), tx("Rebased"), range.repo);
}

/** Interactively Rebase from Here…: IDEA's rebase dialog for `target..HEAD`. */
export async function interactivelyRebaseFrom(target: Commit) {
  const range = await rangeFrom(target, "rebase");
  if (!range) return;
  openDialog((close) => <InteractiveRebaseDialog range={range} onClose={close} />);
}

function promptMessage(title: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <MessageDialog
        title={title}
        initial={initial}
        onDone={(m) => {
          close();
          resolve(m);
        }}
      />
    ));
  });
}

function MessageDialog({
  title,
  initial,
  onDone,
}: {
  title: string;
  initial: string;
  onDone: (message: string | null) => void;
}) {
  const [message, setMessage] = useState(initial);
  return (
    <Dialog
      open
      title={title}
      onClose={() => onDone(null)}
      width={520}
      buttons={[
        { label: "OK", role: "default", disabled: !message.trim(), onClick: () => onDone(message) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <textarea
          data-autofocus
          aria-label={tx("Commit message")}
          className={styles.textarea}
          rows={8}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

const ACTIONS: Array<{ value: RebaseAction; label: string }> = [
  { value: "pick", label: "Pick" },
  { value: "reword", label: "Reword" },
  { value: "edit", label: "Stop to Edit" },
  { value: "squash", label: "Squash" },
  { value: "fixup", label: "Fixup" },
  { value: "drop", label: "Drop" },
];

function InteractiveRebaseDialog({
  range,
  onClose,
}: {
  range: RebaseRange & { repo: string | null };
  onClose: () => void;
}) {
  const [rows, setRows] = useState<RebaseRow[]>(() => initialRows(range.commits));
  const problem = planProblem(rows);
  const noop = planIsNoop(rows, range.commits);
  const update = (i: number, patch: Partial<RebaseRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const start = () => {
    if (problem || noop) return;
    onClose();
    void runRebase(range.base, toEntries(rows), "Rebase finished", range.repo);
  };
  return (
    <Dialog
      open
      title={rebaseTitle(range.commits.length, range.base && short(range.base))}
      onClose={onClose}
      width={720}
      footerStart={problem ? <span className={styles.error}>{problem}</span> : undefined}
      buttons={[
        { label: "Start Rebasing", role: "default", disabled: !!problem || noop, onClick: start },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.section}>
        <T>Commits are applied from top to bottom.</T>
      </div>
      <div className={styles.rebaseList} role="list" aria-label={tx("Commits to rebase")}>
        {rows.map((r, i) => (
          <div key={r.commit.id} className={styles.rebaseRow} role="listitem">
            <Select<RebaseAction>
              value={r.action}
              options={ACTIONS}
              aria-label={tx`Action for ${short(r.commit.id)}`}
              className={styles.rebaseAction}
              onChange={(action) => update(i, { action })}
            />
            <span className={styles.commitHash}>{r.commit.shortId}</span>
            {r.action === "reword" ? (
              <textarea
                className={`${styles.textarea} ${styles.rebaseMessage}`}
                aria-label={`New message for ${short(r.commit.id)}`}
                rows={2}
                value={r.message}
                onChange={(e) => update(i, { message: e.target.value })}
              />
            ) : (
              <span
                className={styles.commitSubject}
                style={r.action === "drop" ? { textDecoration: "line-through" } : undefined}
                title={r.commit.message}
              >
                {r.commit.summary}
              </span>
            )}
            <IconButton
              icon="arrow-up"
              size="small"
              title="Move Up"
              disabled={i === 0}
              onClick={() => setRows((rs) => moveRow(rs, i, -1))}
            />
            <IconButton
              icon="arrow-down"
              size="small"
              title="Move Down"
              disabled={i === rows.length - 1}
              onClick={() => setRows((rs) => moveRow(rs, i, 1))}
            />
          </div>
        ))}
      </div>
      <div style={{ height: 12 }} />
    </Dialog>
  );
}

function rebaseTitle(n: number, onto: string | null): string {
  if (onto) return n === 1 ? tx`Rebasing ${n} commit onto ${onto}` : tx`Rebasing ${n} commits onto ${onto}`;
  return n === 1 ? tx`Rebasing ${n} commit from the root` : tx`Rebasing ${n} commits from the root`;
}
