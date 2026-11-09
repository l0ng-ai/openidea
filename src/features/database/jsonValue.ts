/**
 * JSON-aware cell editing (#2333): which cells edit as JSON, pretty-printing
 * and syntax validation. Phase 1 covers JSON (`json` / `jsonb`, MySQL `JSON`,
 * and text that parses as JSON); XML and bytea modes are follow-ups.
 */
import type { Cell } from "./model";

/** Columns of these types (`json`, `jsonb`, MySQL `JSON`) always edit as JSON. */
export const isJsonColumn = (type: string) => /json/i.test(type);

/** The first syntax error of `text`: message and its offset; null when valid (empty counts as valid). */
export interface JsonError {
  message: string;
  pos: number;
}

export function jsonErrorOf(text: string): JsonError | null {
  if (!text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // V8: "… is not valid JSON" / "Unexpected token … at position 3"; other engines differ.
    const at = /position (\d+)/i.exec(message);
    return { message, pos: at ? Math.min(Number(at[1]), text.length) : 0 };
  }
}

/** Whether the Value panel edits this cell as JSON: a JSON column's value, or a text value that is a JSON object or array (a bare number or quoted string does not need the code editor). */
export function isJsonValue(columnType: string, cell: Cell): boolean {
  if (cell === null) return isJsonColumn(columnType);
  if (isJsonColumn(columnType)) return true;
  const text = cell.trim();
  return (text.startsWith("{") || text.startsWith("[")) && jsonErrorOf(text) === null;
}

/** Pretty-prints valid JSON with two spaces; invalid text passes through unchanged. */
export function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
