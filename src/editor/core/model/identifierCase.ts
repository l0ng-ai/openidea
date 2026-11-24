/**
 * Identifier case styles. `cycleIdentifierCase` walks through them in this
 * order, starting after the style a name is written in.
 */
export const identifierCases = ["snake", "screaming", "kebab", "camel", "pascal"] as const;
export type IdentifierCase = (typeof identifierCases)[number];

const WORD = /[\p{L}\p{N}]/u;
const SEPARATOR = /[^\p{L}\p{N}]/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const DIGIT = /\p{N}/u;

/**
 * The words of a name or a selected phrase: split at `_`, `-`, spaces and the
 * like, before an upper-case letter that follows a lower-case one or a digit,
 * and where an acronym ends (`HTTPServer`).
 */
export function identifierWords(text: string): string[] {
  const out: string[] = [];
  let word: string[] = [];
  const chars = Array.from(text);
  for (const [i, c] of chars.entries()) {
    if (SEPARATOR.test(c)) {
      if (word.length) out.push(word.join(""));
      word = [];
      continue;
    }
    const prev = word.at(-1) ?? "";
    const next = chars[i + 1];
    if (UPPER.test(c) && (LOWER.test(prev) || DIGIT.test(prev) || (UPPER.test(prev) && !!next && LOWER.test(next)))) {
      out.push(word.join(""));
      word = [];
    }
    word.push(c);
  }
  if (word.length) out.push(word.join(""));
  return out;
}

/** `text` between its first and last word character; null when it has none. */
export function wordSpan(text: string): { from: number; to: number } | null {
  const from = text.search(WORD);
  if (from < 0) return null;
  const last = text.search(/[\p{L}\p{N}](?![\s\S]*[\p{L}\p{N}])/u);
  return { from, to: last + (text.codePointAt(last)! > 0xffff ? 2 : 1) };
}

/** The style `text` is written in; null when it has no letter with a case. */
export function identifierCase(text: string): IdentifierCase | null {
  if (text === text.toLowerCase() && text === text.toUpperCase()) return null;
  const span = wordSpan(text);
  if (!span) return null;
  const inner = text.slice(span.from, span.to);
  if (inner.includes("_")) return inner === inner.toUpperCase() ? "screaming" : "snake";
  if (SEPARATOR.test(inner)) return "kebab";
  return UPPER.test(Array.from(inner)[0]!) ? "pascal" : "camel";
}

/** `text` written in `style`. */
export function toIdentifierCase(text: string, style: IdentifierCase): string {
  const lower = (c: string) => c.toLowerCase();
  const upper = (c: string) => c.toUpperCase();
  const words = identifierWords(text).map((w) => Array.from(w));
  const every = (c: (ch: string) => string) => words.map((cs) => cs.map(c).join(""));
  /** The first letter in the case of `c`, the rest as written. */
  const lead = (cs: string[], c: (ch: string) => string) => (cs.length ? c(cs[0]!) + cs.slice(1).join("") : "");
  switch (style) {
    case "snake":
      return every(lower).join("_");
    case "screaming":
      return every(upper).join("_");
    case "kebab":
      return every(lower).join("-");
    case "camel":
      return words.map((cs, i) => lead(cs, i ? upper : lower)).join("");
    case "pascal":
      return words.map((cs) => lead(cs, upper)).join("");
  }
}

/**
 * `text` in the next style of the cycle, skipping the styles that write it the
 * same way; null when none writes it differently.
 */
export function cycleIdentifierCase(text: string): string | null {
  const current = identifierCase(text);
  if (!current) return null;
  // One word has three spellings, not five: name → Name → NAME.
  const single = identifierWords(text).length === 1 && !SEPARATOR.test(text);
  const order: readonly IdentifierCase[] = single ? ["camel", "pascal", "screaming", "snake"] : identifierCases;
  const start = Math.max(0, order.indexOf(current));
  for (let step = 1; step <= order.length; step++) {
    const next = toIdentifierCase(text, order[(start + step) % order.length]!);
    if (next !== text) return next;
  }
  return null;
}
