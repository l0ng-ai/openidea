import type { Worktree } from "@/bindings";

/**
 * Comparison key of a path: `/` separators, no trailing slash, drive letter lowercased
 * (Git prints `C:/…` with the drive in either case).
 */
function pathKey(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
  return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s;
}

/**
 * Whether worktree `path` (as `git worktree list` prints it) is the repository root `root`
 * this window works in. A trailing slash doesn't count.
 */
export function isCurrentWorktree(path: string, root: string | null | undefined): boolean {
  return !!root && pathKey(path) === pathKey(root);
}

/** Whether deleting this worktree would also delete the window's project folder. */
export function worktreeContainsProject(path: string, projectRoot: string | null | undefined): boolean {
  if (!projectRoot) return false;
  const worktree = pathKey(path);
  const project = pathKey(projectRoot);
  return project === worktree || project.startsWith(worktree.endsWith("/") ? worktree : worktree + "/");
}

/**
 * Where Move Worktree… puts the worktree at `path` when `folder` is chosen: `folder` itself when
 * it is named like the worktree's folder, otherwise the worktree's folder inside `folder`.
 */
export function worktreeMoveTarget(path: string, folder: string): string {
  const name = pathKey(path).split("/").pop() ?? "";
  const target = folder.replace(/[\\/]+$/, "") || folder;
  if (pathKey(target).split("/").pop() === name) return target;
  const sep = target.includes("\\") && !target.includes("/") ? "\\" : "/";
  return target.endsWith(sep) ? target + name : `${target}${sep}${name}`;
}

/** The worktrees of one repository, loaded from one of its roots. */
export interface RepoWorktrees {
  /** A VCS root of the repository the query ran from. */
  root: string;
  worktrees: Worktree[];
  /** Why the query failed; the repository is still listed. */
  error?: string;
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
    const group = (main && byMain.get(pathKey(main.path))) || byWorktree.get(pathKey(list.root));
    if (group) {
      // Name the group after the repository's main folder when its root is one of them.
      if (main && pathKey(main.path) === pathKey(list.root)) group.root = list.root;
      if (!group.worktrees.length && list.worktrees.length) {
        group.worktrees = list.worktrees;
        group.error = list.error;
        if (main) byMain.set(pathKey(main.path), group);
      }
      for (const w of list.worktrees) byWorktree.set(pathKey(w.path), group);
      continue;
    }
    const created = { ...list };
    groups.push(created);
    if (main) byMain.set(pathKey(main.path), created);
    for (const w of created.worktrees) byWorktree.set(pathKey(w.path), created);
  }
  return groups;
}
