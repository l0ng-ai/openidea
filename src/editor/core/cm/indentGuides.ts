/**
 * Indent guides as in IDEA: a 1px line at the indent column of every enclosing
 * block except top-level ones (IDEA draws no guide at column 0). Each line's
 * indentation carries one background strip per guide (one line decoration per
 * visible line, no extra DOM); a strip sits at the same offset on every line,
 * so a guide stays straight across lines of different depth. Blank lines take
 * the smaller level of their neighbours and code lens rows the level of the
 * line they annotate (`guideVars`), so guides stay continuous. With rainbow
 * guides each depth gets its own image, coloured from `--syn-rainbow-*`. The
 * guide the caret is on takes the selected colour (`caretGuide`).
 */
import { countColumn, Facet, RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { getIndentUnit, matchBrackets } from "@codemirror/language";
import { LINE_INSET } from "./lineInset";

/** How far (px) a guide sits left of its column, so a caret in that column is right of it (IDEA's indent guide shift). */
const GUIDE_SHIFT = 2;

/** Number of `--openidea-guide-<n>` rainbow colours; deeper guides repeat them. */
export const GUIDE_COLORS = 5;

/** Whether guides are coloured by depth (Settings › Editor › General › Appearance › Rainbow indent guides). */
export const rainbowGuides = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

/**
 * Values of `--openidea-guide-images` / `--openidea-guide-positions` for an
 * indentation `levels` deep (in units of `step` columns), or null when it has
 * no guides; the guide at level `active` takes the selected colour, the one at
 * level `brace` the matched brace one. `.cm-openidea-guides` lines and code lens
 * rows turn them into backgrounds (theme.ts).
 */
export function guideVars(
  levels: number,
  step: number,
  rainbow = false,
  active = 0,
  brace = 0,
): { images: string; positions: string } | null {
  if (levels < 2) return null;
  const images: string[] = [];
  const positions: string[] = [];
  for (let level = 1; level < levels; level++) {
    images.push(
      level === brace
        ? "var(--openidea-guide-brace)"
        : level === active
          ? "var(--openidea-guide-active)"
          : rainbow
            ? `var(--openidea-guide-${((level - 1) % GUIDE_COLORS) + 1})`
            : "var(--openidea-guide)",
    );
    positions.push(`calc(${LINE_INSET - GUIDE_SHIFT}px + ${level * step}ch) 0`);
  }
  return { images: images.join(", "), positions: positions.join(", ") };
}

const cache = new Map<string, Decoration | null>();
function guideDeco(levels: number, step: number, rainbow: boolean, active: number, brace: number) {
  const key = `${levels}:${step}:${rainbow ? 1 : 0}:${active}:${brace}`;
  let d = cache.get(key);
  if (d === undefined) {
    const vars = guideVars(levels, step, rainbow, active, brace);
    const style = vars && `--openidea-guide-images: ${vars.images}; --openidea-guide-positions: ${vars.positions}`;
    d = style ? Decoration.line({ attributes: { class: "cm-openidea-guides", style } }) : null;
    cache.set(key, d);
  }
  return d;
}

function indentColumns(text: string, tabSize: number): number | null {
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 32) col++;
    else if (ch === 9) col += tabSize - (col % tabSize);
    else return col;
  }
  return null; // blank
}

const LOOKAROUND = 200;

function levelOf(state: EditorState, lineNo: number, step: number, dir: 1 | -1): number {
  const doc = state.doc;
  for (let n = lineNo, i = 0; n >= 1 && n <= doc.lines && i < LOOKAROUND; n += dir, i++) {
    const cols = indentColumns(doc.line(n).text, state.tabSize);
    if (cols !== null) return Math.floor(cols / step);
  }
  return 0;
}

const BLOCK_SCAN = 10_000;

/** A guide: its level (in indent units) and the lines (`from`..`to`) it is drawn on. */
export interface Guide {
  level: number;
  from: number;
  to: number;
}

/** The guide line `start` opens at column `col` (its indentation): down to the last deeper line. */
function blockGuide(state: EditorState, start: number, col: number, step: number): Guide | null {
  if (col === 0 || col % step) return null;
  let end = start;
  for (let n = start + 1; n <= state.doc.lines && n - start < BLOCK_SCAN; n++) {
    const cols = indentColumns(state.doc.line(n).text, state.tabSize);
    if (cols === null) continue;
    if (cols <= col) break;
    end = n;
  }
  return end === start ? null : { level: col / step, from: start + 1, to: end };
}

/**
 * The guide the caret is on, as IDEA's `IndentsModel.getCaretIndentGuide`: the caret's
 * column is the guide's and its line lies in the guide's block, from the line opening it
 * to the last deeper one.
 */
export function caretGuide(state: EditorState, step: number): Guide | null {
  const head = state.selection.main.head;
  const caretLine = state.doc.lineAt(head);
  const col = countColumn(caretLine.text.slice(0, head - caretLine.from), state.tabSize);
  if (col === 0 || col % step) return null;
  let start = caretLine.number;
  for (let i = 0; ; start--, i++) {
    if (start < 1 || i > BLOCK_SCAN) return null;
    const cols = indentColumns(state.doc.line(start).text, state.tabSize);
    if (cols === null || cols > col) continue;
    if (cols !== col) return null;
    break;
  }
  const guide = blockGuide(state, start, col, step);
  return guide && caretLine.number <= guide.to ? guide : null;
}

/**
 * The guide of the block whose braces the caret is at, while they match on different lines:
 * IDEA draws it in the matched brace colour (`MATCHED_BRACES_INDENT_GUIDE_COLOR`).
 */
export function braceGuide(state: EditorState, step: number): Guide | null {
  const head = state.selection.main.head;
  const match =
    matchBrackets(state, head, -1) ??
    (head > 0 ? matchBrackets(state, head - 1, 1) : null) ??
    matchBrackets(state, head, 1) ??
    (head < state.doc.length ? matchBrackets(state, head + 1, -1) : null);
  if (!match?.matched || !match.end) return null;
  const open = Math.min(match.start.from, match.end.from);
  if (state.sliceDoc(open, open + 1) !== "{") return null;
  const openLine = state.doc.lineAt(open);
  if (openLine.number === state.doc.lineAt(Math.max(match.start.from, match.end.from)).number) return null;
  const col = indentColumns(openLine.text, state.tabSize) ?? 0;
  return blockGuide(state, openLine.number, col, step);
}

function build(view: EditorView): DecorationSet {
  const state = view.state;
  const step = Math.max(1, getIndentUnit(state));
  const rainbow = state.facet(rainbowGuides);
  const caret = caretGuide(state, step);
  const brace = braceGuide(state, step);
  const on = (g: Guide | null, n: number) => (g && n >= g.from && n <= g.to ? g.level : 0);
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (line.length < 10_000) {
        const cols = indentColumns(line.text, state.tabSize);
        let levels: number;
        if (cols === null) {
          levels = Math.min(levelOf(state, line.number - 1, step, -1), levelOf(state, line.number + 1, step, 1));
        } else {
          levels = Math.floor(cols / step);
        }
        const deco = guideDeco(levels, step, rainbow, on(caret, line.number), on(brace, line.number));
        if (deco) b.add(line.from, line.from, deco);
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}

export const indentGuides: Extension = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.selectionSet ||
          u.viewportChanged ||
          u.startState.tabSize !== u.state.tabSize ||
          u.startState.facet(rainbowGuides) !== u.state.facet(rainbowGuides)
        )
          this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
  // Lets code lens rows draw the guides too, only while guides are on.
  EditorView.contentAttributes.of({ class: "cm-openidea-guidesOn" }),
];

/** Indent guides coloured by depth; shares the plugin with `indentGuides`, so toggling only redraws. */
export const rainbowIndentGuides: Extension = [indentGuides, rainbowGuides.of(true)];
