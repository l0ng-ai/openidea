/**
 * Merge window preview: what a merge of `source` into `target` would bring in
 * (the commits the target lacks) and which files both sides touched (#3572).
 */
import type { ChangedFile, Commit_Serialize } from "@/bindings";
import { call, commands } from "@/platform/ipc";

/** Cap on the commits listed and counted on each side of the merge. */
export const PREVIEW_LIMIT = 300;

export interface MergePreview {
  /** Merge base, `null` when the two sides share no history. */
  base: string | null;
  /** Commits the target does not have: they come in with the merge. */
  ahead: Commit_Serialize[];
  /** Commits the source does not have; `null` when more than {@link PREVIEW_LIMIT}. */
  behind: number;
  /** Files changed on both sides since the base: the merge will probably conflict there. */
  conflicts: string[];
}

const log = (repo: string | null, range: string) =>
  call(
    commands.vcsLog(repo, {
      branch: null,
      path: null,
      author: null,
      text: null,
      range,
      skip: 0,
      limit: PREVIEW_LIMIT,
    }),
  );

/** Reads the preview straight from git; safe to call on branches that are only remote. */
export async function loadMergePreview(
  repo: string | null,
  source: string,
  target: string,
): Promise<MergePreview> {
  const [ahead, behindCommits, base] = await Promise.all([
    log(repo, `${target}..${source}`),
    log(repo, `${source}..${target}`),
    call(commands.vcsMergeBase(repo, target, source)).catch(() => null),
  ]);
  return {
    base,
    ahead,
    behind: behindCommits.length,
    conflicts: base ? await overlappingFiles(repo, base, source, target) : [],
  };
}

/** Files both sides changed since `base`, i.e. the ones a merge is most likely to conflict on. */
async function overlappingFiles(
  repo: string | null,
  base: string,
  source: string,
  target: string,
): Promise<string[]> {
  const filesOf = (to: string) =>
    call(commands.vcsDiffRevisions(repo, base, to)).catch((): ChangedFile[] => []);
  const [mine, theirs] = await Promise.all([filesOf(source), filesOf(target)]);
  const ours = new Set(mine.map((f) => f.path));
  return theirs
    .map((f) => f.path)
    .filter((path) => ours.has(path))
    .sort();
}
