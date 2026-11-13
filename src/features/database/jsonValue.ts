import type { Cell } from "./model";

/** Automatic formatting and content detection are bounded on the UI thread. */
export const JSON_INLINE_LIMIT = 256_000;

/** JSON types, Snowflake's semi-structured ones included. */
export const isJsonColumn = (type: string) => /^(json|jsonb|MYSQL_TYPE_JSON|variant|object|array)$/i.test(type.trim());

export interface JsonError {
  message: string;
  pos: number;
}

export function jsonErrorOf(text: string): JsonError | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const at = /position (\d+)/i.exec(message);
    return { message, pos: at ? Math.min(Number(at[1]), text.length) : 0 };
  }
}

/** Content detection chooses highlighting, never the column's validation rules. */
export function isJsonValue(columnType: string, cell: Cell): boolean {
  if (isJsonColumn(columnType)) return true;
  if (cell === null || cell.length > JSON_INLINE_LIMIT) return false;
  const text = cell.trim();
  return (text.startsWith("{") || text.startsWith("[")) && jsonErrorOf(text) === null;
}

/** Change whitespace only: parsing/stringifying would round integers and discard duplicate keys. */
export function formatJson(text: string): string {
  if (jsonErrorOf(text)) return text;
  const tokens: string[] = [];
  // Scan strings directly: WebKit can stop a repeated regular expression on a large literal.
  for (let i = 0; i < text.length;) {
    const start = i;
    const char = text[i++]!;
    if (" \t\r\n".includes(char)) continue;
    if (char === '"') {
      while (i < text.length) {
        const next = text[i++]!;
        if (next === "\\") i++;
        else if (next === '"') break;
      }
    } else if (!"{}[],:".includes(char)) {
      while (i < text.length && !" \t\r\n{}[],:".includes(text[i]!)) i++;
    }
    tokens.push(text.slice(start, i));
  }
  const parts: string[] = [];
  let depth = 0;
  let length = 0;
  const line = () => "\n" + "  ".repeat(Math.min(depth, 100));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    let part = token;
    if (token === "{" || token === "[") {
      depth++;
      if (tokens[i + 1] !== (token === "{" ? "}" : "]")) part += line();
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[i - 1] !== (token === "}" ? "{" : "[")) part = line() + token;
    } else if (token === ",") part += line();
    else if (token === ":") part += " ";
    length += part.length;
    if (length > 16_000_000) return text;
    parts.push(part);
  }
  return parts.join("");
}

export function initialJsonText(text: string): string {
  return text.length <= JSON_INLINE_LIMIT ? formatJson(text) : text;
}
