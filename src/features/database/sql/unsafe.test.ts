import { describe, expect, it } from "vitest";
import { unsafeMessage, unsafeStatement } from "./unsafe";

const check = (text: string) => unsafeStatement(text, "postgres");

describe("unsafeStatement", () => {
  it("flags DELETE and UPDATE without WHERE", () => {
    expect(check("DELETE FROM t")).toMatchObject({ kind: "delete", reason: "no-where" });
    expect(check("delete from t returning *")).toMatchObject({ kind: "delete", reason: "no-where" });
    expect(check("UPDATE t SET a = 1")).toMatchObject({ kind: "update", reason: "no-where" });
    expect(check("update t set a = (select max(b) from u where u.id = 3)")).toMatchObject({
      kind: "update",
      reason: "no-where",
    });
  });

  it("flags a WHERE that is always true", () => {
    expect(check("DELETE FROM t_digital_tachometer_file WHERE 1=1")).toMatchObject({
      kind: "delete",
      reason: "always-true",
    });
    for (const where of [
      "TRUE",
      "1",
      "(1 = 1)",
      "'a' = 'a'",
      "1 <> 2",
      "2 > 1",
      "NOT FALSE",
      "NOT (1 = 0)",
      "id = 5 OR 1 = 1",
      "1 = 1 AND true",
      "1 IS NOT NULL",
      "-1 = -1",
    ])
      expect(check(`delete from t where ${where}`), where).toMatchObject({ reason: "always-true" });
    expect(check("update t set a = 1 where 1=1 returning a")).toMatchObject({ kind: "update", reason: "always-true" });
  });

  it("marks the condition of an always-true WHERE, the whole statement otherwise", () => {
    const text = "DELETE FROM t WHERE 1=1";
    const u = check(text)!;
    expect(text.slice(u.from, u.to)).toBe("1=1");
    const all = check("DELETE FROM t")!;
    expect([all.from, all.to]).toEqual([0, "DELETE FROM t".length]);
  });

  it("leaves statements with a real condition alone", () => {
    for (const text of [
      "DELETE FROM t WHERE id = 1",
      "DELETE FROM t WHERE 1 = 1 AND id = 3",
      "delete from t where 1 = 0 or id = 2",
      "delete from t where id = id",
      "delete from t where x between 1 and 2",
      "delete from t where 1 = 2",
      "update t set a = 1 where current of c",
      "DELETE FROM t USING u WHERE t.id = u.id",
      "SELECT * FROM t",
      "INSERT INTO t VALUES (1)",
      "CREATE RULE r AS ON DELETE TO t DO INSTEAD NOTHING",
      "-- DELETE FROM t\nSELECT 1",
      "SELECT 'DELETE FROM t'",
    ])
      expect(check(text), text).toBeNull();
  });

  it("flags more constant conditions", () => {
    for (const where of [
      "NULL IS NULL",
      "1 + 1 = 2",
      "2 * 3 > 5",
      "(1 + 2) * 2 = 6",
      "10 / 2 = 5",
      "1 IN (1, 2)",
      "3 NOT IN (1, 2)",
      "'a' IN ('a', 'b')",
      "2 BETWEEN 1 AND 3",
      "5 NOT BETWEEN 1 AND 3",
      "'abc' LIKE 'a%'",
      "'abc' LIKE '_b_'",
      "'x' NOT LIKE 'y%'",
      "'ABC' ILIKE 'abc'",
      "EXISTS (SELECT 1)",
      "TRUE = TRUE",
      "id IS NULL OR id IS NOT NULL",
      "status = 1 OR t.x IS NOT NULL OR t.x IS NULL",
      "NOT NOT TRUE",
      "1 = 1 AND 2 BETWEEN 1 AND 3",
    ])
      expect(check(`delete from t where ${where}`), where).toMatchObject({ reason: "always-true" });
  });

  it("leaves conditions that are not certainly true alone", () => {
    for (const where of [
      "NULL = NULL",
      "NULL IS NOT NULL",
      "1 IN (2, NULL)",
      "1 NOT IN (2, NULL)",
      "id IN (1, 2)",
      "1 IN (SELECT id FROM u)",
      "'a' = 'A'",
      "'a' < 'b'",
      "'1' = 1",
      "5 / 2 = 2",
      "1 / 0 = 1",
      "'ABC' LIKE 'abc'",
      "'a_c' LIKE 'a!_c' ESCAPE '!'",
      "EXISTS (SELECT 1 FROM u)",
      "EXISTS (SELECT 1 WHERE false)",
      "id IS NULL OR name IS NOT NULL",
      "NULL",
      "0",
      "id = id",
      "x BETWEEN 1 AND 3",
    ])
      expect(check(`delete from t where ${where}`), where).toBeNull();
  });

  it("flags statements that drop or clear tables", () => {
    expect(check("TRUNCATE TABLE t")).toMatchObject({ kind: "truncate", reason: "clears-table" });
    expect(check("truncate t, u cascade")).toMatchObject({ kind: "truncate" });
    expect(check("DROP TABLE t")).toMatchObject({ kind: "drop", reason: "drops-table" });
    expect(check("drop table if exists t")).toMatchObject({ reason: "drops-table" });
    expect(check("DROP TEMPORARY TABLE t")).toMatchObject({ reason: "drops-table" });
    expect(check("DROP DATABASE app")).toMatchObject({ reason: "drops-database" });
    expect(check("DROP SCHEMA s CASCADE")).toMatchObject({ reason: "drops-schema" });
    expect(check("ALTER TABLE t DROP COLUMN c")).toMatchObject({ kind: "alter", reason: "drops-column" });
    expect(check("alter table t drop c")).toMatchObject({ reason: "drops-column" });
    expect(check("ALTER TABLE t ADD x int, DROP COLUMN IF EXISTS c")).toMatchObject({ reason: "drops-column" });
    const all = check("DROP TABLE t")!;
    expect([all.from, all.to]).toEqual([0, "DROP TABLE t".length]);
  });

  it("leaves drops that keep the data alone", () => {
    for (const text of [
      "DROP VIEW v",
      "DROP INDEX i",
      "DROP FUNCTION f()",
      "ALTER TABLE t DROP CONSTRAINT c",
      "ALTER TABLE t ALTER COLUMN c DROP DEFAULT",
      "ALTER TABLE t ALTER COLUMN c DROP NOT NULL",
      "ALTER TABLE t DROP PRIMARY KEY",
      "ALTER TABLE t DROP FOREIGN KEY fk",
      "ALTER TABLE t ADD COLUMN c int",
      "ALTER INDEX i RENAME TO j",
    ])
      expect(check(text), text).toBeNull();
  });

  it("evaluates IS TRUE / DISTINCT FROM, <=>, N'…' and casts that keep the value", () => {
    for (const where of [
      "TRUE IS TRUE",
      "1 = 1 IS NOT FALSE",
      "FALSE IS NOT TRUE",
      "1 <=> 1",
      "NULL <=> NULL",
      "NULL IS NOT DISTINCT FROM NULL",
      "1 IS DISTINCT FROM 2",
      "N'a' = N'a'",
      "1::int = 1",
      "-1::int = -1",
      "'a'::text = 'a'",
      "CAST(1 AS bigint) = 1",
      "1.5 = 1.5",
      "1 = 1.0",
    ])
      expect(check(`delete from t where ${where}`), where).toMatchObject({ reason: "always-true" });
  });

  it("leaves NULL, lossy casts and inexact numbers alone", () => {
    for (const where of [
      "NOT NULL",
      "NOT (NULL)",
      "NULL IS UNKNOWN",
      "1 <=> NULL",
      "id <=> id",
      "1 IS DISTINCT FROM 1",
      "1.5::int = 2",
      "'1'::int = 1",
      "'ab'::varchar(1) = 'a'",
      "CAST('1' AS int) = 1",
      "E'a\\nb' = 'a'",
      "9007199254740993 = 9007199254740992",
      "0.1 + 0.2 <> 0.3",
      "0x1 = 1",
    ])
      expect(check(`delete from t where ${where}`), where).toBeNull();
  });

  it("finds a statement inside parentheses, EXPLAIN ANALYZE and a WITH clause's queries", () => {
    expect(check("(DELETE FROM t)")).toMatchObject({ kind: "delete", reason: "no-where" });
    expect(check("EXPLAIN ANALYZE DELETE FROM t")).toMatchObject({ kind: "delete", reason: "no-where" });
    expect(check("explain analyze verbose update t set a = 1 where 1 = 1")).toMatchObject({ reason: "always-true" });
    expect(check("EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1")).toMatchObject({ kind: "update" });
    const cte = "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d";
    const u = check(cte)!;
    expect(u).toMatchObject({ kind: "delete", reason: "no-where" });
    expect(cte.slice(u.from, u.to)).toBe("DELETE FROM t RETURNING *");
    expect(check("with x as (select 1), d as materialized (update t set a = 1) select 1")).toMatchObject({
      kind: "update",
    });
    for (const text of [
      "EXPLAIN DELETE FROM t",
      "EXPLAIN (ANALYZE false) DELETE FROM t",
      "EXPLAIN (FORMAT JSON) DELETE FROM t",
      "WITH d AS (DELETE FROM t WHERE id = 1 RETURNING *) SELECT * FROM d",
      "WITH x(a) AS (SELECT 1) SELECT * FROM x",
      "(SELECT 1)",
    ])
      expect(check(text), text).toBeNull();
  });

  it("flags a MERGE whose ON is always true", () => {
    const merge = "MERGE INTO t USING u ON 1=1 WHEN MATCHED THEN DELETE";
    const u = check(merge)!;
    expect(u).toMatchObject({ kind: "merge-delete", reason: "always-true" });
    expect(merge.slice(u.from, u.to)).toBe("1=1");
    expect(
      check(
        "merge into t using u on (1 = 1) when matched then update set a = u.a when not matched then insert values (1)",
      ),
    ).toMatchObject({ kind: "merge-update" });
    expect(check("MERGE t USING u ON TRUE WHEN MATCHED AND 1 = 1 THEN DELETE")).toMatchObject({ kind: "merge-delete" });
    for (const text of [
      "MERGE INTO t USING u ON t.id = u.id WHEN MATCHED THEN DELETE",
      "MERGE INTO t USING u ON 1=1 WHEN MATCHED AND t.x = 1 THEN DELETE",
      "MERGE INTO t USING u ON 1=1 WHEN NOT MATCHED THEN INSERT VALUES (1)",
      "MERGE INTO t USING u ON 1=1 WHEN MATCHED THEN DO NOTHING",
    ])
      expect(check(text), text).toBeNull();
  });

  it("flags ALTER TABLE forms that drop partitions or history", () => {
    expect(check("ALTER TABLE t DROP PARTITION p0, p1")).toMatchObject({ kind: "alter", reason: "drops-partition" });
    expect(check("alter table t truncate partition p0")).toMatchObject({ reason: "clears-partition" });
    expect(check("ALTER TABLE t DROP SYSTEM VERSIONING")).toMatchObject({ reason: "drops-history" });
    for (const text of [
      "ALTER TABLE t ALTER COLUMN c DROP STORED",
      "ALTER TABLE t DROP PERIOD FOR p",
      "ALTER TABLE t DROP UNIQUE (c)",
      "ALTER TABLE t ALTER COLUMN c DROP IDENTITY IF EXISTS",
    ])
      expect(check(text), text).toBeNull();
  });

  it("reads past a WITH clause and comments", () => {
    expect(check("WITH x AS (SELECT 1) DELETE FROM t")).toMatchObject({ kind: "delete", reason: "no-where" });
    expect(check("with x as (select id from u where true) delete from t where id in (select id from x)")).toBeNull();
    expect(check("/* cleanup */ DELETE FROM t -- all of it")).toMatchObject({ reason: "no-where" });
  });
});

describe("unsafeMessage", () => {
  it("says what the statement does, like IDEA", () => {
    expect(unsafeMessage({ kind: "delete", reason: "always-true", from: 0, to: 0 })).toBe(
      "Unsafe query: 'Delete' statement clears all data in the table because 'where' condition is always true",
    );
    expect(unsafeMessage({ kind: "delete", reason: "no-where", from: 0, to: 0 })).toBe(
      "Unsafe query: 'Delete' statement without 'where' clears all data in the table",
    );
    expect(unsafeMessage({ kind: "update", reason: "always-true", from: 0, to: 0 })).toBe(
      "Unsafe query: 'Update' statement updates all rows in the table because 'where' condition is always true",
    );
    expect(unsafeMessage({ kind: "update", reason: "no-where", from: 0, to: 0 })).toBe(
      "Unsafe query: 'Update' statement without 'where' updates all rows in the table",
    );
    expect(unsafeMessage({ kind: "truncate", reason: "clears-table", from: 0, to: 0 })).toBe(
      "Unsafe query: 'Truncate' statement clears all data in the table",
    );
    expect(unsafeMessage({ kind: "drop", reason: "drops-database", from: 0, to: 0 })).toBe(
      "Unsafe query: 'Drop' statement deletes the database with all its data",
    );
    expect(unsafeMessage({ kind: "merge-delete", reason: "always-true", from: 0, to: 0 })).toBe(
      "Unsafe query: 'Merge' statement deletes all rows in the table because 'on' condition is always true",
    );
    expect(unsafeMessage({ kind: "alter", reason: "drops-partition", from: 0, to: 0 })).toBe(
      "Unsafe query: 'Alter' statement drops a partition with all its data",
    );
  });
});
