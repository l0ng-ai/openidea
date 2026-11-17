/** Edit › Sort Lines / Reverse Lines: the selected lines, or the whole file without a selection. */
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";

/** Line blocks the command applies to: one per non-empty selection range, or the document. */
function blocks(state: EditorState): Array<{ from: number; to: number }> {
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  if (!ranges.length) {
    // The empty line after a final newline stays last.
    const doc = state.doc;
    const last = doc.line(doc.lines);
    return [{ from: 0, to: !last.length && doc.lines > 1 ? doc.line(doc.lines - 1).to : doc.length }];
  }
  const out: Array<{ from: number; to: number }> = [];
  for (const r of ranges) {
    const first = state.doc.lineAt(r.from);
    // A selection ending at a line start does not include that line.
    const last = state.doc.lineAt(r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to);
    const prev = out[out.length - 1];
    if (prev && first.from <= prev.to) prev.to = Math.max(prev.to, last.to);
    else out.push({ from: first.from, to: last.to });
  }
  return out;
}

function rewrite(
  state: EditorState,
  transform: (lines: string[]) => string[],
  userEvent: string,
): TransactionSpec | null {
  const changes: ChangeSpec[] = [];
  for (const b of blocks(state)) {
    const text = state.sliceDoc(b.from, b.to);
    const lines = text.split(state.lineBreak);
    if (lines.length < 2) continue;
    const next = transform(lines).join(state.lineBreak);
    if (next !== text) changes.push({ from: b.from, to: b.to, insert: next });
  }
  if (!changes.length) return null;
  const set = state.changes(changes);
  const hadSelection = state.selection.ranges.some((r) => !r.empty);
  return {
    changes: set,
    selection: hadSelection
      ? EditorSelection.create(
          state.selection.ranges.map((r) => EditorSelection.range(set.mapPos(r.anchor, -1), set.mapPos(r.head, 1))),
          state.selection.mainIndex,
        )
      : undefined,
    scrollIntoView: true,
    userEvent,
  };
}

/** Plain UTF-16 code-unit order, as IDEA sorts (`String.compareTo`): every uppercase letter before every lowercase one. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function sortLinesSpec(state: EditorState): TransactionSpec | null {
  return rewrite(state, (lines) => [...lines].sort(byCodeUnit), "input.sort");
}

export function reverseLinesSpec(state: EditorState): TransactionSpec | null {
  return rewrite(state, (lines) => [...lines].reverse(), "input.reverse");
}

type Dispatch = { state: EditorState; dispatch: (tr: Transaction | TransactionSpec) => void };

export function sortLines(view: Dispatch): boolean {
  if (view.state.readOnly) return false;
  const spec = sortLinesSpec(view.state);
  if (spec) view.dispatch(spec);
  return !!spec;
}

export function reverseLines(view: Dispatch): boolean {
  if (view.state.readOnly) return false;
  const spec = reverseLinesSpec(view.state);
  if (spec) view.dispatch(spec);
  return !!spec;
}
