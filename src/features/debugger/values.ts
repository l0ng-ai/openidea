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

/** The value on one line: a multi-line rendering (a pandas Series, a pretty-printed object) joined with spaces. */
export function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, " ");
}

/** Single-line, length-limited value for inline display. */
export function inlineValue(value: string, max = 60): string {
  const flat = oneLine(value);
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

/** How a variable's type and value read in the Variables view: the braced label before the value, then the value. */
export interface ShownValue {
  label: string | null;
  text: string;
  /** A map entry: the row shows `key -> value` alone, without its index. */
  entry?: true;
}

// `HashMap@10 size=1`, `String[0]@9`: a JVM object as the Java debugger writes it (type, then the object id).
const JVM_OBJECT = /^([\w$.]+(?:\[\d*\])*)@(\d+)(?:\s+(.*))?$/s;
// A map entry's key, at the start of `"a":"b"` or `1:"b"`.
const ENTRY_KEY = /^("(?:[^"\\]|\\.)*"|[^:"]+?):(.*)$/s;

/**
 * JVM objects read as `{HashMap@10} size = 1` and a map entry as `"a" -> "b"`; strings show without
 * a type. Values in other forms keep the adapter's text under `{type}`.
 */
export function shownValue(value: string, typeName: string | null | undefined): ShownValue {
  const plain = { label: typeName ? `{${typeName}}` : null, text: value };
  if (!typeName) return plain;
  if (typeName === "String" && /^".*"$/s.test(value)) return { label: null, text: value };
  const object = JVM_OBJECT.exec(value);
  if (!object) return plain;
  const [, head, id, rest = ""] = object;
  const simple = (t: string) => t.replace(/\[\d*\]/g, "[]").replace(/^.*\./, "");
  if (simple(head!) !== simple(typeName)) return plain;
  const entry = /(?:^|\$)\w*(?:Entry|Node)$/.test(typeName) ? ENTRY_KEY.exec(rest) : null;
  if (entry) return { label: null, text: `${entry[1]!.trim()} -> ${entry[2]!.trim()}`, entry: true };
  const text = rest.replace(/\b(size|length)=(\d+)/g, "$1 = $2") || (/\[0\]/.test(head!) ? "[]" : "");
  return { label: `{${head!.replace(/^.*\./, "")}@${id}}`, text };
}
