/**
 * Move Element Left / Right (⌥⇧⌘← / →): swaps the element at the caret with its
 * neighbour in the enclosing comma-separated list — call arguments, parameters,
 * array and object literal entries.
 */
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { Command } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

const OPEN = "([{";
const CLOSE = ")]}";
const NOT_CODE = /String|Comment|Regexp|Char|Template/;
/** Lists longer than this are not scanned. */
const MAX_SCAN = 20_000;

function inCode(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state);
  return !tree.length || !NOT_CODE.test(tree.resolveInner(pos, 1).name);
}

/** `[open, close]` offsets of the innermost bracket pair around `pos` that holds a comma list. */
function enclosingList(state: EditorState, pos: number): [number, number] | null {
  const doc = state.doc;
  const min = Math.max(0, pos - MAX_SCAN);
  const stack: string[] = [];
  for (let p = pos - 1; p >= min; p--) {
    const ch = doc.sliceString(p, p + 1);
    const close = CLOSE.indexOf(ch);
    const open = OPEN.indexOf(ch);
    if (close < 0 && open < 0) continue;
    if (!inCode(state, p)) continue;
    if (close >= 0) stack.push(OPEN[close]!);
    else if (stack.length) {
      if (stack.pop() !== ch) return null;
    } else {
      const end = matchingClose(state, p, ch);
      if (end != null && end >= pos) return [p, end];
    }
  }
  return null;
}

function matchingClose(state: EditorState, open: number, ch: string): number | null {
  const doc = state.doc;
  const want = CLOSE[OPEN.indexOf(ch)]!;
  const max = Math.min(doc.length, open + MAX_SCAN);
  let depth = 0;
  for (let p = open + 1; p < max; p++) {
    const c = doc.sliceString(p, p + 1);
    if (c === ch && inCode(state, p)) depth++;
    else if (c === want && inCode(state, p)) {
      if (depth === 0) return p;
      depth--;
    }
  }
  return null;
}

/** The trimmed top-level elements between `from` and `to`. */
export function listElements(state: EditorState, from: number, to: number): { from: number; to: number }[] {
  const text = state.sliceDoc(from, to);
  const out: { from: number; to: number }[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) out.push({ from: from + start + lead, to: from + start + lead + trimmed.length });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(text.length);
  return out;
}

/** The swap Move Element would make at `pos`, or null when there is no neighbour. */
export function elementSwap(
  state: EditorState,
  pos: number,
  dir: -1 | 1,
): { a: { from: number; to: number }; b: { from: number; to: number }; caret: number } | null {
  // The innermost list with more than one element: in `f(g(x), y)` at `x`, `g(x)` moves.
  let items: { from: number; to: number }[] = [];
  for (let at = pos, depth = 0; items.length < 2; depth++) {
    const list = depth < 16 ? enclosingList(state, at) : null;
    if (!list) return null;
    items = listElements(state, list[0] + 1, list[1]);
    at = list[0];
  }
  // The last element starting at or before the caret (the one before a comma it follows).
  let i = 0;
  items.forEach((it, k) => {
    if (it.from <= pos) i = k;
  });
  const j = i + dir;
  if (j < 0 || j >= items.length) return null;
  const cur = items[i]!;
  const other = items[j]!;
  const offset = Math.max(0, Math.min(pos - cur.from, cur.to - cur.from));
  // Where the moved element starts once both are swapped.
  const start = dir === 1 ? other.to - (cur.to - cur.from) : other.from;
  return { a: cur, b: other, caret: start + offset };
}

function moveElement(dir: -1 | 1): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly || state.selection.ranges.length > 1) return false;
    const swap = elementSwap(state, state.selection.main.head, dir);
    if (!swap) return false;
    const { a, b } = swap;
    view.dispatch({
      changes: [
        { from: a.from, to: a.to, insert: state.sliceDoc(b.from, b.to) },
        { from: b.from, to: b.to, insert: state.sliceDoc(a.from, a.to) },
      ],
      selection: EditorSelection.cursor(swap.caret),
      scrollIntoView: true,
      userEvent: "move.element",
    });
    return true;
  };
}

export const moveElementLeft = moveElement(-1);
export const moveElementRight = moveElement(1);
