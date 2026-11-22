import { call, commands } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { useProject } from "@/platform/project";
import {
  registerWorktreeReviewProvider,
  type WorktreeReview,
  type WorktreeReviewQuery,
} from "@/workbench/contributions";
import { rest } from "./api/client";
import { sameRepository, type GHConnection, useGhRepository } from "./data/repository";
import { openPullRequestQuery, trackedBranch } from "./reviewMode/model";
import { openPullRequest } from "./toolwindow/open";

interface PullRequestMatch {
  number: number;
  title: string;
  state: string;
  head: { repo: { full_name: string } | null };
}

function normalizedPath(path: string) {
  const normalized = ipcPath(path).replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

async function findReviews(
  { root, paths, branches }: WorktreeReviewQuery,
  connection: GHConnection,
): Promise<ReadonlyMap<string, WorktreeReview>> {
  const reviews = new Map<string, WorktreeReview>();
  const project = useProject.getState().project?.root;
  const repo = connection.root ?? project;
  if (!repo || ![root, ...paths].some((path) => normalizedPath(path) === normalizedPath(repo))) return reviews;
  const isCurrent = () =>
    useGhRepository.getState().connection === connection && useProject.getState().project?.root === project;
  const base = connection.coordinates;
  const remotes = await call(commands.vcsRemotes(repo));
  if (!isCurrent()) return reviews;
  await Promise.allSettled(
    branches.map(async (branch) => {
      const [remote, merge] = await Promise.all([
        call(commands.vcsConfigGet(repo, `branch.${branch}.remote`)),
        call(commands.vcsConfigGet(repo, `branch.${branch}.merge`)),
      ]);
      const tracked = trackedBranch(remote, merge, remotes, base);
      if (!tracked || !isCurrent()) return;
      let match: PullRequestMatch | undefined;
      if (tracked.pullRequest !== null && sameRepository(tracked.repository, base)) {
        match =
          (await rest<PullRequestMatch | null>(
            "GET",
            `repos/${base.owner}/${base.name}/pulls/${tracked.pullRequest}`,
          )) ?? undefined;
      } else {
        const query = openPullRequestQuery(base, tracked);
        if (!query) return;
        const head = `${tracked.repository.owner}/${tracked.repository.name}`.toLowerCase();
        match = (await rest<PullRequestMatch[] | null>("GET", query))?.find(
          (pr) => pr.head.repo?.full_name.toLowerCase() === head,
        );
      }
      if (match?.state !== "open" || !isCurrent()) return;
      const { title, number } = match;
      reviews.set(branch, {
        title,
        open: async () => {
          if (isCurrent()) await openPullRequest(number);
        },
      });
    }),
  );
  return reviews;
}

export function activateWorktreeReviews() {
  let dispose: (() => void) | undefined;
  const sync = (connection: GHConnection | null) => {
    dispose?.();
    dispose = connection ? registerWorktreeReviewProvider((query) => findReviews(query, connection)) : undefined;
  };
  const stop = useGhRepository.subscribe((state, previous) => {
    if (state.connection !== previous.connection) sync(state.connection);
  });
  sync(useGhRepository.getState().connection);
  return () => {
    stop();
    dispose?.();
  };
}
