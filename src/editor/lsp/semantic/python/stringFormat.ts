/**
 * PyCharm's "Convert to f-string literal" and "Replace with str.format() call"
 * on `%`-formatting and `str.format()` calls. A conversion that could change
 * what the code does, or produce code an older Python rejects, is not offered.
 * As in PyCharm, a single `%` operand that is not a tuple literal is taken as one
 * value: a variable holding a tuple would format differently after conversion.
 */
import { syntaxTree } from "@codemirror/language";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import type { ContributedIntention } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { docOf } from "../../lsp";

export interface StringConversion {
  kind: "fString" | "format";
  from: number;
  to: number;
  text: string;
}

interface Field {
  /** Auto-numbered (null), positional index or keyword. */
  key: number | string | null;
  /** `.attr` / `[0]` accessors after the field name. */
  tail: string;
  conv: string;
  spec: string;
  /** A `%d`/`%i`/`%u` field: `%` truncates a float with `int()`, a `d` format spec raises. */
  int?: boolean;
}
/** Literal text, already brace-escaped as it appears in the result. */
type Part = string | Field;

interface Arg {
  text: string;
  node: SyntaxNode | null;
}

interface Literal {
  prefix: string;
  raw: boolean;
  quote: string;
  body: string;
}

function literal(text: string): Literal | null {
  const prefix = /^[A-Za-z]*/.exec(text)![0];
  if (/[bBfFtT]/.test(prefix)) return null;
  const rest = text.slice(prefix.length);
  const quote = rest.startsWith('"""') || rest.startsWith("'''") ? rest.slice(0, 3) : rest[0]!;
  return {
    prefix: prefix.replace(/[uU]/, ""),
    raw: /[rR]/.test(prefix),
    quote,
    body: rest.slice(quote.length, rest.length - quote.length),
  };
}

/** Comma-separated groups of `node`'s children, brackets dropped. */
function groups(node: SyntaxNode): SyntaxNode[][] {
  const out: SyntaxNode[][] = [[]];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (/^[([{]$|^[)\]}]$/.test(c.name)) continue;
    if (c.name === ",") out.push([]);
    else out[out.length - 1]!.push(c);
  }
  return out.filter((g) => g.length);
}

const argOf = (doc: Text, g: SyntaxNode[]): Arg => ({
  text: doc.sliceString(g[0]!.from, g[g.length - 1]!.to),
  node: g.length === 1 ? g[0]! : null,
});

const escapeBraces = (s: string) => s.replace(/[{}]/g, "$&$&");

/** Length of a `\\` or `\N{NAME}` escape at `i` of a non-raw literal; its braces are not fields. */
function escapeLength(body: string, i: number): number {
  if (body[i] !== "\\") return 0;
  if (body[i + 1] === "\\") return 2;
  if (body[i + 1] !== "N" || body[i + 2] !== "{") return 0;
  const end = body.indexOf("}", i);
  return end < 0 ? 0 : end + 1 - i;
}

const PERCENT = /%(?:\((\w+)\))?([#0 +-]*)(\d+)?(?:\.(\d+))?[hlL]?([diouxXeEfFgGrsa%])/y;

/** The fields of a `%` format string; null when a conversion has no f-string equivalent. */
export function percentParts(body: string, raw = false): Part[] | null {
  const parts: Part[] = [];
  let text = "";
  for (let i = 0; i < body.length;) {
    const escape = raw ? 0 : escapeLength(body, i);
    if (escape) {
      text += body.slice(i, i + escape);
      i += escape;
      continue;
    }
    if (body[i] !== "%") {
      text += escapeBraces(body[i++]!);
      continue;
    }
    PERCENT.lastIndex = i;
    const m = PERCENT.exec(body);
    if (!m) return null;
    i = PERCENT.lastIndex;
    const [all, key, flags = "", width = "", precision] = m;
    const type = m[5]!;
    if (type === "%") {
      if (all !== "%%") return null;
      text += "%";
      continue;
    }
    const prec = precision === undefined ? "" : `.${precision}`;
    // An integer's `%` precision pads with zeros; a format spec rejects it.
    if (prec && "diuoxX".includes(type)) return null;
    const int = "diu".includes(type);
    let conv = "";
    let spec: string;
    if ("sra".includes(type)) {
      conv = type === "s" && !width && !prec ? "" : `!${type}`;
      spec = (width ? (flags.includes("-") ? "<" : ">") : "") + width + prec;
    } else {
      const align = flags.includes("-") ? "<" : "";
      const sign = flags.includes("+") ? "+" : flags.includes(" ") ? " " : "";
      const zero = flags.includes("0") && !align && width ? "0" : "";
      const rest = align + sign + (flags.includes("#") ? "#" : "") + zero + width + prec;
      spec = int ? rest && `${rest}d` : rest + type;
    }
    parts.push(text, { key: key ?? null, tail: "", conv, spec: spec && `:${spec}`, ...(int && { int }) });
    text = "";
  }
  parts.push(text);
  return parts;
}

const FIELD = /^(\d+|[A-Za-z_]\w*)?((?:\.[A-Za-z_]\w*|\[\d+\])*)(![rsa])?(:[^{}]*)?$/;

/** The fields of a `str.format` string; null for nested or malformed fields. */
export function formatParts(body: string, raw = false): Part[] | null {
  const parts: Part[] = [];
  let text = "";
  for (let i = 0; i < body.length;) {
    const escape = raw ? 0 : escapeLength(body, i);
    if (escape) {
      text += body.slice(i, i + escape);
      i += escape;
      continue;
    }
    const c = body[i]!;
    if ((c === "{" || c === "}") && body[i + 1] === c) {
      text += c + c;
      i += 2;
      continue;
    }
    if (c === "}") return null;
    if (c !== "{") {
      text += c;
      i++;
      continue;
    }
    const end = body.indexOf("}", i);
    const m = end < 0 ? null : FIELD.exec(body.slice(i + 1, end));
    if (!m) return null;
    const [, name, tail = "", conv = "", spec = ""] = m;
    parts.push(text, { key: name === undefined ? null : /^\d/.test(name) ? Number(name) : name, tail, conv, spec });
    text = "";
    i = end + 1;
  }
  parts.push(text);
  return parts;
}

/** An int literal, or `len()` / `int()` / `ord()`: `%d` of it needs no `int()`. */
function isInt(arg: Arg): boolean {
  const node = arg.node;
  if (node?.name === "Number") return /^(?:\d[\d_]*|0[xob][\da-f_]+)$/i.test(arg.text);
  const callee = node?.name === "CallExpression" ? node.firstChild : null;
  return callee?.name === "VariableName" && /^(?:len|int|ord)\($/.test(arg.text.slice(0, callee.to - node!.from + 1));
}

/** The argument as a `%d` value: wrapped in `int()` unless it is one already. */
function asInt(arg: Arg): Arg {
  if (isInt(arg)) return arg;
  const inner = arg.node?.name === "ParenthesizedExpression" ? arg.text.slice(1, -1) : arg.text;
  return { text: "int(" + inner + ")", node: null };
}

const KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
);

const ATOMIC = new Set(["VariableName", "MemberExpression", "CallExpression", "SubscriptExpression"]);

/** `parts` with each field's argument inlined, or null if that is not safe. */
function inline(parts: Part[], positional: Arg[], keyword: Map<string, Arg>, quote: string): string | null {
  const used = new Map<Arg, number>();
  let next = 0;
  let out = "";
  for (const part of parts) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    if (part.key === null && next < 0) return null;
    if (typeof part.key === "number") {
      if (next > 0) return null;
      next = -1;
    }
    const arg =
      part.key === null
        ? positional[next++]
        : typeof part.key === "number"
          ? positional[part.key]
          : keyword.get(part.key);
    if (!arg) return null;
    used.set(arg, (used.get(arg) ?? 0) + 1);
    const value = part.int ? asInt(arg) : arg;
    const text = value.text;
    // Before Python 3.12 an f-string field cannot hold its quote, a backslash or a comment.
    if (text.includes("\\") || text.includes("#") || text.includes(quote[0]!)) return null;
    if (text.includes("\n") && quote.length === 1) return null;
    const bare = value !== arg || (arg.node && arg.node.name !== "LambdaExpression" && !text.includes(":="));
    let expr = bare ? text : `(${text})`;
    if (part.tail) {
      if ([...part.tail.matchAll(/\.(\w+)/g)].some(([, attr]) => KEYWORDS.has(attr!))) return null;
      const accessors = part.tail.replace(/\[0+(?=\d)/g, "[");
      expr = (arg.node && ATOMIC.has(arg.node.name) ? expr : `(${text})`) + accessors;
    }
    if (expr.startsWith("{")) expr = ` ${expr}`;
    out += `{${expr}${part.conv}${part.spec}}`;
  }
  const all = [...positional, ...keyword.values()];
  // Every argument is evaluated once by the call: unused or repeated side effects would change.
  for (const arg of all) {
    const n = used.get(arg) ?? 0;
    if (n === 0 || (n > 1 && arg.node?.name !== "VariableName")) return null;
  }
  // A call or dict evaluates arguments in source order. Inlining follows field order.
  if (all.some((arg) => arg.node?.name !== "VariableName") && [...used.keys()].some((arg, i) => arg !== all[i]))
    return null;
  return out;
}

/** The `%` operands: positional arguments, or the entries of a dict literal. */
function percentArgs(doc: Text, rhs: SyntaxNode): { positional: Arg[]; keyword: Map<string, Arg> } | null {
  const keyword = new Map<string, Arg>();
  if (rhs.name === "TupleExpression") {
    const items = groups(rhs);
    if (items.some((g) => g[0]!.name === "*")) return null;
    return { positional: items.map((g) => argOf(doc, g)), keyword };
  }
  if (rhs.name === "DictionaryExpression") {
    for (const g of groups(rhs)) {
      const [key, colon, ...value] = g;
      if (key?.name !== "String" || colon?.name !== ":" || !value.length) return null;
      const k = /^["']([A-Za-z_]\w*)["']$/.exec(doc.sliceString(key.from, key.to));
      if (!k || keyword.has(k[1]!)) return null;
      keyword.set(k[1]!, argOf(doc, value));
    }
    return { positional: [], keyword };
  }
  return { positional: [{ text: doc.sliceString(rhs.from, rhs.to), node: rhs }], keyword };
}

function percentConversions(doc: Text, node: SyntaxNode): StringConversion[] {
  const [str, op, rhs] = [node.firstChild, node.firstChild?.nextSibling, node.lastChild];
  if (str?.name !== "String" || op?.name !== "ArithOp" || doc.sliceString(op.from, op.to) !== "%" || !rhs) return [];
  const lit = literal(doc.sliceString(str.from, str.to));
  const parts = lit && percentParts(lit.body, lit.raw);
  const args = rhs && percentArgs(doc, rhs);
  if (!lit || !parts || !args) return [];
  const fields = parts.filter((p): p is Field => typeof p !== "string");
  const named = fields.every((f) => f.key !== null);
  if (named) {
    if (args.positional.length || fields.some((f) => typeof f.key !== "string" || !args.keyword.has(f.key))) return [];
  } else if (args.keyword.size || fields.length !== args.positional.length || fields.some((f) => f.key !== null)) {
    return [];
  }
  const out: StringConversion[] = [];
  const inlined = inline(parts, args.positional, args.keyword, lit.quote);
  if (inlined !== null)
    out.push({
      kind: "fString",
      from: node.from,
      to: node.to,
      text: `${lit.prefix}f${lit.quote}${inlined}${lit.quote}`,
    });
  const body = parts.map((p) => (typeof p === "string" ? p : `{${p.key ?? ""}${p.conv}${p.spec}}`)).join("");
  // `.format(k=…)` needs keys that are not keywords, and a key used as `%d` and as text cannot be both.
  const intKeys = new Set(fields.filter((f) => f.int).map((f) => f.key));
  const mixed = fields.some((f) => !f.int && intKeys.has(f.key));
  if (named && (mixed || [...args.keyword.keys()].some((k) => KEYWORDS.has(k)))) return out;
  const callArgs = named
    ? [...args.keyword].map(([k, v]) => `${k}=${(intKeys.has(k) ? asInt(v) : v).text}`)
    : args.positional.map((a, i) => (fields[i]!.int ? asInt(a) : a).text);
  out.push({
    kind: "format",
    from: node.from,
    to: node.to,
    text: `${lit.prefix}${lit.quote}${body}${lit.quote}.format(${callArgs.join(", ")})`,
  });
  return out;
}

function formatConversion(doc: Text, call: SyntaxNode): StringConversion[] {
  const member = call.firstChild;
  const str = member?.firstChild;
  const name = member?.lastChild;
  const argList = call.getChild("ArgList");
  if (member?.name !== "MemberExpression" || str?.name !== "String" || name?.name !== "PropertyName" || !argList)
    return [];
  if (doc.sliceString(name.from, name.to) !== "format") return [];
  const lit = literal(doc.sliceString(str.from, str.to));
  const parts = lit && formatParts(lit.body, lit.raw);
  if (!lit || !parts) return [];
  const positional: Arg[] = [];
  const keyword = new Map<string, Arg>();
  for (const g of groups(argList)) {
    if (g[0]!.name === "*" || g[0]!.name === "**" || g.some((node) => node.type.isError)) return [];
    if (g[1]?.name === "AssignOp") {
      const key = doc.sliceString(g[0]!.from, g[0]!.to);
      if (!g[2] || keyword.has(key)) return [];
      keyword.set(key, argOf(doc, g.slice(2)));
    } else positional.push(argOf(doc, g));
  }
  const inlined = inline(parts, positional, keyword, lit.quote);
  return inlined === null
    ? []
    : [{ kind: "fString", from: call.from, to: call.to, text: `${lit.prefix}f${lit.quote}${inlined}${lit.quote}` }];
}

/** Conversions of the `%` expression or `.format()` call around `pos`, innermost first. */
export function stringConversions(tree: Tree, doc: Text, pos: number): StringConversion[] {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "BinaryExpression") {
      const found = percentConversions(doc, n);
      if (found.length) return found;
    } else if (n.name === "CallExpression") {
      const found = formatConversion(doc, n);
      if (found.length) return found;
    } else if (/Statement$|^Body$|^Script$/.test(n.name)) break;
  }
  return [];
}

export function pythonStringIntentions(view: EditorView): ContributedIntention[] {
  if (docOf(view)?.uiMode !== "Python" || !view.state.selection.main.empty) return [];
  return stringConversions(syntaxTree(view.state), view.state.doc, view.state.selection.main.head).map((c) => ({
    id: `python.${c.kind}`,
    label: c.kind === "fString" ? tx("Convert to f-string literal") : tx("Replace with str.format() call"),
    icon: "bulb",
    run: () =>
      view.dispatch({ changes: { from: c.from, to: c.to, insert: c.text }, userEvent: "input", scrollIntoView: true }),
  }));
}
