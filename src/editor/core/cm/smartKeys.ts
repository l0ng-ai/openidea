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
import { getIndentUnit, getIndentation, indentString, indentUnit, syntaxTree } from "@codemirror/language";
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
