const MAX_STRINGS = 64;
const SPECIAL = new Set([".", "*", "+", "?", "{", "}", "(", ")", "[", "]", "|", "^", "$", "\\"]);
const ESCAPED_LITERALS = new Set([
  ".",
  "-",
  "_",
  "/",
  "+",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "$",
  "^",
  "|",
  "?",
  "*",
  "\\",
]);

type Strings = string[] | null;

interface Cursor {
  src: string;
  at: number;
}

function product(a: string[], b: string[]): Strings {
  if (a.length * b.length > MAX_STRINGS) return null;
  return a.flatMap((x) => b.map((y) => x + y));
}

function parseClass(c: Cursor): Strings {
  const chars: string[] = [];
  c.at++;
  while (c.at < c.src.length && c.src[c.at] !== "]") {
    const ch = c.src[c.at]!;
    if (ch === "^" || ch === "[" || (ch === "-" && chars.length > 0 && c.src[c.at + 1] !== "]")) return null;
    if (ch === "\\") {
      const next = c.src[c.at + 1];
      if (!next || !ESCAPED_LITERALS.has(next)) return null;
      chars.push(next);
      c.at += 2;
      continue;
    }
    chars.push(ch);
    c.at++;
  }
  if (c.src[c.at] !== "]") return null;
  c.at++;
  return chars.length ? chars : null;
}

function parseAtom(c: Cursor): Strings {
  const ch = c.src[c.at]!;
  if (ch === "(") {
    c.at += c.src.startsWith("(?:", c.at) ? 3 : 1;
    if (c.src[c.at] === "?") return null;
    const inner = parseAlternation(c);
    if (inner === null || c.src[c.at] !== ")") return null;
    c.at++;
    return inner;
  }
  if (ch === "[") return parseClass(c);
  if (ch === "\\") {
    const next = c.src[c.at + 1];
    if (!next || !ESCAPED_LITERALS.has(next)) return null;
    c.at += 2;
    return [next];
  }
  if (SPECIAL.has(ch)) return null;
  c.at++;
  return [ch];
}

function parseConcat(c: Cursor): Strings {
  let out: string[] = [""];
  while (c.at < c.src.length && c.src[c.at] !== "|" && c.src[c.at] !== ")") {
    const atom = parseAtom(c);
    if (atom === null) return null;
    const quantifier = c.src[c.at];
    if (quantifier === "*" || quantifier === "+" || quantifier === "{") return null;
    const options = quantifier === "?" ? [...atom, ""] : atom;
    if (quantifier === "?") c.at++;
    const next = product(out, options);
    if (next === null) return null;
    out = next;
  }
  return out;
}

function parseAlternation(c: Cursor): Strings {
  const out: string[] = [];
  for (;;) {
    const branch = parseConcat(c);
    if (branch === null) return null;
    out.push(...branch);
    if (out.length > MAX_STRINGS) return null;
    if (c.src[c.at] !== "|") return out;
    c.at++;
  }
}

function finiteStrings(src: string): Strings {
  const c = { src, at: 0 };
  const out = parseAlternation(c);
  return out !== null && c.at === src.length ? out : null;
}

interface TopLevel {
  alternation: boolean;
  lastDot: number;
}

function scanTopLevel(src: string): TopLevel {
  let depth = 0;
  let inClass = false;
  let lastDot = -1;
  let alternation = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      if (!inClass && depth === 0 && src[i + 1] === ".") lastDot = i;
      i++;
    } else if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") inClass = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "|" && depth === 0) alternation = true;
  }
  return { alternation, lastDot };
}

export function extensionKeys(src: string): string[] | null {
  if (!src.endsWith("$") || src.endsWith("\\$")) return null;
  const { alternation, lastDot } = scanTopLevel(src);
  if (alternation || lastDot < 0) return null;
  const tail = finiteStrings(src.slice(lastDot + 2, -1));
  if (tail === null) return null;
  return [...new Set(tail.map((s) => s.slice(s.lastIndexOf(".") + 1)))];
}

export function firstCharKeys(src: string): string[] | null {
  if (!src.startsWith("^") || scanTopLevel(src).alternation || src.length < 2) return null;
  const c = { src, at: 1 };
  const atom = parseAtom(c);
  const quantifier = src[c.at];
  if (atom === null || quantifier === "?" || quantifier === "*" || quantifier === "+" || quantifier === "{") {
    return null;
  }
  if (atom.some((s) => s === "")) return null;
  return [...new Set(atom.map((s) => s[0]!))];
}

export interface IndexedPattern {
  re: RegExp;
  source: string;
  path: boolean;
  order: number;
}

export interface PatternIndex<T extends IndexedPattern> {
  find(name: string, path: string | null): T | undefined;
}

function add<T>(map: Map<string, T[]>, key: string, item: T) {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

const NONE: readonly never[] = [];

export function createPatternIndex<T extends IndexedPattern>(
  patterns: readonly T[],
  accept: (pattern: T, name: string, path: string | null) => boolean = (p, name, path) => {
    const subject = p.path ? path : name;
    return subject !== null && p.re.test(subject);
  },
): PatternIndex<T> {
  const byExt = new Map<string, T[]>();
  const byFirst = new Map<string, T[]>();
  const generic: T[] = [];
  for (const p of patterns) {
    const ext = extensionKeys(p.source);
    if (ext) {
      for (const key of new Set(ext.map((k) => k.toLowerCase()))) add(byExt, key, p);
      continue;
    }
    const first = p.path ? null : firstCharKeys(p.source);
    if (first) for (const key of new Set(first.map((k) => k.toLowerCase()))) add(byFirst, key, p);
    else generic.push(p);
  }
  return {
    find(name, path) {
      const dot = name.lastIndexOf(".");
      const lists = [
        generic,
        dot >= 0 ? (byExt.get(name.slice(dot + 1).toLowerCase()) ?? NONE) : NONE,
        byFirst.get(name.charAt(0).toLowerCase()) ?? NONE,
      ];
      const at = [0, 0, 0];
      for (;;) {
        let pick = -1;
        for (let l = 0; l < 3; l++) {
          const item = lists[l]![at[l]!];
          if (item && (pick < 0 || item.order < lists[pick]![at[pick]!]!.order)) pick = l;
        }
        if (pick < 0) return undefined;
        const item = lists[pick]![at[pick]!]!;
        at[pick]!++;
        if (accept(item, name, path)) return item;
      }
    },
  };
}
