import { SQLDialect } from "@codemirror/lang-sql";
import type { LRLanguage } from "@codemirror/language";
import { CLAUSE_WORDS, DATA_TYPES, functions, predicateKeywords, statementStarters } from "./dialect";

let language: LRLanguage | undefined;

/** Token colouring for DuckDB; scope and completion come from the SQL editor. */
export function duckdbLanguage(): LRLanguage {
  return (language ??= SQLDialect.define({
    keywords: [
      ...CLAUSE_WORDS,
      ...statementStarters("duckdb"),
      ...predicateKeywords("duckdb"),
      "ASOF ANTI SEMI EXCLUDE REPLACE RENAME COLUMNS QUALIFY OVER PARTITION FILTER NULLS FIRST LAST",
      "IF RECURSIVE DESCRIBE SUMMARIZE COMMENT INSTALL LOAD EXPORT IMPORT PRAGMA RESET VACUUM",
      "SAMPLE REPEATABLE PERCENT ROWS MATERIALIZED TEMPORARY LAMBDA TRY_CAST AT TIME ZONE",
    ]
      .join(" ")
      .toLowerCase(),
    types: DATA_TYPES.duckdb
      .filter((type) => type !== "UNION")
      .join(" ")
      .toLowerCase(),
    builtin: functions("duckdb")
      .map((f) => f.name)
      .join(" "),
    caseInsensitiveIdentifiers: true,
    doubleDollarQuotedStrings: true,
    specialVar: "?$",
  }).language);
}
