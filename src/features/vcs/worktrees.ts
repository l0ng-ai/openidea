import type { Worktree } from "@/bindings";
import { useEffect, useState } from "react";
import { call, commands } from "@/platform/ipc";
import { useVcs } from "./store";

export function worktreeLocation(repoRoot: string): string {
  const trimmed = repoRoot.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return repoRoot;
  return trimmed.slice(0, cut === 0 || /^[A-Za-z]:$/.test(trimmed.slice(0, cut)) ? cut + 1 : cut);
}

export function worktreePath(location: string, name: string): string {
  const sep = location.includes("\\") && !location.includes("/") ? "\\" : "/";
  return /[\\/]$/.test(location) ? location + name : location + sep + name;
}

/**
 * Comparison key of a path: `/` separators, no trailing slash, drive letter lowercased
 * (Git prints `C:/…` with the drive in either case).
 */
export function worktreePathKey(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
  return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s;
}

/**
 * Whether worktree `path` (as `git worktree list` prints it) is the repository root `root`
 * this window works in. A trailing slash doesn't count.
 */
export function isCurrentWorktree(path: string, root: string | null | undefined): boolean {
  return !!root && worktreePathKey(path) === worktreePathKey(root);
}

/** Whether deleting this worktree would also delete the window's project folder. */
export function worktreeContainsProject(path: string, projectRoot: string | null | undefined): boolean {
  if (!projectRoot) return false;
  const worktree = worktreePathKey(path);
  const project = worktreePathKey(projectRoot);
  return project === worktree || project.startsWith(worktree.endsWith("/") ? worktree : worktree + "/");
}

/**
 * Where Move Worktree… puts the worktree at `path` when `folder` is chosen: `folder` itself when
 * it is named like the worktree's folder, otherwise the worktree's folder inside `folder`.
 */
export function worktreeMoveTarget(path: string, folder: string): string {
  const name =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  const target = folder.replace(/[\\/]+$/, "") || folder;
  if (worktreePathKey(target).split("/").pop() === worktreePathKey(path).split("/").pop()) return target;
  return worktreePath(target, name);
}

/** The worktrees of one repository, loaded from one of its roots. */
export interface RepoWorktrees {
  /** A VCS root of the repository the query ran from. */
  root: string;
  worktrees: Worktree[];
  /** Why the query failed; the repository is still listed. */
  error?: string;
}

export function useBranchWorktrees(enabled = true) {
  const roots = useVcs((s) => s.roots);
  const branches = useVcs((s) => s.branches);
  const [loaded, setLoaded] = useState<{ roots: typeof roots; lists: Map<string, Worktree[]> }>();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void Promise.all(
      roots.map(async (root) => [root, await call(commands.vcsWorktrees(root)).catch(() => [])] as const),
    ).then((lists) => {
      if (live) setLoaded({ roots, lists: new Map(lists) });
    });
    return () => {
      live = false;
    };
  }, [roots, branches, enabled]);
  return (repo: string | null, branch: string) =>
    enabled && repo && loaded?.roots === roots
      ? loaded.lists
          .get(repo)
          ?.find((tree) => tree.branch === branch && !tree.prunable && !isCurrentWorktree(tree.path, repo))?.path
      : undefined;
}

/**
 * One group per repository. A project holds a linked worktree as a root of its own, and
 * every root of a repository lists all of its worktrees: their duplicate lists are
 * merged, the first root (in root order) staying the group's.
 */
export function groupWorktrees(lists: readonly RepoWorktrees[]): RepoWorktrees[] {
  // Loaded lists first: a failed query knows only its own root, which a loaded list
  // can claim as one of the repository's worktrees.
  const ordered = [...lists].sort((a, b) => Number(b.worktrees.length > 0) - Number(a.worktrees.length > 0));
  const groups: RepoWorktrees[] = [];
  const byMain = new Map<string, RepoWorktrees>();
  const byWorktree = new Map<string, RepoWorktrees>();
  for (const list of ordered) {
    const main = list.worktrees.find((w) => w.main);
    const group = (main && byMain.get(worktreePathKey(main.path))) || byWorktree.get(worktreePathKey(list.root));
    if (group) {
      // Name the group after the repository's main folder when its root is one of them.
      if (main && worktreePathKey(main.path) === worktreePathKey(list.root)) group.root = list.root;
      if (!group.worktrees.length && list.worktrees.length) {
        group.worktrees = list.worktrees;
        group.error = list.error;
        if (main) byMain.set(worktreePathKey(main.path), group);
      }
      for (const w of list.worktrees) byWorktree.set(worktreePathKey(w.path), group);
      continue;
    }
    const created = { ...list };
    groups.push(created);
    if (main) byMain.set(worktreePathKey(main.path), created);
    for (const w of created.worktrees) byWorktree.set(worktreePathKey(w.path), created);
  }
  return groups;
}
