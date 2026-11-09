/**
 * Context keys + `when` clauses, like IDEA's DataContext / VS Code's when.
 *
 * Components publish facts (`editorFocus`, `toolWindow.project.active`,
 * `debugSession.paused`…); actions and keybindings are enabled by a `when`
 * expression over those facts. Grammar:
 *   expr := or ; or := and ("||" and)* ; and := unary ("&&" unary)*
 *   unary := "!" unary | "(" expr ")" | cmp ; cmp := key (("==" | "!=") value)?
 */
import { create } from "zustand";

export type ContextValue = string | number | boolean | null | undefined;
export type ContextKeys = Record<string, ContextValue>;

export const useContextKeys = create<ContextKeys>(() => ({}));

export function setContext(key: string, value: ContextValue) {
  if (useContextKeys.getState()[key] !== value) useContextKeys.setState({ [key]: value });
}

export function clearContext(key: string) {
  const next = { ...useContextKeys.getState() };
  if (!(key in next)) return;
  delete next[key];
  useContextKeys.setState(next, true);
}

export function getContext(): ContextKeys {
  return useContextKeys.getState();
}

type Token = { t: "id" | "str" | "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (
      src.startsWith("&&", i) ||
      src.startsWith("||", i) ||
      src.startsWith("==", i) ||
      src.startsWith("!=", i)
    ) {
      out.push({ t: "op", v: src.slice(i, i + 2) });
      i += 2;
    } else if (c === "!" || c === "(" || c === ")") {
      out.push({ t: "op", v: c });
      i++;
    } else if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error(`unterminated string in when clause: ${src}`);
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
    } else {
      const m = /^[\w.\-:/]+/.exec(src.slice(i));
      if (!m) throw new Error(`unexpected '${c}' in when clause: ${src}`);
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
    }
  }
  return out;
}

const cache = new Map<string, (ctx: ContextKeys) => boolean>();

/** Compiles (and caches) a when clause into a predicate. Empty clause = always true. */
export function compileWhen(expr: string | undefined): (ctx: ContextKeys) => boolean {
  if (!expr || !expr.trim()) return () => true;
  const hit = cache.get(expr);
  if (hit) return hit;
  const toks = tokenize(expr);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v: string) => {
    if (peek()?.v === v) {
      p++;
      return true;
    }
    return false;
  };
  type Node = (ctx: ContextKeys) => boolean;
  const parseOr = (): Node => {
    let left = parseAnd();
    while (eat("||")) {
      const l = left,
        r = parseAnd();
      left = (c) => l(c) || r(c);
    }
    return left;
  };
  const parseAnd = (): Node => {
    let left = parseUnary();
    while (eat("&&")) {
      const l = left,
        r = parseUnary();
      left = (c) => l(c) && r(c);
    }
    return left;
  };
  const parseUnary = (): Node => {
    if (eat("!")) {
      const inner = parseUnary();
      return (c) => !inner(c);
    }
    if (eat("(")) {
      const inner = parseOr();
      if (!eat(")")) throw new Error(`missing ')' in when clause: ${expr}`);
      return inner;
    }
    const tok = toks[p++];
    if (!tok || tok.t === "op") throw new Error(`expected key in when clause: ${expr}`);
    const key = tok.v;
    if (peek()?.v === "==" || peek()?.v === "!=") {
      const negate = toks[p++]!.v === "!=";
      const valTok = toks[p++];
      if (!valTok || valTok.t === "op") throw new Error(`expected value in when clause: ${expr}`);
      const raw = valTok.v;
      const lit: ContextValue =
        valTok.t === "str" ? raw : raw === "true" ? true : raw === "false" ? false : isFinite(+raw) ? +raw : raw;
      return (c) => (c[key] === lit) !== negate;
    }
    return (c) => !!c[key];
  };
  const fn = parseOr();
  if (p !== toks.length) throw new Error(`unexpected trailing tokens in when clause: ${expr}`);
  cache.set(expr, fn);
  return fn;
}

export function evaluateWhen(expr: string | undefined, ctx: ContextKeys = getContext()): boolean {
  return compileWhen(expr)(ctx);
}
