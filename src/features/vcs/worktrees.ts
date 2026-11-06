/**
 * Whether worktree `path` (as `git worktree list` prints it) is the repository root `root`
 * this window works in. Git prints `C:/…` with the drive in either case, so drive paths
 * compare case-insensitively; a trailing slash doesn't count.
 */
export function isCurrentWorktree(path: string, root: string | null | undefined): boolean {
  if (!root) return false;
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
    return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s;
  };
  return norm(path) === norm(root);
}
