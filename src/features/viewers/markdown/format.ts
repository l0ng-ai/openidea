/**
 * Builtin markdown formatting (Reformat Code on .md files): marksman provides
 * no documentFormattingProvider, so formatting used to answer with a "no
 * running language server supports formatting" hint. The normalization is
 * whitespace-level only — trailing spaces, blank-line collapse, one blank line
 * around headings, one space after list markers. Fenced code block contents
 * and indented code blocks are left verbatim.
 */
import { EditorState, type Extension } from "@codemirror/state";
import { CONTRIBUTED_FORMAT, registerEditorContribution, type ContributedFormatter } from "@/editor/api";

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** A line that only repeats the opening fence's character and is at least as long. */
function closingFence(line: string, fence: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match !== null && match[1]![0] === fence[0] && match[1]!.length >= fence.length;
}

/**
 * One non-fence line with fewer than 4 leading spaces: trailing whitespace
 * gone, heading and list markers collapsed to their single-space form.
 */
function normalizeLine(line: string): string {
  let t = line.replace(/[ \t]+$/, "");
  const heading = /^( {0,3}#{1,6})[ \t]+(\S.*?)[ \t]*$/.exec(t) ?? /^( {0,3}#{1,6})[ \t]+$/.exec(t);
  if (heading) t = heading[2] ? `${heading[1]} ${heading[2]}` : heading[1]!;
  const item = /^( {0,3})(?:([-*+])|(\d{1,9})([.)]))[ \t]+(\S.*?)[ \t]*$/.exec(t);
  if (item) t = `${item[1]}${item[2] ?? `${item[3]}${item[4]}`} ${item[5]}`;
  return t;
}

function isAtxHeading(line: string): boolean {
  return /^ {0,3}#{1,6}([ \t].*)?$/.test(line);
}

/**
 * Normalizes a block of markdown lines. `edges` also strips blank lines at the
 * start and end of the block and inserts the blank lines around headings;
 * selection formatting passes false so no lines are added or removed.
 */
export function formatMarkdownBlock(text: string, edges = true): string {
  const endsWithNewline = text.endsWith("\n");
  const raw = (endsWithNewline ? text.slice(0, -1) : text).split("\n");

  type Line = { text: string; fence: boolean; blank: boolean };
  const lines: Line[] = [];
  let fence: string | null = null;
  for (const line of raw) {
    if (fence) {
      lines.push({ text: line, fence: true, blank: false });
      if (closingFence(line, fence)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = open[1]!;
      lines.push({ text: line.replace(/[ \t]+$/, ""), fence: false, blank: false });
      continue;
    }
    // A 4-space indent can start an indented code block: whitespace trim only.
    const indent = line.length - line.trimStart().length;
    const normalized = indent >= 4 ? line.replace(/[ \t]+$/, "") : normalizeLine(line);
    lines.push({ text: normalized, fence: false, blank: normalized === "" });
  }

  // Collapse runs of blank lines to one and drop them at the block edges.
  const squeezed: Line[] = [];
  for (const [i, line] of lines.entries()) {
    if (line.blank && (squeezed.at(-1)?.blank || (edges && (i === 0 || i === lines.length - 1)))) continue;
    squeezed.push(line);
  }
  if (edges) while (squeezed[0]?.blank) squeezed.shift();
  if (edges) while (squeezed.at(-1)?.blank) squeezed.pop();

  // One blank line around ATX headings, never right at a block edge.
  const spaced: string[] = [];
  for (const [i, line] of squeezed.entries()) {
    if (!line.fence && isAtxHeading(line.text)) {
      if (edges && i !== 0 && spaced.at(-1) && spaced.at(-1) !== "") spaced.push("");
      spaced.push(line.text);
      const next = squeezed[i + 1];
      if (edges && i !== squeezed.length - 1 && next && !next.fence && !next.blank) spaced.push("");
    } else {
      spaced.push(line.text);
    }
  }
  return spaced.join("\n") + (endsWithNewline ? "\n" : "");
}

/** Reformat Code for one markdown editor: whole document or the selection. */
function markdownFormatter(): ContributedFormatter {
  return (state, range) => {
    if (range) {
      const fromLine = state.doc.lineAt(range.from);
      const toLine = state.doc.lineAt(range.to);
      const slice = state.sliceDoc(fromLine.from, toLine.to);
      return [{ from: fromLine.from, to: toLine.to, insert: formatMarkdownBlock(slice, false) }];
    }
    return [{ from: 0, to: state.doc.length, insert: formatMarkdownBlock(state.doc.toString(), true) }];
  };
}

function markdownFormatExtensions(): Extension {
  return EditorState.languageData.of(() => [{ [CONTRIBUTED_FORMAT]: markdownFormatter() }]);
}

/** Registers the .md formatter; a no-op extension for every other language. */
export function registerMarkdownFormat(): () => void {
  return registerEditorContribution({
    id: "markdown.format",
    order: 60,
    extensions: (ctx) => (ctx.language === "markdown" ? markdownFormatExtensions() : []),
  });
}
