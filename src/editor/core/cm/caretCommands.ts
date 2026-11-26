/** IDEA caret commands that CodeMirror has no equivalent for: Split Line, Scroll to Center / Up / Down / Top / Bottom, Scroll Up / Down and Move if Necessary, Page Top / Bottom, code block, brace and paragraph navigation. */
import { countColumn, EditorSelection, findColumn, type EditorState, type Transaction } from "@codemirror/state";
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

/** Scroll Up / Scroll Down: move the viewport by one line, leaving the caret where it is even when it scrolls out of view. */
const scrollByLine =
  (lines: number): Command =>
  (view) => {
    view.scrollDOM.scrollTop += lines * view.defaultLineHeight;
    return true;
  };
export const scrollUp = scrollByLine(-1);
export const scrollDown = scrollByLine(1);

/** Scroll to Top / Scroll to Bottom (as IDEA): show the start of the file at the top, or bring its end toward the middle, without moving the caret. */
export const scrollToTop: Command = (view) => {
  view.scrollDOM.scrollTop = 0;
  return true;
};
export const scrollToBottom: Command = (view) => {
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: "center" }) });
  return true;
};

/**
 * The line Move Caret to Page Top / Bottom goes to (as IDEA): the first / last line
 * the scroller shows whole; a partly hidden edge line only when there is no other.
 */
function pageEdgeLine(view: EditorView, edge: "top" | "bottom"): number {
  // In document coordinates, as sticky lines measure it.
  const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
  const bottom = top + view.scrollDOM.clientHeight;
  const { doc } = view.state;
  if (edge === "top") {
    const block = view.lineBlockAtHeight(top);
    const next = top > block.top && block.bottom < bottom && block.to < doc.length;
    return next ? view.lineBlockAt(block.to + 1).from : block.from;
  }
  const block = view.lineBlockAtHeight(bottom);
  if (block.from === 0) return 0;
  const previous = view.lineBlockAt(block.from - 1);
  return block.top >= bottom || (block.bottom > bottom && previous.top >= top) ? previous.from : block.from;
}

/** `head` moved to the line starting at `lineStart`, keeping its visual column. */
function sameColumnOn(state: EditorState, head: number, lineStart: number): number {
  const line = state.doc.lineAt(head);
  const target = state.doc.lineAt(lineStart);
  const column = countColumn(line.text, state.tabSize, head - line.from);
  return target.from + findColumn(target.text, column, state.tabSize);
}

/** Move Caret to Page Top / Bottom (with Selection): every caret to that line, keeping its column. */
function moveToPageEdge(edge: "top" | "bottom", extend = false): Command {
  return (view) => {
    const { state } = view;
    const target = pageEdgeLine(view, edge);
    const ranges = state.selection.ranges.map((r) => {
      const head = sameColumnOn(state, r.head, target);
      return extend ? EditorSelection.range(r.anchor, head) : EditorSelection.cursor(head);
    });
    view.dispatch({
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      userEvent: extend ? "select" : "select.navigate",
    });
    return true;
  };
}

export const cursorPageTop = moveToPageEdge("top");
export const cursorPageBottom = moveToPageEdge("bottom");
export const selectPageTop = moveToPageEdge("top", true);
export const selectPageBottom = moveToPageEdge("bottom", true);

/**
 * Scroll Up / Down and Move if Necessary: move the viewport by one line, then bring
 * a caret outside the lines the view shows whole to the first or last of them,
 * keeping its column. Carets in view keep their place and selection.
 */
const scrollByLineAndMove =
  (lines: number): Command =>
  (view) => {
    scrollByLine(lines)(view);
    const { state } = view;
    const first = pageEdgeLine(view, "top");
    const last = view.lineBlockAt(pageEdgeLine(view, "bottom"));
    let moved = false;
    const ranges = state.selection.ranges.map((r) => {
      if (r.head >= first && r.head <= last.to) return r;
      moved = true;
      return EditorSelection.cursor(sameColumnOn(state, r.head, r.head < first ? first : last.from));
    });
    if (moved) {
      view.dispatch({
        selection: EditorSelection.create(ranges, state.selection.mainIndex),
        userEvent: "select.navigate",
      });
    }
    return true;
  };
export const scrollUpAndMove = scrollByLineAndMove(-1);
export const scrollDownAndMove = scrollByLineAndMove(1);

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

/** A line with nothing but whitespace, which separates paragraphs. */
const isBlankLine = (text: string) => !/\S/.test(text);

/**
 * Where Move Caret Forward a Paragraph goes from `pos` (as IDEA, after Emacs
 * `forward-paragraph`): past any blank lines at the caret, then to the start of
 * the next blank line, or the end of the text.
 */
export function nextParagraphBoundary(state: EditorState, pos: number): number {
  const { doc } = state;
  let line = doc.lineAt(pos).number;
  if (isBlankLine(doc.line(line).text)) while (++line <= doc.lines && isBlankLine(doc.line(line).text));
  while (++line <= doc.lines) {
    if (isBlankLine(doc.line(line).text)) return doc.line(line).from;
  }
  return doc.length;
}

/**
 * Where Move Caret Backward a Paragraph goes from `pos`: back over the
 * paragraph (from a blank line or a line start, past the blank lines above
 * first) to the empty line before it, or the start of the line after a
 * whitespace-only one; the start of the text when there is none.
 */
export function previousParagraphBoundary(state: EditorState, pos: number): number {
  const { doc } = state;
  const at = doc.lineAt(pos);
  let line = at.number;
  if (pos === at.from || isBlankLine(at.text)) while (--line >= 1 && isBlankLine(doc.line(line).text));
  while (--line >= 1 && !isBlankLine(doc.line(line).text));
  if (line < 1) return 0;
  const target = doc.line(line);
  return target.length === 0 ? target.from : doc.line(line + 1).from;
}

/** Move Caret Forward / Backward a Paragraph (with Selection), for every caret. */
function moveByParagraph(find: (state: EditorState, pos: number) => number, extend = false): Command {
  return (view) => {
    const { state } = view;
    const ranges = state.selection.ranges.map((r) => {
      const head = find(state, r.head);
      return extend ? EditorSelection.range(r.anchor, head) : EditorSelection.cursor(head);
    });
    view.dispatch({
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      scrollIntoView: true,
      userEvent: extend ? "select" : "select.navigate",
    });
    return true;
  };
}

export const cursorParagraphForward = moveByParagraph(nextParagraphBoundary);
export const cursorParagraphBackward = moveByParagraph(previousParagraphBoundary);
export const selectParagraphForward = moveByParagraph(nextParagraphBoundary, true);
export const selectParagraphBackward = moveByParagraph(previousParagraphBoundary, true);

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
