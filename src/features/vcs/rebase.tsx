import { commitRepo } from "./multiRoot";
/**
 * Git Log history rewriting: Undo Commit, Edit Commit Message, Drop Commit and
 * Interactively Rebase from Here (IDEA's Git.Log.ContextMenu).
 */
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { BranchInfo, Commit, RebaseAction, RebaseEntry } from "@/bindings";
import { fontWeightOf } from "@/platform/editorSettings";
import { resolveMonoFont } from "@/platform/fonts";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { Dialog, IconButton, Select, SplitGroup, SplitHandle, SplitPanel, T } from "@/ui";
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
  protectedBranchProblem,
  rebaseRange,
  singleCommitPlan,
  squashPlan,
  toEntries,
  undoCommitProblem,
  type RebaseRange,
  type RebaseRow,
} from "./rebasePlan";
import { currentRepo, refreshNow, useVcs } from "./store";
import { isProtectedBranch } from "./remoteUi";
import { notifications } from "@/workbench/contributions";
import styles from "./common.module.css";
import messageStyles from "./CommitMessageDialog.module.css";
import { tx } from "@/platform/i18n";

const short = (id: string) => id.slice(0, 8);

/** IDEA reports a refused history rewrite in an error dialog. */
function refuse(title: string, body: string) {
  void showError(title, body);
}

/** Pushed history of a protected branch cannot be rewritten (force push is not allowed there). */
const protectedProblem = (branch: { head: string | null; upstream: string | null } | null) =>
  protectedBranchProblem(branch ?? { head: null, upstream: null }, isProtectedBranch);

const pushedWarning = (what: string) =>
  `The commit is already pushed to ${useVcs.getState().branch?.upstream ?? "the remote"}. ${what} rewrites published history; pushing afterwards needs a force push.`;

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
  await refreshNow();
  const branch = useVcs.getState().branch;
  // Protected branches refuse only rewrites of history that is already pushed.
  const problem = undoCommitProblem(commit, branch) ?? (headPushed(branch) ? protectedProblem(branch) : null);
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
    if (await rangeTouchesUpstream(branch, range, repo)) {
      // Protected branches refuse only rewrites of history that is already pushed.
      const protectedBranch = protectedProblem(branch);
      if (protectedBranch) {
        refuse(`Cannot ${verb}`, protectedBranch);
        return null;
      }
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
  const hash = short(commit.id);
  const author = commit.author || commit.email;
  const label = author ? tx`Edit message for commit ${hash} by ${author}` : tx`Edit message for commit ${hash}`;
  const message = await promptMessage("Edit Commit Message", label, initial);
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
    "Squashed Commit Message",
    tx("Edit message for squashed commit"),
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

function promptMessage(title: string, label: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <MessageDialog
        title={title}
        label={label}
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
  label,
  initial,
  onDone,
}: {
  title: string;
  label: string;
  initial: string;
  onDone: (message: string | null) => void;
}) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState(initial);
  const editor = useProject((s) => s.settings?.editor);
  const { family, size } = resolveMonoFont(undefined, editor);
  useLayoutEffect(() => field.current?.setSelectionRange(0, 0), []);

  return (
    <Dialog
      open
      title={title}
      onClose={() => onDone(null)}
      width={620}
      minWidth={340}
      resizable="both"
      className={messageStyles.dialog}
      buttons={[
        { label: "OK", role: "default", disabled: !message.trim(), onClick: () => onDone(message) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={messageStyles.form}>
        <label className={messageStyles.label} htmlFor={id}>
          {label}
        </label>
        <textarea
          id={id}
          ref={field}
          data-autofocus
          className={`${styles.textarea} ${messageStyles.editor}`}
          style={{
            fontFamily: family,
            fontSize: size,
            fontWeight: fontWeightOf(editor?.fontWeight, 400),
            lineHeight: editor?.lineHeight ? `${editor.lineHeight}px` : undefined,
          }}
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
  const [selectedId, setSelectedId] = useState(() => rows[0]?.commit.id);
  const pageRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const measure = () => setStacked(page.clientWidth < 640);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);

  const selectedIndex = rows.findIndex((r) => r.commit.id === selectedId);
  const selected = rows[selectedIndex];
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
      width={960}
      minWidth={360}
      minHeight={360}
      resizable="both"
      className={styles.rebaseDialog}
      buttons={[
        { label: "Start Rebasing", role: "default", disabled: !!problem || noop, onClick: start },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.rebasePage} ref={pageRef}>
        <SplitGroup id="rebase-panes" className={styles.rebaseSplit} orientation={stacked ? "vertical" : "horizontal"}>
          <SplitPanel id="rebase-plan" defaultSize="50%" minSize="30%">
            <div className={styles.rebaseToolbar}>
              <IconButton
                icon="arrow-up"
                size="small"
                title="Move Up"
                disabled={selectedIndex <= 0}
                onClick={() => setRows((rs) => moveRow(rs, selectedIndex, -1))}
              />
              <IconButton
                icon="arrow-down"
                size="small"
                title="Move Down"
                disabled={selectedIndex < 0 || selectedIndex === rows.length - 1}
                onClick={() => setRows((rs) => moveRow(rs, selectedIndex, 1))}
              />
              <span className={styles.hint}>
                <T>Commits are applied from top to bottom.</T>
              </span>
            </div>
            <div className={styles.rebaseList} role="list" aria-label={tx("Commits to rebase")}>
              {rows.map((r, i) => (
                <div
                  key={r.commit.id}
                  className={styles.rebaseRow}
                  role="listitem"
                  data-selected={r.commit.id === selectedId || undefined}
                >
                  <button
                    type="button"
                    className={styles.rebaseCommit}
                    aria-current={r.commit.id === selectedId || undefined}
                    onClick={() => setSelectedId(r.commit.id)}
                    title={r.commit.summary}
                  >
                    <span className={styles.rebaseSubject} data-dropped={r.action === "drop" || undefined}>
                      {r.commit.summary}
                    </span>
                    <span className={styles.commitHash}>{r.commit.shortId}</span>
                  </button>
                  <Select<RebaseAction>
                    value={r.action}
                    options={ACTIONS}
                    aria-label={tx`Action for ${short(r.commit.id)}`}
                    className={styles.rebaseAction}
                    onChange={(action) => {
                      setSelectedId(r.commit.id);
                      update(i, { action });
                    }}
                  />
                </div>
              ))}
            </div>
          </SplitPanel>
          <SplitHandle aria-label={tx("Resize rebase panes")} />
          <SplitPanel id="rebase-details" defaultSize="50%" minSize="30%">
            {selected && (
              <section className={styles.rebaseDetails} aria-label={tx("Commit details")}>
                <div className={styles.rebaseMetadata}>
                  <span className={styles.commitHash}>{selected.commit.shortId}</span>
                  <span>{selected.commit.author}</span>
                </div>
                {selected.action === "reword" ? (
                  <textarea
                    key={selected.commit.id}
                    className={`${styles.textarea} ${styles.rebaseMessage}`}
                    aria-label={tx`New message for ${short(selected.commit.id)}`}
                    rows={5}
                    value={selected.message}
                    onChange={(e) => update(selectedIndex, { message: e.target.value })}
                  />
                ) : (
                  <div className={styles.rebasePreview}>
                    {selected.commit.message.trimEnd() || selected.commit.summary}
                  </div>
                )}
              </section>
            )}
          </SplitPanel>
        </SplitGroup>
        {problem && (
          <div className={styles.error} role="alert">
            {tx(problem)}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function rebaseTitle(n: number, onto: string | null): string {
  if (onto) return n === 1 ? tx`Rebasing ${n} commit onto ${onto}` : tx`Rebasing ${n} commits onto ${onto}`;
  return n === 1 ? tx`Rebasing ${n} commit from the root` : tx`Rebasing ${n} commits from the root`;
}
