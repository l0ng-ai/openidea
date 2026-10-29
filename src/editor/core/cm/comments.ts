/**
 * Comment with Line Comment and Enter inside a line comment, as in IDEA.
 */
import {
  EditorSelection,
  Facet,
  countColumn,
  type ChangeSpec,
  type EditorState,
  type SelectionRange,
} from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { indentString, syntaxTree } from "@codemirror/language";
import { toggleComment } from "@codemirror/commands";
import { offsetAtVisibleColumn, visibleColumn } from "./visibleColumn";

/** Code Style › <Language> › Code Generation › Comment Code. */
export interface LineCommentStyle {
  atFirstColumn: boolean;
  addSpace: boolean;
}

export const lineCommentStyle = Facet.define<LineCommentStyle, LineCommentStyle>({
  combine: (values) => values[0] ?? { atFirstColumn: true, addSpace: false },
});

function lineToken(state: EditorState, pos: number): string | undefined {
  return state.languageDataAt<{ line?: string }>("commentTokens", pos)[0]?.line;
}

const leadingWs = (text: string) => /^[ \t]*/.exec(text)![0].length;

interface Block {
  startLine: number;
  endLine: number;
  ranges: number[];
  caretUpdate: "commentStart" | "down" | "restoreSelection" | null;
}

/** The view state right after the last ⌘/, to tell a repeated ⌘/ (IDEA's previous performed action). */
const afterComment = new WeakMap<EditorView, EditorState>();

/**
 * ⌘/: comments the caret / selected lines (or uncomments when every line is
 * commented). Without a selection the caret moves down — on an empty line it
 * stays after the inserted prefix; with whole lines selected the selection
 * then starts at its first line's start.
 */
export const commentLine: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const doc = state.doc;
  const style = state.facet(lineCommentStyle);
  const repeated = afterComment.get(view) === state;

  const blocks: Block[] = [];
  const order = state.selection.ranges.map((r, i) => ({ r, i })).sort((a, b) => a.r.from - b.r.from);
  for (const { r, i } of order) {
    const startLine = doc.lineAt(r.from).number;
    let endLine = doc.lineAt(r.to).number;
    if (!r.empty && endLine > startLine && doc.line(endLine).from === r.to) endLine--;
    const last = blocks[blocks.length - 1];
    const block = last && startLine <= last.endLine + 1 ? last : null;
    const target = block ?? { startLine, endLine, ranges: [], caretUpdate: null };
    if (!block) blocks.push(target);
    target.ranges.push(i);
    target.endLine = Math.max(target.endLine, endLine);
    const wholeLines =
      r.empty || (r.from === doc.lineAt(r.from).from && r.to === doc.lineAt(r.to).from && r.to > r.from);
    const emptyLine = !doc.lineAt(r.from).text.trim();
    target.caretUpdate =
      r.empty && emptyLine && !repeated ? "commentStart" : r.empty ? "down" : wholeLines ? "restoreSelection" : null;
  }

  const tokens = blocks.map((b) =>
    lineToken(state, doc.line(b.startLine).from + leadingWs(doc.line(b.startLine).text)),
  );
  // Languages without line comments (CSS, HTML…): block comments.
  if (tokens.some((t) => !t)) return toggleComment(view);

  let allCommented = true;
  let commentedNonEmpty = false;
  blocks.forEach((b, bi) => {
    const token = tokens[bi]!;
    const single = b.startLine === b.endLine;
    for (let n = b.startLine; n <= b.endLine; n++) {
      const text = doc.line(n).text;
      const commented = text.slice(leadingWs(text)).startsWith(token);
      const empty = !text.trim();
      if (commented && !empty) commentedNonEmpty = true;
      if (!commented && (single || !empty)) allCommented = false;
    }
    if (allCommented && !single && !commentedNonEmpty) allCommented = false;
  });

  const changes: ChangeSpec[] = [];
  blocks.forEach((b, bi) => {
    const token = tokens[bi]!;
    if (allCommented) {
      for (let n = b.startLine; n <= b.endLine; n++) {
        const line = doc.line(n);
        const start = line.from + leadingWs(line.text);
        if (!doc.sliceString(start, line.to).startsWith(token) || !line.text.trim()) continue;
        let end = start + token.length;
        if (style.addSpace && doc.sliceString(end, end + 1) === " ") end++;
        // Nothing but whitespace left: the line is emptied.
        if (!doc.sliceString(end, line.to).trim()) changes.push({ from: line.from, to: line.to });
        else changes.push({ from: start, to: end });
      }
      return;
    }
    const commentStart = b.caretUpdate === "commentStart";
    const prefixFor = (shifted: number, line: { to: number }) =>
      token + (style.addSpace && (shifted < line.to || (commentStart && shifted < doc.length)) ? " " : "");
    if (style.atFirstColumn) {
      for (let n = b.startLine; n <= b.endLine; n++) {
        const line = doc.line(n);
        changes.push({ from: line.from, insert: prefixFor(line.from + leadingWs(line.text), line) });
      }
      return;
    }
    const min = minIndent(state, b.startLine, b.endLine, token);
    for (let n = b.startLine; n <= b.endLine; n++) {
      const line = doc.line(n);
      let cols = 0;
      let i = 0;
      for (; i < line.length && cols < min; i++) {
        const ch = line.text[i];
        if (ch === " ") cols++;
        else if (ch === "\t") cols += state.tabSize - (cols % state.tabSize);
        else break;
      }
      const prefix = prefixFor(line.from + leadingWs(line.text), line);
      if (cols >= min) changes.push({ from: line.from + i, insert: prefix });
      else changes.push({ from: line.from, to: line.from + i, insert: indentString(state, min) + prefix });
    }
  });

  const set = state.changes(changes);
  const next = set.apply(doc);
  const moveCarets = !blocks.some((b) => b.ranges.length > 1 && b.startLine !== b.endLine);
  const ranges: SelectionRange[] = state.selection.ranges.map((r) => r.map(set));
  for (const [bi, b] of blocks.entries()) {
    if (!moveCarets || !b.caretUpdate) continue;
    for (const i of b.ranges) {
      const r = ranges[i]!;
      if (b.caretUpdate === "commentStart") {
        const line = next.line(b.startLine);
        let pos = line.from + leadingWs(line.text) + tokens[bi]!.length;
        pos += leadingWs(next.sliceString(pos, line.to));
        ranges[i] = EditorSelection.cursor(Math.min(pos, next.length));
      } else if (b.caretUpdate === "down") {
        const line = next.lineAt(r.head);
        if (line.number >= next.lines) continue;
        const col = visibleColumn(line.text, r.head - line.from, state.tabSize);
        const below = next.line(line.number + 1);
        ranges[i] = EditorSelection.cursor(below.from + offsetAtVisibleColumn(below.text, col, state.tabSize));
      } else {
        const from = next.lineAt(r.from).from;
        ranges[i] = r.head >= r.anchor ? EditorSelection.range(from, r.to) : EditorSelection.range(r.to, from);
      }
    }
  }
  view.dispatch({
    changes: set,
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: allCommented ? "delete.uncomment" : "input.comment",
  });
  afterComment.set(view, view.state);
  return true;
};

/** Smallest indent of the non-blank lines, also no deeper than a line comment right above. */
function minIndent(state: EditorState, startLine: number, endLine: number, token: string): number {
  const doc = state.doc;
  const indentOf = (text: string) => countColumn(text.slice(0, leadingWs(text)), state.tabSize);
  let min: number | null = null;
  const scan = (from: number, to: number) => {
    for (let n = from; n <= to; n++) {
      const line = doc.line(n);
      if (!line.text.trim() && n < doc.lines) continue;
      const indent = indentOf(line.text);
      min = min === null ? indent : Math.min(min, indent);
    }
  };
  scan(startLine, endLine);
  if (min === null && startLine === endLine && startLine < doc.lines) scan(startLine + 1, startLine + 1);
  if (startLine > 1) {
    const above = doc.line(startLine - 1).text;
    if (above.slice(leadingWs(above)).startsWith(token)) min = Math.min(min ?? Infinity, indentOf(above));
  }
  return min ?? 0;
}

// --- Enter in a line comment ------------------------------------------------------

/** The start of the line comment the caret is in (after its prefix), else -1. */
function lineCommentStart(state: EditorState, pos: number, token: string): number {
  if (pos < 1) return -1;
  const tree = syntaxTree(state);
  if (!tree.length) return -1;
  const node = tree.resolveInner(pos, -1);
  if (!/comment/i.test(node.type.name) || node.from >= pos) return -1;
  const line = state.doc.lineAt(pos);
  if (node.from < line.from || !state.sliceDoc(node.from, pos).startsWith(token)) return -1;
  return node.from + token.length <= pos ? node.from : -1;
}

/**
 * Enter inside a `//` comment with text after the caret: the rest moves to a
 * new line that continues the comment (with the comment's own spacing).
 */
export const enterInLineComment: Command = (view) => {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.some((r) => !r.empty)) return false;
  const doc = state.doc;
  const plans: Array<{ changes: ChangeSpec[]; caret: number }> = [];
  for (const r of state.selection.ranges) {
    const pos = r.head;
    const token = lineToken(state, pos);
    if (!token) return false;
    const start = lineCommentStart(state, pos, token);
    if (start < 0) return false;
    const line = doc.lineAt(pos);
    const offset = pos + leadingWs(doc.sliceString(pos, line.to));
    if (offset >= line.to) return false;
    const indent = line.text.slice(0, leadingWs(line.text));
    const onlyComment = start === line.from + indent.length;
    const br = state.lineBreak;
    if (doc.sliceString(offset, offset + token.length) === token) {
      // The rest is a comment already: break before it.
      const after = offset + token.length;
      const changes: ChangeSpec[] = [{ from: offset, insert: br + indent }];
      if (after < line.to && doc.sliceString(after, after + 1) !== " ") changes.push({ from: after, insert: " " });
      plans.push({ changes, caret: onlyComment ? token.length + 1 : 0 });
      continue;
    }
    let spacing = " ";
    let to = pos;
    if (onlyComment) {
      const own = /^[ \t]*/.exec(doc.sliceString(start + token.length, line.to))![0];
      if (own) spacing = own;
      to = offset;
    } else if (doc.sliceString(pos, pos + 1) === " ") spacing = "";
    plans.push({
      changes: [{ from: pos, to, insert: br + indent + token + spacing }],
      caret: onlyComment ? token.length + spacing.length : 0,
    });
  }
  const tr = state.changeByRange((r) => {
    const plan = plans[state.selection.ranges.indexOf(r)]!;
    const set = state.changes(plan.changes);
    // The caret lands on the new line, after its indent (and the prefix when the comment owns the line).
    let lineStart = -1;
    set.iterChanges((_fa, _ta, fromB, _tb, inserted) => {
      const text = inserted.toString();
      const at = text.indexOf(state.lineBreak);
      if (lineStart < 0 && at >= 0) lineStart = fromB + at + state.lineBreak.length;
    });
    const indent = leadingWs(doc.lineAt(r.head).text);
    return { changes: set, range: EditorSelection.cursor(lineStart + indent + plan.caret) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
  return true;
};
