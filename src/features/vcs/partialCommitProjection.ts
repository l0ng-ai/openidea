import { ChangeSet, Text } from "@codemirror/state";
import type { HunkRange, LineHunk, PartialCommitFile } from "@/bindings";
import { currentHunkText, lineStarts, rollbackEdit } from "./hunks";

const key = (h: HunkRange) => `${h.oldStart}:${h.oldLines}:${h.start}:${h.lines}`;

/** Inverts the hunk selection so edits can be mapped back to their original working lines. */
export function partialCommitProjection(
  working: Text,
  selected: Text,
  hunks: readonly LineHunk[],
  file: PartialCommitFile,
): ChangeSet | null {
  const text = working.toString();
  const starts = lineStarts(text);
  const whole = new Set(file.hunks.map(key));
  const lines = new Map((file.lineHunks ?? []).map((h) => [key(h.range), h]));
  const edits = [];
  for (const hunk of hunks) {
    const id = key(hunk);
    if (whole.delete(id)) continue;
    const partial = lines.get(id);
    if (!partial) {
      edits.push(rollbackEdit(text, hunk));
      continue;
    }
    lines.delete(id);
    if (partial.oldText !== hunk.oldText || partial.newText !== currentHunkText(text, hunk)) return null;
    const additions = new Set(partial.additions);
    const deletions = new Set(partial.deletions);
    const oldLines = hunk.oldText.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let kept = oldLines.filter((_, line) => !deletions.has(line)).join("");
    if (kept && !kept.endsWith("\n") && additions.size) kept += "\n";
    if (kept) edits.push({ from: starts[hunk.start]!, insert: kept });
    for (let line = 0; line < hunk.lines; line++) {
      if (additions.has(line)) continue;
      const start = hunk.start + line;
      edits.push({ from: starts[start]!, to: starts[start + 1]! });
    }
  }
  if (whole.size || lines.size) return null;
  const reverted = ChangeSet.of(edits, working.length);
  if (!reverted.apply(working).eq(selected)) return null;
  return reverted.invert(working);
}

/** A fix can change shared text but must leave every excluded edit in place. */
export function keepsExcludedChanges(changes: ChangeSet, excluded: ChangeSet): boolean {
  let overlaps = false;
  excluded.iterChangedRanges((from, to) => {
    changes.iterChangedRanges((start, end) => {
      if (from === to || start === end) {
        overlaps ||= from <= end && start <= to;
      } else {
        overlaps ||= from < end && start < to;
      }
    });
  });
  return !overlaps;
}
