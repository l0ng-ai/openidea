import { commitKey, commitRepo } from "./multiRoot";
/**
 * Operations on history: Continue / Abort / Skip of a stopped merge, rebase,
 * cherry-pick or revert, and the Git Log commit actions (Cherry-Pick, Revert
 * Commit, Reset Current Branch to Here, New Tag, Compare with Local).
 */
import { useEffect, useMemo, useState } from "react";
import type { ChangedFile, Commit, CompareResult, ResetMode, WorkingTreeChange } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands, nextRequestId } from "@/platform/ipc";
import { Checkbox, Dialog, Icon, Input, Spinner, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { diffInput, openDiff, type DiffData, type DiffSide } from "./diffInput";
import { openDialog, promptText } from "./dialogs";
import { KIND_COLOR, fileCount } from "./model";
import { runGitOperation, runOp } from "./ops";
import { reloadLog, useGitLog } from "./logStore";
import { conflictedFiles, currentRepo, currentRepoRoot, refreshNow, repoName, repoOf, useVcs } from "./store";
import styles from "./common.module.css";
import { ComparisonTree } from "./ComparisonTree";
import { buildFileTree, type FileTreeNode } from "./fileTree";
import { tx } from "@/platform/i18n";
import { displayPath } from "./compareData";

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

/** Files that differ between two revisions (e.g. two branches from Compare with Current). */
export function showCompareRevisions(from: string, to: string, fromLabel = from, toLabel = to) {
  openDialog((close) => (
    <ChangesBetweenDialog from={{ rev: from, label: fromLabel }} to={{ rev: to, label: toLabel }} onClose={close} />
  ));
}

export function showPathComparison(paths: string[], rev: string, repositories: string[] | null) {
  openDialog((close) => (
    <ChangesBetweenDialog from={{ rev, label: rev }} to={null} scope={{ paths, repositories }} onClose={close} />
  ));
}

interface Revision {
  rev: string;
  label: string;
}

interface ScopedComparison {
  paths: string[];
  repositories: string[] | null;
}

interface ComparisonFile extends ChangedFile {
  root: string;
  revision: string;
  added?: number;
  removed?: number;
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
  onClose,
}: {
  from: Revision;
  to: Revision | null;
  scope?: ScopedComparison;
  onClose: () => void;
}) {
  const [root] = useState(currentRepoRoot);
  const [repo] = useState(currentRepo);
  const [files, setFiles] = useState<ComparisonFile[] | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<ComparisonFile | null>(null);
  const fromRev = from.rev;
  const toRev = to?.rev ?? null;
  useEffect(() => {
    let alive = true;
    let pending = true;
    const request = nextRequestId();
    const load = async () => {
      if (scope) {
        const r = await call(commands.vcsComparePaths(scope.paths, fromRev, scope.repositories, request));
        if (!alive) return;
        setResult(r);
        setFiles(
          r.repositories.flatMap((r) =>
            r.files.map((f: WorkingTreeChange) => ({ ...f, root: r.root, revision: r.revision! })),
          ),
        );
      } else {
        const f = await call(
          toRev ? commands.vcsDiffRevisions(repo, fromRev, toRev) : commands.vcsDiffWithWorktree(repo, fromRev),
        );
        if (alive) setFiles(f.map((f) => ({ ...f, root: root ?? "", revision: fromRev })));
      }
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
  }, [fromRev, toRev, repo, root, scope]);
  const tree = useMemo(() => {
    if (!scope) return buildFileTree(files ?? [], (f) => f.path);
    return (result?.repositories ?? []).map((r): FileTreeNode<ComparisonFile> => {
      const list = (files ?? []).filter((f) => f.root === r.root);
      const prefix = (nodes: FileTreeNode<ComparisonFile>[]): FileTreeNode<ComparisonFile>[] =>
        nodes.map((n) => ({ ...n, key: `${r.root}:${n.key}`, children: prefix(n.children) }));
      return {
        key: r.root,
        name: repoName(r.root),
        file: null,
        count: list.length,
        children: prefix(buildFileTree(list, (f) => f.path)),
      };
    });
  }, [files, result, scope]);
  const diffFor = (f: ComparisonFile): DiffData => {
    const missing = (label: string): DiffSide => ({ type: "text", text: "", label });
    return {
      path: `${f.root}/${f.path}`,
      left:
        f.kind === "added" || f.kind === "untracked"
          ? missing("(does not exist)")
          : {
              type: "rev",
              rev: f.revision,
              label: from.label,
              path: f.oldPath ? `${f.root}/${f.oldPath}` : undefined,
            },
      right:
        f.kind === "deleted"
          ? missing("(deleted)")
          : !to
            ? { type: "worktree" }
            : { type: "rev", rev: to.rev, label: to.label },
    };
  };
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
  return (
    <Dialog
      open
      title={files ? `${title} — ${count}` : title}
      onClose={onClose}
      width={input ? 1100 : 680}
      buttons={[
        {
          label: "Show Diff",
          role: "default",
          disabled: !current,
          onClick: () => {
            if (current) {
              void openDiff(diffFor(current));
              onClose();
            }
          },
        },
        { label: "Close", role: "cancel" },
      ]}
    >
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
          getColor={(f) => KIND_COLOR[f.kind === "untracked" ? "added" : f.kind]}
          ariaLabel="Changed files"
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
    </Dialog>
  );
}
