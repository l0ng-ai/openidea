/**
 * IDEA-style Tab, smart Backspace and Tab out of auto-inserted brackets and
 * quotes.
 */
import {
  EditorSelection,
  StateEffect,
  countColumn,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import {
  getIndentUnit,
  getIndentation,
  indentService,
  indentString,
  indentUnit,
  syntaxTree,
} from "@codemirror/language";
import { indentMore } from "@codemirror/commands";
import { visibleColumn } from "./visibleColumn";

// --- Tab -------------------------------------------------------------------------------

/**
 * Tab: steps out of an auto-inserted pair (when enabled); with a selection
 * holding more than whitespace, indents the selected lines; otherwise inserts
 * whitespace at each caret up to the next indent stop (a tab character when
 * the code style uses tabs). Live templates / Emmet get Tab first.
 */
export const insertTab: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  if (tabOutOfScope(view)) return true;
  if (state.selection.ranges.some((r) => !r.empty && state.sliceDoc(r.from, r.to).trim())) return indentMore(view);
  const useTab = state.facet(indentUnit) === "\t";
  const size = Math.max(1, getIndentUnit(state));
  const tr = state.changeByRange((r) => {
    const line = state.doc.lineAt(r.from);
    const col = visibleColumn(line.text, r.from - line.from, state.tabSize);
    const insert = useTab ? "\t" : " ".repeat(size - (col % size));
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

/** Tab ahead of the default `indentWithTab` (⇧Tab stays Unindent). */
export const tabKeymap: Extension = keymap.of([{ key: "Tab", run: insertTab }]);

// --- Backspace -------------------------------------------------------------------------------

/** Languages whose layout is indentation: IDEA keeps "to nearest indent position" there. */
const NEAREST_INDENT_LANGS = new Set(["python", "gdscript", "yaml", "shellscript"]);

export function smartBackspaceApplies(mode: string, language: string | undefined): boolean {
  return mode === "autoindent" && !NEAREST_INDENT_LANGS.has(language ?? "");
}

/** The change one Backspace makes at `pos` in "To proper indent position" mode, or null to delete normally. */
export function autoIndentBackspace(
  state: EditorState,
  pos: number,
): { from: number; to: number; insert: string } | null {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  if (/[^ \t]/.test(doc.sliceString(line.from, pos))) return null;
  const target = getIndentation(state, line.from);
  if (target === null) return null;
  const end = pos + /^[ \t]*/.exec(doc.sliceString(pos, line.to))![0].length;
  const current = countColumn(doc.sliceString(line.from, end), state.tabSize);
  if (current > target) return { from: line.from, to: end, insert: indentString(state, target) };
  if (line.number === 1) return end > 0 ? { from: 0, to: end, insert: "" } : null;
  const prev = doc.line(line.number - 1);
  const prevEnd = prev.from + prev.text.trimEnd().length;
  if (prevEnd === prev.from && prevEnd !== 0) {
    // A blank line above: the text moves up, at its proper indent.
    return { from: prevEnd, to: end, insert: indentString(state, target) };
  }
  const before = doc.sliceString(prev.from, prevEnd);
  const after = doc.sliceString(end, line.to);
  const space = !after || !before || /[([{]$/.test(before) || /^[)\]}.,;]/.test(after) ? "" : " ";
  return { from: prevEnd, to: end, insert: space };
}

/** Backspace in leading whitespace: to the proper indent, or joined with the line above when already there. */
export const smartBackspace: Command = (view) => {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.some((r) => !r.empty)) return false;
  const plans = state.selection.ranges.map((r) => autoIndentBackspace(state, r.head));
  if (plans.some((p) => !p)) return false;
  const tr = state.changeByRange((r) => {
    const p = plans[state.selection.ranges.indexOf(r)]!;
    return { changes: p, range: EditorSelection.cursor(p.from + p.insert.length) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "delete.backward" }));
  return true;
};

// --- Tab out of brackets / quotes ------------------------------------------------------------

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };

interface Scope {
  from: number;
  to: number;
}

const leaveScopes = StateEffect.define<readonly number[]>();

/** Inside each pair the editor inserted itself; Tab at a scope's end steps over the closing character. */
const tabOutScopes = StateField.define<readonly Scope[]>({
  create: () => [],
  update(scopes, tr) {
    for (const e of tr.effects) if (e.is(leaveScopes)) scopes = scopes.filter((s) => !e.value.includes(s.to));
    if (!tr.docChanged) return scopes;
    const caret = tr.startState.selection.main.head;
    let next: Scope[] = scopes.filter((s) => {
      let keep = true;
      tr.changes.iterChangedRanges((fromA, toA) => {
        const outside = fromA < s.from || toA > s.to;
        if (outside && (caret < s.from || caret > s.to || (toA >= s.from && fromA <= s.to))) keep = false;
      });
      return keep;
    });
    next = next.map((s) => ({ from: tr.changes.mapPos(s.from, -1), to: tr.changes.mapPos(s.to, 1) }));
    return [...next, ...insertedPairs(tr)];
  },
});

/** Empty scopes between the bracket / quote pairs a typing transaction auto-inserted. */
function insertedPairs(tr: Transaction): Scope[] {
  if (!tr.isUserEvent("input.type")) return [];
  const out: Scope[] = [];
  tr.changes.iterChanges((_fa, _ta, fromB, toB, inserted) => {
    const text = inserted.toString();
    if (toB - fromB !== 2 || PAIRS[text[0]!] !== text[1]) return;
    const inside = fromB + 1;
    if (tr.newSelection.ranges.some((r) => r.empty && r.head === inside)) out.push({ from: inside, to: inside });
  });
  return out;
}

export const tabOutOfScope: Command = (view) => {
  const { state } = view;
  const scopes = state.field(tabOutScopes, false);
  if (!scopes?.length || state.selection.ranges.some((r) => !r.empty || !scopes.some((s) => s.to === r.head)))
    return false;
  view.dispatch({
    selection: EditorSelection.create(
      state.selection.ranges.map((r) => EditorSelection.cursor(Math.min(r.head + 1, state.doc.length))),
      state.selection.mainIndex,
    ),
    effects: leaveScopes.of(state.selection.ranges.map((r) => r.head)),
    userEvent: "select",
  });
  return true;
};

/** Settings › Smart Keys › "Jump outside closing bracket/quote with Tab" (Tab itself is `insertTab`). */
export const tabOut: Extension = tabOutScopes;

// --- closing quote ---------------------------------------------------------------------------

/** `quote` at `pos` closes the string literal the caret is in (typed or not, the pair's end). */
export function closesStringAt(state: EditorState, pos: number, quote: string): boolean {
  if (state.sliceDoc(pos, pos + 1) !== quote) return false;
  for (
    let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1);
    n;
    n = n.parent
  ) {
    if (n.to > pos + 1) break;
    if (n.to === pos + 1 && n.from < pos && /String|Char|Template|Rune/.test(n.type.name)) return true;
  }
  return false;
}

// --- closing bracket -------------------------------------------------------------------------

const OPEN_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Whether `pos` is inside a string or comment (brackets there don't count).
 * Code embedded in a string is code again (`${x}` in a template, `{$x}` in a
 * PHP string), and a file's root node is never a literal, whatever it is
 * called (PHP's is `Template`).
 */
function inLiteral(state: EditorState, pos: number): boolean {
  for (
    let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1);
    n;
    n = n.parent
  ) {
    if (n.type.isTop || /Interpolation|Substitution/.test(n.type.name)) return false;
    if (/String|Char|Template|Comment|Rune|Heredoc/.test(n.type.name) && n.from < pos + 1 && n.to > pos) return true;
  }
  return false;
}

/**
 * `close` at `pos` can be typed over: the next character is that closing
 * bracket and its line is not short of closers (so typing over it leaves the
 * brackets balanced), as IDEA's "Insert pair bracket" does for existing
 * brackets, not only the ones it inserted.
 */
export function closesBracketAt(state: EditorState, pos: number, close: string): boolean {
  const open = OPEN_OF[close];
  if (!open || state.sliceDoc(pos, pos + 1) !== close || inLiteral(state, pos)) return false;
  const line = state.doc.lineAt(pos);
  let depth = 0;
  for (let i = line.from; i < line.to; i++) {
    const ch = state.sliceDoc(i, i + 1);
    if ((ch === open || ch === close) && !inLiteral(state, i)) depth += ch === open ? 1 : -1;
  }
  return depth <= 0;
}

/** Typing a closing bracket right before the same closing bracket steps over it, as in IDEA. */
export const skipClosingBracket = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (!OPEN_OF[text] || view.state.readOnly) return false;
  const { state } = view;
  const sel = state.selection;
  if (!sel.ranges.every((r) => r.empty && closesBracketAt(state, r.head, text))) return false;
  view.dispatch({
    selection: EditorSelection.create(
      sel.ranges.map((r) => EditorSelection.cursor(r.head + 1)),
      sel.mainIndex,
    ),
    scrollIntoView: true,
    userEvent: "input.type",
  });
  return true;
});

/** Typing a quote right before the closing quote of a string literal steps over it, as in IDEA. */
export const skipClosingQuote = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (!/^["'`]$/.test(text) || view.state.readOnly) return false;
  const { state } = view;
  const sel = state.selection;
  if (!sel.ranges.every((r) => r.empty && closesStringAt(state, r.head, text))) return false;
  view.dispatch({
    selection: EditorSelection.create(
      sel.ranges.map((r) => EditorSelection.cursor(r.head + 1)),
      sel.mainIndex,
    ),
    scrollIntoView: true,
    userEvent: "input.type",
  });
  return true;
});

// --- indentation after a bracket that ends its line ---------------------------------------------

const CLOSE_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** How far back the opening bracket around a position is looked for. */
const BRACKET_SCAN = 20_000;

/**
 * Indentation inside a bracket that is the last thing on its line while
 * another bracket before it on that line is still open (`$this->add([`,
 * `foo(function () {`). A language mode then aligns the content under the
 * outer bracket's content, columns to the right; IDEA indents one unit from
 * the line instead:
 *
 * - the line right after the opening bracket: one unit deeper than its line;
 * - a line starting with its closing bracket: that line's indentation;
 * - in `[…]` and `(…)`, a line after one ending in `,`: that line's
 *   indentation (the next element or argument).
 *
 * Everything else is left to the language mode.
 */
export const trailingBracketIndent = indentService.of((cx, pos) => {
  const { state } = cx;
  const from = Math.max(0, pos - BRACKET_SCAN);
  const text = state.sliceDoc(from, pos);
  let depth = 0;
  let open = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch !== "(" && ch !== ")" && ch !== "[" && ch !== "]" && ch !== "{" && ch !== "}") continue;
    if (inLiteral(state, from + i)) continue;
    if (OPEN_OF[ch]) depth++;
    else if (depth > 0) depth--;
    else {
      open = from + i;
      break;
    }
  }
  if (open < 0) return undefined;
  const line = state.doc.lineAt(open);
  // The bracket ends its line (up to the caret, when the break is on it).
  const lineEnd = pos <= line.to ? pos : line.to;
  if (state.sliceDoc(open + 1, lineEnd).trim()) return undefined;
  // Another bracket before it on the line is still open.
  let outer = false;
  let nested = 0;
  for (let i = open - 1; i >= line.from && !outer; i--) {
    const ch = state.sliceDoc(i, i + 1);
    if (!CLOSE_OF[ch] && !OPEN_OF[ch]) continue;
    if (inLiteral(state, i)) continue;
    if (OPEN_OF[ch]) nested++;
    else if (nested > 0) nested--;
    else outer = true;
  }
  if (!outer) return undefined;
  const base = cx.lineIndent(line.from);
  const bracket = state.sliceDoc(open, open + 1);
  const close = CLOSE_OF[bracket];
  if (close && cx.textAfterPos(pos).trimStart().startsWith(close)) return base;
  // The last line with text before the position.
  const here = state.doc.lineAt(pos);
  let before = here.from === pos || !state.sliceDoc(here.from, pos).trim() ? null : state.sliceDoc(here.from, pos);
  let beforeFrom = here.from;
  for (let n = here.number - 1; before === null && n >= line.number; n--) {
    const prev = state.doc.line(n);
    if (prev.text.trim()) {
      before = prev.text;
      beforeFrom = prev.from;
    }
  }
  if (before === null || beforeFrom === line.from) return base + cx.unit;
  if (bracket !== "{" && before.trimEnd().endsWith(",")) return cx.lineIndent(beforeFrom);
  return undefined;
});
