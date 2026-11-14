/**
 * Smart Keys › Enter › Insert documentation comment stub: Enter right after a `/**` that opens a
 * new comment closes it, the caret on the summary line. In PHP the stub of a function lists its
 * parameters (`@param`) and return type (`@return`), as PhpStorm does.
 */
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { Command } from "@codemirror/view";

/** `@param` / `@return` lines for the PHP function declared in `text` (the code below the `/**`). */
export function phpDocTags(text: string): string[] {
  const m =
    /^\s*(?:#\[[^\]]*\]\s*)*(?:(?:abstract|final|public|protected|private|static)\s+)*function\s+&?\s*(\w+)\s*\(/.exec(
      text,
    );
  if (!m) return [];
  let depth = 1;
  let i = m[0].length;
  for (; i < text.length && depth > 0; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
  }
  if (depth > 0) return [];
  const tags = splitTopLevel(text.slice(m[0].length, i - 1)).flatMap((param) => {
    const p = /^(?:#\[[^\]]*\]\s*)*(?:(?:public|protected|private|readonly)\s+)*([^$=.]*?)\s*(\.\.\.)?\s*(\$\w+)/.exec(
      param.trim(),
    );
    if (!p) return [];
    // `&$x` passes by reference: the `&` belongs to no type (`Foo&Bar` is an intersection).
    const type = p[1]!.replace(/&\s*$/, "").trim().replace(/\s+/g, " ");
    const name = (p[2] ?? "") + p[3];
    return [type ? `@param ${type} ${name}` : `@param ${name}`];
  });
  const ret = /^\s*:\s*([?\w\\|&() ]+?)\s*(?:\{|;|$)/.exec(text.slice(i));
  const type = ret?.[1]?.trim();
  if (type && type !== "void" && m[1] !== "__construct") tags.push(`@return ${type}`);
  return tags;
}

function splitTopLevel(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(params.slice(start, i));
      start = i + 1;
    }
  }
  out.push(params.slice(start));
  return out.filter((p) => p.trim());
}

/** The Enter command for documents of `language` (stub tags in PHP). */
export function enterInDocComment(language: string | undefined): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly || state.selection.ranges.length !== 1) return false;
    const r = state.selection.main;
    if (!r.empty) return false;
    const block = state.languageDataAt<{ block?: { open: string; close: string } }>("commentTokens", r.head)[0]?.block;
    if (block?.open !== "/*" || block.close !== "*/") return false;
    const line = state.doc.lineAt(r.head);
    const before = line.text.slice(0, r.head - line.from);
    if (before.trim() !== "/**" || line.text.slice(r.head - line.from).trim()) return false;
    // A `/**` that already starts a doc block (the next line continues it) only breaks the line.
    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text.trimStart() : "";
    if (next.startsWith("*")) return false;
    const indent = /^[ \t]*/.exec(before)![0];
    const br = state.lineBreak;
    const below = line.number < state.doc.lines ? state.sliceDoc(state.doc.line(line.number + 1).from) : "";
    const tags = language === "php" ? phpDocTags(below.slice(0, 4000)) : [];
    const summary = `${br}${indent} * `;
    const insert = summary + tags.map((t) => `${br}${indent} * ${t}`).join("") + `${br}${indent} */`;
    view.dispatch(
      state.update({
        changes: { from: r.head, insert },
        selection: EditorSelection.cursor(r.head + summary.length),
        scrollIntoView: true,
        userEvent: "input",
      }),
    );
    return true;
  };
}

/** How far back the opening `/*` of the comment around the caret is looked for. */
const OPENER_SCAN = 20_000;

/** Whether `pos` is inside a `/* *\/` comment opened at `open` (by the syntax tree, when it has one there). */
function inBlockComment(state: EditorState, pos: number): number | null {
  const from = Math.max(0, pos - OPENER_SCAN);
  const before = state.sliceDoc(from, pos);
  const open = before.lastIndexOf("/*");
  if (open < 0 || before.indexOf("*/", open + 2) >= 0) return null;
  const node = syntaxTree(state).resolveInner(pos, -1);
  // A parsed document says whether this `/*` opens the comment (not text in a string or a `//`).
  if (node.parent && !(/comment/i.test(node.name) && node.from === from + open)) return null;
  return from + open;
}

/**
 * Enter inside a `/* *\/` comment, on its first line or on a line that starts with `*`: the new
 * line starts with `* ` aligned under the comment's asterisks, as IDEA's leading asterisks do.
 */
export const enterInBlockComment: Command = (view) => {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length !== 1) return false;
  const r = state.selection.main;
  if (!r.empty) return false;
  const block = state.languageDataAt<{ block?: { open: string; close: string } }>("commentTokens", r.head)[0]?.block;
  if (block?.open !== "/*" || block.close !== "*/") return false;
  const open = inBlockComment(state, r.head);
  if (open === null) return false;
  const line = state.doc.lineAt(r.head);
  const before = line.text.slice(0, r.head - line.from);
  const after = line.text.slice(r.head - line.from);
  let prefix: string;
  if (open >= line.from) {
    // The opening line: the asterisks go one column right of the `/`.
    prefix = line.text.slice(0, open - line.from).replace(/[^\t]/g, " ") + " ";
  } else {
    const star = /^([ \t]*)\*(?!\/)/.exec(line.text);
    if (!star || star[0].length > before.length) return false;
    prefix = star[1]!;
  }
  const br = state.lineBreak;
  const rest = after.trimStart();
  const insert = rest.startsWith("*/") ? `${br}${prefix}* ${br}${prefix}` : `${br}${prefix}* `;
  // Spaces around the break go, as a plain Enter drops them.
  const from = r.head - (before.length - before.trimEnd().length);
  const caret = from + br.length + prefix.length + 2;
  view.dispatch(
    state.update({
      changes: { from, to: r.head + (after.length - rest.length), insert },
      selection: EditorSelection.cursor(caret),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};
