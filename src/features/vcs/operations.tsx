import { commitKey, commitRepo } from "./multiRoot";
/**
 * Operations on history: Continue / Abort / Skip of a stopped merge, rebase,
 * cherry-pick or revert, and the Git Log commit actions (Cherry-Pick, Revert
 * Commit, Reset Current Branch to Here, New Tag, Compare with Local).
 */
import { useEffect, useState } from "react";
import type { ChangedFile, Commit, ResetMode } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { Checkbox, Dialog, Icon, Input, List, Spinner, fileIconName, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { openDiff, type DiffSide } from "./diffInput";
import { openDialog, promptText } from "./dialogs";
import { KIND_COLOR, baseName, dirName } from "./model";
import { runGitOperation, runOp } from "./ops";
import { reloadLog, useGitLog } from "./logStore";
import { conflictedFiles, currentRepo, currentRepoRoot, refreshNow, repoOf, useVcs } from "./store";
import styles from "./common.module.css";
import { tx } from "@/platform/i18n";

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

/** Opens the conflicts dialog instead of an error balloon when the operation stopped on conflicts. */
export async function conflictsInstead(): Promise<boolean> {
  await refreshNow();
  if (!conflictedFiles().length) return false;
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

/**
 * Continue / Skip / Abort of the operation in progress. `expected` restricts the
 * action to one kind (e.g. Git › Continue Rebase).
 */
export async function controlOperation(control: "continue" | "skip" | "abort", expected: InProgress | null = null) {
  await refreshNow();
  const op = inProgress();
  if (!op || (expected && op !== expected)) return notInProgress(expected);
  // Only the selected repository's conflicts block it (others may be in their own merge).
  const repo = currentRepo();
  const conflicts = conflictedFiles().filter((f) => !repo || repoOf(f.path) === repo);
  if (control === "continue" && conflicts.length) {
    notifications().notify({ group: "vcs", level: "warning", title: "Resolve all conflicts before continuing" });
    void executeAction("vcs.resolveConflicts");
    return;
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
  await runGitOperation(
    { op: control },
    {
      progress,
      success,
      failure: `${controlLabel(op, control)} failed`,
      onError: control === "abort" ? undefined : conflictsInstead,
    },
  );
  // A rebase that continued and stopped again (next conflict) is reported by the conflicts listener.
  await refreshNow();
}

/** Banner above the Commit tool window's changes while an operation is stopped. */
export function OperationBanner() {
  const branch = useVcs((s) => s.branch);
  const conflicts = useVcs((s) => s.status.filter((f) => f.unstaged === "conflicted").length);
  const busy = useVcs((s) => s.remoteBusy);
  const op = inProgress(branch?.operation);
  if (!op) return null;
  return (
    <div className={styles.banner} role="status" aria-label={tx(IN_PROGRESS[op])}>
      <Icon name={conflicts ? "warning" : "branch"} size={14} />
      <span className={styles.bannerText}>
        {operationTitle(op, branch?.head ?? null)}
        {conflicts
          ? ` · ${conflicts === 1 ? tx`${conflicts} conflict` : tx`${conflicts} conflicts`}`
          : op === "merge"
            ? tx(" · commit to conclude")
            : ""}
      </span>
      {conflicts > 0 && (
        <button type="button" className={styles.linkButton} onClick={() => void executeAction("vcs.resolveConflicts")}>
          <T>Resolve…</T>
        </button>
      )}
      {operationControls(op).map((c) => (
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

export async function cherryPick(commits: Commit[]) {
  if (!commits.length) return;
  // Oldest first, as IDEA applies them.
  const ordered = newestFirst(commits).reverse();
  const label =
    ordered.length === 1 ? `${short(ordered[0]!.id)} “${ordered[0]!.summary}”` : `${ordered.length} commits`;
  await runGitOperation(
    { op: "cherryPick", commits: ordered.map((c) => c.id) },
    {
      progress: "Cherry-picking",
      success: `Cherry-picked ${label}`,
      failure: "Cherry-pick failed",
      onError: conflictsInstead,
    },
    commitRepo(commits[0]!) ?? currentRepo(),
  );
}

export async function revertCommits(commits: Commit[]) {
  if (!commits.length) return;
  const ordered = newestFirst(commits);
  const label =
    ordered.length === 1 ? `${short(ordered[0]!.id)} “${ordered[0]!.summary}”` : `${ordered.length} commits`;
  await runGitOperation(
    { op: "revert", commits: ordered.map((c) => c.id) },
    { progress: "Reverting", success: `Reverted ${label}`, failure: "Revert failed", onError: conflictsInstead },
    commitRepo(commits[0]!) ?? currentRepo(),
  );
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

/** Git Reset dialog: Reset Current Branch to Here… (log) and Git › Reset HEAD… (`commit` omitted). */
export function showResetDialog(commit?: Commit) {
  openDialog((close) => <ResetDialog commit={commit} onClose={close} />);
}

function ResetDialog({ commit, onClose }: { commit?: Commit; onClose: () => void }) {
  const [repo] = useState(() => (commit && commitRepo(commit)) || currentRepo());
  const head = useVcs((s) => s.branch?.head ?? "HEAD");
  const [mode, setMode] = useState<ResetMode>("mixed");
  const [target, setTarget] = useState(commit?.id ?? "HEAD");
  const run = async () => {
    const rev = target.trim();
    if (!rev) return;
    onClose();
    await runGitOperation(
      { op: "reset", commit: rev, mode },
      {
        progress: "Resetting",
        success: `Reset ${head} to ${commit ? short(commit.id) : rev} (${mode})`,
        failure: "Reset failed",
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
      <div className={styles.form} role="radiogroup" aria-label={tx("Reset type")}>
        {commit ? (
          <div className={styles.hint}>
            <T>
              {
                "This will reset the current branch head to the selected commit, and update the working tree and the index according to the selected mode:"
              }
            </T>
            <div className={styles.mono} style={{ marginTop: 4 }}>
              {short(commit.id)} {commit.summary}
            </div>
          </div>
        ) : (
          <>
            <label className={styles.fieldLabel} htmlFor="openidea-reset-to">
              <T>To commit:</T>
            </label>
            <Input
              id="openidea-reset-to"
              data-autofocus
              mono
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </>
        )}
        {RESET_MODES.map((m) => (
          <label key={m.mode} className={styles.radioRow}>
            <input type="radio" name="reset" checked={mode === m.mode} onChange={() => setMode(m.mode)} />
            <span className={styles.radioText}>
              {m.label}
              <span className={styles.hint}>{m.hint}</span>
            </span>
          </label>
        ))}
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
  const ok = await runOp(`Create tag ${r.value}`, create, {
    success: `Created tag ${r.value} on ${short(commit.id)}`,
  });
  // Tags are not part of the refs signature that reloads the log.
  if (ok !== undefined) void reloadLog();
}

/** Git › New Tag…: IDEA's Tag dialog (name, force, commit, message). */
export function showTagDialog() {
  openDialog((close) => <TagDialog onClose={close} />);
}

function TagDialog({ onClose }: { onClose: () => void }) {
  const [repo] = useState(currentRepo);
  const [name, setName] = useState("");
  const [commit, setCommit] = useState("HEAD");
  const [message, setMessage] = useState("");
  const [force, setForce] = useState(false);
  const [existing, setExisting] = useState<string[]>([]);
  useEffect(() => {
    void call(commands.vcsTags(repo)).then(setExisting, () => undefined);
  }, []);
  const error = validateTagName(name, force ? [] : existing);
  const run = async () => {
    if (error) return;
    onClose();
    const tag = name.trim();
    const ok = await runOp(
      `Create tag ${tag}`,
      () => call(commands.vcsCreateTag(repo, tag, commit.trim() || "HEAD", message || null, force)),
      { success: `Created tag ${tag}` },
    );
    if (ok !== undefined && useGitLog.getState().commits.length) void reloadLog();
  };
  return (
    <Dialog
      open
      title="Tag"
      onClose={onClose}
      width={460}
      buttons={[
        { label: "Create Tag", role: "default", disabled: !!error, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <label className={styles.fieldLabel} htmlFor="openidea-tag-name">
          <T>Tag name:</T>
        </label>
        <Input
          id="openidea-tag-name"
          data-autofocus
          mono
          value={name}
          invalid={!!name && !!error}
          onChange={(e) => setName(e.target.value)}
        />
        {name && error && <div className={styles.error}>{error}</div>}
        <Checkbox checked={force} onChange={setForce} label="Force" />
        <label className={styles.fieldLabel} htmlFor="openidea-tag-commit">
          <T>Commit:</T>
        </label>
        <Input id="openidea-tag-commit" mono value={commit} onChange={(e) => setCommit(e.target.value)} />
        <label className={styles.fieldLabel} htmlFor="openidea-tag-message">
          <T>Message:</T>
        </label>
        <textarea
          id="openidea-tag-message"
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
export function showCompareWithLocal(commit: Commit) {
  showDiffWithWorkingTree(commit.id, short(commit.id));
}

/** Files that differ between `rev` (a commit or branch) and the working tree. */
export function showDiffWithWorkingTree(rev: string, label = rev) {
  openDialog((close) => <ChangesBetweenDialog from={{ rev, label }} to={null} onClose={close} />);
}

/** IDEA's Compare Versions of two Git Log commits: files that differ between them, older first. */
export function showCompareVersions(older: Commit, newer: Commit) {
  openDialog((close) => (
    <ChangesBetweenDialog
      from={{ rev: older.id, label: short(older.id) }}
      to={{ rev: newer.id, label: short(newer.id) }}
      onClose={close}
    />
  ));
}

interface Revision {
  rev: string;
  label: string;
}

/** Files that differ between `from` and `to` (`null`: the working tree). */
function ChangesBetweenDialog({ from, to, onClose }: { from: Revision; to: Revision | null; onClose: () => void }) {
  const [root] = useState(currentRepoRoot);
  const [repo] = useState(currentRepo);
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const fromRev = from.rev;
  const toRev = to?.rev ?? null;
  useEffect(() => {
    let alive = true;
    call(toRev ? commands.vcsDiffRevisions(repo, fromRev, toRev) : commands.vcsDiffWithWorktree(repo, fromRev))
      .then((f) => alive && setFiles(f))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [fromRev, toRev]);
  const open = (f: ChangedFile) => {
    const repoRoot = root;
    const missing = (label: string): DiffSide => ({ type: "text", text: "", label });
    void openDiff({
      path: `${repoRoot}/${f.path}`,
      left:
        f.kind === "added" || f.kind === "untracked"
          ? missing("(does not exist)")
          : { type: "rev", rev: from.rev, label: from.label, path: f.oldPath ? `${repoRoot}/${f.oldPath}` : undefined },
      right: !to
        ? { type: "worktree" }
        : f.kind === "deleted"
          ? missing("(deleted)")
          : { type: "rev", rev: to.rev, label: to.label },
    });
  };
  const current = files?.[active];
  return (
    <Dialog
      open
      title={
        to
          ? tx`Changes between ${from.label} and ${to.label}`
          : tx`Changes between ${from.label} and Local Working Tree`
      }
      onClose={onClose}
      width={620}
      buttons={[
        { label: "Show Diff", role: "default", disabled: !current, onClick: () => current && open(current) },
        { label: "Close", role: "cancel" },
      ]}
    >
      <div className={styles.section}>{files ? `${files.length} file${files.length === 1 ? "" : "s"} differ` : ""}</div>
      <div style={{ height: 300, display: "flex", flexDirection: "column", padding: "0 14px 14px" }}>
        {error ? (
          <div className={styles.error}>{error}</div>
        ) : !files ? (
          <div className={styles.empty}>
            <Spinner size={14} />
          </div>
        ) : (
          <List
            items={files}
            getKey={(f) => f.path}
            activeIndex={Math.min(active, Math.max(0, files.length - 1))}
            onActiveChange={setActive}
            rowHeight={22}
            aria-label="Changed files"
            className={styles.boxList}
            empty={
              <span>
                <T>No differences</T>
              </span>
            }
            onActivate={(f, _i, e) => {
              if (e.type === "click" && (e as unknown as MouseEvent).detail < 2) return;
              open(f);
            }}
            renderItem={(f) => (
              <span className={styles.fileRow} style={{ flex: 1, padding: 0 }}>
                <Icon name={fileIconName(baseName(f.path))} size={14} />
                <span
                  className={styles.fileName}
                  style={{ color: KIND_COLOR[f.kind === "untracked" ? "added" : f.kind] }}
                >
                  {baseName(f.path)}
                </span>
                <span className={styles.fileDir}>{dirName(f.path)}</span>
              </span>
            )}
          />
        )}
      </div>
    </Dialog>
  );
}
