/** Summaries of workspace edits for rename / refactoring previews, and the intention preview diff. */
import { ChangeSet, type Text } from "@codemirror/state";
import type { TextEdit, WorkspaceEdit } from "@/bindings";
import { tx } from "@/platform/i18n";
import type { DiffLine } from "./popupStore";
import { textEditsToChanges } from "./positions";

export interface WorkspaceEditFileSummary {
  path: string;
  /** Text edits in this file. */
  edits: number;
  /** Non-text operations (create/rename/delete) touching this path. */
  operation?: "create" | "rename" | "delete";
  /** Rename target, for `operation: "rename"`. */
  to?: string;
}

export interface WorkspaceEditSummary {
  /** Distinct files touched (text edits or operations). */
  files: number;
  /** Total text edits. */
  occurrences: number;
  /** Whether the edit creates, renames or deletes files. */
  hasFileOperations: boolean;
  entries: WorkspaceEditFileSummary[];
}

export function summarizeWorkspaceEdit(edit: WorkspaceEdit): WorkspaceEditSummary {
  const byPath = new Map<string, WorkspaceEditFileSummary>();
  const entry = (path: string) => {
    let e = byPath.get(path);
    if (!e) byPath.set(path, (e = { path, edits: 0 }));
    return e;
  };
  let occurrences = 0;
  let hasFileOperations = false;
  for (const f of edit.files) {
    switch (f.kind) {
      case "edit": {
        entry(f.path).edits += f.edits.length;
        occurrences += f.edits.length;
        break;
      }
      case "create":
        hasFileOperations = true;
        entry(f.path).operation = "create";
        break;
      case "delete":
        hasFileOperations = true;
        entry(f.path).operation = "delete";
        break;
      case "rename": {
        hasFileOperations = true;
        const e = entry(f.from);
        e.operation = "rename";
        e.to = f.to;
        break;
      }
    }
  }
  const entries = [...byPath.values()].filter((e) => e.edits > 0 || e.operation);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { files: entries.length, occurrences, hasFileOperations, entries };
}

/** "3 occurrences in 2 files". */
export function describeSummary({ occurrences, files }: WorkspaceEditSummary): string {
  if (occurrences === 1) return files === 1 ? tx("1 occurrence in 1 file") : tx`1 occurrence in ${files} files`;
  return files === 1 ? tx`${occurrences} occurrences in 1 file` : tx`${occurrences} occurrences in ${files} files`;
}

/** Whether applying needs confirmation (IDEA previews multi-file refactorings). */
export function needsPreview(s: WorkspaceEditSummary): boolean {
  return s.files > 1 || s.hasFileOperations;
}

/** Line diff of `a` → `b` (LCS; both short: they are the changed lines of one hunk). */
function lineDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000)
    return [
      ...a.map((text) => ({ kind: "removed" as const, text })),
      ...b.map((text) => ({ kind: "added" as const, text })),
    ];
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: "context", text: a[i]! });
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ kind: "removed", text: a[i++]! });
    else out.push({ kind: "added", text: b[j++]! });
  }
  return out;
}

const lines = (doc: Text, first: number, last: number) => {
  const out: string[] = [];
  for (let n = first; n <= last; n++) out.push(doc.line(n).text);
  return out;
};

/**
 * The intention preview of `edits` to `doc`: changed lines with `context`
 * unchanged lines around each hunk, hunks separated by a gap line, at most
 * `maxLines` lines.
 */
export function editPreviewLines(doc: Text, edits: readonly TextEdit[], context = 1, maxLines = 60): DiffLine[] {
  const changes = textEditsToChanges(doc, edits);
  if (!changes.length) return [];
  const set = ChangeSet.of(changes, doc.length);
  const after = set.apply(doc);
  // Hunks: changed old-line ranges, merged when their contexts touch.
  const hunks: { a1: number; a2: number }[] = [];
  for (const c of changes) {
    const a1 = doc.lineAt(c.from).number;
    const a2 = doc.lineAt(c.to).number;
    const last = hunks[hunks.length - 1];
    if (last && a1 - last.a2 <= 2 * context + 1) last.a2 = Math.max(last.a2, a2);
    else hunks.push({ a1, a2 });
  }
  const out: DiffLine[] = [];
  for (const h of hunks) {
    if (out.length) out.push({ kind: "gap", text: "" });
    const from = doc.line(h.a1).from;
    const to = doc.line(h.a2).to;
    const b1 = after.lineAt(set.mapPos(from, -1)).number;
    const b2 = after.lineAt(set.mapPos(to, 1)).number;
    const c1 = Math.max(1, h.a1 - context);
    const c2 = Math.min(doc.lines, h.a2 + context);
    for (const text of lines(doc, c1, h.a1 - 1)) out.push({ kind: "context", text });
    out.push(...lineDiff(lines(doc, h.a1, h.a2), lines(after, b1, b2)));
    for (const text of lines(doc, h.a2 + 1, c2)) out.push({ kind: "context", text });
    if (out.length >= maxLines) break;
  }
  if (out.length <= maxLines) return out;
  return [...out.slice(0, maxLines), { kind: "gap", text: "" }];
}
