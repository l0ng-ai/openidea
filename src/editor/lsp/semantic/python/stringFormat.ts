/**
 * PyCharm's "Convert to f-string literal" and "Replace with str.format() call"
 * on `%`-formatting and `str.format()` calls. A conversion that could change
 * what the code does, or produce code an older Python rejects, is not offered.
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
}
/** Literal text, already brace-escaped as it appears in the result. */
type Part = string | Field;

interface Arg {
  text: string;
  node: SyntaxNode | null;
}

interface Literal {
  prefix: string;
  quote: string;
  body: string;
}

function literal(text: string): Literal | null {
  const prefix = /^[A-Za-z]*/.exec(text)![0];
  if (/[bBfFtT]/.test(prefix)) return null;
  const rest = text.slice(prefix.length);
  const quote = rest.startsWith('"""') || rest.startsWith("'''") ? rest.slice(0, 3) : rest[0]!;
  return { prefix: prefix.replace(/[uU]/, ""), quote, body: rest.slice(quote.length, rest.length - quote.length) };
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

const PERCENT = /%(?:\((\w+)\))?([#0 +-]*)(\d+)?(?:\.(\d+))?[hlL]?([diouxXeEfFgGrsa%])/y;

/** The fields of a `%` format string; null when a conversion has no f-string equivalent. */
export function percentParts(body: string): Part[] | null {
  const parts: Part[] = [];
  let text = "";
  for (let i = 0; i < body.length;) {
    if (body[i] !== "%") {
      text += body[i++];
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
    let conv = "";
    let spec: string;
    if ("sra".includes(type)) {
      conv = type === "s" && !width && !prec ? "" : `!${type}`;
      spec = (width ? (flags.includes("-") ? "<" : ">") : "") + width + prec;
    } else {
      const align = flags.includes("-") ? "<" : "";
      const sign = flags.includes("+") ? "+" : flags.includes(" ") ? " " : "";
      const zero = flags.includes("0") && !align && width ? "0" : "";
      spec =
        align + sign + (flags.includes("#") ? "#" : "") + zero + width + prec + ("diu".includes(type) ? "d" : type);
    }
    parts.push(escapeBraces(text), { key: key ?? null, tail: "", conv, spec: spec && `:${spec}` });
    text = "";
  }
  parts.push(escapeBraces(text));
  return parts;
}

const FIELD = /^(\d+|[A-Za-z_]\w*)?((?:\.[A-Za-z_]\w*|\[\d+\])*)(![rsa])?(:[^{}]*)?$/;

/** The fields of a `str.format` string; null for nested or malformed fields. */
export function formatParts(body: string): Part[] | null {
  const parts: Part[] = [];
  let text = "";
  for (let i = 0; i < body.length;) {
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
    if (typeof part.key === "number") next = -1;
    const arg =
      part.key === null
        ? positional[next++]
        : typeof part.key === "number"
          ? positional[part.key]
          : keyword.get(part.key);
    if (!arg) return null;
    used.set(arg, (used.get(arg) ?? 0) + 1);
    const text = arg.text;
    // Before Python 3.12 an f-string field cannot hold its quote, a backslash or a comment.
    if (text.includes("\\") || text.includes("#") || text.includes(quote[0]!)) return null;
    if (text.includes("\n") && quote.length === 1) return null;
    const bare = arg.node && arg.node.name !== "LambdaExpression" && !text.includes(":=");
    let expr = bare ? text : `(${text})`;
    if (part.tail) expr = (arg.node && ATOMIC.has(arg.node.name) ? expr : `(${text})`) + part.tail;
    if (expr.startsWith("{")) expr = ` ${expr}`;
    out += `{${expr}${part.conv}${part.spec}}`;
  }
  const all = [...positional, ...keyword.values()];
  // Every argument is evaluated once by the call: unused or repeated side effects would change.
  for (const arg of all) {
    const n = used.get(arg) ?? 0;
    if (n === 0 || (n > 1 && arg.node?.name !== "VariableName")) return null;
  }
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
      if (!k) return null;
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
  const parts = lit && percentParts(lit.body);
  const args = rhs && percentArgs(doc, rhs);
  if (!lit || !parts || !args) return [];
  const fields = parts.filter((p): p is Field => typeof p !== "string");
  const named = fields.every((f) => f.key !== null);
  if (fields.some((f) => (f.key !== null) !== named) || (named ? args.positional.length : args.keyword.size)) return [];
  if (!named && fields.length !== args.positional.length) return [];
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
  const callArgs = named ? [...args.keyword].map(([k, v]) => `${k}=${v.text}`) : args.positional.map((a) => a.text);
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
  const parts = lit && formatParts(lit.body);
  if (!lit || !parts) return [];
  const positional: Arg[] = [];
  const keyword = new Map<string, Arg>();
  for (const g of groups(argList)) {
    if (g[0]!.name === "*" || g[0]!.name === "**") return [];
    if (g[1]?.name === "AssignOp") keyword.set(doc.sliceString(g[0]!.from, g[0]!.to), argOf(doc, g.slice(2)));
    else positional.push(argOf(doc, g));
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
