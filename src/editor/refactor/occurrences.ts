/**
 * Textual candidates for "replace all occurrences": spans of `text` equal to
 * an expression up to whitespace between tokens. Callers confirm each span
 * with the syntax tree (same node kind, same resolution) before using it.
 */

const WORD = /[\w$]/;

/**
 * Collapses whitespace between tokens (kept as one space between two word
 * characters), leaving string / char literal contents untouched.
 */
export function normalizeExpression(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      if (pendingSpace && out && WORD.test(out[out.length - 1]!)) out += " ";
      pendingSpace = false;
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out && WORD.test(out[out.length - 1]!) && WORD.test(c)) out += " ";
    pendingSpace = false;
    out += c;
  }
  return out;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex source matching `expr` with any whitespace between its tokens. */
export function expressionPattern(expr: string): string {
  const norm = normalizeExpression(expr.trim());
  const tokens: string[] = [];
  let i = 0;
  while (i < norm.length) {
    const c = norm[i]!;
    if (c === " ") {
      tokens.push("\\s+");
      i++;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < norm.length && norm[j] !== c) j += norm[j] === "\\" ? 2 : 1;
      tokens.push(escape(norm.slice(i, j + 1)));
      i = j + 1;
    } else if (WORD.test(c)) {
      let j = i;
      while (j < norm.length && WORD.test(norm[j]!)) j++;
      tokens.push(escape(norm.slice(i, j)));
      i = j;
    } else {
      tokens.push(escape(c));
      i++;
    }
  }
  let src = "";
  tokens.forEach((t, k) => {
    if (k > 0 && t !== "\\s+" && tokens[k - 1] !== "\\s+") src += "\\s*";
    src += t;
  });
  const tail = WORD.test(norm[norm.length - 1] ?? "") ? "(?![\\w$])" : "";
  return src + tail;
}

/** Spans in `text[from, to)` matching `expr` (absolute offsets), at most `limit`. */
export function findTextOccurrences(
  text: string,
  from: number,
  to: number,
  expr: string,
  limit = 100,
): { from: number; to: number }[] {
  const re = new RegExp(expressionPattern(expr), "g");
  const scope = text.slice(from, to);
  const want = normalizeExpression(expr.trim());
  const out: { from: number; to: number }[] = [];
  for (let m = re.exec(scope); m; m = re.exec(scope)) {
    if (!m[0].length) re.lastIndex = m.index + 1;
    if (WORD.test(want[0] ?? "") && m.index > 0 && WORD.test(scope[m.index - 1]!)) {
      re.lastIndex = m.index + 1;
      continue;
    }
    if (normalizeExpression(m[0]) !== want) continue;
    out.push({ from: from + m.index!, to: from + m.index! + m[0].length });
    if (out.length >= limit) break;
  }
  return out;
}

/** Identifier-like words of an expression outside literals, with offsets relative to it. */
export function expressionWords(expr: string): { word: string; offset: number }[] {
  const out: { word: string; offset: number }[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < expr.length && expr[j] !== c) j += expr[j] === "\\" ? 2 : 1;
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c) && (i === 0 || !WORD.test(expr[i - 1]!))) {
      let j = i;
      while (j < expr.length && WORD.test(expr[j]!)) j++;
      out.push({ word: expr.slice(i, j), offset: i });
      i = j;
    } else i++;
  }
  return out;
}
