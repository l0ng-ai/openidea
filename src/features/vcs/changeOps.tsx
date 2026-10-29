/** Local change operations: commit, rollback, add, stash. */
import { useEffect, useState } from "react";
import type { FileStatus, PartialCommitFile, Stash } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { Checkbox, Dialog, Icon, Input, T, fileIconName } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { commitRepos, groupOf, planCommit, renamedFromPath } from "./changes";
import { useChangelists, withListDefaults } from "./changelists";
import { runCommitChecks } from "./commitChecks";
import { forgetAmendDraft, keepMessageAfterCommit, rememberMessage, useCommit } from "./commitStore";
import { workflowSettings } from "@/platform/workflowSettings";
import { confirmDialog, openDialog } from "./dialogs";
import { hunkKeys } from "./hunks";
import { KIND_COLOR, baseName, dirName, effectiveKind, relTo, rootOf, stripSlash } from "./model";
import { logConsole, runOp, saveAll } from "./ops";
import { currentRepo, loadStashes, refreshNow, useVcs } from "./store";
import styles from "./common.module.css";
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
  const { message, amend, signOff, author, runHooks } = useCommit.getState();
  if (!message.trim() && !amend) {
    notifications().notify({ group: "vcs", level: "warning", title: "Commit message is empty" });
    return undefined;
  }
  await saveAll();
  await refreshNow();
  const status = useVcs.getState().status;
  const checks = withListDefaults(
    status,
    useVcs.getState().root ?? "",
    useChangelists.getState().state,
    useCommit.getState().checks,
  );
  const plan = planCommit(status, checks);
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
  const candidates = plan.included.map((f) => ({ path: stripSlash(f.path), exists: effectiveKind(f) !== "deleted" }));
  // IDEA: failed checks show in the commit panel; the next Commit ("Commit Anyway") skips them.
  if (!useCommit.getState().checkProblems.length) {
    const problems = await runCommitChecks(candidates, amend);
    if (problems.length) {
      useCommit.setState({ checkProblems: problems });
      return undefined;
    }
  }
  const partial = await partialCommitFiles(plan.partial);
  // Like IDEA, every repository with included changes gets a commit with the same message.
  const roots = useVcs.getState().roots;
  const repos = commitRepos(plan.included, roots, currentRepo());
  const id = await runOp(
    amend ? "Amend commit" : "Commit",
    async () => {
      if (plan.unstage.length) await call(commands.vcsUnstage(plan.unstage));
      const stage = [...plan.stage, ...partial.whole];
      if (stage.length) await call(commands.vcsStage(stage));
      let id = "";
      for (const repo of repos) {
        const files = partial.files.filter((f) => (rootOf(f.path, roots) ?? null) === repo || repos.length === 1);
        const options = { amend, signOff, author: author.trim() || null, runHooks, partial: files };
        id = await call(commands.vcsCommit(repo, message.trim(), options));
      }
      return id;
    },
    {
      success: () => {
        const n = plan.included.length;
        const summary = firstLine(message);
        const where = repos.length > 1 ? ` in ${repos.length} repositories` : "";
        return `${n} file${n === 1 ? "" : "s"} ${amend ? "amended" : "committed"}${where}${summary ? `: ${summary}` : ""}`;
      },
    },
  );
  if (id !== undefined) {
    rememberMessage(message);
    forgetAmendDraft();
    useCommit.setState({ amend: false, checks: new Map(), excludedHunks: new Map(), checkProblems: [] });
    keepMessageAfterCommit(message, workflowSettings().vcs.commit.clearInitialMessage);
  }
  return id;
}

/**
 * The included blocks of files committed partially, as hunk ranges against HEAD of the
 * text on disk (saved just before). A file whose blocks are all included again (e.g. it
 * was edited since) is committed whole.
 */
async function partialCommitFiles(paths: readonly string[]): Promise<{ files: PartialCommitFile[]; whole: string[] }> {
  const files: PartialCommitFile[] = [];
  const whole: string[] = [];
  const excludedHunks = useCommit.getState().excludedHunks;
  for (const path of paths) {
    const [head, disk] = await Promise.all([call(commands.vcsFileAt(path, "HEAD")), call(commands.fsReadText(path))]);
    const hunks = await commands.vcsDiffHunks(head ?? "", disk);
    const keys = hunkKeys(disk, hunks);
    const excluded = excludedHunks.get(path) ?? excludedHunks.get(`${path}/`);
    const chosen = hunks.filter((_, i) => !excluded?.has(keys[i]!));
    if (chosen.length === hunks.length) whole.push(path);
    else
      files.push({
        path,
        hunks: chosen.map(({ start, lines, oldStart, oldLines }) => ({ start, lines, oldStart, oldLines })),
      });
  }
  return { files, whole };
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
  const root = useVcs((s) => s.root) ?? "";
  const [selected, setSelected] = useState(() => new Set(files.map((f) => f.path)));
  const [deleteAdded, setDeleteAdded] = useState(false);
  const hasAdded = files.some((f) => f.staged === "added");
  const run = async () => {
    const chosen = files.filter((f) => selected.has(f.path));
    onClose();
    if (!chosen.length) return;
    await saveAll();
    const { unstage, discard } = rollbackPlan(chosen, deleteAdded);
    await runOp(
      "Rollback",
      async () => {
        if (unstage.length) await call(commands.vcsUnstage(unstage));
        if (discard.length) await call(commands.vcsDiscard(discard));
      },
      { success: `Rolled back ${chosen.length} file${chosen.length === 1 ? "" : "s"}` },
    );
  };
  return (
    <Dialog
      open
      title="Rollback Changes"
      onClose={onClose}
      width={520}
      footerStart={
        hasAdded && (
          <Checkbox checked={deleteAdded} onChange={setDeleteAdded} label="Delete local copies of added files" />
        )
      }
      buttons={[
        { label: "Rollback", role: "default", autoFocus: true, disabled: !selected.size, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.section}>
        {files.length === 1
          ? tx`${selected.size} of ${files.length} file will be reverted to their last committed state. Uncommitted changes are lost.`
          : tx`${selected.size} of ${files.length} files will be reverted to their last committed state. Uncommitted changes are lost.`}
      </div>
      <div className={styles.fileList} role="group" aria-label={tx("Files to roll back")}>
        {files.map((f) => {
          const kind = effectiveKind(f) ?? "modified";
          return (
            <div key={f.path} className={styles.fileRow}>
              <Checkbox
                aria-label={tx`Include ${baseName(f.path)}`}
                checked={selected.has(f.path)}
                onChange={(v) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (v) n.add(f.path);
                    else n.delete(f.path);
                    return n;
                  })
                }
              />
              <Icon name={fileIconName(baseName(f.path))} size={14} />
              <span className={styles.fileName} style={{ color: KIND_COLOR[kind] }}>
                {baseName(f.path)}
              </span>
              <span className={styles.fileDir}>{dirName(relTo(root, stripSlash(f.path)))}</span>
            </div>
          );
        })}
      </div>
      <div style={{ height: 12 }} />
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
  await runOp(`Add ${targets.length} file${targets.length === 1 ? "" : "s"} to Git`, () =>
    call(commands.vcsStage(targets.map(stripSlash))),
  );
}

/** Stash Changes dialog: message, Keep index (staged changes stay), include untracked files. */
export function stashChanges(repo = currentRepo()): Promise<void> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <StashDialog
        onDone={async (r) => {
          close();
          if (r) {
            await saveAll();
            await runOp(
              "Stash changes",
              () => call(commands.vcsStashPush(repo, r.message || null, r.includeUntracked, r.keepIndex)),
              { success: "Changes stashed" },
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
  onDone,
}: {
  onDone: (r: { message: string; keepIndex: boolean; includeUntracked: boolean } | null) => void;
}) {
  const [message, setMessage] = useState("");
  const [keepIndex, setKeepIndex] = useState(false);
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const branch = useVcs((s) => s.branch?.head ?? null);
  const submit = () => onDone({ message: message.trim(), keepIndex, includeUntracked });
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
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {branch && <div className={styles.hint}>{tx`Current branch: ${branch}`}</div>}
        <label className={styles.fieldLabel}>
          <T>Message:</T>
        </label>
        <Input
          data-autofocus
          aria-label="Message"
          placeholder="WIP"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <Checkbox checked={keepIndex} onChange={setKeepIndex} label="Keep index" />
        <Checkbox checked={includeUntracked} onChange={setIncludeUntracked} label="Include untracked files" />
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
    return { title: tx`Unstash ${ref} as branch ${o.branch}`, success: `Unstashed ${ref} on branch ${o.branch}` };
  return o.pop
    ? { title: tx`Pop ${ref}`, success: `Unstashed ${ref}` }
    : { title: tx`Apply ${ref}`, success: `Applied ${ref}` };
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

/** Unstash Changes dialog: pick a stash; Pop, Reinstate index, or As new branch. */
export function showUnstashDialog(index = 0, repo = currentRepo()) {
  openDialog((close) => <UnstashDialog initial={index} repo={repo} onClose={close} />);
}

function UnstashDialog({ initial, repo, onClose }: { initial: number; repo: string | null; onClose: () => void }) {
  const [stashes, setStashes] = useState<Stash[]>([]);
  useEffect(() => {
    let live = true;
    void call(commands.vcsStashes(repo))
      .then((value) => live && setStashes(value))
      .catch((e) => logConsole("err", String(e)));
    return () => {
      live = false;
    };
  }, [repo]);
  const [index, setIndex] = useState(initial);
  const [pop, setPop] = useState(false);
  const [reinstateIndex, setReinstateIndex] = useState(false);
  const [branch, setBranch] = useState("");
  const asBranch = branch.trim();
  const chosen = stashes.find((s) => s.index === index) ?? stashes[0];
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

export async function dropStash(index: number, message: string, repo = currentRepo()) {
  const ok = await confirmDialog({
    title: "Drop Stash",
    message: message
      ? tx`Drop ${`stash@{${index}}`} “${message}”? This cannot be undone.`
      : tx`Drop ${`stash@{${index}}`}? This cannot be undone.`,
    okLabel: "Drop",
    danger: true,
  });
  if (!ok) return;
  await runOp(`Drop stash@{${index}}`, () => call(commands.vcsStashDrop(repo, index)), {
    success: `Dropped stash@{${index}}`,
  });
  void loadStashes().catch((e) => logConsole("err", String(e)));
}
