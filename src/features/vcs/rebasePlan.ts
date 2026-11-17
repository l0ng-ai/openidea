/** Interactive rebase / Undo Commit model: ranges, plans and validation (pure). */
import type { BranchInfo, Commit, RebaseAction, RebaseEntry } from "@/bindings";

export interface RebaseRow {
  commit: Commit;
  action: RebaseAction;
  /** New message (reword only). */
  message: string;
}

export interface RebaseRange {
  /** Parent of the oldest commit; `null` rebases from the root. */
  base: string | null;
  /** Oldest first. */
  commits: Commit[];
}

/**
 * The commits an interactive rebase from `target` rewrites: `target..HEAD` plus
 * `target`, given `history` = HEAD's history, newest first (topological).
 */
export function rebaseRange(target: Commit, history: readonly Commit[]): RebaseRange | { error: string } {
  const index = history.findIndex((c) => c.id === target.id);
  if (index < 0) return { error: "The commit is not in the current branch" };
  const commits = history.slice(0, index + 1);
  if (commits.some((c) => c.parents.length > 1))
    return { error: "Interactive rebase is not supported for a range that contains merge commits" };
  return { base: target.parents[0] ?? null, commits: [...commits].reverse() };
}

/** Why `commit` cannot be undone, or null. */
export function undoCommitProblem(commit: Commit, branch: BranchInfo | null): string | null {
  if (branch?.operation) return `Cannot undo a commit while a ${branch.operation} is in progress`;
  if (!branch?.headCommit || commit.id !== branch.headCommit)
    return "Undo Commit is available only for the latest commit of the current branch";
  if (commit.parents.length > 1) return "A merge commit cannot be undone; use Reset Current Branch to Here instead";
  if (commit.parents.length === 0 && !branch.head) return "The initial commit cannot be undone on a detached HEAD";
  return null;
}

/** HEAD is already on its upstream (undoing / rewriting it needs a force push). */
export function headPushed(branch: BranchInfo | null): boolean {
  return !!branch?.upstream && branch.ahead === 0;
}

/** Pushed history of a protected branch cannot be rewritten (force push is not allowed there). */
export function protectedBranchProblem(
  branch: { head: string | null; upstream: string | null },
  protectedBranch: (name: string) => boolean,
): string | null {
  const name = branch.head;
  // With no upstream there is no force push to prohibit, so the branch is not protected.
  if (!name || !branch.upstream || !protectedBranch(name)) return null;
  return `Pushed commits of the protected branch '${name}' cannot be rewritten`;
}

export function initialRows(commits: readonly Commit[]): RebaseRow[] {
  return autosquash(commits.map((commit) => ({ commit, action: "pick", message: commit.message })));
}

/**
 * git's `--autosquash`: a `fixup! <subject>` / `squash! <subject>` commit moves right
 * after the commit it targets (by subject or hash prefix) with that action.
 */
export function autosquash(rows: readonly RebaseRow[]): RebaseRow[] {
  const targetOf = (r: RebaseRow) => {
    const m = /^(fixup|squash)! (.+)$/.exec(r.commit.summary);
    if (!m) return null;
    const subject = m[2]!.trim();
    const target = rows
      .slice(0, rows.indexOf(r))
      .find((t) => t.commit.summary === subject || (subject.length >= 4 && t.commit.id.startsWith(subject)));
    return target ? { target, action: m[1] as RebaseAction } : null;
  };
  const moved = new Map<string, RebaseRow[]>();
  for (const r of rows) {
    const t = targetOf(r);
    if (!t) continue;
    // Chains (fixup! fixup! x) resolve to the root target.
    let root = t.target;
    for (let next = targetOf(root); next; next = targetOf(root)) root = next.target;
    moved.set(root.commit.id, [...(moved.get(root.commit.id) ?? []), { ...r, action: t.action }]);
  }
  const placed = new Set([...moved.values()].flat().map((r) => r.commit.id));
  return rows.filter((r) => !placed.has(r.commit.id)).flatMap((r) => [r, ...(moved.get(r.commit.id) ?? [])]);
}

/**
 * Squash Commits: the selected commits (`ids`) become one commit with `message`, at
 * the position of the oldest of them; the others keep their order.
 */
export function squashPlan(range: RebaseRange, ids: ReadonlySet<string>, message: string): RebaseEntry[] {
  const first = range.commits.findIndex((c) => ids.has(c.id));
  const selected = range.commits.filter((c) => ids.has(c.id));
  const entry = (c: Commit, action: RebaseAction, msg: string | null = null): RebaseEntry => ({
    commit: c.id,
    action,
    message: msg,
  });
  return [
    ...range.commits.slice(0, first).map((c) => entry(c, "pick")),
    ...selected.map((c, i) =>
      entry(c, i === 0 ? "pick" : "squash", i === selected.length - 1 && i > 0 ? message.trim() : null),
    ),
    ...range.commits
      .slice(first + 1)
      .filter((c) => !ids.has(c.id))
      .map((c) => entry(c, "pick")),
  ];
}

export function moveRow(rows: readonly RebaseRow[], index: number, delta: -1 | 1): RebaseRow[] {
  const to = index + delta;
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return [...rows];
  const out = [...rows];
  [out[index], out[to]] = [out[to]!, out[index]!];
  return out;
}

export function planProblem(rows: readonly RebaseRow[]): string | null {
  const kept = rows.filter((r) => r.action !== "drop");
  if (!kept.length) return "At least one commit must be kept";
  const first = kept[0]!;
  if (first.action === "squash" || first.action === "fixup")
    return `The first commit cannot be ${first.action === "squash" ? "squashed" : "fixed up"} into a previous one`;
  if (rows.some((r) => r.action === "reword" && !r.message.trim())) return "A reworded commit needs a message";
  return null;
}

/** Nothing would change (same order, every commit picked). */
export function planIsNoop(rows: readonly RebaseRow[], original: readonly Commit[]): boolean {
  return (
    rows.length === original.length &&
    rows.every(
      (r, i) =>
        r.commit.id === original[i]!.id &&
        (r.action === "pick" || (r.action === "reword" && r.message.trim() === r.commit.message.trim())),
    )
  );
}

export function toEntries(rows: readonly RebaseRow[]): RebaseEntry[] {
  return rows.map((r) => ({
    commit: r.commit.id,
    action: r.action,
    message: r.action === "reword" ? r.message.trim() : null,
  }));
}

/** Plan for a single-commit action from the log (Edit Commit Message, Drop Commit). */
export function singleCommitPlan(
  range: RebaseRange,
  target: string,
  action: RebaseAction,
  message?: string,
): RebaseEntry[] {
  return range.commits.map((c) =>
    c.id === target
      ? { commit: c.id, action, message: action === "reword" ? (message ?? c.message).trim() : null }
      : { commit: c.id, action: "pick", message: null },
  );
}
