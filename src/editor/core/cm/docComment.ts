/**
 * Smart Keys › Enter › Insert documentation comment stub: Enter right after a `/**` that opens a
 * new comment closes it, the caret on the summary line. In PHP the stub of a function lists its
 * parameters (`@param`) and return type (`@return`), as PhpStorm does; in Java a method's,
 * constructor's or generic type's parameters, return value and exceptions, as IDEA does; in
 * JavaScript / TypeScript a function's parameters and result, as WebStorm does.
 */
import { ensureSyntaxTree, language, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
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

const C_SPECIFIERS =
  /^(static|inline|extern|virtual|explicit|constexpr|consteval|friend|const|volatile|unsigned|signed|long|short|struct|enum|union|\[\[[^\]]*\]\])\s+/;

/**
 * Doxygen tags for the C / C++ function declared at the start of `text`: `@param` per named
 * parameter (default values and arrays dropped, `void` and `...` skipped) and `@return` unless it
 * returns `void` or is a constructor / destructor. A type, a call or a statement gets none.
 */
export function cDocTags(text: string): string[] {
  let s = text.trimStart();
  if (/^template\s*</.test(s)) {
    const end = closing(s, s.indexOf("<"));
    if (end < 0) return [];
    s = s.slice(end).trimStart();
  }
  for (let m = C_SPECIFIERS.exec(s); m; m = C_SPECIFIERS.exec(s)) s = s.slice(m[0].length);
  const open = s.indexOf("(");
  if (open < 0) return [];
  const head = s.slice(0, open).trim();
  // `Type name`, `Type *name`, `Type Class::name`, or a lone `Name` / `~Name` for constructors.
  const m = /^(?:([\w:<>,\s*&]+?)\s*([*&]+\s*|\s+))?((?:[\w:]*(?:<[^()]*>)?::)?~?\w+)$/.exec(head);
  const statement = /^(return|if|while|for|switch|sizeof|case|else|do|new|delete|throw|goto)$/;
  if (!m || statement.test(m[3]!) || statement.test((m[1] ?? "").trim().split(/\s+/)[0]!)) return [];
  const end = closing(s, open);
  if (end < 0 || !/^\s*(const\s*)?(noexcept\s*)?(override\s*)?(->\s*[^{;]+)?(:[^{;]*)?\s*(\{|;|$)/.test(s.slice(end)))
    return [];
  const params = splitTopLevel(s.slice(open + 1, end - 1), true).flatMap((p) => {
    const t = p.replace(/=.*$/s, "").trim();
    if (!t || t === "void" || t === "...") return [];
    // A parameter without a name (`int`) has nothing to document.
    const name = /(\w+)\s*(\[[^\]]*\]\s*)*$/.exec(t)?.[1];
    return name && /[\s*&]/.test(t) ? [name] : [];
  });
  const tags = params.map((n) => `@param ${n}`);
  const returnType = (m[1] ?? "").trim();
  if (returnType && !(returnType === "void" && !(m[2] ?? "").includes("*"))) tags.push("@return");
  return tags;
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

/** Splits `params` at top-level commas (any bracket, `<>` included). */
function splitParams(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < params.length; i++) {
    const c = params[i]!;
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c) && params[i - 1] !== "=") depth--;
    else if (c === "," && depth === 0) {
      out.push(params.slice(start, i));
      start = i + 1;
    }
  }
  out.push(params.slice(start));
  return out.map((p) => p.trim()).filter(Boolean);
}

/** The parameter list after the `(` at `open` in `text`, and what follows it; null when unclosed. */
function paramList(text: string, open: number): { params: string; after: string } | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { params: text.slice(open + 1, i), after: text.slice(i + 1) };
  }
  return null;
}

/** The JSDoc type of a default value (`= "a"`, `= 1`, `= []`, `= new Map()`), when it shows one. */
function defaultType(value: string): string | undefined {
  if (/^["'`]/.test(value)) return "string";
  if (/^-?\.?\d[\w.]*$/.test(value)) return value.endsWith("n") ? "bigint" : "number";
  if (/^(true|false)$/.test(value)) return "boolean";
  if (value.startsWith("[")) return "Array";
  if (value.startsWith("{")) return "Object";
  return /^new\s+([\w$.]+)/.exec(value)?.[1];
}

/** Code with string literals and comments emptied, so their text is not read as code. */
const STRINGS_AND_COMMENTS = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g;
/** What ends right before the `{` of a nested function body: `=>`, `function f(…)` or a method `f(…)`. */
const NESTED_BODY =
  /(?:=>|\bfunction\b[^{};]*|(?:^|[^\w$.])(?!(?:if|for|await|while|switch|catch|with)\b)[\w$]+\s*\([^(){};]*\))\s*$/;

/**
 * Whether the block at the start of `code` returns a value (`return x`), not counting the
 * functions declared in it.
 */
// A text scan, not a parse: a regex literal or a `${}` with braces in a template can mislead it.
function returnsValue(code: string): boolean {
  const s = code.replace(STRINGS_AND_COMMENTS, '""');
  let depth = 0;
  let nested = Infinity;
  for (const m of s.matchAll(/[{}]|\breturn\b[ \t]*([^\s;}])?/g)) {
    if (m[0] === "{") {
      depth++;
      if (depth > 1 && nested === Infinity && NESTED_BODY.test(s.slice(Math.max(0, m.index - 200), m.index)))
        nested = depth;
    } else if (m[0] === "}") {
      if (depth === nested) nested = Infinity;
      if (--depth <= 0) return false;
    } else if (m[1] && depth > 0 && nested === Infinity) return true;
  }
  return false;
}

/**
 * The declared result type in `after` (the code after a parameter list) and the body that follows
 * it: a block for a method or function declaration, `=>` for an arrow. Null when neither follows.
 */
function signature(after: string): { declared?: string; arrow: boolean; body: string } | null {
  let s = after.trimStart();
  let declared: string | undefined;
  if (s.startsWith(":")) {
    let depth = 0;
    let i = 1;
    for (; i < s.length; i++) {
      const arrow = s.startsWith("=>", i);
      // A `{` ends the type once some type is there (`{ x: number } {`, not `A | {`).
      if (depth === 0 && (arrow || (s[i] === "{" && /[^\s|&:,]\s*$/.test(s.slice(1, i))))) break;
      if (arrow) i++;
      else if ("{(<[".includes(s[i]!)) depth++;
      else if ("})>]".includes(s[i]!) && --depth < 0) return null;
    }
    declared = s.slice(1, i).trim();
    s = s.slice(i);
  }
  if (s.startsWith("=>")) return { declared, arrow: true, body: s.slice(2).trimStart() };
  return s.startsWith("{") ? { declared, arrow: false, body: s } : null;
}

/**
 * `@param` / `@returns` lines for the JavaScript / TypeScript function declared in `text`, as
 * WebStorm writes them: rest parameters as `...name`, a destructured one as `options`, and in
 * JavaScript (`withTypes`) the `{type}` a default value shows. `@returns` when a declared result
 * isn't void, or without one when the body returns a value; never for a constructor.
 */
export function jsDocTags(text: string, withTypes = false): string[] {
  const head = text.trimStart();
  const decl =
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([\w$]*)\s*(?:<[^(]*>)?\s*(?=\()/.exec(head) ??
    /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?(?:<[^(]*>)?\s*(?=\(|[\w$]+\s*=>)/.exec(
      head,
    ) ??
    /^(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set)\s+)*\*?\s*(?!(?:if|for|while|switch|catch|return|function)\b)([\w$]+)\s*(?:<[^(]*>)?\s*(?=\()/.exec(
      head,
    );
  if (!decl) return [];
  // `x => …`: a single parameter without parentheses.
  const bare = /^([\w$]+)\s*=>/.exec(head.slice(decl[0].length));
  const list = bare
    ? { params: bare[1]!, after: head.slice(decl[0].length + bare[1]!.length) }
    : paramList(head, decl[0].length);
  if (!list) return [];
  const sig = signature(list.after);
  if (!sig) return [];
  let destructured = 0;
  const tags = splitParams(list.params).flatMap((param) => {
    const p = param.replace(/^(?:(?:public|private|protected|readonly|override)\s+)*/, "");
    const rest = p.startsWith("...") ? "..." : "";
    const q = p.slice(rest.length).trimStart();
    let name: string;
    let tail: string;
    if (q[0] === "{" || q[0] === "[") {
      let depth = 0;
      let end = 0;
      for (; end < q.length; end++) {
        if ("{[(".includes(q[end]!)) depth++;
        else if ("}])".includes(q[end]!) && --depth === 0) break;
      }
      name = `options${destructured++ || ""}`;
      tail = q.slice(end + 1);
    } else {
      const n = /^[\w$]+/.exec(q)?.[0];
      if (!n || n === "this") return [];
      name = n;
      tail = q.slice(n.length);
    }
    const value = /^\s*\??\s*(?::[^=]*)?=\s*([\s\S]+)$/.exec(tail)?.[1];
    const type = withTypes && !rest && value ? defaultType(value.trim()) : undefined;
    return [type ? `@param {${type}} ${rest}${name}` : `@param ${rest}${name}`];
  });
  if (decl[1] === "constructor") return tags;
  const declared = sig.declared?.replace(/\s+/g, "");
  // An arrow's expression body is its result.
  const returns = declared
    ? !/^(void|undefined|never|Promise<void>)$/.test(declared)
    : (sig.arrow && !sig.body.startsWith("{")) || returnsValue(sig.body);
  if (returns) tags.push("@returns");
  return tags;
}

/** Python docstring formats (Settings › Python › Docstrings). */
export type PythonDocFormat = "plain" | "rest" | "epytext" | "google" | "numpy";

function pythonRaises(body: SyntaxNode, text: string): string[] {
  const names = new Set<string>();
  body.cursor().iterate((node) => {
    if (node.name === "FunctionDefinition" || node.name === "ClassDefinition") return false;
    if (node.name !== "RaiseStatement") return;
    let target = node.node.firstChild?.nextSibling;
    while (target?.name === "CallExpression" || target?.name === "ParenthesizedExpression") {
      target = target.name === "CallExpression" ? target.firstChild : target.firstChild?.nextSibling;
    }
    if (target?.name === "VariableName" || target?.name === "MemberExpression") {
      names.add(text.slice(target.from, target.to));
    }
    return false;
  });
  return [...names];
}

/** The lines below a Python function docstring's summary. */
export function pythonDocStub(text: string, owner: SyntaxNode, format: PythonDocFormat): string[] {
  if (format === "plain" || owner.name !== "FunctionDefinition") return [];
  const params: string[] = [];
  let start = true;
  for (let param = owner.getChild("ParamList")?.firstChild; param; param = param.nextSibling) {
    if (param.name === ",") start = true;
    if (!start || param.name !== "VariableName") continue;
    const name = text.slice(param.from, param.to);
    if (name !== "self" && name !== "cls") params.push(name);
    start = false;
  }
  const name = owner.getChild("VariableName");
  const annotation = owner.getChild("TypeDef");
  const returnType = annotation && text.slice(annotation.from + 2, annotation.to);
  const returns =
    !!name && text.slice(name.from, name.to) !== "__init__" && returnType?.replace(/[()\s]/g, "") !== "None";
  const body = owner.getChild("Body");
  const raises = body ? pythonRaises(body, text) : [];
  switch (format) {
    case "rest":
    case "epytext": {
      const [mark, raise] = format === "rest" ? [":", ":raises"] : ["@", "@raise"];
      return [
        ...params.map((p) => `${mark}param ${p}:`),
        ...(returns ? [`${mark}return:`] : []),
        ...raises.map((r) => `${raise} ${r}:`),
      ];
    }
    case "google": {
      const sections = [
        params.length ? ["Args:", ...params.map((p) => `    ${p}:`)] : [],
        returns ? ["Returns:", ""] : [],
        raises.length ? ["Raises:", ...raises.map((r) => `    ${r}:`)] : [],
      ].filter((s) => s.length);
      return sectioned(sections);
    }
    case "numpy": {
      const sections = [
        params.length ? ["Parameters", "----------", ...params] : [],
        returns ? ["Returns", "-------", ""] : [],
        raises.length ? ["Raises", "------", ...raises] : [],
      ].filter((s) => s.length);
      return sectioned(sections);
    }
  }
}

/** Sections after a blank line below the summary, one blank line apart (a trailing blank line of a section kept once). */
function sectioned(sections: string[][]): string[] {
  const out: string[] = [];
  for (const s of sections) {
    if (out[out.length - 1] !== "") out.push("");
    out.push(...s);
  }
  return out;
}

/**
 * Enter between the quotes of a `"""` docstring opened right under a `def` or `class` (or `"""`
 * alone at its end): the docstring's lines with the function's parameters, return value and raised
 * exceptions in `format`, as PyCharm does.
 */
export function enterInDocstring(format: () => PythonDocFormat): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const before = line.text.slice(0, head - line.from);
    const after = line.text.slice(head - line.from);
    const quote = /^\s*("""|''')$/.exec(before)?.[1];
    if (!quote || (after.trim() && after.trim() !== quote)) return false;
    const indent = /^\s*/.exec(before)![0];
    const literal = ensureSyntaxTree(state, line.to, 50)?.resolveInner(head - quote.length, 1);
    const statement = literal?.parent;
    const body = statement?.parent;
    const owner = body?.parent;
    if (
      literal?.name !== "String" ||
      literal.from !== head - quote.length ||
      statement?.name !== "ExpressionStatement" ||
      body?.name !== "Body" ||
      (owner?.name !== "FunctionDefinition" && owner?.name !== "ClassDefinition")
    )
      return false;
    for (let prev = statement.prevSibling; prev; prev = prev.prevSibling) {
      if (prev.name !== ":" && prev.name !== "Comment") return false;
    }
    const br = state.lineBreak;
    const style = format();
    let tags: string[] = [];
    if (style !== "plain" && owner.name === "FunctionDefinition") {
      // Close the opener in a temporary parse so an unfinished literal doesn't swallow the body.
      const end = state.doc.line(Math.min(state.doc.lines, line.number + 2000)).to;
      const text = state.sliceDoc(owner.from, head) + quote + state.sliceDoc(line.to, end);
      const parsed = state.facet(language)?.parser.parse(text).topNode.firstChild;
      if (parsed) tags = pythonDocStub(text, parsed, style);
    }
    const summary = `${br}${indent}`;
    const insert = summary + tags.map((t) => br + (t ? indent + t : "")).join("") + `${br}${indent}${quote}`;
    view.dispatch({
      changes: { from: head, to: line.to, insert },
      selection: EditorSelection.cursor(head + summary.length),
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  };
}

/**
 * Whether the comments at `pos` include `/* *\/` ones. Embedded languages list several comment
 * styles there (PHP after HTML's `<!-- -->`), so every entry counts, not only the first.
 */
function hasCBlockComments(state: EditorState, pos: number): boolean {
  return state
    .languageDataAt<{ block?: { open: string; close: string } }>("commentTokens", pos)
    .some((t) => t.block?.open === "/*" && t.block.close === "*/");
}

/** The Enter command for documents of `language` (stub tags in PHP). */
export function enterInDocComment(language: string | undefined): Command {
  return (view) => {
    const { state } = view;
    if (state.readOnly || state.selection.ranges.length !== 1) return false;
    const r = state.selection.main;
    if (!r.empty) return false;
    // Lezer PHP leaves `<?php` + an unclosed `/**` to the HTML around it, whose comments are
    // `<!-- -->`; PHP code always takes `/* */`.
    if (language !== "php" && !hasCBlockComments(state, r.head)) return false;
    const line = state.doc.lineAt(r.head);
    const before = line.text.slice(0, r.head - line.from);
    if (before.trim() !== "/**" || line.text.slice(r.head - line.from).trim()) return false;
    // A `/**` that already starts a doc block (the next line continues it) only breaks the line.
    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text.trimStart() : "";
    if (next.startsWith("*")) return false;
    const indent = /^[ \t]*/.exec(before)![0];
    const br = state.lineBreak;
    const below = line.number < state.doc.lines ? state.sliceDoc(state.doc.line(line.number + 1).from) : "";
    const code = below.slice(0, 4000);
    const tags =
      language === "php"
        ? phpDocTags(code)
        : language === "java"
          ? javaDocTags(code)
          : /^(java|type)script(react)?$/.test(language ?? "")
            ? jsDocTags(code, language!.startsWith("javascript"))
            : /^(c|cpp|objective-c|objective-cpp)$/.test(language ?? "")
              ? cDocTags(code)
              : [];
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
