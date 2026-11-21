import { type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { openideaHighlightStyle } from "./highlight";
import { bracketClass, DEFAULT_BRACKET_COLORS, type BracketMark } from "./rainbowBrackets";

/** Maximum characters rendered for one preview line. */
export const MAX_PREVIEW_LINE_LENGTH = 400;

/**
 * Renders line `lineNo` highlighted into `target`; `brackets` (ascending, as from the
 * rainbow bracket scanner) are wrapped in their rainbow class, outside the token's span
 * as in the editor.
 */
export function renderLineContent(
  state: EditorState,
  lineNo: number,
  target: HTMLElement,
  brackets: readonly BracketMark[] = [],
  colors = DEFAULT_BRACKET_COLORS,
) {
  const line = state.doc.line(lineNo);
  const text = line.text.slice(0, MAX_PREVIEW_LINE_LENGTH);
  const end = line.from + text.length;
  const tree = syntaxTree(state);
  let pos = line.from;
  let next = 0;
  const node = (to: number, cls: string): Node => {
    const s = state.doc.sliceString(pos, to);
    pos = to;
    if (!cls) return document.createTextNode(s);
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = s;
    return span;
  };
  const push = (to: number, cls: string) => {
    while (to > pos) {
      while (next < brackets.length && brackets[next]!.from < pos) next++;
      const bracket = brackets[next];
      if (!bracket || bracket.from >= to) {
        target.appendChild(node(to, cls));
        return;
      }
      if (bracket.from > pos) target.appendChild(node(bracket.from, cls));
      const wrap = document.createElement("span");
      wrap.className = bracketClass(bracket.depth, colors);
      wrap.appendChild(node(bracket.from + 1, cls));
      target.appendChild(wrap);
    }
  };
  if (tree.length >= end) {
    highlightTree(
      tree,
      openideaHighlightStyle,
      (from, to, cls) => {
        push(Math.max(from, pos), "");
        push(Math.min(to, end), cls);
      },
      line.from,
      end,
    );
  }
  push(end, "");
}
