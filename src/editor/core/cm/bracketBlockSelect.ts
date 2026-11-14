/**
 * A double-click that puts the caret next to a curly brace selects the block it opens or
 * closes, both braces included, as IDEA does: past the end of a line ending in `{` too.
 * A double-click on a word still selects the word.
 */
import { matchBrackets } from "@codemirror/language";
import { EditorSelection, Prec, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** The range from the brace at `at` to its match, both included, or null when it has none. */
export function braceBlock(state: EditorState, at: number): { from: number; to: number } | null {
  const ch = state.sliceDoc(at, at + 1);
  if (ch !== "{" && ch !== "}") return null;
  const match = ch === "{" ? matchBrackets(state, at, 1) : matchBrackets(state, at + 1, -1);
  if (!match?.matched || !match.end) return null;
  return { from: Math.min(match.start.from, match.end.from), to: Math.max(match.start.to, match.end.to) };
}

const isBrace = (ch: string) => ch === "{" || ch === "}";

/**
 * The brace next to the caret position `pos` a click at `x` gives, unless the click is on a
 * word character (that double-click selects the word).
 */
export function braceNextTo(state: EditorState, pos: number, onWord: boolean): number | null {
  if (onWord) return null;
  if (pos > 0 && isBrace(state.sliceDoc(pos - 1, pos))) return pos - 1;
  if (isBrace(state.sliceDoc(pos, pos + 1))) return pos;
  return null;
}

/** Whether the click at `x` is on a word character around `pos`. */
function clickOnWord(view: EditorView, pos: number, x: number): boolean {
  for (const at of [pos - 1, pos]) {
    if (at < 0 || at >= view.state.doc.length) continue;
    const box = view.coordsForChar(at);
    if (box && x >= box.left && x <= box.right) return /[\p{L}\p{N}_$]/u.test(view.state.sliceDoc(at, at + 1));
  }
  return false;
}

export const bracketBlockSelect = Prec.high(
  EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.detail !== 2 || event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
      return null;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const at = pos == null ? null : braceNextTo(view.state, pos, clickOnWord(view, pos, event.clientX));
    const block = at == null ? null : braceBlock(view.state, at);
    if (!block) return null;
    const selection = EditorSelection.single(block.from, block.to);
    return { get: () => selection, update: () => false };
  }),
);
