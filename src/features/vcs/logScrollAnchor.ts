import type { RepoCommit } from "./multiRoot";

/**
 * Rows to move the Log's scroll position by after its commits were replaced, so the first
 * row at or below `top` that is still listed keeps its place; null when none is.
 * Rows match as `commitKey` does: same id, same repository (null and "" alike).
 * Usually the top row survived, so rows get plain searches first. Searching once per row
 * is quadratic, though, and a checkout to an older commit drops tens of thousands of
 * leading rows; after about eight full misses the rest are looked up in an index instead,
 * which costs a few plain searches to build.
 */
export function survivingRowShift(
  previous: readonly RepoCommit[],
  commits: readonly RepoCommit[],
  top: number,
): number | null {
  let budget = 8 * commits.length;
  let index: Map<string, Map<string, number>> | undefined;
  for (let i = top; i < previous.length; i++) {
    const { id } = previous[i]!;
    const repo = previous[i]!.repo || "";
    let next: number;
    if (index) next = index.get(repo)?.get(id) ?? -1;
    else {
      next = commits.findIndex((c) => c.id === id && (c.repo || "") === repo);
      budget -= next < 0 ? commits.length : next + 1;
      if (budget < 0) index = indexCommits(commits);
    }
    if (next >= 0) return next - i;
  }
  return null;
}

/** Repository → id → first index. */
function indexCommits(commits: readonly RepoCommit[]) {
  const index = new Map<string, Map<string, number>>();
  for (let i = commits.length - 1; i >= 0; i--) {
    const repo = commits[i]!.repo || "";
    let ids = index.get(repo);
    if (!ids) index.set(repo, (ids = new Map()));
    ids.set(commits[i]!.id, i);
  }
  return index;
}
