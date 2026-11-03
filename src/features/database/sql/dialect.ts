/** Per-dialect SQL vocabulary: reserved words, statement starters and built-in functions. */
import type { DbDriver } from "@/platform/ipc";

export interface SqlFunction {
  name: string;
  /** Parameter list shown in the popup, without parentheses. */
  params: string;
  returns?: string;
  aggregate?: boolean;
}

/** Words that must be quoted when used as identifiers (the common core of the three dialects). */
const RESERVED = new Set(
  (
    "ALL AND ANY AS ASC BETWEEN BY CASE CAST CHECK COLLATE COLUMN CONSTRAINT CREATE CROSS CURRENT_DATE " +
    "CURRENT_TIME CURRENT_TIMESTAMP DEFAULT DELETE DESC DISTINCT DROP ELSE END EXCEPT EXISTS FALSE FETCH FOR " +
    "FOREIGN FROM FULL GRANT GROUP HAVING IN INNER INSERT INTERSECT INTO IS JOIN LEFT LIKE LIMIT NATURAL NOT " +
    "NULL OFFSET ON OR ORDER OUTER PRIMARY REFERENCES RIGHT SELECT SET TABLE THEN TO TRUE UNION UNIQUE UPDATE " +
    "USING VALUES WHEN WHERE WINDOW WITH"
  ).split(" "),
);

export function isReserved(word: string): boolean {
  return RESERVED.has(word.toUpperCase());
}

/** Clause keywords: a word in this set ends a table alias or expression. */
export const CLAUSE_WORDS = new Set(
  (
    "SELECT FROM WHERE GROUP ORDER HAVING LIMIT OFFSET UNION INTERSECT EXCEPT JOIN INNER LEFT RIGHT FULL CROSS " +
    "NATURAL OUTER ON USING SET VALUES RETURNING INTO WINDOW FETCH FOR LATERAL AS WITH UPDATE DELETE INSERT " +
    "AND OR NOT WHEN THEN ELSE END CASE BY ASC DESC IS IN LIKE ILIKE BETWEEN EXISTS NULL STRAIGHT_JOIN"
  ).split(" "),
);

export function statementStarters(driver: DbDriver): string[] {
  const common = [
    "SELECT",
    "INSERT INTO",
    "UPDATE",
    "DELETE FROM",
    "WITH",
    "CREATE TABLE",
    "CREATE INDEX",
    "CREATE VIEW",
    "ALTER TABLE",
    "DROP TABLE",
    "DROP VIEW",
    "DROP INDEX",
    "EXPLAIN",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
  ];
  if (driver === "sqlite") return [...common, "PRAGMA", "VACUUM", "ATTACH DATABASE", "REPLACE INTO", "CREATE TRIGGER"];
  if (driver === "mysql")
    return [
      ...common,
      "SHOW TABLES",
      "SHOW CREATE TABLE",
      "DESCRIBE",
      "TRUNCATE TABLE",
      "REPLACE INTO",
      "USE",
      "CREATE DATABASE",
      "START TRANSACTION",
    ];
  return [
    ...common,
    "TRUNCATE",
    "CREATE SCHEMA",
    "CREATE FUNCTION",
    "CREATE MATERIALIZED VIEW",
    "SET search_path TO",
    "COPY",
    "ANALYZE",
    "VACUUM",
  ];
}

export function joinKeywords(driver: DbDriver): string[] {
  const j = ["JOIN", "LEFT JOIN", "INNER JOIN", "CROSS JOIN", "RIGHT JOIN"];
  if (driver !== "mysql") j.push("FULL JOIN");
  if (driver === "postgres") j.push("JOIN LATERAL", "LEFT JOIN LATERAL");
  return j;
}

/** Comparison / predicate keywords of WHERE, ON and HAVING. */
export function predicateKeywords(driver: DbDriver): string[] {
  const k = [
    "AND",
    "OR",
    "NOT",
    "IN",
    "IS NULL",
    "IS NOT NULL",
    "LIKE",
    "BETWEEN",
    "EXISTS",
    "NULL",
    "TRUE",
    "FALSE",
    "CASE",
  ];
  if (driver === "postgres") k.push("ILIKE", "IS DISTINCT FROM", "ANY", "SIMILAR TO");
  if (driver === "mysql") k.push("REGEXP");
  if (driver === "sqlite") k.push("GLOB", "REGEXP");
  return k;
}

export const DATA_TYPES: Record<DbDriver, string[]> = {
  sqlite: ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC", "BOOLEAN", "DATETIME"],
  postgres: [
    "integer",
    "bigint",
    "smallint",
    "serial",
    "bigserial",
    "text",
    "varchar",
    "char",
    "boolean",
    "numeric",
    "real",
    "double precision",
    "date",
    "timestamp",
    "timestamptz",
    "time",
    "interval",
    "uuid",
    "json",
    "jsonb",
    "bytea",
  ],
  mysql: [
    "INT",
    "BIGINT",
    "SMALLINT",
    "TINYINT",
    "VARCHAR",
    "CHAR",
    "TEXT",
    "LONGTEXT",
    "DECIMAL",
    "DOUBLE",
    "FLOAT",
    "DATE",
    "DATETIME",
    "TIMESTAMP",
    "TIME",
    "JSON",
    "BLOB",
    "BOOLEAN",
    "ENUM",
  ],
  sqlServer: [
    "INT",
    "BIGINT",
    "SMALLINT",
    "TINYINT",
    "VARCHAR",
    "NVARCHAR",
    "CHAR",
    "NCHAR",
    "TEXT",
    "NTEXT",
    "DECIMAL",
    "FLOAT",
    "REAL",
    "DATE",
    "DATETIME",
    "DATETIME2",
    "TIME",
    "UNIQUEIDENTIFIER",
    "BIT",
    "VARBINARY",
    "XML",
  ],
};

const f = (name: string, params: string, returns?: string, aggregate?: boolean): SqlFunction => ({
  name,
  params,
  returns,
  aggregate,
});

const COMMON: SqlFunction[] = [
  f("count", "*", "bigint", true),
  f("sum", "expr", undefined, true),
  f("avg", "expr", undefined, true),
  f("min", "expr", undefined, true),
  f("max", "expr", undefined, true),
  f("coalesce", "value, ...", undefined),
  f("nullif", "a, b"),
  f("lower", "text", "text"),
  f("upper", "text", "text"),
  f("length", "text", "integer"),
  f("trim", "text", "text"),
  f("replace", "text, from, to", "text"),
  f("substr", "text, start, length", "text"),
  f("abs", "number"),
  f("round", "number, digits"),
  f("cast", "expr AS type"),
];

const FUNCTIONS: Record<DbDriver, SqlFunction[]> = {
  sqlite: [
    ...COMMON,
    f("group_concat", "expr, separator", "text", true),
    f("ifnull", "a, b"),
    f("iif", "cond, then, else"),
    f("instr", "text, search", "integer"),
    f("printf", "format, ...", "text"),
    f("date", "time, modifier...", "text"),
    f("datetime", "time, modifier...", "text"),
    f("strftime", "format, time, modifier...", "text"),
    f("julianday", "time", "real"),
    f("json_extract", "json, path"),
    f("json_object", "key, value, ...", "text"),
    f("random", "", "integer"),
    f("typeof", "expr", "text"),
    f("last_insert_rowid", "", "integer"),
    f("total", "expr", "real", true),
  ],
  postgres: [
    ...COMMON,
    f("string_agg", "expr, delimiter", "text", true),
    f("array_agg", "expr", "anyarray", true),
    f("json_agg", "expr", "json", true),
    f("jsonb_agg", "expr", "jsonb", true),
    f("bool_and", "expr", "boolean", true),
    f("bool_or", "expr", "boolean", true),
    f("now", "", "timestamptz"),
    f("current_date", "", "date"),
    f("date_trunc", "field, source", "timestamp"),
    f("extract", "field FROM source", "numeric"),
    f("age", "timestamp, timestamp", "interval"),
    f("to_char", "value, format", "text"),
    f("to_timestamp", "text, format", "timestamptz"),
    f("concat", "value, ...", "text"),
    f("concat_ws", "separator, value, ...", "text"),
    f("split_part", "text, delimiter, n", "text"),
    f("regexp_replace", "text, pattern, replacement", "text"),
    f("position", "substring IN text", "integer"),
    f("greatest", "value, ..."),
    f("least", "value, ..."),
    f("gen_random_uuid", "", "uuid"),
    f("jsonb_build_object", "key, value, ...", "jsonb"),
    f("json_build_object", "key, value, ...", "json"),
    f("unnest", "anyarray", "setof"),
    f("generate_series", "start, stop, step", "setof"),
    f("row_number", "", "bigint"),
    f("rank", "", "bigint"),
    f("dense_rank", "", "bigint"),
    f("lag", "value, offset, default"),
    f("lead", "value, offset, default"),
    f("pg_size_pretty", "bigint", "text"),
  ],
  mysql: [
    ...COMMON,
    f("group_concat", "expr SEPARATOR ','", "text", true),
    f("ifnull", "a, b"),
    f("if", "cond, then, else"),
    f("concat", "value, ...", "text"),
    f("concat_ws", "separator, value, ...", "text"),
    f("now", "", "datetime"),
    f("curdate", "", "date"),
    f("date_format", "date, format", "text"),
    f("date_add", "date, INTERVAL n unit", "datetime"),
    f("date_sub", "date, INTERVAL n unit", "datetime"),
    f("datediff", "a, b", "int"),
    f("unix_timestamp", "date", "bigint"),
    f("from_unixtime", "seconds", "datetime"),
    f("json_extract", "json, path"),
    f("json_object", "key, value, ...", "json"),
    f("json_arrayagg", "expr", "json", true),
    f("greatest", "value, ..."),
    f("least", "value, ..."),
    f("uuid", "", "varchar"),
    f("last_insert_id", "", "bigint"),
    f("row_number", "", "bigint"),
    f("rank", "", "bigint"),
  ],
  sqlServer: [
    ...COMMON,
    f("getdate", "", "datetime"),
    f("getutcdate", "", "datetime"),
    f("dateadd", "part, n, date", "datetime"),
    f("datediff", "part, a, b", "int"),
    f("isnull", "a, b"),
    f("iif", "cond, then, else"),
    f("concat", "value, ...", "text"),
    f("format", "value, format", "text"),
    f("newid", "", "uniqueidentifier"),
    f("row_number", "", "bigint"),
    f("rank", "", "bigint"),
  ],
};

export function functions(driver: DbDriver): SqlFunction[] {
  return FUNCTIONS[driver];
}
