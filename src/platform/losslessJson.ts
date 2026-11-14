/**
 * Lossless JSON numbers: JSON that keeps every digit of a numeric value
 * instead of rounding it through JavaScript Number. Shared by the database
 * JSON extractor and the HTTP client / GraphQL response and request bodies,
 * where BIGINT identifiers and high-precision decimals must survive
 * formatting and transport unchanged.
 */

/** JSON where a number carries its literal text (as written, digits intact). */
export type JsonValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "num"; text: string }
  | { t: "str"; v: string }
  | { t: "arr"; items: JsonValue[] }
  | { t: "obj"; entries: [string, JsonValue][] };

/**
 * Numeric text as a JSON number literal, normalized to valid JSON syntax
 * (sign, leading zeroes and an empty fraction normalized, digits and exponent
 * kept); null when the text is not a finite number.
 */
export function jsonNumber(text: string): string | null {
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  const parts = /^([+-]?)(\d*)(?:\.(\d*))?([eE][+-]?\d+)?$/.exec(text.trim());
  if (!parts) return null;
  const whole = parts[2]!.replace(/^0+/, "") || "0";
  const fraction = parts[3] ?? "";
  if (!/[1-9]/.test(whole + fraction)) return "0";
  return `${parts[1] === "-" ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}${parts[4] ?? ""}`;
}

/** The JSON value a plain JavaScript value would have had before `Number` rounded it; a `JsonValue` passes through. */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return { t: "null" };
  if (typeof value === "object" && !Array.isArray(value) && typeof (value as { t?: unknown }).t === "string")
    return value as JsonValue;
  switch (typeof value) {
    case "boolean":
      return { t: "bool", v: value };
    case "number":
      return Number.isFinite(value) ? { t: "num", text: String(value) } : { t: "null" };
    case "string":
      return { t: "str", v: value };
    default:
      return Array.isArray(value)
        ? { t: "arr", items: value.map(toJsonValue) }
        : { t: "obj", entries: Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonValue(v)]) };
  }
}

/** Parses JSON text into a `JsonValue`, keeping numeric literals exact; null when the text is not valid JSON. */
export function parseJsonText(text: string): JsonValue | null {
  const parse = (i: number): [JsonValue | null, number] => {
    i = skipSpaces(text, i);
    const c = text[i];
    if (c === "{") {
      const entries: [string, JsonValue][] = [];
      const at = new Map<string, number>();
      i = skipSpaces(text, i + 1);
      if (text[i] === "}") return [{ t: "obj", entries }, i + 1];
      for (;;) {
        i = skipSpaces(text, i);
        const key = i < text.length && text[i] === '"' ? parseString(text, i) : null;
        if (!key) return [null, i];
        i = skipSpaces(text, key[1]);
        if (text[i] !== ":") return [null, i];
        const [value, next] = parse(i + 1);
        if (value === null) return [null, next];
        // A repeated key keeps its first position and the last value, like `JSON.parse`.
        const seen = at.get(key[0]);
        if (seen === undefined) {
          at.set(key[0], entries.length);
          entries.push([key[0], value]);
        } else entries[seen]![1] = value;
        i = skipSpaces(text, next);
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") return [{ t: "obj", entries }, i + 1];
        return [null, i];
      }
    }
    if (c === "[") {
      const items: JsonValue[] = [];
      i = skipSpaces(text, i + 1);
      if (text[i] === "]") return [{ t: "arr", items }, i + 1];
      for (;;) {
        const [value, next] = parse(i);
        if (value === null) return [null, next];
        items.push(value);
        i = skipSpaces(text, next);
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") return [{ t: "arr", items }, i + 1];
        return [null, i];
      }
    }
    if (c === '"') {
      const s = parseString(text, i);
      return s ? [{ t: "str", v: s[0] }, s[1]] : [null, i];
    }
    if (text.startsWith("true", i)) return [{ t: "bool", v: true }, i + 4];
    if (text.startsWith("false", i)) return [{ t: "bool", v: false }, i + 5];
    if (text.startsWith("null", i)) return [{ t: "null" }, i + 4];
    const number = parseNumberToken(text, i);
    return number ? [{ t: "num", text: number[0] }, number[1]] : [null, i];
  };
  try {
    const [value, end] = parse(0);
    if (value === null || skipSpaces(text, end) !== text.length) return null;
    return value;
  } catch {
    return null;
  }
}

const SPACES = " \t\n\r";

function skipSpaces(text: string, i: number): number {
  while (i < text.length && SPACES.includes(text[i]!)) i++;
  return i;
}

/** A string's value and the index past its closing quote; null when unterminated or badly escaped. */
function parseString(text: string, i: number): [string, number] | null {
  let out = "";
  for (i++; ;) {
    if (i >= text.length) return null;
    const c = text[i++]!;
    if (c === '"') return [out, i];
    if (c === "\\") {
      const e = text[i++]!;
      if (e === "u") {
        const hex = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else if (e === '"') out += '"';
      else if (e === "\\") out += "\\";
      else if (e === "/") out += "/";
      else if (e === "b") out += "\b";
      else if (e === "f") out += "\f";
      else if (e === "n") out += "\n";
      else if (e === "r") out += "\r";
      else if (e === "t") out += "\t";
      else return null;
    } else if (c < " ") return null;
    else out += c;
  }
}

/** A JSON number literal at `i` and the index past it; null when the text there is no number. */
function parseNumberToken(text: string, i: number): [string, number] | null {
  const start = i;
  const digit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  if (text[i] === "-") i++;
  if (text[i] === "0") i++;
  else if (digit(text[i])) while (digit(text[i])) i++;
  else return null;
  if (text[i] === ".") {
    i++;
    if (!digit(text[i])) return null;
    while (digit(text[i])) i++;
  }
  if (text[i] === "e" || text[i] === "E") {
    i++;
    if (text[i] === "+" || text[i] === "-") i++;
    if (!digit(text[i])) return null;
    while (digit(text[i])) i++;
  }
  return [text.slice(start, i), i];
}

/** JSON text of a `JsonValue`; `indent` (default none) pretty-prints like `JSON.stringify`. */
export function stringifyJson(value: JsonValue, indent?: number): string {
  const pad = indent === undefined ? "" : " ".repeat(Math.max(0, indent));
  const write = (v: JsonValue, depth: number): string => {
    switch (v.t) {
      case "null":
        return "null";
      case "bool":
        return v.v ? "true" : "false";
      case "num":
        return v.text;
      case "str":
        return JSON.stringify(v.v);
      case "arr": {
        if (!v.items.length) return "[]";
        const inner = v.items.map((item) => `${pad.repeat(depth + 1)}${write(item, depth + 1)}`);
        return indent === undefined ? `[${inner.join(",")}]` : `[\n${inner.join(",\n")}\n${pad.repeat(depth)}]`;
      }
      case "obj": {
        if (!v.entries.length) return "{}";
        const colon = indent === undefined ? ":" : ": ";
        const inner = v.entries.map(
          ([key, item]) => `${pad.repeat(depth + 1)}${JSON.stringify(key)}${colon}${write(item, depth + 1)}`,
        );
        return indent === undefined ? `{${inner.join(",")}}` : `{\n${inner.join(",\n")}\n${pad.repeat(depth)}}`;
      }
    }
  };
  return write(value, 0);
}

/** Pretty-prints JSON text keeping numeric literals exact; null when the text is not valid JSON. */
export function formatJsonText(text: string, indent = 2): string | null {
  const value = parseJsonText(text);
  return value === null ? null : stringifyJson(value, indent);
}
