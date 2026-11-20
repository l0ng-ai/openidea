/** Local change operations: commit, rollback, add, stash. */
import { useEffect, useId, useState } from "react";
import type { FileStatus, Stash } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { Checkbox, Dialog, IconButton, Input, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { addedThenDeleted, groupOf, remainingOverrides, renamedFromPath } from "./changes";
import { runCommitChecks } from "./commitChecks";
import { contributedCheckProblems, currentPlan, selectionOf } from "./commitSelection";
import { forgetAmendDraft, keepMessageAfterCommit, rememberMessage, useCommit } from "./commitStore";
import { workflowSettings } from "@/platform/workflowSettings";
import { notifyFileOperation } from "@/platform/fileOps";
import { confirmDialog, openDialog } from "./dialogs";
import { RepoPicker, useBranchInfo } from "./gitMenuDialogs";
import { baseName, effectiveKind, stripSlash } from "./model";
import { logConsole, runOp, saveAll } from "./ops";
import { ensureCommitIdentity } from "./commitIdentity";
import { showCompareRevisions } from "./operations";
import { FileChecklist } from "./shelf";
import { currentRepo, loadStashes, refreshNow, useVcs } from "./store";
import styles from "./common.module.css";
import rollbackStyles from "./RollbackDialog.module.css";
import { tx } from "@/platform/i18n";

export function firstLine(message: string): string {
  return (
    message
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? ""
  );
}

/** Stages the included changes and commits them. Returns the new commit id. */
export async function commitChanges(): Promise<string | undefined> {
  const { message, amend } = useCommit.getState();
  if (!message.trim() && !amend) {
    notifications().notify({ group: "vcs", level: "warning", title: "Commit message is empty" });
    return undefined;
  }
  await saveAll();
  await refreshNow();
  const plan = currentPlan();
  // Concluding a merge needs no further changes (e.g. every conflict resolved as "yours").
  const merging = useVcs.getState().branch?.operation === "merge";
  if (!plan.included.length && !amend && !merging) {
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
  const candidates = plan.included.map((f) => ({
    path: stripSlash(f.path),
    exists: effectiveKind(f) !== "deleted" && !addedThenDeleted(f),
  }));
  // IDEA: failed checks show in the commit panel; the next Commit ("Commit Anyway") skips them.
  const checked = !useCommit.getState().checkProblems.length;
  if (checked) {
    const { problems, blocked } = await runCommitChecks(candidates, amend);
    if (problems.length) useCommit.setState({ checkProblems: problems });
    if (blocked) return undefined;
  }
  // After the checks: their modifications (reformat…) are part of the commit.
  const selection = await selectionOf(plan);
  if (checked) {
    const problems = await contributedCheckProblems(selection);
    if (problems.length) {
      useCommit.setState({ checkProblems: problems });
      return undefined;
    }
  }
  if (
    !(await ensureCommitIdentity(
      selection.repositories.map((r) => r.root || null),
      amend,
    ))
  )
    return undefined;
  const id = await runOp(
    amend ? "Amend commit" : "Commit",
    async () => {
      let id = "";
      for (const repo of selection.repositories) {
        id = await call(commands.vcsCommit(repo.root || null, message.trim(), repo.options));
      }
      return id;
    },
    {
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
  if (id !== undefined) {
    rememberMessage(message);
    forgetAmendDraft();
    // What the user left out of this commit stays left out; only the committed changes start over.
    const { checks: userChecks, excludedHunks } = useCommit.getState();
    useCommit.setState({
      amend: false,
      checks: remainingOverrides(userChecks, plan.included),
      excludedHunks: remainingOverrides(excludedHunks, plan.included),
      checkProblems: [],
    });
    keepMessageAfterCommit(message, workflowSettings().vcs.commit.clearInitialMessage);
  }
  return id;
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
  roots: readonly string[] = useVcs.getState().roots,
): FileStatus[] {
  // A nested repository's own entry (a submodule's checked-out commit) is not rolled back
  // from the enclosing repository: it is changed by checking out a commit in the submodule.
  const changed = status.filter((f) => {
    const g = groupOf(f);
    return (g === "changes" || g === "conflicts") && !isNestedRepoEntry(f.path, roots);
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

/** `path` is the root of a repository nested in another one (its submodule / untracked-folder entry there). */
export function isNestedRepoEntry(path: string, roots: readonly string[] = useVcs.getState().roots): boolean {
  const p = stripSlash(path);
  return roots.includes(p) && roots.some((r) => p.startsWith(r + "/"));
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

export function showRollbackDialog(files: FileStatus[]) {
  if (!files.length) {
    notifications().notify({ group: "vcs", level: "info", title: "No changes to roll back" });
    return;
  }
  openDialog((close) => <RollbackDialog files={files} onClose={close} />);
}

function RollbackDialog({ files, onClose }: { files: FileStatus[]; onClose: () => void }) {
  const [selected, setSelected] = useState(() => new Set(files.map((f) => f.path)));
  const [deleteAdded, setDeleteAdded] = useState(false);
  const chosen = files.filter((f) => selected.has(f.path));
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const file of chosen) {
    const kind = effectiveKind(file);
    counts[kind === "added" || kind === "deleted" ? kind : "modified"]++;
  }
  const { added, modified, deleted } = counts;
  const run = async () => {
    onClose();
    if (!chosen.length) return;
    await saveAll();
    const { unstage, discard } = rollbackPlan(chosen, deleteAdded);
    await runOp(
      tx("Rollback"),
      async () => {
        if (unstage.length) await call(commands.vcsUnstage(unstage));
        if (discard.length) await call(commands.vcsDiscard(discard));
      },
      { success: chosen.length === 1 ? tx("Rolled back 1 file") : tx`Rolled back ${chosen.length} files` },
    );
  };
  return (
    <Dialog
      open
      title="Rollback Changes"
      onClose={onClose}
      className={rollbackStyles.dialog}
      width={540}
      minWidth={320}
      minHeight={240}
      resizable="both"
      buttons={[
        { label: "Rollback", role: "default", disabled: !chosen.length, onClick: () => void run() },
        { label: "Close", role: "cancel" },
      ]}
    >
      <div className={rollbackStyles.content}>
        <FileChecklist
          files={files}
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
        <Checkbox
          checked={added > 0 && deleteAdded}
          disabled={!added}
          onChange={setDeleteAdded}
          label="Delete local copies of added files"
        />
        <p className={rollbackStyles.warning}>
          <T>Rollback discards uncommitted changes in the selected files.</T>
        </p>
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

export async function unstash(o: UnstashOptions, repo = currentRepo()) {
  await saveAll();
  const { title, success } = unstashTitles(o);
  await runOp(title, () => call(commands.vcsStashApply(repo, o.index, o.pop, o.reinstateIndex, o.branch)), {
    success,
  });
  void loadStashes().catch((e) => logConsole("err", String(e)));
}

export function applyStash(index: number, pop: boolean, repo = currentRepo()) {
  return unstash({ index, pop, reinstateIndex: false, branch: null }, repo);
}

/** Unstash Changes dialog: pick a stash; Pop, Reinstate index, or As new branch; view or drop it. */
export function showUnstashDialog(index = 0, repo = currentRepo()) {
  openDialog((close) => <UnstashDialog initial={index} repo={repo} onClose={close} />);
}

function UnstashDialog({ initial, repo, onClose }: { initial: number; repo: string | null; onClose: () => void }) {
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void call(commands.vcsStashes(repo))
      .then((value) => live && setStashes(value))
      .catch((e) => logConsole("err", String(e)));
    return () => {
      live = false;
    };
  }, [repo, tick]);
  const [index, setIndex] = useState(initial);
  const [pop, setPop] = useState(false);
  const [reinstateIndex, setReinstateIndex] = useState(false);
  const [branch, setBranch] = useState("");
  const asBranch = branch.trim();
  const chosen = stashes.find((s) => s.index === index) ?? stashes[0];
  const view = () => {
    if (!chosen) return;
    const ref = `stash@{${chosen.index}}`;
    showCompareRevisions(`${ref}^`, ref, `${ref}^`, ref, repo);
  };
  const drop = async () => {
    if (!chosen || !(await dropStash(chosen.index, chosen.message, repo))) return;
    // The older stashes move up: the next one takes the dropped one's index, else the new last one.
    setIndex(Math.max(0, Math.min(chosen.index, stashes.length - 2)));
    setTick((n) => n + 1);
  };
  const submit = () => {
    if (!chosen) return;
    onClose();
    void unstash({ index: chosen.index, pop, reinstateIndex, branch: asBranch || null }, repo);
  };
  return (
    <Dialog
      open
      title="Unstash Changes"
      onClose={onClose}
      width={520}
      buttons={[
        {
          label: asBranch ? "Create Branch" : pop ? "Pop Stash" : "Apply Stash",
          role: "default",
          disabled: !chosen,
          onClick: submit,
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className={styles.manageBar} role="toolbar" aria-label={tx("Stashes")}>
          <IconButton icon="diff" title="Show Changes" size="small" disabled={!chosen} onClick={view} />
          <IconButton icon="trash" title="Drop Stash" size="small" disabled={!chosen} onClick={() => void drop()} />
        </div>
        <div className={styles.choiceList} role="radiogroup" aria-label={tx("Stashes")}>
          {stashes.length === 0 && (
            <div className={styles.hint}>
              <T>No stashes</T>
            </div>
          )}
          {stashes.map((s) => (
            <label key={s.index} className={styles.radioRow}>
              <input type="radio" name="stash" checked={chosen?.index === s.index} onChange={() => setIndex(s.index)} />
              <span className={styles.radioText}>
                <span>{`stash@{${s.index}}: ${s.message}`}</span>
              </span>
            </label>
          ))}
        </div>
        <Checkbox checked={pop || !!asBranch} disabled={!!asBranch} onChange={setPop} label="Pop stash" />
        <Checkbox
          checked={reinstateIndex || !!asBranch}
          disabled={!!asBranch}
          onChange={setReinstateIndex}
          label="Reinstate index"
        />
        <label className={styles.fieldLabel}>
          <T>As new branch:</T>
        </label>
        <Input mono aria-label="As new branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
      </form>
    </Dialog>
  );
}

/** Drops the stash once confirmed; whether it was confirmed. */
export async function dropStash(index: number, message: string, repo = currentRepo()): Promise<boolean> {
  const ok = await confirmDialog({
    title: "Drop Stash",
    message: message
      ? tx`Drop ${`stash@{${index}}`} “${message}”? This cannot be undone.`
      : tx`Drop ${`stash@{${index}}`}? This cannot be undone.`,
    okLabel: "Drop",
    danger: true,
  });
  if (!ok) return false;
  await runOp(tx`Drop ${`stash@{${index}}`}`, () => call(commands.vcsStashDrop(repo, index)), {
    success: tx`Dropped ${`stash@{${index}}`}`,
  });
  void loadStashes().catch((e) => logConsole("err", String(e)));
  return true;
}
