/**
 * Git Log changed-files pane: the selected commits' files as one model (a single
 * commit's files or the combined changes of several), and what its toolbar and
 * context menu do with them.
 */
import { create } from "zustand";
import type { ChangedFile, Commit, FileLineStats, RevisionChange } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { editorService } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import {
  commitFileDiffData,
  openDiff,
  openVcsDiff,
  revisionChangeDiffData,
  vcsDiffInFront,
  withChain,
  type DiffData,
} from "./diffInput";
import type { FileTreeNode } from "./fileTree";
import { baseName } from "./model";
import { readWorkingText, runOp, saveAll, writeFileText } from "./ops";
import { reportApply } from "./shelf";
import { currentRepoRoot } from "./store";
import { commitRepo } from "./multiRoot";
import { repositoryPath } from "./repositoryPaths";
import { confirmDialog } from "./dialogs";

/** Git's empty tree: a file added in a root commit is diffed against this. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
  /**
   * Revisions whose diff holds this file's line counts. For one commit that is its
   * first parent (or the empty tree) and the commit itself, added files included.
   */
  statsFrom: string;
  statsTo: string;
  added?: number;
  removed?: number;
  diff: DiffData;
  readOnly?: boolean;
  group?: string;
  mergeParents?: Array<{ rev: string; path: string }>;
}

/** One `git diff --numstat` covering every file that shares its endpoints. */
export interface LineStatRange {
  repo: string | null;
  from: string;
  to: string;
  paths: string[];
}

/** One commit's files (`commit` given) or several commits' combined changes. */
export function toLogChanges(
  files: readonly (ChangedFile | RevisionChange)[],
  commit: Commit | null,
  repo = currentRepoRoot(),
  readOnly = false,
): LogChange[] {
  return files.map((f) => {
    if (commit) {
      const parent = commit.parents[0] ?? null;
      return {
        repo,
        readOnly,
        path: f.path,
        oldPath: f.oldPath,
        kind: f.kind,
        before: f.kind === "added" ? null : parent,
        after: f.kind === "deleted" ? null : commit.id,
        statsFrom: parent ?? EMPTY_TREE,
        statsTo: commit.id,
        diff: commitFileDiffData({ ...commit, repo }, f),
      };
    }
    const r = f as RevisionChange;
    return {
      repo,
      readOnly,
      path: r.path,
      oldPath: r.oldPath,
      kind: r.kind,
      before: r.before,
      after: r.after,
      statsFrom: r.before ?? EMPTY_TREE,
      statsTo: r.after ?? EMPTY_TREE,
      diff: revisionChangeDiffData(r, repo),
    };
  });
}

/** Groups files that share a diff, so one numstat covers a commit's additions and edits. */
export function lineStatRanges(files: readonly LogChange[]): LineStatRange[] {
  const groups = new Map<string, LineStatRange>();
  for (const f of files) {
    if (!f.statsFrom || !f.statsTo || f.statsFrom === f.statsTo) continue;
    const repo = f.repo ?? null;
    const key = `${repo ?? ""}\0${f.statsFrom}\0${f.statsTo}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { repo, from: f.statsFrom, to: f.statsTo, paths: [] }));
    if (!group.paths.includes(f.path)) group.paths.push(f.path);
    if (f.oldPath && !group.paths.includes(f.oldPath)) group.paths.push(f.oldPath);
  }
  return [...groups.values()];
}

/** Writes numstat rows onto the files of the same revision pair, matching a rename by either name. */
export function assignLineStats(
  files: readonly LogChange[],
  loaded: readonly (LineStatRange & { stats: readonly FileLineStats[] })[],
): LogChange[] {
  const byPath = new Map<string, FileLineStats>();
  for (const range of loaded)
    for (const stat of range.stats) {
      const put = (path: string) => byPath.set(`${range.repo ?? ""}\0${range.from}\0${range.to}\0${path}`, stat);
      put(stat.path);
      if (stat.oldPath) put(stat.oldPath);
    }
  return files.map((f) => {
    const repo = f.repo ?? "";
    const stat =
      byPath.get(`${repo}\0${f.statsFrom}\0${f.statsTo}\0${f.path}`) ??
      (f.oldPath ? byPath.get(`${repo}\0${f.statsFrom}\0${f.statsTo}\0${f.oldPath}`) : undefined);
    return stat ? { ...f, added: stat.added, removed: stat.removed } : f;
  });
}

/** Fills `added` / `removed` from `git diff --numstat`. A failed diff leaves the files uncounted. */
export async function withLineStats(files: LogChange[]): Promise<LogChange[]> {
  const ranges = lineStatRanges(files);
  if (!ranges.length) return files;
  const loaded = await Promise.all(
    ranges.map(async (range) => ({
      ...range,
      stats: await call(commands.vcsDiffNumstat(range.repo, range.from, range.to, range.paths)),
    })),
  );
  return assignLineStats(files, loaded);
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
  return repositoryPath(root, rel);
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
  if (first.mergeParents?.length === 2 && first.after) {
    const input = {
      kind: "git-merge-diff",
      key: `git-merge-diff:${first.repo}:${first.after}:${first.path}`,
      data: {
        repo: first.repo ?? currentRepoRoot(),
        revision: first.after,
        path: first.path,
        parents: first.mergeParents,
      },
    };
    if (!preview && vcsDiffInFront()) (await import("./diffDialog")).openMergeDiffDialog(input);
    else await editorService().openInput(input, { preview, focus: !preview });
    return;
  }
  const all = useLogChanges.getState().all;
  const chain = all.includes(first) ? all : [...changes];
  const data = withChain(
    chain.map((c) => c.diff),
    Math.max(0, chain.indexOf(first)),
  );
  // Selection preview stays a preview tab even under the modal interface; an explicit
  // diff opens where the commit interface puts it.
  if (preview) await openDiff(data, { preview: true, focus: false });
  else await openVcsDiff(data);
}

/** Compare with Local (`side` after) / Compare Before with Local: the revision ↔ the working file. */
export async function compareChangeWithLocal(change: LogChange, side: "after" | "before" = "after") {
  if (change.readOnly) return;
  const rev = side === "after" ? change.after : change.before;
  if (!rev) return;
  const revPath = side === "before" && change.oldPath ? absolutePath(change.oldPath, change.repo) : undefined;
  await openVcsDiff({
    path: absolutePath(change.path, change.repo),
    left: { type: "rev", rev, path: revPath, label: rev.slice(0, 8) },
    right: { type: "worktree" },
  });
}

/** Jump to Source: the working file. */
export async function openChangeSource(change: LogChange) {
  if (change.readOnly) return;
  await editorService().openFile(absolutePath(change.path, change.repo), { focus: true });
}

/**
 * Get from Revision: the working files take their content after the change; a file the
 * change deleted is deleted.
 */
export async function getFromRevision(changes: readonly LogChange[]) {
  if (changes.some((c) => c.readOnly)) return;
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
    tx("Get from Revision"),
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
  if (changes.some((c) => c.readOnly)) return;
  if (!changes.length || !commits.length) return;
  const repo = changes[0]!.repo ?? currentRepoRoot();
  if (changes.some((c) => (c.repo ?? currentRepoRoot()) !== repo)) return;
  await saveAll();
  // Oldest first; the backend reverses the order for a reversed patch.
  const ids = [...commits]
    .reverse()
    .filter((c) => (commitRepo(c) ?? currentRepoRoot()) === repo)
    .map((c) => c.id);
  if (!ids.length) return;
  const paths = new Set(changes.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])));
  const outcome = await runOp(
    tx("Revert selected changes"),
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
