/** Presentation helpers for debugger values. */

export type ValueKind = "number" | "string" | "keyword" | "object" | "plain";

const KEYWORDS = new Set([
  "null",
  "nil",
  "None",
  "undefined",
  "true",
  "false",
  "True",
  "False",
  "NaN",
  "Infinity",
  "-Infinity",
  "nullptr",
  "<nil>",
]);

const NUMBER = /^[-+]?(?:0x[\da-f]+|0b[01]+|0o[0-7]+|(?:\d[\d_]*\.?[\d_]*|\.\d+)(?:e[-+]?\d+)?)(?:[a-z]\w*)?$/i;

/** Classifies a value string for colouring: numbers, strings, keywords (null/true…), objects (`{…}`, `[…]`). */
export function classifyValue(value: string, typeName?: string | null): ValueKind {
  const v = value.trim();
  if (!v) return "plain";
  if (KEYWORDS.has(v)) return "keyword";
  if (/^(['"`]).*\1$/s.test(v) || (/^[bru]?['"]/.test(v) && /['"]$/.test(v))) return "string";
  if (NUMBER.test(v)) return "number";
  if (/^[{[(]/.test(v) || /^[\w$.:<>]+\s*[{(@]/.test(v) || /^<.*>$/.test(v)) return "object";
  const t = typeName?.toLowerCase() ?? "";
  if (/\b(str|string|char|&str)\b/.test(t)) return "string";
  return "plain";
}

/** Single-line, length-limited value for inline display. */
export function inlineValue(value: string, max = 60): string {
  const flat = value.replace(/\s*\n\s*/g, " ");
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Identifiers in a line of code (for matching inline values). */
export function identifiersIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Skip string literal contents roughly so `"total"` doesn't count.
  const code = text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, " ");
  for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}

const INDEX = /^\[?\d+\]?$/;

/**
 * Data Views › "Sort values alphabetically": children by name (numbers in
 * names compared numerically). Array / list elements keep their index order.
 */
export function sortVariables<T extends { name: string }>(vars: readonly T[]): T[] {
  if (vars.every((v) => INDEX.test(v.name))) return [...vars];
  return [...vars].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}
