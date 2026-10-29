/** Repository identity for log rows and shared repository queries. */
import type { Branch, Commit } from "@/bindings";
import { call, commands } from "@/platform/ipc";

export type RepoCommit = Commit & { repo?: string | null; user?: string | null; remoteNames?: string[] };
export const commitRepo = (c: Commit | undefined): string | null | undefined => (c as RepoCommit | undefined)?.repo;
export const commitKey = (c: Pick<RepoCommit, "id" | "repo">): string => (c.repo ? `${c.repo}\0${c.id}` : c.id);
export const graphCommit = (c: Commit): Commit => ({
  ...c,
  id: commitKey(c),
  parents: c.parents.map((id) => commitKey({ ...c, id })),
});

/** Merge ordered streams without breaking any repository's topological order. */
export function mergeRepoLogs(streams: readonly RepoCommit[][], limit: number): RepoCommit[] {
  const offsets = streams.map(() => 0);
  const result: RepoCommit[] = [];
  while (result.length < limit) {
    let best = -1;
    for (let i = 0; i < streams.length; i++) {
      const c = streams[i]![offsets[i]!];
      if (
        c &&
        (best < 0 ||
          (c.commitTimeMs ?? c.timeMs ?? 0) >
            (streams[best]![offsets[best]!]!.commitTimeMs ?? streams[best]![offsets[best]!]!.timeMs ?? 0))
      )
        best = i;
    }
    if (best < 0) break;
    result.push(streams[best]![offsets[best]!]!);
    offsets[best]!++;
  }
  return result;
}

export async function branchesByRepo(roots: readonly string[]): Promise<Record<string, Branch[]>> {
  return Object.fromEntries(
    await Promise.all(
      roots.map(async (root) => [root, await call(commands.vcsBranches(root)).catch(() => [] as Branch[])] as const),
    ),
  );
}
