/**
 * Replace in Files (⇧⌘R), IDEA's flow: the usages found by the search can be
 * replaced one by one (Replace / Skip), per file, all at once (after a
 * confirmation) or excluded first (⌫ in the Find window). Replacement runs in
 * the backend off the command thread, cancellable, one undoable step per file.
 */
import { Channel } from "@tauri-apps/api/core";
import { editorsFor, whenSynced } from "@/editor/api";
import {
  call,
  commands,
  nextRequestId,
  type Pos,
  type ReplaceEvent,
  type ReplacePreview,
  type ReplaceSummary,
  type ReplaceTarget,
  type RequestId,
  type SearchQuery,
  type TextEdit,
} from "@/platform/ipc";

/** One usage (match) of the search. */
export interface Usage {
  path: string;
  line: number;
  col: number;
}

export const usageKey = (u: Usage) => `${u.path}:${u.line}:${u.col}`;

/** A group of usages handled together (a result row = one line, a file, a directory). */
export interface UsageGroup {
  key: string;
  path: string;
  starts: ReadonlyArray<{ line: number; col: number }>;
}

/** Usages excluded by the user (⌫) or already replaced in this session. */
export interface ReplaceMarks {
  excluded: ReadonlySet<string>;
  done: ReadonlySet<string>;
}

export const NO_MARKS: ReplaceMarks = { excluded: new Set(), done: new Set() };

function usagesOf(groups: readonly UsageGroup[]): Usage[] {
  return groups.flatMap((g) => g.starts.map((s) => ({ path: g.path, line: s.line, col: s.col })));
}

/** Usages still to replace among `groups` (not excluded, not yet replaced). */
export function pendingUsages(groups: readonly UsageGroup[], marks: ReplaceMarks): Usage[] {
  return usagesOf(groups).filter((u) => {
    const k = usageKey(u);
    return !marks.excluded.has(k) && !marks.done.has(k);
  });
}

/** Backend targets for `usages`, one per file in first-seen order, with explicit positions. */
export function replaceTargets(usages: readonly Usage[]): ReplaceTarget[] {
  const byPath = new Map<string, Pos[]>();
  for (const u of usages) {
    let list = byPath.get(u.path);
    if (!list) byPath.set(u.path, (list = []));
    list.push({ line: u.line, col: u.col });
  }
  return [...byPath].map(([path, only]) => ({ path, only }));
}

export interface ReplaceCounts {
  usages: number;
  files: number;
}

export function countUsages(usages: readonly Usage[]): ReplaceCounts {
  return { usages: usages.length, files: new Set(usages.map((u) => u.path)).size };
}

/** "Replace 3 occurrences in 2 files" for the confirmation dialog. */
export function confirmText(c: ReplaceCounts, pattern: string, replacement: string): string {
  const occ = `${c.usages} occurrence${c.usages === 1 ? "" : "s"}`;
  const files = `${c.files} file${c.files === 1 ? "" : "s"}`;
  return `Replace ${occ} of '${pattern}' with '${replacement}' in ${files}?`;
}

/** Toggles exclusion of every usage in `groups` (all excluded → include them again). */
export function toggleExcluded(marks: ReplaceMarks, groups: readonly UsageGroup[]): ReplaceMarks {
  const keys = usagesOf(groups).map(usageKey);
  if (!keys.length) return marks;
  const excluded = new Set(marks.excluded);
  const all = keys.every((k) => excluded.has(k));
  for (const k of keys) {
    if (all) excluded.delete(k);
    else excluded.add(k);
  }
  return { ...marks, excluded };
}

export function markDone(marks: ReplaceMarks, usages: readonly Usage[]): ReplaceMarks {
  const done = new Set(marks.done);
  for (const u of usages) done.add(usageKey(u));
  return { ...marks, done };
}

export type GroupState = "pending" | "excluded" | "done" | "partial";

export function groupState(group: UsageGroup, marks: ReplaceMarks): GroupState {
  const keys = group.starts.map((s) => usageKey({ path: group.path, ...s }));
  if (!keys.length) return "pending";
  if (keys.every((k) => marks.done.has(k))) return "done";
  if (keys.every((k) => marks.excluded.has(k) || marks.done.has(k))) return "excluded";
  if (keys.some((k) => marks.excluded.has(k) || marks.done.has(k))) return "partial";
  return "pending";
}

/** Next row after `from` that still has something to replace (Skip / after Replace); -1 if none. */
export function nextPending(groups: readonly UsageGroup[], from: number, marks: ReplaceMarks): number {
  for (let i = from + 1; i < groups.length; i++) {
    const s = groupState(groups[i]!, marks);
    if (s === "pending" || s === "partial") return i;
  }
  return -1;
}

export interface ReplaceRequest {
  query: SearchQuery;
  replacement: string;
  preserveCase: boolean;
  targets: ReplaceTarget[];
}

export interface ReplaceProgress {
  done: number;
  total: number;
  replacements: number;
  failures: Array<{ path: string; message: string }>;
}

export interface ReplaceDeps {
  /** Waits until open editors of `paths` pushed their local edits to the backend. */
  synced(paths: readonly string[]): Promise<void>;
  start(request: RequestId, r: ReplaceRequest, onEvent: (e: ReplaceEvent) => void): Promise<void>;
  cancel(request: RequestId): void;
  nextRequestId(): RequestId;
}

export function ipcReplaceDeps(): ReplaceDeps {
  return {
    synced: async (paths) => {
      await Promise.all(paths.flatMap((p) => editorsFor(p).map((e) => whenSynced(e.view))));
    },
    start: async (request, r, onEvent) => {
      const channel = new Channel<ReplaceEvent>();
      channel.onmessage = onEvent;
      await call(commands.replaceInFiles(request, r.query, r.replacement, r.preserveCase, r.targets, channel));
    },
    cancel: (request) => void commands.cancelRequest(request).catch(() => {}),
    nextRequestId,
  };
}

/** A running Replace; `cancel()` stops it between files. */
export interface ReplaceRun {
  request: RequestId;
  result: Promise<ReplaceSummary>;
  cancel(): void;
}

export function startReplace(
  r: ReplaceRequest,
  onProgress: (p: ReplaceProgress) => void = () => {},
  deps: ReplaceDeps = ipcReplaceDeps(),
): ReplaceRun {
  const request = deps.nextRequestId();
  let cancelled = false;
  const result = (async () => {
    await deps.synced(r.targets.map((t) => t.path));
    if (cancelled) return { files: 0, replacements: 0, failed: 0, cancelled: true, elapsedMs: 0 };
    const progress: ReplaceProgress = { done: 0, total: r.targets.length, replacements: 0, failures: [] };
    let summary: ReplaceSummary | null = null;
    await deps.start(request, r, (e) => {
      if (e.type === "done") {
        summary = e.summary;
        return;
      }
      progress.done = e.done;
      progress.total = e.total;
      if (e.type === "file") progress.replacements += e.replacements;
      else progress.failures = [...progress.failures, { path: e.path, message: e.message }];
      onProgress({ ...progress });
    });
    return (
      summary ?? {
        files: 0,
        replacements: progress.replacements,
        failed: progress.failures.length,
        cancelled,
        elapsedMs: 0,
      }
    );
  })();
  return {
    request,
    result,
    cancel: () => {
      cancelled = true;
      deps.cancel(request);
    },
  };
}

/** Before / after text of one file for Preview (only the given usages replaced). */
export function loadReplacePreview(
  query: SearchQuery,
  replacement: string,
  preserveCase: boolean,
  path: string,
  usages: readonly Usage[] | null,
): Promise<ReplacePreview> {
  const only = usages ? usages.map((u) => ({ line: u.line, col: u.col })) : null;
  return call(commands.replacePreview(query, replacement, preserveCase, path, only));
}

export function summaryText(s: ReplaceSummary): string {
  const occ = `${s.replacements} occurrence${s.replacements === 1 ? "" : "s"}`;
  const files = `${s.files} file${s.files === 1 ? "" : "s"}`;
  return `${s.cancelled ? "Stopped after replacing" : "Replaced"} ${occ} in ${files}${s.failed ? ` (${s.failed} failed)` : ""}`;
}

export interface PreviewLine {
  kind: "same" | "del" | "add";
  /** 0-based line in the old text (`same` / `del`) or the new text (`add`). */
  line: number;
  text: string;
}

/** Unified line preview of `edits` (non-overlapping, UTF-16 line/col) applied to `before`. */
export function replacePreviewLines(before: string, edits: readonly TextEdit[]): PreviewLine[] {
  const lines = before.split("\n");
  const sorted = [...edits].sort(
    (a, b) => a.range.start.line - b.range.start.line || a.range.start.col - b.range.start.col,
  );
  const out: PreviewLine[] = [];
  const between = (from: Pos, to: Pos) => {
    if (from.line === to.line) return (lines[from.line] ?? "").slice(from.col, to.col);
    const parts = [(lines[from.line] ?? "").slice(from.col)];
    for (let l = from.line + 1; l < to.line; l++) parts.push(lines[l] ?? "");
    parts.push((lines[to.line] ?? "").slice(0, to.col));
    return parts.join("\n");
  };
  let next = 0;
  let delta = 0;
  for (let i = 0; i < sorted.length;) {
    const first = sorted[i]!;
    const startLine = first.range.start.line;
    let endLine = first.range.end.line;
    const group = [first];
    for (i++; i < sorted.length && sorted[i]!.range.start.line <= endLine; i++) {
      group.push(sorted[i]!);
      endLine = Math.max(endLine, sorted[i]!.range.end.line);
    }
    for (let l = next; l < startLine; l++) out.push({ kind: "same", line: l, text: lines[l] ?? "" });
    let cursor: Pos = { line: startLine, col: 0 };
    let text = "";
    for (const e of group) {
      text += between(cursor, e.range.start) + e.new_text;
      cursor = e.range.end;
    }
    text += between(cursor, { line: endLine, col: (lines[endLine] ?? "").length });
    for (let l = startLine; l <= endLine; l++) out.push({ kind: "del", line: l, text: lines[l] ?? "" });
    const added = text.split("\n");
    added.forEach((t, k) => out.push({ kind: "add", line: startLine + delta + k, text: t }));
    delta += added.length - (endLine - startLine + 1);
    next = endLine + 1;
  }
  for (let l = next; l < lines.length; l++) out.push({ kind: "same", line: l, text: lines[l] ?? "" });
  return out;
}
