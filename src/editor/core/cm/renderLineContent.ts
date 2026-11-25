import { Facet, type EditorState, type Text } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { highlightTree } from "@lezer/highlight";
import { openideaHighlightStyle } from "./highlight";
import { bracketClass, DEFAULT_BRACKET_COLORS, type BracketMark } from "./rainbowBrackets";

/** Maximum characters rendered for one preview line. */
export const MAX_PREVIEW_LINE_LENGTH = 400;

/**
 * Mark decorations a line preview (sticky lines, fold and scope previews) paints over the syntax
 * colours, as the editor does: semantic highlighting registers its marks here.
 */
export const previewHighlights = Facet.define<(state: EditorState) => DecorationSet>();

/** A class over `from..to`, painted inside the syntax token spans. */
export interface ClassMark {
  from: number;
  to: number;
  cls: string;
}

/** The decoration sets of the {@link previewHighlights} sources (compare them to see a change). */
export function previewHighlightSets(state: EditorState): DecorationSet[] {
  return state.facet(previewHighlights).map((source) => source(state));
}

/** The classed marks of the {@link previewHighlights} sources within `from..to`. */
export function previewMarks(state: EditorState, from: number, to: number): ClassMark[] {
  const out: ClassMark[] = [];
  for (const set of previewHighlightSets(state))
    set.between(from, to, (f, t, deco) => {
      const cls = deco.spec.class as string | undefined;
      if (cls && t > from && f < to) out.push({ from: Math.max(f, from), to: Math.min(t, to), cls });
    });
  return out;
}

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
  const end = Math.min(line.to, line.from + MAX_PREVIEW_LINE_LENGTH);
  renderSyntaxRange(
    state.doc,
    syntaxTree(state),
    line.from,
    end,
    target,
    brackets,
    colors,
    previewMarks(state, line.from, end),
  );
}

export function renderSyntaxRange(
  doc: Text,
  tree: Tree,
  start: number,
  end: number,
  target: ParentNode,
  brackets: readonly BracketMark[] = [],
  colors = DEFAULT_BRACKET_COLORS,
  marks: readonly ClassMark[] = [],
) {
  let pos = start;
  let next = 0;
  const span = (cls: string, child: Node) => {
    const el = document.createElement("span");
    el.className = cls;
    el.appendChild(child);
    return el;
  };
  // The text up to `to`, in the syntax class with the marks covering it inside, as the editor nests them.
  const node = (to: number, cls: string): Node => {
    let out: Node = document.createTextNode(doc.sliceString(pos, to));
    for (const m of marks) if (m.from <= pos && m.to >= to) out = span(m.cls, out);
    pos = to;
    return cls ? span(cls, out) : out;
  };
  // Ends text runs where a mark starts or ends, so each run has one set of marks.
  const markStop = (to: number) => {
    let stop = to;
    for (const m of marks) {
      if (m.from > pos && m.from < stop) stop = m.from;
      if (m.to > pos && m.to < stop) stop = m.to;
    }
    return stop;
  };
  const push = (to: number, cls: string) => {
    while (to > pos) {
      while (next < brackets.length && brackets[next]!.from < pos) next++;
      const bracket = brackets[next];
      if (!bracket || bracket.from >= to) {
        target.appendChild(node(markStop(to), cls));
        continue;
      }
      if (bracket.from > pos) {
        target.appendChild(node(markStop(bracket.from), cls));
        continue;
      }
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
      start,
      end,
    );
  }
  push(end, "");
}
