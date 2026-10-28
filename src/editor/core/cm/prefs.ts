/**
 * Editor behaviour driven by Settings › Editor (General, Appearance, Smart
 * Keys, Code Editing, Code Style). Everything here is rebuilt into the
 * `prefs` compartment when settings change.
 */
import {
  EditorSelection,
  EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  drawSelection,
  keymap,
  scrollPastEnd,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import { getIndentUnit, getIndentation, indentRange, indentString, indentUnit, syntaxTree } from "@codemirror/language";
import {
  cursorLineStart,
  deleteCharBackwardStrict,
  insertNewlineKeepIndent,
  selectLineStart,
} from "@codemirror/commands";
import type { EditorExtras } from "@/platform/editorSettings";
import { openideaHighlightStyle } from "./highlight";
import {
  cursorHumpLeft,
  cursorHumpRight,
  deleteHumpBackward,
  deleteHumpForward,
  deleteWordBackward,
  selectHumpLeft,
  selectHumpRight,
} from "./editing";
import { enterInLineComment, lineCommentStyle, type LineCommentStyle } from "./comments";
import { skipClosingQuote, smartBackspace, smartBackspaceApplies, tabOut } from "./smartKeys";

// --- soft wraps ---------------------------------------------------------------

/** `*.md; *.txt` style patterns matched against the file name (`*` alone matches everything). */
export function matchesFilePatterns(patterns: string, path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return patterns
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => {
      const re = new RegExp(
        `^${p
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")}$`,
        "i",
      );
      return re.test(name);
    });
}

export function softWrapActive(softWrap: boolean | undefined, prefs: EditorExtras, path: string): boolean {
  return !!softWrap && matchesFilePatterns(prefs.general.softWrapFiles || "*", path);
}

const wrapIndentCache = new Map<number, Decoration>();
function wrapIndentDeco(cols: number) {
  let d = wrapIndentCache.get(cols);
  if (!d) {
    d = Decoration.line({ attributes: { style: `padding-left: calc(6px + ${cols}ch); text-indent: -${cols}ch` } });
    wrapIndentCache.set(cols, d);
  }
  return d;
}

/** "Use original line's indent for wrapped parts": a hanging indent per visible line. */
const wrapIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      const tab = view.state.tabSize;
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to;) {
          const line = view.state.doc.lineAt(pos);
          let cols = 0;
          for (let i = 0; i < line.length; i++) {
            const ch = line.text.charCodeAt(i);
            if (ch === 32) cols++;
            else if (ch === 9) cols += tab - (cols % tab);
            else break;
          }
          if (cols > 0 && cols < line.length + tab) b.add(line.from, line.from, wrapIndentDeco(cols));
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

// --- whitespace ---------------------------------------------------------------

const spaceMark = Decoration.mark({ class: "cm-highlightSpace" });
const tabMark = Decoration.mark({ class: "cm-highlightTab" });

/** Show whitespaces with IDEA's Leading / Inner / Trailing filters. */
export function whitespaceMarks(o: { leading: boolean; inner: boolean; trailing: boolean }): Extension {
  const decorator = new MatchDecorator({
    regexp: /[ \t]/g,
    decorate: (add, from, to, match, view) => {
      const line = view.state.doc.lineAt(from);
      const col = from - line.from;
      const lead = line.text.length - line.text.trimStart().length;
      const trail = line.text.trimEnd().length;
      const kind = col < lead ? "leading" : col >= trail ? "trailing" : "inner";
      // Whitespace-only lines count as leading.
      if (lead === line.length ? !o.leading && !o.trailing : !o[kind]) return;
      add(from, to, match[0] === "\t" ? tabMark : spaceMark);
    },
  });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = decorator.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// --- right margin / visual guides --------------------------------------------

/** Vertical lines at the hard-wrap column and the visual guides (`ch` columns of the mono font). */
export function marginGuides(columns: readonly number[]): Extension {
  const cols = [...new Set(columns.filter((c) => c > 0 && c < 1000))].sort((a, b) => a - b);
  if (!cols.length) return [];
  const image = cols
    .map(
      (c) =>
        `linear-gradient(to right, transparent calc(6px + ${c}ch), var(--border-right-margin, var(--border)) calc(6px + ${c}ch), var(--border-right-margin, var(--border)) calc(7px + ${c}ch), transparent calc(7px + ${c}ch))`,
    )
    .join(", ");
  return EditorView.contentAttributes.of({ style: `background-image: ${image}` });
}

// --- method separators --------------------------------------------------------

/** Lines (0-based) that start a function / method, from the document outline. */
export const setMethodLines = StateEffect.define<number[]>();

const separatorDeco = Decoration.line({ class: "cm-openidea-methodSeparator" });

const methodLines = StateField.define<number[]>({
  create: () => [],
  update(lines, tr) {
    for (const e of tr.effects) if (e.is(setMethodLines)) return e.value;
    if (!tr.docChanged || !lines.length) return lines;
    const oldDoc = tr.startState.doc;
    return lines
      .filter((l) => l + 1 <= oldDoc.lines)
      .map((l) => tr.state.doc.lineAt(tr.changes.mapPos(oldDoc.line(l + 1).from, 1)).number - 1);
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state) => {
      const b = new RangeSetBuilder<Decoration>();
      for (const l of [...new Set(state.field(f))].sort((a, c) => a - c))
        if (l > 0 && l + 1 <= state.doc.lines) {
          const line = state.doc.line(l + 1);
          b.add(line.from, line.from, separatorDeco);
        }
      return b.finish();
    }),
});

/** Kept in every editor so outline refreshes can always deliver separators. */
export const methodLinesField = methodLines;

// --- paste --------------------------------------------------------------------

function leadingColumns(text: string, tabSize: number): number {
  let col = 0;
  for (const ch of text) {
    if (ch === " ") col++;
    else if (ch === "\t") col += tabSize - (col % tabSize);
    else break;
  }
  return col;
}

/** Reformat on paste › Indent Block: re-indents a pasted block to the caret's indentation. */
export function indentPastedText(
  text: string,
  targetCol: number,
  unit: string,
  tabSize: number,
  unitCols = tabSize,
): string {
  const lines = text.split("\n");
  if (lines.length < 2) return text;
  const rest = lines.slice(1).filter((l) => l.trim());
  if (!rest.length) return text;
  // A first line copied with its indentation defines the block's base; one copied from
  // mid-line does not, so the following lines do.
  const firstIndented = /^[ \t]/.test(lines[0]!);
  let base = Math.min(...(firstIndented ? [lines[0]!, ...rest] : rest).map((l) => leadingColumns(l, tabSize)));
  // A block opener copied from mid-line ("if x:", "fn f() {") sat one level above its body.
  if (!firstIndented && base > 0 && /[:{([]\s*$/.test(lines[0]!)) base = Math.max(0, base - unitCols);
  const delta = targetCol - base;
  const pad = (n: number) =>
    unit === "\t" ? "\t".repeat(Math.floor(n / tabSize)) + " ".repeat(n % tabSize) : " ".repeat(n);
  return lines
    .map((l, i) => {
      if (i === 0) return l.trimStart();
      if (!l.trim()) return "";
      return pad(Math.max(0, leadingColumns(l, tabSize) + delta)) + l.trimStart();
    })
    .join("\n");
}

/**
 * Reformat on paste. `indentBlock` shifts the pasted block to the paste
 * column; `indentEachLine` (IDEA's default) then gives each pasted line the
 * language's indentation, where the language can compute one. A paste
 * after nothing but whitespace starts at the line's proper indentation.
 */
export function pasteReindentFilter(mode: "indentBlock" | "indentEachLine") {
  return EditorState.transactionFilter.of((tr: Transaction) => {
    if (!tr.isUserEvent("input.paste") || !tr.docChanged) return tr;
    const start = tr.startState;
    const changes: Array<{ from: number; to: number; text: string }> = [];
    tr.changes.iterChanges((from, to, _fb, _tb, inserted) => changes.push({ from, to, text: inserted.toString() }));
    if (changes.length !== 1) return tr;
    let { from } = changes[0]!;
    const { to, text } = changes[0]!;
    if (!text.trim()) return tr;
    const line = start.doc.lineAt(from);
    const before = start.doc.sliceString(line.from, from);
    const atIndent = /^\s*$/.test(before);
    const tabSize = start.tabSize;
    const unitCols = getIndentUnit(start) || tabSize;
    const useTabs = start.facet(indentUnit)[0] === "\t";
    let targetCol = leadingColumns(atIndent ? before : line.text, tabSize);
    let prefix = "";
    if (atIndent) {
      const proper = getIndentation(start, line.from);
      if (proper !== null && proper !== targetCol) {
        targetCol = proper;
        prefix = indentString(start, proper);
        from = line.from;
      }
    }
    const block = indentPastedText(text, targetCol, useTabs ? "\t" : " ", tabSize, unitCols);
    const out = prefix + (prefix ? block.trimStart() : block);
    const first: TransactionSpec = {
      changes: { from, to, insert: out },
      selection: EditorSelection.cursor(from + out.length),
      userEvent: "input.paste",
      scrollIntoView: true,
    };
    if (mode !== "indentEachLine") return out === text && from === changes[0]!.from ? tr : first;
    // Lines whose start lies in the pasted text, plus the paste line when it was pasted at its indentation.
    const pasted = start.update({ ...first, filter: false }).state;
    const end = from + out.length;
    const firstLine = pasted.doc.lineAt(from);
    const lineStart = atIndent ? firstLine.from : firstLine.to + 1;
    const lastLine = pasted.doc.lineAt(end);
    const lineEnd = lastLine.from === end && end > from ? end - 1 : end;
    if (lineStart > lineEnd) return first;
    const reindent = indentRange(pasted, lineStart, lineEnd);
    if (reindent.empty) return first;
    return [first, { changes: reindent, selection: EditorSelection.cursor(reindent.mapPos(end, 1)), sequential: true }];
  });
}

// --- rich-text copy -----------------------------------------------------------

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** HTML of `[from, to)` with the editor's syntax colours inlined (Copy as rich text). */
export function richTextHtml(view: EditorView, from: number, to: number): string {
  const state = view.state;
  const styleOf = new Map<string, string>();
  const probe = document.createElement("span");
  view.contentDOM.appendChild(probe);
  // Bold = heavier than the editor's main weight (Typography Settings).
  const regular = Number(getComputedStyle(view.contentDOM).fontWeight) || 400;
  const resolve = (cls: string) => {
    let s = styleOf.get(cls);
    if (s === undefined) {
      probe.className = cls;
      const cs = getComputedStyle(probe);
      s = `color:${cs.color};${cs.fontStyle !== "normal" ? `font-style:${cs.fontStyle};` : ""}${Number(cs.fontWeight) > regular ? "font-weight:bold;" : ""}`;
      styleOf.set(cls, s);
    }
    return s;
  };
  let html = "";
  let pos = from;
  try {
    highlightTree(
      syntaxTree(state),
      openideaHighlightStyle,
      (a, b, cls) => {
        const s = Math.max(a, from);
        const e = Math.min(b, to);
        if (e <= s) return;
        if (s > pos) html += escapeHtml(state.sliceDoc(pos, s));
        html += `<span style="${resolve(cls)}">${escapeHtml(state.sliceDoc(s, e))}</span>`;
        pos = e;
      },
      from,
      to,
    );
  } finally {
    probe.remove();
  }
  if (pos < to) html += escapeHtml(state.sliceDoc(pos, to));
  const cs = getComputedStyle(view.contentDOM);
  const bg = getComputedStyle(view.dom).backgroundColor;
  return `<pre style="font-family:${cs.fontFamily.replace(/"/g, "'")};font-size:${cs.fontSize};color:${cs.color};background:${bg}">${html}</pre>`;
}

const richCopy = EditorView.domEventHandlers({
  copy(e, view) {
    const sel = view.state.selection;
    if (sel.ranges.length !== 1 || sel.main.empty || !e.clipboardData) return false;
    const { from, to } = sel.main;
    try {
      const html = richTextHtml(view, from, to);
      e.clipboardData.clearData();
      e.clipboardData.setData("text/plain", view.state.sliceDoc(from, to));
      e.clipboardData.setData("text/html", html);
      e.preventDefault();
      return true;
    } catch {
      return false;
    }
  },
});

// --- caret / scrolling / mouse ----------------------------------------------

/** Font zoom of one editor (⌘ + wheel), in px relative to the configured size. */
export const setFontZoom = StateEffect.define<number>();
export const fontZoom = StateField.define<number>({
  create: () => 0,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setFontZoom) ? e.value : acc), v),
  // Highest precedence: its style comes after the configured font size, which it scales.
  provide: (f) =>
    Prec.highest(
      EditorView.editorAttributes.compute([f], (s) => {
        const z = s.field(f);
        const attrs: Record<string, string> = {};
        if (z)
          attrs.style = `--openidea-editor-font-size: calc(var(--openidea-editor-base-size, var(--fs-code)) + ${z}px); --openidea-editor-line-height: calc(var(--openidea-editor-base-line, var(--lh-code)) + ${Math.round(z * 1.6)}px)`;
        return attrs;
      }),
    ),
});

/** Steps an editor's font zoom by `delta` px, kept within -6..36. */
export function stepFontZoom(view: EditorView, delta: number): void {
  const z = view.state.field(fontZoom, false);
  if (z === undefined) return;
  const next = Math.max(-6, Math.min(36, z + delta));
  if (next !== z) view.dispatch({ effects: setFontZoom.of(next) });
}

const wheelZoom = EditorView.domEventHandlers({
  wheel(e, view) {
    if (!e.metaKey && !e.ctrlKey) return false;
    e.preventDefault();
    stepFontZoom(view, e.deltaY < 0 ? 1 : -1);
    return true;
  },
});

const noTextDrag = EditorView.domEventHandlers({
  dragstart(e, view) {
    if (!view.contentDOM.contains(e.target as Node)) return false;
    e.preventDefault();
    return true;
  },
});

/** "Prefer scrolling editor canvas to keep caret line centered". */
const centerCaret = EditorState.transactionExtender.of((tr) => {
  if (!tr.selection || tr.docChanged || tr.isUserEvent("select.pointer") || !tr.isUserEvent("select")) return null;
  return { effects: EditorView.scrollIntoView(tr.newSelection.main.head, { y: "center" }) };
});

// --- smart keys ----------------------------------------------------------------

const OPENERS: Record<string, true> = { "(": true, "[": true, "{": true, '"': true, "'": true, "`": true };

/** Typing a bracket / quote over a selection replaces it instead of wrapping it. */
const noSurround = EditorView.inputHandler.of((view, from, to, text) => {
  if (!OPENERS[text] || from === to || view.state.selection.ranges.length !== 1) return false;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + 1),
    userEvent: "input.type",
  });
  return true;
});

/** Gutter icon groups of Settings › Editor › General › Gutter Icons (stable gutter classes). */
export const GUTTER_ICON_GROUPS = [
  { id: "run", gutterClass: "cm-openidea-gutter-run" },
  { id: "bookmarks", gutterClass: "cm-openidea-bookmarks" },
  { id: "inheritors", gutterClass: "cm-openidea-gutter-lineMarkers" },
  { id: "supers", gutterClass: "cm-openidea-gutter-lineMarkers" },
] as const;

export interface PrefsOptions {
  prefs: EditorExtras;
  path: string;
  softWrap: boolean | undefined;
  /** Soft wraps toggled for the file, overriding `softWrap` and the file patterns. */
  wrapOverride?: boolean | null;
  showWhitespace: boolean | undefined;
  /** Hard wrap column for this file's language. */
  hardWrapAt: number;
  readOnly: boolean;
  /** Distraction Free Mode: no right margin / visual guides beside the centred column. */
  distractionFree?: boolean;
  /** Language id of the document (per-language smart-key behaviour). */
  language?: string;
  /** Code Style › Comment Code of the document's language. */
  commentStyle?: LineCommentStyle;
}

function caretOnScreen(view: EditorView, pos: number): boolean {
  const c = view.coordsAtPos(pos);
  if (!c) return false;
  const r = view.scrollDOM.getBoundingClientRect();
  return c.top >= r.top && c.bottom <= r.bottom;
}

/**
 * Use smooth caret movement. The cursor layer reuses its caret elements, so a
 * CSS transition on their position animates a move (VS Code's
 * `cursorSmoothCaretAnimation: "explicit"`). Only moves of the selection
 * alone glide; typing, edits, a changed number of carets, layout changes and
 * moves that scroll the editor put the caret in place at once.
 */
const caretGlide = ViewPlugin.fromClass(
  class {
    on = false;
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      const from = u.startState.selection;
      const to = u.state.selection;
      if (!u.selectionSet || u.docChanged || u.geometryChanged || from.ranges.length !== to.ranges.length) {
        this.set(false);
        return;
      }
      // Measured before the editor scrolls the new caret into view.
      u.view.requestMeasure({
        key: this,
        read: (view) => caretOnScreen(view, from.main.head) && caretOnScreen(view, to.main.head),
        write: (on) => this.set(on),
      });
    }
    set(on: boolean) {
      if (on === this.on) return;
      this.on = on;
      this.view.scrollDOM.querySelector(":scope > .cm-cursorLayer")?.classList.toggle("cm-openidea-caretGlide", on);
    }
  },
);

export function caretExtension(prefs: EditorExtras): Extension {
  const a = prefs.appearance;
  const classes = [
    a.blockCaret && "cm-openidea-blockCaret",
    a.smoothCaretBlinking && "cm-openidea-smoothCaretBlink",
    a.smoothCaretMovement && `cm-openidea-caretMotion-${a.caretMovementStyle === "gliding" ? "gliding" : "snappy"}`,
  ].filter(Boolean);
  return [
    // Before drawSelection: its measure request must run before the cursor layer redraws.
    a.smoothCaretMovement ? caretGlide : [],
    drawSelection({ cursorBlinkRate: a.caretBlinking ? Math.max(100, Math.min(5000, a.caretBlinkPeriod)) * 2 : 0 }),
    classes.length ? EditorView.editorAttributes.of({ class: classes.join(" ") }) : [],
  ];
}

export function prefsExtension(o: PrefsOptions): Extension {
  const { prefs } = o;
  const g = prefs.general;
  const k = prefs.smartKeys;
  const out: Extension[] = [];
  if (g.scrollPastEnd) out.push(scrollPastEnd());
  if ((o.wrapOverride ?? softWrapActive(o.softWrap, prefs, o.path)) && g.softWrapIndent) out.push(wrapIndent);
  if (o.showWhitespace) {
    const a = prefs.appearance;
    out.push(
      whitespaceMarks({ leading: a.whitespaceLeading, inner: a.whitespaceInner, trailing: a.whitespaceTrailing }),
    );
  }
  if (prefs.appearance.hardWrapGuides && !o.distractionFree)
    out.push(marginGuides([o.hardWrapAt, ...prefs.codeStyle.visualGuides]));
  if (prefs.appearance.methodSeparators)
    out.push(EditorView.editorAttributes.of({ class: "cm-openidea-methodSeparators" }));
  const hidden = GUTTER_ICON_GROUPS.filter(
    (grp) => !prefs.showGutterIcons || prefs.gutterIconsDisabled.includes(grp.id),
  );
  if (hidden.length)
    out.push(
      EditorView.editorAttributes.of({ class: hidden.map((grp) => `cm-openidea-hideGutter-${grp.id}`).join(" ") }),
    );
  if (g.wheelZoom) out.push(wheelZoom);
  if (!g.dragAndDrop) out.push(noTextDrag);
  if (g.caretScroll === "center") out.push(centerCaret);
  if (g.richTextCopy) out.push(richCopy);
  if (!o.readOnly && (k.reformatOnPaste === "indentBlock" || k.reformatOnPaste === "indentEachLine"))
    out.push(pasteReindentFilter(k.reformatOnPaste));

  // Pairing: closeBrackets() reads the brackets list from language data; ours comes first.
  const brackets = [...(k.pairBrackets ? ["(", "[", "{"] : []), ...(k.pairQuotes ? ["'", '"'] : [])];
  out.push(Prec.highest(EditorState.languageData.of(() => [{ closeBrackets: { brackets } }])));
  if (!k.surroundSelection) out.push(Prec.highest(noSurround));
  if (k.pairQuotes) out.push(Prec.highest(skipClosingQuote));
  if (k.tabOutOfPair) out.push(tabOut);
  if (o.commentStyle) out.push(lineCommentStyle.of(o.commentStyle));

  const keys = [];
  if (k.camelHumps)
    keys.push(
      { key: "Alt-ArrowLeft", run: cursorHumpLeft, shift: selectHumpLeft, preventDefault: true },
      { key: "Alt-ArrowRight", run: cursorHumpRight, shift: selectHumpRight, preventDefault: true },
      { key: "Alt-Delete", run: deleteHumpForward },
    );
  // Delete to Word Start: the whitespace before the caret and the word before it.
  keys.push({
    key: "Mod-Backspace",
    mac: "Alt-Backspace",
    run: k.camelHumps ? deleteHumpBackward : deleteWordBackward,
  });
  if (!k.smartHome)
    keys.push(
      { key: "Home", run: cursorLineStart, shift: selectLineStart, preventDefault: true },
      { mac: "Mod-ArrowLeft", run: cursorLineStart, shift: selectLineStart, preventDefault: true },
    );
  if (!o.readOnly) keys.push({ key: "Enter", run: enterInLineComment });
  if (!k.smartIndent) keys.push({ key: "Enter", run: insertNewlineKeepIndent });
  if (k.backspaceUnindent === "none") keys.push({ key: "Backspace", run: deleteCharBackwardStrict });
  else if (smartBackspaceApplies(k.backspaceUnindent, o.language)) keys.push({ key: "Backspace", run: smartBackspace });
  if (keys.length) out.push(Prec.high(keymap.of(keys)));
  return out;
}
