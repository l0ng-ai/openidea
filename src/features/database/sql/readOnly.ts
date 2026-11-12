import type { DbDriver } from "@/platform/ipc";
import { lex } from "./lexer";

/** Statements that only read. */
const READ_VERBS = new Set(["SELECT", "WITH", "VALUES", "TABLE", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "PRAGMA"]);
/** Words that make a reading statement write (data-modifying CTEs, SELECT INTO, row locks, sequences). */
const WRITES = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "INTO", "NEXTVAL", "SETVAL", "CALL", "EXEC", "EXECUTE"]);

/** Whether running `text` again only reads (paging a result re-runs its query). */
export function isReadOnlyQuery(text: string, driver: DbDriver): boolean {
  const tokens = lex(text, driver).tokens;
  const first = tokens.find((t) => t.text !== "(");
  if (!first || first.kind !== "word" || !READ_VERBS.has(first.upper)) return false;
  return !tokens.some((t) => t.kind === "word" && WRITES.has(t.upper));
}
