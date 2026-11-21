/**
 * Smart Keys › Enter › Insert documentation comment stub: Enter right after a `/**` that opens a
 * new comment closes it, the caret on the summary line. In PHP the stub of a function lists its
 * parameters (`@param`) and return type (`@return`), as PhpStorm does; in Java a method's,
 * constructor's or generic type's parameters, return value and exceptions, as IDEA does.
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

/** Index just past the bracket matching the one at `open` (`(` / `<`), else -1. */
function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "<": ">", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

const JAVA_MODIFIERS =
  /^(public|protected|private|static|final|abstract|synchronized|native|default|strictfp|sealed|non-sealed|transient|volatile)\s+/;

/** Drops leading annotations (`@Override`, `@SuppressWarnings("x")`) and modifiers. */
function javaDeclaration(text: string): string {
  let s = text.trimStart();
  for (;;) {
    const a = /^@(?!interface\b)[\w.]+\s*/.exec(s);
    if (a) {
      s = s.slice(a[0].length);
      if (s.startsWith("(")) {
        const end = closing(s, 0);
        if (end < 0) return "";
        s = s.slice(end);
      }
      s = s.trimStart();
      continue;
    }
    const m = JAVA_MODIFIERS.exec(s);
    if (!m) return s;
    s = s.slice(m[0].length);
  }
}

/** Type parameter names of `<T extends A, U>`. */
function typeParams(list: string): string[] {
  return splitTopLevel(list.slice(1, -1), true).flatMap((p) => /^\s*(\w+)/.exec(p)?.[1] ?? []);
}

/** Parameter names of `(final int a, Map<K, V>... b)`. */
function paramNames(list: string): string[] {
  return splitTopLevel(list.slice(1, -1), true).flatMap((p) => /(\w+)\s*(\[\s*\])*\s*$/.exec(p.trim())?.[1] ?? []);
}

/** `@param` / `@return` / `@throws` lines for the Java declaration in `text` (the code below the `/**`). */
export function javaDocTags(text: string): string[] {
  const s = javaDeclaration(text);
  const type = /^(class|interface|record|enum|@interface)\s+\w+\s*/.exec(s);
  if (type) {
    let rest = s.slice(type[0].length);
    const tags: string[] = [];
    let generics: string[] = [];
    if (rest.startsWith("<")) {
      const end = closing(rest, 0);
      if (end < 0) return [];
      generics = typeParams(rest.slice(0, end));
      rest = rest.slice(end).trimStart();
    }
    // A record's components come first, as IDEA lists them.
    if (type[1] === "record" && rest.startsWith("(")) {
      const end = closing(rest, 0);
      if (end > 0) tags.push(...paramNames(rest.slice(0, end)).map((n) => `@param ${n}`));
    }
    return [...tags, ...generics.map((g) => `@param <${g}>`)];
  }
  let rest = s;
  let generics: string[] = [];
  if (rest.startsWith("<")) {
    const end = closing(rest, 0);
    if (end < 0) return [];
    generics = typeParams(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  const open = rest.indexOf("(");
  if (open < 0) return [];
  const head = rest.slice(0, open).trim();
  // `Type name` for a method, a lone `Name` for a constructor; anything else is not a declaration.
  const m = /^(?:([\w$.]+(?:\s*<.*>)?(?:\s*\[\s*\])*)\s+)?([\w$]+)$/.exec(head);
  if (!m || /^(return|throw|new|else|case|yield|assert)$/.test(m[1] ?? "")) return [];
  const end = closing(rest, open);
  if (end < 0) return [];
  const returnType = m[1];
  const tags = paramNames(rest.slice(open, end)).map((n) => `@param ${n}`);
  tags.push(...generics.map((g) => `@param <${g}>`));
  if (returnType && returnType !== "void") tags.push("@return");
  const throws = /^\s*throws\s+([\w$.,\s<>]+?)\s*(?:\{|;|$)/.exec(rest.slice(end));
  if (throws) tags.push(...splitTopLevel(throws[1]!, true).map((t) => `@throws ${t.trim()}`));
  return tags;
}

function splitTopLevel(params: string, angles = false): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (c === "(" || c === "[" || (angles && c === "<")) depth++;
    else if (c === ")" || c === "]" || (angles && c === ">")) depth--;
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
    const head = below.slice(0, 4000);
    const tags = language === "php" ? phpDocTags(head) : language === "java" ? javaDocTags(head) : [];
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
