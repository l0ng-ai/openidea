import type { CommitSelection, FileStatus, LineHunk } from "@/bindings";
import { editorsFor } from "@/editor/api";
import { tx, txTemplate } from "@/platform/i18n";
import { commands, isErrorKind } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  activePatterns,
  scanText,
  todoFilterKeywords,
  useTodoSettings,
  type TodoItem,
  type TodoSettings,
} from "@/platform/todo";
import { todoFilterSelection } from "@/platform/todoFilterSelection";
import { maybeEditorService } from "@/workbench/contributions";
import { showTodoReview, type TodoReview, type TodoReviewSkippedFile } from "@/workbench/todoReview";
import type { CommitCheckResult } from "./commitCheckRegistry";
import {
  collectSnapshotResults,
  commitFileDiff,
  commitFiles,
  readCommitFile,
  readSnapshotText,
  workingText,
  type SnapshotText,
  type CommittedSnapshot,
} from "./commitContents";
import { openVcsDiff, readDiffSide, withChain, type DiffData } from "./diffInput";

export interface CommitTodoRules {
  settings: TodoSettings;
  keywords: ReadonlySet<string> | null;
}

export function commitTodoRules(
  settings = useTodoSettings.getState(),
  filter = todoFilterSelection("commit"),
): CommitTodoRules {
  return { settings, keywords: todoFilterKeywords(settings, filter) };
}

function scanCommitTodos(path: string, text: string, { settings, keywords }: CommitTodoRules): TodoItem[] {
  const items = scanText(path, text, settings);
  return keywords ? items.filter(({ keyword }) => keywords.has(keyword)) : items;
}

function hasPatterns({ keywords, settings }: CommitTodoRules): boolean {
  return (keywords?.size ?? activePatterns(settings).length) > 0;
}

function skippedFile(path: string, reason: string, error?: unknown): TodoReviewSkippedFile {
  const message = error instanceof Error ? error.message : error;
  return { path, reason, detail: typeof message === "string" ? txTemplate(message) : undefined };
}

interface CheckedTodoFile {
  diff: DiffData;
  text: string;
  items: TodoItem[];
  /** Lines in the worktree at the time of the pending check. */
  worktreeLines?: ReadonlyMap<number, number>;
}

interface TodoCheckFiles {
  files: CheckedTodoFile[];
  skipped: TodoReviewSkippedFile[];
}

/** Translate a line through the unselected changes. A replaced or deleted line has no equivalent. */
function workingLine(line: number, hunks: readonly LineHunk[]): number | null {
  let offset = 0;
  for (const h of hunks) {
    if (line < h.oldStart) break;
    const end = h.oldStart + h.oldLines;
    if (line < end) return null;
    offset = h.start + h.lines - end;
  }
  return line + offset;
}

/** Inspect the same staged files, worktree files and selected hunks that Git will commit. */
export async function todosForCommit(
  files: readonly FileStatus[],
  selection: CommitSelection,
  rules = commitTodoRules(),
): Promise<TodoCheckFiles> {
  const results: TodoCheckFiles = { files: [], skipped: [] };
  if (!hasPatterns(rules)) return results;
  for (const file of commitFiles(files, selection)) {
    const read = await readCommitFile(file, selection.amend);
    if (read.kind === "nonText") continue;
    if (read.kind !== "ready") {
      results.skipped.push(
        skippedFile(
          file.path,
          tx("Could not read the selected version."),
          read.kind === "unavailable" ? read.error : undefined,
        ),
      );
      continue;
    }
    const { snapshot } = read;
    const { before, content, text } = snapshot;
    const candidates = scanCommitTodos(file.path, text, rules);
    if (!candidates.length) continue;
    const items = await todosInChangedLines(file.path, before, text, candidates);
    if (!Array.isArray(items)) {
      results.skipped.push(items);
      continue;
    }
    if (!items.length) continue;

    const working = file.source === "staged" ? await workingText(file.path) : content;
    const worktreeLines = new Map<number, number>();
    if (working !== null) {
      const mapping = working === text ? [] : await commands.vcsDiffHunks(text, working).catch(() => null);
      if (mapping) {
        for (const { line } of items) {
          const target = workingLine(line, mapping);
          if (target !== null) worktreeLines.set(line, target);
        }
      }
    }
    results.files.push({ diff: commitFileDiff(file, snapshot, items[0]!.line), text, items, worktreeLines });
  }
  return results;
}

async function todosInChangedLines(
  path: string,
  before: SnapshotText,
  selected: string,
  candidates: TodoItem[],
): Promise<TodoItem[] | TodoReviewSkippedFile> {
  if (before.kind === "unavailable") return skippedFile(path, tx("Could not read the previous version."), before.error);
  if (before.kind !== "text") return candidates;
  try {
    const hunks = await commands.vcsDiffHunks(before.text, selected);
    let next = 0;
    return candidates.filter(({ line }) => {
      let hunk = hunks[next];
      while (hunk && line >= hunk.start + hunk.lines) hunk = hunks[++next];
      return hunk && line >= hunk.start;
    });
  } catch (error) {
    if (isErrorKind(error, "cancelled") || (error instanceof DOMException && error.name === "AbortError")) throw error;
    return skippedFile(path, tx("Could not compare the file versions."), error);
  }
}

export async function checkCommittedTodos(
  files: readonly CommittedSnapshot[],
  signal: AbortSignal,
  rules: CommitTodoRules,
  revision: string,
): Promise<CommitCheckResult | null> {
  if (!hasPatterns(rules)) return null;
  const inspected = await collectSnapshotResults<CommittedSnapshot, CheckedTodoFile | TodoReviewSkippedFile>(
    files,
    async ({ diff, read }) => {
      const current = await read();
      signal.throwIfAborted();
      if (current.kind === "nonText") return null;
      if (current.kind !== "text") {
        return skippedFile(
          diff.path,
          tx("Could not read the selected version."),
          current.kind === "unavailable" ? current.error : undefined,
        );
      }
      const text = current.text;
      const candidates = scanCommitTodos(diff.path, text, rules);
      if (!candidates.length) return null;
      const before = await readSnapshotText(readDiffSide(diff.path, diff.left));
      signal.throwIfAborted();
      const items = await todosInChangedLines(diff.path, before, text, candidates);
      return Array.isArray(items) ? (items.length ? { diff, text, items } : null) : items;
    },
  );
  const results: TodoCheckFiles = { files: [], skipped: [] };
  for (const item of inspected) {
    if ("items" in item) results.files.push(item);
    else results.skipped.push(item);
  }
  signal.throwIfAborted();
  return todoCheckResult(results, revision.slice(0, 8), "committed");
}

export function todoCheckResult(
  { files, skipped }: TodoCheckFiles,
  subject: string,
  kind: TodoReview["kind"] = "pending",
): CommitCheckResult | null {
  const count = files.reduce((total, file) => total + file.items.length, 0);
  if (!count && !skipped.length) return null;
  const project = useProject.getState().project;
  const current = () => useProject.getState().project === project;
  const diffs = files.map(({ diff, items }) => ({
    ...diff,
    line: items[0]!.line,
    col: items[0]!.col,
    annotations: items.map(({ line, text, keyword }) => ({
      side: "right" as const,
      line,
      author: keyword,
      body: text,
    })),
  }));
  const review: TodoReview = {
    kind,
    subject,
    skipped,
    files: files.map(({ diff, text, items, worktreeLines }, index) => ({
      path: diff.path,
      text,
      items,
      async open(item, focus) {
        if (!current()) return;
        const target = worktreeLines?.get(item.line);
        const editor = maybeEditorService();
        if (target !== undefined && editor) {
          const buffer = editorsFor(item.path)[0]?.view?.state.doc.toString();
          const working = buffer ?? (await workingText(item.path));
          if (!current()) return;
          if (working?.split("\n")[target] === text.split("\n")[item.line]) {
            await editor.openFile(item.path, { selection: { line: target, col: item.col }, focus, preview: !focus });
            return;
          }
        }
        await openVcsDiff({ ...withChain(diffs, index), line: item.line, col: item.col }, { focus, preview: !focus });
      },
    })),
  };
  const findings = count
    ? kind === "committed"
      ? count === 1
        ? tx`${count} TODO item in committed changes`
        : tx`${count} TODO items in committed changes`
      : count === 1
        ? tx`${count} TODO item found in the changed lines`
        : tx`${count} TODO items found in the changed lines`
    : "";
  const skippedCount = skipped.length;
  const incomplete =
    skippedCount === 1
      ? tx("Could not check 1 file")
      : skippedCount > 1
        ? tx`Could not check ${skippedCount} files`
        : "";
  return {
    severity: "error",
    text: findings && incomplete ? `${findings}. ${incomplete}` : findings || incomplete,
    fix: {
      label: "Review TODOs",
      opensToolWindow: true,
      run: () => {
        if (!current() || showTodoReview(review)) return;
        const first = review.files[0];
        if (first) return first.open(first.items[0]!, true);
      },
    },
  };
}
