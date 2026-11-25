import type { FileStatus } from "@/bindings";
import { renamedFromPath } from "./changes";
import { GITLINK_MODE, loadDiffEntries } from "./gitDiffEntries";
import { stripSlash } from "./model";

interface SubmoduleRollback {
  indexPaths: string[];
  worktree: { path: string; missing: boolean }[];
}

export function isNestedRepoEntry(path: string, roots: readonly string[]): boolean {
  const p = stripSlash(path);
  return roots.includes(p) && roots.some((r) => p.startsWith(r + "/"));
}

export async function inspectSubmoduleRollback(
  files: readonly FileStatus[],
  roots: readonly string[],
  scope: "all" | "unstaged",
): Promise<Map<string, SubmoduleRollback>> {
  const candidates = files.filter(
    (file) => isNestedRepoEntry(file.path, roots) || file.staged !== null || file.unstaged === "deleted",
  );
  const plans = new Map<string, SubmoduleRollback>();
  if (!candidates.length) return plans;
  const pathsOf = (file: FileStatus) => {
    const path = stripSlash(file.path);
    const old = scope === "all" && file.staged === "renamed" ? renamedFromPath(file) : null;
    return old ? [path, old] : [path];
  };
  const paths = [...new Set(candidates.flatMap(pathsOf))];
  const entries = await loadDiffEntries(paths.flatMap((path) => ["HEAD", ":0", "WT"].map((rev) => ({ path, rev }))));
  const byPath = new Map(paths.map((path, i) => [path, entries?.slice(i * 3, i * 3 + 3)]));
  for (const file of candidates) {
    const plan: SubmoduleRollback = { indexPaths: [], worktree: [] };
    let gitlink = false;
    for (const path of pathsOf(file)) {
      const [head, index, working] = byPath.get(path) ?? [];
      if (head?.mode !== GITLINK_MODE && index?.mode !== GITLINK_MODE) continue;
      gitlink = true;
      const target = scope === "all" ? head?.gitlink : index?.gitlink;
      if (scope === "all" && (head?.gitlink ?? null) !== (index?.gitlink ?? null)) plan.indexPaths.push(path);
      if (target && working?.mode === GITLINK_MODE) {
        if (working.gitlink && target !== working.gitlink) {
          plan.worktree.push({ path, missing: false });
        } else if (!working.gitlink && (file.unstaged === "deleted" || (scope === "all" && !index))) {
          plan.worktree.push({ path, missing: true });
        }
      }
    }
    // Keep a nested root out of ordinary file rollback when its entry could not be read.
    if (gitlink || isNestedRepoEntry(file.path, roots)) plans.set(file.path, plan);
  }
  return plans;
}
