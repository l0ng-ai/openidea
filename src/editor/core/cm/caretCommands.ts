/** IDEA caret commands that CodeMirror has no equivalent for: Split Line, Scroll to Center, code block and brace navigation. */
import { EditorSelection, type EditorState, type Transaction } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { matchBrackets, syntaxTree } from "@codemirror/language";

/** Split Line: break the line at each caret, indented, leaving the caret before the break. */
export const splitLine: Command = (view) => {
  if (view.state.readOnly) return false;
  const before = view.state.selection;
  let tr: Transaction | null = null;
  insertNewlineAndIndent({ state: view.state, dispatch: (t) => (tr = t) });
  if (!tr) return false;
  const changes = (tr as Transaction).changes;
  const selection = EditorSelection.create(
    before.ranges.map((r) => EditorSelection.cursor(changes.mapPos(r.from, -1))),
    before.mainIndex,
  );
  view.dispatch({ changes, selection, scrollIntoView: true, userEvent: "input" });
  return true;
};

/** Scroll to Center: put the caret line in the middle of the viewport. */
export const scrollToCenter: Command = (view) => {
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) });
  return true;
};

const NOT_CODE = /String|Comment|Regexp|Char|Template/;

/** `{` / `}` at `pos` when it is code (not inside a string or comment, as far as the syntax tree knows). */
function braceAt(state: EditorState, pos: number): "{" | "}" | null {
  const ch = state.sliceDoc(pos, pos + 1);
  if (ch !== "{" && ch !== "}") return null;
  const tree = syntaxTree(state);
  if (tree.length && NOT_CODE.test(tree.resolveInner(pos, 1).name)) return null;
  return ch;
}

/**
 * Where Move Caret to Code Block Start goes from `pos` (as IDEA):
 * just after the enclosing `{`, or before the `{` matching a `}` the caret follows.
 */
export function codeBlockStart(state: EditorState, pos: number): number | null {
  const from = pos - 1;
  if (from < 0) return null;
  const afterClose = braceAt(state, from) === "}";
  let depth = afterClose ? -1 : 0;
  for (let p = from; p >= 0; p--) {
    const b = braceAt(state, p);
    if (b === "{" && p !== from) {
      if (depth === 0) return afterClose ? p : p + 1;
      depth--;
    } else if (b === "}") {
      depth++;
    }
  }
  return null;
}

/**
 * Where Move Caret to Code Block End goes from `pos`: before the enclosing `}`,
 * or after the `}` matching a `{` the caret precedes.
 */
export function codeBlockEnd(state: EditorState, pos: number): number | null {
  const len = state.doc.length;
  const beforeOpen = braceAt(state, pos) === "{";
  let depth = beforeOpen ? -1 : 0;
  for (let p = pos; p < len; p++) {
    const b = braceAt(state, p);
    if (b === "}" && p !== pos) {
      if (depth === 0) return beforeOpen ? p + 1 : p;
      depth--;
    } else if (b === "{") {
      depth++;
    }
  }
  return null;
}

function moveToBlock(find: (state: EditorState, pos: number) => number | null, extend = false): Command {
  return (view) => {
    const { state } = view;
    const main = state.selection.main;
    const target = find(state, main.head);
    if (target == null) return false;
    view.dispatch({
      selection: extend ? EditorSelection.range(main.anchor, target) : EditorSelection.cursor(target),
      scrollIntoView: true,
      userEvent: extend ? "select" : "select.navigate",
    });
    return true;
  };
}

export const cursorCodeBlockStart = moveToBlock(codeBlockStart);
export const cursorCodeBlockEnd = moveToBlock(codeBlockEnd);
export const selectCodeBlockStart = moveToBlock(codeBlockStart, true);
export const selectCodeBlockEnd = moveToBlock(codeBlockEnd, true);

/**
 * The inside of the `{…}` block around `pos` (between the braces) for Collapse Block;
 * after a `}` the block it closes. `null` outside any block.
 */
export function enclosingCodeBlock(state: EditorState, pos: number): { from: number; to: number } | null {
  const start = codeBlockStart(state, pos);
  if (start == null) return null;
  const open = braceAt(state, start) === "{" ? start : start - 1;
  const end = codeBlockEnd(state, open);
  if (end == null) return null;
  return { from: open + 1, to: end - 1 };
}

/**
 * Where Go to Matching Brace (⌃M) goes from `pos`: from a brace next to the
 * caret to its match; elsewhere to the unclosed opening brace before the caret.
 */
export function matchBraceTarget(state: EditorState, pos: number): number | null {
  const found =
    matchBrackets(state, pos, -1) ||
    matchBrackets(state, pos, 1) ||
    (pos > 0 && matchBrackets(state, pos - 1, 1)) ||
    (pos < state.doc.length && matchBrackets(state, pos + 1, -1));
  if (found && found.end) return found.start.from === pos ? found.end.to : found.end.from;
  const tree = syntaxTree(state);
  let depth = 0;
  for (let p = pos - 1; p >= 0; p--) {
    const ch = state.sliceDoc(p, p + 1);
    const open = "([{".includes(ch);
    if (!open && !")]}".includes(ch)) continue;
    if (tree.length && NOT_CODE.test(tree.resolveInner(p, 1).name)) continue;
    if (!open) depth++;
    else if (depth-- === 0) return p;
  }
  return null;
}

export const cursorMatchBrace: Command = (view) => {
  const { state } = view;
  let moved = false;
  const ranges = state.selection.ranges.map((r) => {
    const target = matchBraceTarget(state, r.head);
    if (target == null) return r;
    moved = true;
    return EditorSelection.cursor(target);
  });
  if (!moved) return false;
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: "select.navigate",
  });
  return true;
};
