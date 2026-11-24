import type { ProjectInfo } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { runGitOperationWith } from "./ops";
import { conflictedFiles, refreshNow, repoOf, useVcs, type VcsState } from "./store";

export interface MergeConflictSession {
  roots: readonly string[];
  finish: () => Promise<void>;
}

const sessions = new Map<string, MergeConflictSession>();

export function mergeConflictSession(root: string | null): MergeConflictSession | undefined {
  return root ? sessions.get(root) : undefined;
}

/** A conflicted merge can be finished from Commit, Continue Merge or an external Git client. */
export async function trackMergeCompletion(
  roots: readonly string[],
  project: ProjectInfo,
  onComplete: () => void,
): Promise<MergeConflictSession | null> {
  const isCurrentProject = () => useProject.getState().project === project;
  if (!isCurrentProject() || !roots.length) return null;
  const state = useVcs.getState();
  const candidates = await Promise.all(
    roots.map(async (root) => {
      const before = state.heads[root];
      if (state.operations[root] !== "merge" || !before?.headCommit) return null;
      const target = await call(commands.vcsMergeBase(root, "MERGE_HEAD", "MERGE_HEAD")).catch(() => null);
      return target ? { root, branch: before.head, before: before.headCommit, target } : null;
    }),
  );
  const merges = candidates.filter((merge) => merge !== null);
  if (merges.length !== roots.length || !isCurrentProject()) return null;

  let active = true;
  const finished = new Map<string, string>();
  const session: MergeConflictSession = {
    roots,
    async finish() {
      await refreshNow();
      const hasConflicts = conflictedFiles().some((file) => {
        const repo = repoOf(file.path);
        return repo !== null && roots.includes(repo);
      });
      if (!active || hasConflicts) return;
      await runGitOperationWith(
        "merge --continue",
        { progress: "Continuing merge", success: null, failure: "Continue Merge failed" },
        async ({ request, output, cancelled }) => {
          for (const { root, branch, before, target } of merges) {
            if (!active || cancelled()) break;
            if (finished.has(root)) continue;
            await call(
              commands.vcsOperation(root, request, { op: "finishMerge", branch, head: before, target }, output()),
            );
            await refreshNow();
          }
          return null;
        },
      );
    },
  };
  const stop = () => {
    active = false;
    offVcs();
    offProject();
    for (const root of roots) if (sessions.get(root) === session) sessions.delete(root);
  };
  const verify = async () => {
    const matches = await Promise.all(
      merges.map(async ({ root, before, target }) => {
        const commit = finished.get(root);
        if (!commit) return false;
        const [entry] = await call(
          commands.vcsLog(root, { branch: commit, path: null, author: null, text: null, skip: 0, limit: 1 }),
        ).catch(() => []);
        return entry?.id === commit && entry.parents[0] === before && entry.parents.slice(1).includes(target);
      }),
    );
    if (isCurrentProject() && matches.every(Boolean)) onComplete();
  };
  const observe = (next: VcsState) => {
    for (const { root, branch, before } of merges) {
      const head = next.heads[root];
      const operation = next.operations[root];
      if (!head?.headCommit || head.head !== branch) {
        stop();
        return;
      }
      // Git can publish the commit before it removes MERGE_HEAD.
      if (operation === "merge" && !finished.has(root)) continue;
      if (operation || head.headCommit === before) {
        stop();
        return;
      }
      if (!finished.has(root)) finished.set(root, head.headCommit);
    }
    if (finished.size !== merges.length) return;
    stop();
    void verify();
  };
  const offVcs = useVcs.subscribe((next, previous) => {
    if (next.heads !== previous.heads || next.operations !== previous.operations) observe(next);
  });
  const offProject = useProject.subscribe(() => {
    if (!isCurrentProject()) stop();
  });
  for (const root of roots) sessions.set(root, session);
  observe(useVcs.getState());
  return active ? session : null;
}
