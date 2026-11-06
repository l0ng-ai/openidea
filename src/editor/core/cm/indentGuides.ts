/**
 * Indent guides as in IDEA: a 1px line at the indent column of every enclosing
 * block except top-level ones (IDEA draws no guide at column 0). Each line's
 * indentation carries one background strip per guide (one line decoration per
 * visible line, no extra DOM); a strip sits at the same offset on every line,
 * so a guide stays straight across lines of different depth. Blank lines take
 * the smaller level of their neighbours and code lens rows the level of the
 * line they annotate (`guideVars`), so guides stay continuous. With rainbow
 * guides each depth gets its own image, coloured from `--syn-rainbow-*`.
 */
import { Facet, RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { getIndentUnit } from "@codemirror/language";

/** Number of `--openidea-guide-<n>` rainbow colours; deeper guides repeat them. */
export const GUIDE_COLORS = 5;

/** Whether guides are coloured by depth (Settings › Editor › General › Appearance › Rainbow indent guides). */
export const rainbowGuides = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

/**
 * Values of `--openidea-guide-images` / `--openidea-guide-positions` for an
 * indentation `levels` deep (in units of `step` columns), or null when it has
 * no guides. `.cm-openidea-guides` lines and code lens rows turn them into
 * backgrounds (theme.ts).
 */
export function guideVars(levels: number, step: number, rainbow = false): { images: string; positions: string } | null {
  if (levels < 2) return null;
  const images: string[] = [];
  const positions: string[] = [];
  for (let level = 1; level < levels; level++) {
    images.push(rainbow ? `var(--openidea-guide-${((level - 1) % GUIDE_COLORS) + 1})` : "var(--openidea-guide)");
    positions.push(`calc(6px + ${level * step}ch) 0`);
  }
  return { images: images.join(", "), positions: positions.join(", ") };
}

const cache = new Map<string, Decoration | null>();
function guideDeco(levels: number, step: number, rainbow: boolean) {
  const key = `${levels}:${step}:${rainbow ? 1 : 0}`;
  let d = cache.get(key);
  if (d === undefined) {
    const vars = guideVars(levels, step, rainbow);
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

function build(view: EditorView): DecorationSet {
  const state = view.state;
  const step = Math.max(1, getIndentUnit(state));
  const rainbow = state.facet(rainbowGuides);
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
        const deco = guideDeco(levels, step, rainbow);
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
