/** Interactive rebase / Undo Commit model: ranges, plans and validation (pure). */
import type {
  BranchInfo,
  Commit,
  RebaseAction,
  RebaseEditorReply,
  RebaseEntry,
  RebaseFixupMessage,
  RebaseTodoRow,
} from "@/bindings";

export interface RebaseRow {
  commit: Pick<Commit, "id" | "shortId" | "author" | "summary" | "message">;
  action: RebaseAction;
  fixupMessage?: RebaseFixupMessage;
  /** New message (reword only). */
  message: string;
}

interface UpdateRefRow {
  action: "updateRef";
  reference: string;
}

export type RebasePlanRow = RebaseRow | UpdateRefRow;

function refRowKey(reference: string): string {
  return `update-ref:${reference}`;
}

export function rebaseRowKey(row: RebasePlanRow): string {
  return row.action === "updateRef" ? refRowKey(row.reference) : row.commit.id;
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
export function undoCommitProblem(
  commit: Commit,
  branch: (Pick<BranchInfo, "head" | "headCommit"> & { operation?: string | null }) | null,
): string | null {
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

export function initialRows(commits: readonly Commit[]): RebaseRow[] {
  return autosquash(commits.map((commit) => ({ commit, action: "pick", message: commit.message })));
}

const autosquashSubject = /^(?:fixup|squash|amend)! (.+)$/;

export function isAutosquashSubject(subject: string): boolean {
  return autosquashSubject.test(subject);
}

export function fixupReplacementMessage(message: string): string {
  if (!message.startsWith("amend! ")) return message.trimEnd();
  const end = message.indexOf("\n");
  return end < 0 ? "" : message.slice(end + 1).trim();
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

function moveAdjacent<T>(rows: T[], selected: (row: T) => boolean, delta: -1 | 1): T[] {
  const boundary = delta < 0 ? 0 : rows.length - 1;
  const out = [...rows];
  for (let i = boundary - delta; i >= 0 && i < out.length; i -= delta) {
    const row = out[i]!;
    const next = out[i + delta]!;
    if (selected(row) && !selected(next)) {
      out[i] = next;
      out[i + delta] = row;
    }
  }
  return out;
}

export function moveRebaseRows(rows: RebasePlanRow[], selected: ReadonlySet<string>, delta: -1 | 1): RebasePlanRow[] {
  const isSelected = (row: RebasePlanRow) => selected.has(rebaseRowKey(row));
  if (!rows.length || !selected.size || isSelected(rows[delta < 0 ? 0 : rows.length - 1]!)) return rows;
  const roots = rebaseRoots(rows);
  const end = new Map(rows.map((row, i) => [roots.get(rebaseRowKey(row))!, i]));
  const blocks: { rows: RebasePlanRow[]; move: boolean }[] = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i]!;
    const last = end.get(rebaseRowKey(row)) ?? i;
    const group = rows.slice(i, last + 1);
    i = last + 1;
    if (isSelected(row) || group.length === 1) {
      blocks.push({ rows: group, move: isSelected(row) });
      continue;
    }

    // A child may swap with a sibling or leave the group as a standalone commit.
    const children = group.slice(1);
    const boundary =
      delta < 0
        ? children.findIndex((child) => !isSelected(child))
        : children.findLastIndex((child) => !isSelected(child));
    const split = delta < 0 ? (boundary < 0 ? children.length : boundary) : boundary + 1;
    const moving = delta < 0 ? children.slice(0, split) : children.slice(split);
    const staying = delta < 0 ? children.slice(split) : children.slice(0, split);
    blocks.push({ rows: [row, ...moveAdjacent(staying, isSelected, delta)], move: false });
    if (moving.length) {
      blocks.push({
        rows: moving.map((child) =>
          child.action !== "updateRef" && roots.get(child.commit.id) === rebaseRowKey(row)
            ? { ...child, action: "pick", fixupMessage: undefined }
            : child,
        ),
        move: true,
      });
    }
  }
  const edge = blocks[delta < 0 ? 0 : blocks.length - 1];
  if (edge?.move) return rows;
  const result = moveAdjacent(blocks, (block) => block.move, delta).flatMap((block) => block.rows);
  return rebaseRowsMatch(rows, result) ? rows : result;
}

export function rebaseRowsMatch(a: readonly RebasePlanRow[], b: readonly RebasePlanRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => {
      const other = b[i]!;
      return (
        rebaseRowKey(row) === rebaseRowKey(other) &&
        row.action === other.action &&
        (row.action !== "reword" || (other.action === "reword" && row.message === other.message)) &&
        (row.action !== "fixup" || (other.action === "fixup" && row.fixupMessage === other.fixupMessage))
      );
    })
  );
}

export function rebaseRoots(rows: readonly RebasePlanRow[]): ReadonlyMap<string, string> {
  const rootOf = new Map<string, string>();
  let lastKept: string | undefined;
  for (const row of rows) {
    const id = rebaseRowKey(row);
    if (row.action === "drop" || row.action === "updateRef") {
      rootOf.set(id, id);
    } else {
      if (row.action !== "squash" && row.action !== "fixup") lastKept = id;
      rootOf.set(id, lastKept ?? id);
    }
  }
  return rootOf;
}

/** Change the action without attaching unrelated fixups to a different commit. */
export function setRebaseRowAction(
  rows: readonly RebasePlanRow[],
  selected: ReadonlySet<string>,
  action: RebaseAction,
  fixupMessage?: RebaseFixupMessage,
): RebasePlanRow[] {
  const updated = (row: RebaseRow): RebaseRow => ({
    ...row,
    action,
    fixupMessage: action === "fixup" ? fixupMessage : undefined,
  });
  if (action === "squash" || action === "fixup") {
    return rows.map((row) => (row.action !== "updateRef" && selected.has(row.commit.id) ? updated(row) : row));
  }
  const rootOf = rebaseRoots(rows);
  const rewordGroups = new Map<string, RebaseRow[]>();
  if (action === "reword") {
    for (const row of rows) {
      if (row.action !== "squash" && row.action !== "fixup") continue;
      const root = rootOf.get(row.commit.id)!;
      if (root !== row.commit.id && selected.has(root)) {
        const children = rewordGroups.get(root) ?? [];
        children.push(row);
        rewordGroups.set(root, children);
      }
    }
    for (const [root, children] of rewordGroups) {
      if (!children.some((row) => row.fixupMessage)) rewordGroups.delete(root);
    }
  }
  const detached = new Map<string, RebaseRow[]>();
  const remaining = rows.flatMap((row): RebasePlanRow[] => {
    if (row.action === "updateRef") return [row];
    const id = row.commit.id;
    const root = rootOf.get(id)!;
    if (action === "drop" && selected.has(root)) return [updated(row)];
    const group = rewordGroups.get(root);
    if (group) {
      if (root === id) return [{ ...updated(row), message: groupMessages(row, group).join("\n\n\n") }];
      return [{ ...row, action: "fixup", fixupMessage: undefined }];
    }
    if (!selected.has(id)) return [row];
    if (root === id) return [updated(row)];
    detached.set(root, [...(detached.get(root) ?? []), updated(row)]);
    return [];
  });
  const last = new Map(remaining.map((row, index) => [rootOf.get(rebaseRowKey(row))!, index]));
  return remaining.flatMap((row, index) => {
    const root = rootOf.get(rebaseRowKey(row))!;
    return index === last.get(root) ? [row, ...(detached.get(root) ?? [])] : [row];
  });
}

function groupMessages(root: RebaseRow, children: readonly RebasePlanRow[]): string[] {
  let messages = [root.action === "reword" ? root.message : root.commit.message];
  for (const row of children) {
    if (row.action === "fixup" && row.fixupMessage) {
      messages = [fixupReplacementMessage(row.commit.message)];
    } else if (row.action === "squash") {
      messages.push(row.commit.message);
    }
  }
  return messages;
}

/** Combine selected commits at the oldest selected commit or its existing group. */
export function combineRebaseRows(
  rows: RebasePlanRow[],
  selected: ReadonlySet<string>,
  action: "squash" | "fixup",
): { rows: RebasePlanRow[]; messageCommit?: string } {
  if (rows.some((row) => row.action === "updateRef" && selected.has(rebaseRowKey(row)))) return { rows };
  const first = rows.find((row) => selected.has(rebaseRowKey(row)));
  if (!first || first.action === "updateRef" || selected.size < 2) return { rows };
  const rootOf = rebaseRoots(rows);
  const root = rootOf.get(first.commit.id)!;
  const joins = rows.filter((row): row is RebaseRow => {
    if (row.action === "updateRef") return false;
    const id = row.commit.id;
    const parent = rootOf.get(id)!;
    return parent !== root && (selected.has(id) || selected.has(parent));
  });
  if (!joins.length) return { rows };
  const joined = new Set(joins.map((row) => row.commit.id));
  const result = rows.filter((row) => !joined.has(rebaseRowKey(row)));
  const target = result.findIndex((row) => rebaseRowKey(row) === root);
  const targetRow = result[target]!;
  if (targetRow.action === "updateRef") return { rows };
  if (targetRow.action === "drop" || targetRow.action === "squash" || targetRow.action === "fixup") {
    result[target] = { ...targetRow, action: "pick", fixupMessage: undefined };
  }
  const last = result.findLastIndex((row) => rootOf.get(rebaseRowKey(row)) === root);
  result.splice(last + 1, 0, ...joins.map((row) => ({ ...row, action: "fixup" as const, fixupMessage: undefined })));
  if (action === "fixup") return { rows: result };

  const messages = [
    ...groupMessages(targetRow, result.slice(target + 1, last + 1)),
    ...joins.map((row) => (row.action === "reword" ? row.message : row.commit.message)),
  ];
  for (let i = target + 1; i <= last; i++) {
    const row = result[i]!;
    if (row.action === "squash" || (row.action === "fixup" && row.fixupMessage)) {
      result[i] = { ...row, action: "fixup", fixupMessage: undefined };
    }
  }
  result[target] = {
    ...targetRow,
    action: "reword",
    fixupMessage: undefined,
    message: combinedCommitMessage(messages),
  };
  return { rows: result, messageCommit: root };
}

export function combinedCommitMessage(messages: readonly string[]): string {
  const subjects = messages.map((message) => message.split(/\r?\n/, 1)[0]!);
  const targets = new Set(subjects.filter((subject) => !isAutosquashSubject(subject)));
  return [
    ...new Set(
      messages.map((message, i) => {
        const target = autosquashSubject.exec(subjects[i]!)?.[1];
        const start = message.indexOf("\n") + 1;
        return (target && targets.has(target) ? (start ? message.slice(start) : "") : message).trim();
      }),
    ),
  ]
    .filter(Boolean)
    .join("\n\n\n");
}

export function planProblem(rows: readonly RebasePlanRow[]): string | null {
  return rows.some((r) => r.action !== "drop" && r.action !== "updateRef")
    ? nativePlanProblem(rows)
    : "At least one commit must be kept";
}

export function nativePlanProblem(rows: readonly RebasePlanRow[]): string | null {
  const first = rows.find((r) => r.action !== "drop" && r.action !== "updateRef");
  const action = first?.action;
  if (action === "squash" || action === "fixup")
    return `The first commit cannot be ${action === "squash" ? "squashed" : "fixed up"} into a previous one`;
  if (rows.some((r) => r.action === "reword" && !r.message.trim())) return "A reworded commit needs a message";
  return null;
}

export function nativePlanRows(plan: readonly RebaseTodoRow[]): RebasePlanRow[] {
  return plan.map((row) => {
    if (row.kind === "updateRef") return { action: "updateRef", reference: row.reference };
    const { action, id, revision, author, summary, message, fixupMessage } = row;
    return {
      action,
      commit: { id, shortId: revision, author, summary, message },
      message,
      fixupMessage: fixupMessage ?? undefined,
    };
  });
}

/** Rewrite only the command slots. Git's comments and original abbreviations survive. */
export function nativePlanReply(
  text: string,
  plan: readonly RebaseTodoRow[],
  rows: readonly RebasePlanRow[],
): RebaseEditorReply {
  const lines = text.split(/(\r?\n)/);
  const source = new Map(plan.map((row) => [row.kind === "updateRef" ? refRowKey(row.reference) : row.id, row]));
  const commands = rows.map((row) => {
    const original = source.get(rebaseRowKey(row))!;
    const line = lines[original.line * 2]!;
    if (original.kind === "updateRef" || row.action === "updateRef") return line;
    const sameAction = row.action === original.action;
    if (sameAction && row.fixupMessage === (original.fixupMessage ?? undefined)) return line;
    const flag = row.fixupMessage === "replace" ? " -C" : row.fixupMessage === "edit" ? " -c" : "";
    return line.replace(
      /^([ \t]*)(\S+)(?:[ \t]+-[Cc](?=[ \t]))?/,
      (_, indent: string, verb: string) => indent + (sameAction ? verb : row.action) + flag,
    );
  });
  plan.forEach((row, i) => {
    lines[row.line * 2] = commands[i]!;
  });
  const rewords = Object.fromEntries(
    rows.flatMap((row) => (row.action === "reword" ? [[row.commit.id, row.message]] : [])),
  );
  return { text: lines.join(""), rewords };
}

/** Nothing would change (same order, every commit picked). */
export function planIsNoop(rows: readonly RebasePlanRow[], original: readonly Commit[]): boolean {
  return (
    rows.length === original.length &&
    rows.every(
      (r, i) =>
        rebaseRowKey(r) === original[i]!.id &&
        (r.action === "pick" || (r.action === "reword" && r.message.trim() === r.commit.message.trim())),
    )
  );
}

export function toEntries(rows: readonly RebasePlanRow[]): RebaseEntry[] {
  const entries = rows
    .filter((row) => row.action !== "updateRef")
    .map((r) => ({
      commit: r.commit.id,
      action: r.action,
      message: r.action === "reword" ? r.message.trim() : null,
    }));
  let head: RebaseEntry | undefined;
  for (const entry of entries) {
    if (entry.action === "drop") continue;
    if ((entry.action === "squash" || entry.action === "fixup") && head?.message) {
      entry.message = head.message;
      head.message = null;
      if (head.action === "reword") head.action = "pick";
    }
    head = entry;
  }
  return entries;
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
