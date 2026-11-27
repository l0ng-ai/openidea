/**
 * Indent guides as in IDEA: a 1px line at the indent column of every enclosing
 * block except top-level ones (IDEA draws no guide at column 0). Each line's
 * indentation carries one background strip per guide (one line decoration per
 * visible line, no extra DOM); a strip sits at the same offset on every line,
 * so a guide stays straight across lines of different depth. Blank lines take
 * the smaller level of their neighbours and code lens rows the level of the
 * line they annotate (`guideVars`), so guides stay continuous. With rainbow
 * guides each depth gets its own image, coloured from `--syn-rainbow-*`. The
 * guide the caret is on takes the selected colour (`caretGuide`). A column is
 * the editor font's space width (`--openidea-space`, measured), not `ch`: in a
 * proportional font a space is narrower than "0", and guides would drift into the code.
 *
 * With rainbow brackets on too, a rainbow guide whose block opens with a bracket left
 * open at the end of the opening line (`foo(`, `} else {`) takes that bracket's colour
 * (`--syn-bracket-*`), so a guide and its delimiters agree; blocks without one (Python,
 * YAML) keep the depth colour. Code lens rows above a line repeat that line's guides.
 */
import { countColumn, Facet, RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { getIndentUnit, matchBrackets, syntaxTree } from "@codemirror/language";
import { LINE_INSET } from "./lineInset";
import { SPACE, spaceWidth } from "./spaceWidth";
import { BRACKET_COLORS, LONG_LINE, bracketScanner, type BracketScanner } from "./rainbowBrackets";

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
 * level `brace` the matched brace one. With `rainbow`, `brackets[level]` is the
 * bracket colour of the block a guide belongs to (its depth within the rainbow
 * bracket palette), if any.
 * `.cm-openidea-guides` lines and code lens rows turn them into backgrounds (theme.ts).
 */
export function guideVars(
  levels: number,
  step: number,
  rainbow = false,
  active = 0,
  brace = 0,
  brackets: readonly (number | undefined)[] = [],
): { images: string; positions: string } | null {
  if (levels < 2) return null;
  const images: string[] = [];
  const positions: string[] = [];
  for (let level = 1; level < levels; level++) {
    const bracket = brackets[level];
    images.push(
      level === brace
        ? "var(--openidea-guide-brace)"
        : level === active
          ? "var(--openidea-guide-active)"
          : !rainbow
            ? "var(--openidea-guide)"
            : bracket !== undefined
              ? `var(--openidea-guide-bracket-${(bracket % BRACKET_COLORS) + 1})`
              : `var(--openidea-guide-${((level - 1) % GUIDE_COLORS) + 1})`,
    );
    positions.push(`calc(${LINE_INSET - GUIDE_SHIFT}px + ${level * step} * ${SPACE}) 0`);
  }
  return { images: images.join(", "), positions: positions.join(", ") };
}

interface GuideDeco {
  deco: Decoration;
  vars: { images: string; positions: string };
}

const cache = new Map<string, GuideDeco | null>();
function guideDeco(
  levels: number,
  step: number,
  rainbow: boolean,
  active: number,
  brace: number,
  brackets: readonly (number | undefined)[],
): GuideDeco | null {
  let key = `${levels}:${step}:${rainbow ? 1 : 0}:${active}:${brace}`;
  if (rainbow)
    for (let level = 1; level < Math.min(levels, brackets.length); level++) key += `:${brackets[level] ?? ""}`;
  let d = cache.get(key);
  if (d === undefined) {
    const vars = guideVars(levels, step, rainbow, active, brace, brackets);
    const style = vars && `--openidea-guide-images: ${vars.images}; --openidea-guide-positions: ${vars.positions}`;
    d = vars && style ? { deco: Decoration.line({ attributes: { class: "cm-openidea-guides", style } }), vars } : null;
    if (cache.size > 10_000) cache.clear();
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

/**
 * Bracket colour (depth within the palette) per guide level on each of the lines `first`..`last` (index `n - first`).
 * The guide at `level` belongs to the block opened by the nearest line above indented
 * exactly `level` units (none when the nearest line indented at most that much is indented
 * less, as for `blockGuide`); its depth is that of the bracket the opening line leaves open
 * at its end, if any. Openers above `first` are found by walking up, so the colours do not
 * depend on where the viewport starts.
 */
export function bracketGuideDepths(
  state: EditorState,
  scanner: Pick<BracketScanner, "openAt" | "colors">,
  step: number,
  first: number,
  last: number,
): (number | undefined)[][] {
  const doc = state.doc;
  const tab = state.tabSize;
  const indentOf = (n: number) => {
    // Checks the length first: `text` of a minified line would copy all of it.
    const line = doc.line(n);
    return line.length >= LONG_LINE ? null : indentColumns(line.text, tab);
  };
  /** Opener line number per level (0 or unset: none). */
  const openers: number[] = [];
  let minSeen = Infinity;
  for (let n = first; n <= last && minSeen === Infinity; n++) minSeen = indentOf(n) ?? Infinity;
  for (let n = first - 1, i = 0; n >= 1 && minSeen > step && i < BLOCK_SCAN; n--, i++) {
    const cols = indentOf(n);
    if (cols === null || cols >= minSeen) continue;
    // A blank-only range only needs the levels of the first line above it.
    const below = minSeen === Infinity ? cols + 1 : minSeen;
    for (let level = Math.max(1, Math.ceil(cols / step)); level * step < below; level++)
      openers[level] = cols === level * step ? n : 0;
    minSeen = cols;
  }
  const candidates = new Set(openers.filter((n) => n > 0));
  for (let n = first; n <= last; n++) {
    const cols = indentOf(n);
    if (cols && cols % step === 0) candidates.add(n);
  }
  const lines = [...candidates].sort((a, b) => a - b);
  const open = scanner.openAt(
    state,
    lines.map((n) => doc.line(n).to),
  );
  const depthOf = new Map<number, number>();
  lines.forEach((n, i) => {
    const bracket = open[i];
    if (bracket && bracket.from >= doc.line(n).from) depthOf.set(n, bracket.depth % scanner.colors);
  });
  const out: (number | undefined)[][] = [];
  let current: (number | undefined)[] = [];
  let dirty = true;
  for (let n = first; n <= last; n++) {
    if (dirty) {
      current = openers.map((o) => (o ? depthOf.get(o) : undefined));
      dirty = false;
    }
    out.push(current);
    const cols = indentOf(n);
    if (cols === null) continue;
    const level = Math.ceil(cols / step);
    if (openers.length > level) openers.length = level;
    if (cols && cols % step === 0) openers[level] = n;
    dirty = true;
  }
  return out;
}

interface BracketCache {
  doc: EditorState["doc"];
  tree: ReturnType<typeof syntaxTree>;
  step: number;
  first: number;
  last: number;
  depths: (number | undefined)[][];
}

function build(
  view: EditorView,
  scanner: BracketScanner | null,
  brackets: BracketCache[],
  lineVars: Map<number, { images: string; positions: string }>,
): DecorationSet {
  const state = view.state;
  const step = Math.max(1, getIndentUnit(state));
  const rainbow = state.facet(rainbowGuides);
  const caret = caretGuide(state, step);
  const brace = braceGuide(state, step);
  const on = (g: Guide | null, n: number) => (g && n >= g.from && n <= g.to ? g.level : 0);
  const b = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(state);
  const previous = brackets.splice(0);
  lineVars.clear();
  for (const { from, to } of view.visibleRanges) {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    let depths: (number | undefined)[][] | null = null;
    if (rainbow && scanner) {
      // Moving the caret reuses the colours; edits, scrolling and reparses recompute them.
      const hit = previous.find(
        (c) => c.doc === state.doc && c.tree === tree && c.step === step && c.first === first && c.last === last,
      );
      depths = hit?.depths ?? bracketGuideDepths(state, scanner, step, first, last);
      brackets.push({ doc: state.doc, tree, step, first, last, depths });
    }
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (line.length < LONG_LINE) {
        const cols = indentColumns(line.text, state.tabSize);
        let levels: number;
        if (cols === null) {
          levels = Math.min(levelOf(state, line.number - 1, step, -1), levelOf(state, line.number + 1, step, 1));
        } else {
          levels = Math.floor(cols / step);
        }
        const deco = guideDeco(
          levels,
          step,
          rainbow,
          on(caret, line.number),
          on(brace, line.number),
          depths?.[line.number - first] ?? [],
        );
        if (deco) {
          b.add(line.from, line.from, deco.deco);
          lineVars.set(line.from, deco.vars);
        }
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}

export const indentGuides: Extension = [
  spaceWidth,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private brackets: BracketCache[] = [];
      /** Guide variables of each decorated line, by its start: code lens rows above it repeat them. */
      private lineVars = new Map<number, { images: string; positions: string }>();
      private scanner: BracketScanner | null;
      constructor(readonly view: EditorView) {
        const scanner = bracketScanner(view);
        this.scanner = scanner;
        this.decorations = build(view, scanner, this.brackets, this.lineVars);
        this.syncLenses();
      }
      /** Gives code lens rows the guides of the line they annotate, once they are in the DOM. */
      syncLenses() {
        this.view.requestMeasure({
          key: this.lineVars,
          read: (view) =>
            Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-openidea-lens"), (el) => {
              const pos = view.posAtDOM(el);
              return { el, vars: this.lineVars.get(view.state.doc.lineAt(pos).from) };
            }),
          write: (rows) => {
            for (const { el, vars } of rows) {
              if (vars) {
                el.style.setProperty("--openidea-guide-images", vars.images);
                el.style.setProperty("--openidea-guide-positions", vars.positions);
              } else {
                el.style.removeProperty("--openidea-guide-images");
                el.style.removeProperty("--openidea-guide-positions");
              }
            }
          },
        });
      }
      destroy() {
        for (const el of this.view.contentDOM.querySelectorAll<HTMLElement>(".cm-openidea-lens")) {
          el.style.removeProperty("--openidea-guide-images");
          el.style.removeProperty("--openidea-guide-positions");
        }
      }
      update(u: ViewUpdate) {
        const scanner = bracketScanner(u.view);
        // A new scanner (rainbow brackets toggled or reconfigured) may colour blocks differently.
        const bracketsChanged = scanner !== this.scanner;
        if (bracketsChanged) this.brackets.length = 0;
        this.scanner = scanner;
        const rainbow = u.state.facet(rainbowGuides);
        if (
          u.docChanged ||
          u.selectionSet ||
          u.viewportChanged ||
          bracketsChanged ||
          u.startState.tabSize !== u.state.tabSize ||
          u.startState.facet(rainbowGuides) !== rainbow ||
          (rainbow && scanner && syntaxTree(u.startState) !== syntaxTree(u.state))
        )
          this.decorations = build(u.view, scanner, this.brackets, this.lineVars);
        // Lens rows change with transactions (new lenses) and scrolling (new rows rendered).
        if (u.transactions.length || u.viewportChanged) this.syncLenses();
      }
    },
    { decorations: (v) => v.decorations },
  ),
  // Lets code lens rows draw the guides too, only while guides are on.
  EditorView.contentAttributes.of({ class: "cm-openidea-guidesOn" }),
];

/** Indent guides coloured by depth; shares the plugin with `indentGuides`, so toggling only redraws. */
export const rainbowIndentGuides: Extension = [indentGuides, rainbowGuides.of(true)];
