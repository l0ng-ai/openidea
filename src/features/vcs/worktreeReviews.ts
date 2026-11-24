import { useEffect, useState } from "react";
import { useWorktreeReviewProvider, type WorktreeReview, type WorktreeReviewQuery } from "@/workbench/contributions";
import type { RepoWorktrees } from "./worktrees";

export const OPEN_WORKTREE_REVIEW = "vcs.worktree.openReview";

export function useWorktreeReviews(project: string | undefined, groups: readonly RepoWorktrees[], refresh: number) {
  const lookup = useWorktreeReviewProvider((s) => s.lookup);
  // Equivalent worktree lists can arrive on each Git status refresh.
  const key = JSON.stringify(
    groups.map(({ root, worktrees }): WorktreeReviewQuery => ({
      root,
      paths: worktrees.map((tree) => tree.path).sort(),
      branches: [...new Set(worktrees.flatMap((tree) => (tree.branch ? [tree.branch] : [])))].sort(),
    })),
  );
  const [result, setResult] = useState<{
    project: typeof project;
    key: string;
    lookup: typeof lookup;
    refresh: number;
    reviews: Map<string, ReadonlyMap<string, WorktreeReview>>;
  }>();
  useEffect(() => {
    if (!project || !lookup) return;
    let live = true;
    const queries = JSON.parse(key) as WorktreeReviewQuery[];
    for (const query of queries) {
      if (!query.branches.length) continue;
      void lookup(query)
        .then((reviews) => {
          if (live && reviews.size)
            setResult((previous) => {
              const sameQuery =
                previous?.project === project &&
                previous.key === key &&
                previous.lookup === lookup &&
                previous.refresh === refresh;
              return {
                project,
                key,
                lookup,
                refresh,
                reviews: new Map(sameQuery ? previous.reviews : undefined).set(query.root, reviews),
              };
            });
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [project, key, lookup, refresh]);
  return result?.project === project && result?.key === key && result.lookup === lookup && result.refresh === refresh
    ? result.reviews
    : undefined;
}
