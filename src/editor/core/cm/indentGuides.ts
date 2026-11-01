/**
 * Indent guides drawn as a repeating background on each line's indentation
 * (cheap: one line decoration per visible line, no extra DOM). Blank lines
 * inherit the smaller level of their neighbours so guides stay continuous.
 */
import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { getIndentUnit } from "@codemirror/language";

const cache = new Map<string, Decoration>();
function guideDeco(levels: number, step: number) {
  const key = `${levels}:${step}`;
  let d = cache.get(key);
  if (!d) {
    d = Decoration.line({
      attributes: {
        class: "cm-openidea-guides",
        style: `--openidea-guide-levels: ${levels}; --openidea-guide-step: ${step}`,
      },
    });
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
        if (levels > 0) b.add(line.from, line.from, guideDeco(levels, step));
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}

export const indentGuides: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.startState.tabSize !== u.state.tabSize)
        this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
