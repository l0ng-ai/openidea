/**
 * Git Log changed-files pane: the selected commits' files as one model (a single
 * commit's files or the combined changes of several), and what its toolbar and
 * context menu do with them.
 */
import { create } from "zustand";
import type { ChangedFile, Commit, RevisionChange } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { editorService } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { commitFileDiffData, openDiff, revisionChangeDiffData, withChain, type DiffData } from "./diffInput";
import type { FileTreeNode } from "./fileTree";
import { baseName } from "./model";
import { readWorkingText, runOp, saveAll, writeFileText } from "./ops";
import { reportApply } from "./shelf";
import { currentRepoRoot } from "./store";
import { confirmDialog } from "./dialogs";

/** A file of the pane, with the revisions holding its content before and after the change. */
export interface LogChange {
  /** Repository-relative path (after the change). */
  path: string;
  repo?: string | null;
  oldPath: string | null;
  kind: ChangedFile["kind"];
  /** `null`: the file did not exist before. */
  before: string | null;
  /** `null`: the change deleted the file. */
  after: string | null;
  diff: DiffData;
}

/** One commit's files (`commit` given) or several commits' combined changes. */
export function toLogChanges(
  files: readonly (ChangedFile | RevisionChange)[],
  commit: Commit | null,
  repo = currentRepoRoot(),
): LogChange[] {
  return files.map((f) => {
    if (commit) {
      const parent = commit.parents[0] ?? null;
      return {
        repo,
        path: f.path,
        oldPath: f.oldPath,
        kind: f.kind,
        before: f.kind === "added" ? null : parent,
        after: f.kind === "deleted" ? null : commit.id,
        diff: commitFileDiffData({ ...commit, repo }, f),
      };
    }
    const r = f as RevisionChange;
    return {
      repo,
      path: r.path,
      oldPath: r.oldPath,
      kind: r.kind,
      before: r.before,
      after: r.after,
      diff: revisionChangeDiffData(r, repo),
    };
  });
}

/** Files without directory grouping: by name, each node's path shown next to it. */
export function flatFileNodes<F>(files: readonly F[], relPath: (f: F) => string): FileTreeNode<F>[] {
  return files
    .map((file) => {
      const rel = relPath(file);
      return { key: `f:${rel}`, name: baseName(rel), file, children: [], count: 1, rel };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.rel.localeCompare(b.rel))
    .map(({ rel: _rel, ...n }) => n);
}

/**
 * Files of `nodes` in display order; with `keys`, only the selected files and the files
 * under selected directories (each once).
 */
export function filesUnder<F>(nodes: readonly FileTreeNode<F>[], keys?: ReadonlySet<string>): F[] {
  const out: F[] = [];
  const walk = (list: readonly FileTreeNode<F>[], inSelected: boolean) => {
    for (const n of list) {
      const hit = inSelected || !keys || keys.has(n.key);
      if (n.file) {
        if (hit) out.push(n.file);
      } else walk(n.children, hit);
    }
  };
  walk(nodes, false);
  return out;
}

/**
 * The sections of a `git diff` patch that touch `paths` (repository-relative; a rename
 * matches by either name, in either direction for a reversed patch).
 */
export function filterPatch(patch: string, paths: ReadonlySet<string>): string {
  const sections = patch.split(/^(?=diff --git )/m);
  const header = /^diff --git ("?)a\/(.+?)\1 ("?)b\/(.+?)\3$/;
  return sections
    .filter((s) => {
      const first = s.slice(0, s.indexOf("\n") >>> 0);
      const m = header.exec(first);
      return !!m && (paths.has(m[2]!) || paths.has(m[4]!));
    })
    .join("");
}

/** Absolute path of a repository-relative one. */
export function absolutePath(rel: string, root = currentRepoRoot()): string {
  return root ? `${root}/${rel}` : rel;
}

/** Pane state the changed-files actions work on when they get no argument. */
export interface LogChangesState {
  /** The selected commits, newest first. */
  commits: Commit[];
  /** Every file of the pane, in display order. */
  all: LogChange[];
  /** The selected files. */
  selected: LogChange[];
}

export const useLogChanges = create<LogChangesState>(() => ({ commits: [], all: [], selected: [] }));

/** The files an action refers to: its argument, else the pane's selection. */
export function changesArg(arg: unknown): LogChange[] {
  if (Array.isArray(arg)) return arg as LogChange[];
  return useLogChanges.getState().selected;
}

/**
 * Show Diff: the first file, with every file of the pane in the chain (F7 moves along).
 * `preview`: in the editor's preview tab without taking focus (selection in the pane).
 */
export async function showChangesDiff(changes: readonly LogChange[], preview = false) {
  const first = changes[0];
  if (!first) return;
  const all = useLogChanges.getState().all;
  const chain = all.includes(first) ? all : [...changes];
  await openDiff(
    withChain(
      chain.map((c) => c.diff),
      Math.max(0, chain.indexOf(first)),
    ),
    preview ? { preview: true, focus: false } : {},
  );
}

/** Compare with Local (`side` after) / Compare Before with Local: the revision ↔ the working file. */
export async function compareChangeWithLocal(change: LogChange, side: "after" | "before" = "after") {
  const rev = side === "after" ? change.after : change.before;
  if (!rev) return;
  const revPath = side === "before" && change.oldPath ? absolutePath(change.oldPath, change.repo) : undefined;
  await openDiff({
    path: absolutePath(change.path, change.repo),
    left: { type: "rev", rev, path: revPath, label: rev.slice(0, 8) },
    right: { type: "worktree" },
  });
}

/** Jump to Source: the working file. */
export async function openChangeSource(change: LogChange) {
  await editorService().openFile(absolutePath(change.path, change.repo), { focus: true });
}

/**
 * Get from Revision: the working files take their content after the change; a file the
 * change deleted is deleted.
 */
export async function getFromRevision(changes: readonly LogChange[]) {
  if (!changes.length) return;
  const ok = await confirmDialog({
    title: "Get from Revision",
    message:
      changes.length === 1
        ? tx`Replace '${baseName(changes[0]!.path)}' with its content from the revision? Local changes to it are lost.`
        : tx`Replace ${changes.length} files with their content from the revision? Local changes to them are lost.`,
    okLabel: "Get",
    danger: true,
  });
  if (!ok) return;
  await saveAll();
  await runOp(
    "Get from Revision",
    async () => {
      for (const c of changes) {
        const path = absolutePath(c.path, c.repo);
        if (!c.after) {
          if ((await readWorkingText(path)) !== null) await call(commands.fsDelete(path));
          continue;
        }
        const text = await call(commands.vcsFileAt(path, c.after));
        if (text === null) continue;
        if ((await readWorkingText(path)) === null) await call(commands.fsCreateFile(path));
        await writeFileText(path, text, { save: true });
      }
      return changes.length;
    },
    { success: (n) => (n === 1 ? tx("Got 1 file from revision") : tx`Got ${n} files from revision`) },
  );
}

/** Revert Selected Changes: applies the reverse of the selected files' changes to the working tree. */
export async function revertSelectedChanges(changes: readonly LogChange[], commits: readonly Commit[]) {
  if (!changes.length || !commits.length) return;
  await saveAll();
  // Oldest first; the backend reverses the order for a reversed patch.
  const ids = [...commits].reverse().map((c) => c.id);
  const paths = new Set(changes.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])));
  const outcome = await runOp(
    "Revert selected changes",
    async () => {
      const patch = filterPatch(
        await call(
          commands.vcsCreatePatch(changes[0]!.repo ?? currentRepoRoot(), {
            from: "commits",
            commits: ids,
            reverse: true,
          }),
        ),
        paths,
      );
      if (!patch.trim()) throw new Error(tx("Nothing to revert"));
      return call(commands.vcsApplyPatch(changes[0]!.repo ?? currentRepoRoot(), patch));
    },
    { refresh: false },
  );
  if (outcome) await reportApply(outcome, "Changes reverted");
}
