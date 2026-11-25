import type { DbDriver } from "@/platform/ipc";
import { lex } from "./lexer";

/** Statements that only read. */
const READ_VERBS = new Set(["SELECT", "WITH", "VALUES", "TABLE", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "PRAGMA"]);
/** Words that make a reading statement write (data-modifying CTEs, SELECT INTO, row locks, sequences). */
const WRITES = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "INTO", "NEXTVAL", "SETVAL", "CALL", "EXEC", "EXECUTE"]);

/** Snowflake's stage listings read too. */
const SNOWFLAKE_READ_VERBS = new Set(["LIST", "LS"]);
/** Snowflake functions that act on the account or depend on the statements run before. */
const SNOWFLAKE_WRITES = /^(SYSTEM\$.*|LAST_QUERY_ID|RESULT_SCAN)$/;

/** Whether running `text` again only reads (paging a result re-runs its query). */
export function isReadOnlyQuery(text: string, driver: DbDriver): boolean {
  const tokens = lex(text, driver).tokens;
  const first = tokens.find((t) => t.text !== "(");
  const snowflake = driver === "snowflake";
  if (!first || first.kind !== "word") return false;
  if (!READ_VERBS.has(first.upper) && !(snowflake && SNOWFLAKE_READ_VERBS.has(first.upper))) return false;
  return !tokens.some(
    (t) => t.kind === "word" && (WRITES.has(t.upper) || (snowflake && SNOWFLAKE_WRITES.test(t.upper))),
  );
}
