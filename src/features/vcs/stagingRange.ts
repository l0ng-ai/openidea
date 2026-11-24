import { diff } from "@codemirror/merge";
import { ChangeSet, type ChangeDesc, type Text } from "@codemirror/state";
import type { EditorHunk } from "./gutter";
import { currentHunkText } from "./hunks";
import type { ThreePanes } from "./ThreePaneDiff";

interface HunkLines {
  start: number;
  lines: number;
  text: string;
}

export interface StagingRange {
  indexVersion: string;
  panes: ThreePanes<HunkLines>;
}

export interface DiffRange {
  from: number;
  to: number;
  line: number;
  lines: number;
}

export function stagingRange(hunk: EditorHunk, doc: Text): StagingRange | undefined {
  const index = hunk.staging;
  if (!index) return;
  return {
    indexVersion: index.indexVersion,
    panes: [
      { start: hunk.oldStart, lines: hunk.oldLines, text: hunk.oldText },
      { start: index.indexStart, lines: index.indexLines, text: index.indexText },
      { start: hunk.start, lines: hunk.lines, text: currentHunkText(doc.toString(), hunk) },
    ],
  };
}

function lineRange(doc: Text, line: number, lines: number): DiffRange {
  const from = line < doc.lines ? doc.line(line + 1).from : doc.length;
  const to = lines ? doc.line(line + lines).to : from;
  return { from, to, line, lines };
}

export function initialDiffRanges(
  range: StagingRange,
  docs: ThreePanes<Text>,
  indexVersion: string | undefined,
): ThreePanes<DiffRange> | null {
  if (indexVersion !== range.indexVersion) return null;
  const { panes } = range;
  if (
    !panes.every(
      (span, i) =>
        span.start + span.lines <= docs[i]!.lines && currentHunkText(docs[i]!.toString(), span) === span.text,
    )
  )
    return null;
  const before = Number(panes.every((span) => span.start > 0));
  const after = Number(panes.every((span, i) => docs[i]!.length > 0 && span.start + span.lines < docs[i]!.lines));
  const at = (i: 0 | 1 | 2) => lineRange(docs[i], panes[i].start - before, panes[i].lines + before + after);
  return [at(0), at(1), at(2)];
}

/** Keep a displayed excerpt anchored as earlier lines or the excerpt itself change. */
export function mapDiffRange(range: DiffRange, before: Text, after: Text, changes?: ChangeDesc): DiffRange | null {
  if (before.eq(after)) return range;
  const desc =
    changes ??
    ChangeSet.of(
      diff(before.toString(), after.toString(), { scanLimit: 500 }).map((change) => ({
        from: change.fromA,
        to: change.toA,
        insert: after.slice(change.fromB, change.toB),
      })),
      before.length,
    );
  let lost = false;
  desc.iterChangedRanges((from, to) => {
    if (from > range.from || to < range.to) return;
    const prefix = before.sliceString(from, range.from);
    const suffix = before.sliceString(range.to, to);
    if ((prefix && prefix !== "\n") || (suffix && suffix !== "\n")) lost = true;
  });
  if (lost) return null;
  const from = desc.mapPos(range.from, -1);
  const to = desc.mapPos(range.to, 1);
  const start = after.lineAt(from);
  const end = after.lineAt(to);
  if (from === to && (range.lines === 0 || range.from !== range.to))
    return lineRange(after, from > start.from ? start.number : start.number - 1, 0);
  return lineRange(after, start.number - 1, end.number - start.number + 1);
}
