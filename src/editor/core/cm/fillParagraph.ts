/**
 * Edit › Fill Paragraph (IDEA's FillParagraph): re-wraps the paragraph at the
 * caret to the hard wrap column. A paragraph is a run of line comments with the
 * same marker, of ` * ` lines of a block comment, or of non-blank lines of a
 * plain text file; a blank line, a comment opener / closer, a line with code or
 * a `@tag` line ends it. Elsewhere in code the command does nothing.
 */
import { language, syntaxTree } from "@codemirror/language";
import { EditorSelection, countColumn, type EditorState, type Line } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function inComment(state: EditorState, pos: number): boolean {
  return /comment/i.test(syntaxTree(state).resolveInner(pos, 1).name);
}

/** The marker a paragraph line starts with (indentation plus `//`, `#`, `*`), or `null` if the line can't be filled. */
function markerOf(state: EditorState, line: Line): string | null {
  const indent = /^[ \t]*/.exec(line.text)![0];
  if (!state.facet(language)) return indent;
  const at = line.from + indent.length;
  const tokens = state.languageDataAt<{ line?: string; block?: { open: string } }>("commentTokens", at)[0];
  const rest = line.text.slice(indent.length);
  // A shebang or a block comment opened by the line token (Lua's `--[[`) isn't a line comment.
  if ((line.number === 1 && rest.startsWith("#!")) || (tokens?.block && rest.startsWith(tokens.block.open)))
    return null;
  // `///`, `//!` and `#:` are markers of their own, not text after `//` or `#`.
  const lineComment = tokens?.line && new RegExp(`^${escape(tokens.line)}[^\\s\\w]*`).exec(rest);
  if (lineComment && inComment(state, at)) return indent + lineComment[0];
  if (/^\*(?!\/)/.test(rest) && inComment(state, at)) return indent + "*";
  return null;
}

/** The text of `line` after `marker`, or `null` if the line isn't part of a paragraph with that marker. */
function contentOf(state: EditorState, line: Line, marker: string): string | null {
  if (markerOf(state, line) !== marker) return null;
  const text = line.text.slice(marker.length).trim();
  return text && !text.includes("*/") ? text : null;
}

const solid = (s: string) => s.replace(/\s/g, "").length;

export function fillParagraph(view: EditorView, width: number): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const head = state.selection.main.head;
  const caretLine = state.doc.lineAt(head);
  const marker = markerOf(state, caretLine);
  if (marker == null || contentOf(state, caretLine, marker) == null) return false;
  // In a comment a `@tag`, `<p>` or list item starts a paragraph of its own.
  const starts = (n: number) =>
    !!marker.trim() && /^(?:@|<\/?(?:p|pre|ul|ol|li)\b)/i.test(contentOf(state, state.doc.line(n), marker) ?? "");
  let first = caretLine.number;
  while (!starts(first) && first > 1 && contentOf(state, state.doc.line(first - 1), marker) != null) first--;
  let last = caretLine.number;
  while (last < state.doc.lines && !starts(last + 1) && contentOf(state, state.doc.line(last + 1), marker) != null)
    last++;

  const prefix = marker + /^[ \t]*/.exec(state.doc.line(first).text.slice(marker.length))![0];
  const lines: string[] = [];
  let current = "";
  let before = 0;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    const text = contentOf(state, line, marker)!;
    if (n < caretLine.number) before += solid(text);
    else if (n === caretLine.number) {
      const offset = head - line.from - marker.length;
      before += offset > 0 ? solid(line.text.slice(marker.length, marker.length + offset)) : 0;
    }
    for (const word of text.split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (current && countColumn(prefix + next, state.tabSize) > width) {
        lines.push(current);
        current = word;
      } else current = next;
    }
  }
  lines.push(current);

  const from = state.doc.line(first).from;
  const to = state.doc.line(last).to;
  const insert = lines.map((l) => prefix + l).join(state.lineBreak);
  if (insert === state.sliceDoc(from, to)) return true;
  // Keep the caret after the same non-blank character of the paragraph's text.
  let caret = from + insert.length;
  for (let i = 0, pos = from, left = before; i < lines.length; i++) {
    const text = lines[i]!;
    if (left <= solid(text)) {
      let k = 0;
      for (let seen = 0; seen < left; k++) if (!/\s/.test(text[k]!)) seen++;
      caret = pos + prefix.length + k;
      break;
    }
    left -= solid(text);
    pos += prefix.length + text.length + 1;
  }
  const changes = state.changes({ from, to, insert });
  const { ranges, mainIndex } = state.selection;
  view.dispatch({
    changes,
    selection: EditorSelection.create(
      ranges.map((r, i) => (i === mainIndex ? EditorSelection.cursor(caret) : r.map(changes))),
      mainIndex,
    ),
    scrollIntoView: true,
    userEvent: "input.fill",
  });
  return true;
}
