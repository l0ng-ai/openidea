import { describe, expect, it } from "vitest";
import { isReadOnlyQuery } from "./readOnly";

describe("isReadOnlyQuery", () => {
  it("accepts queries that only read", () => {
    for (const text of [
      "SELECT * FROM t",
      "with x as (select 1) select * from x",
      "VALUES (1), (2)",
      "show tables",
      "(select 1) union (select 2)",
    ])
      expect(isReadOnlyQuery(text, "postgres"), text).toBe(true);
  });

  it("rejects statements that change data", () => {
    for (const text of [
      "DELETE FROM t RETURNING *",
      "UPDATE t SET a = 1 RETURNING a",
      "INSERT INTO t VALUES (1) RETURNING id",
      "with d as (delete from t returning *) select * from d",
      "select * into t2 from t",
      "select * from t for update",
      "select nextval('s')",
    ])
      expect(isReadOnlyQuery(text, "postgres"), text).toBe(false);
  });

  it("classifies Snowflake statements", () => {
    for (const text of [
      "SELECT src:a::string FROM t // insert",
      "with x as (select 1) select * from x",
      "SHOW TABLES IN SCHEMA db.public",
      "describe table t",
      "DESC VIEW v",
      "EXPLAIN SELECT 1",
      "LIST @my_stage/path",
      "ls @~",
      "TABLE t",
      "VALUES (1), (2)",
      "select $1 from @my_stage/data (file_format => 'ff')",
    ])
      expect(isReadOnlyQuery(text, "snowflake"), text).toBe(true);
    for (const text of [
      "COPY INTO t FROM @my_stage",
      "PUT file:///tmp/a.csv @my_stage",
      "GET @my_stage file:///tmp/",
      "REMOVE @my_stage/path",
      "rm @~/x",
      "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1",
      "CALL my_proc()",
      "EXECUTE IMMEDIATE $$ select 1 $$",
      "USE SCHEMA public",
      "ALTER SESSION SET TIMEZONE = 'UTC'",
      "CREATE OR REPLACE TABLE t (a int)",
      "DROP TABLE t",
      "UNDROP TABLE t",
      "TRUNCATE TABLE t",
      "GRANT SELECT ON t TO ROLE r",
      "REVOKE SELECT ON t FROM ROLE r",
      "BEGIN",
      "COMMIT",
      "ROLLBACK",
      "SET v = 1",
      "UNSET v",
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "select seq.nextval",
      "select system$cancel_query('x')",
      "select * from table(result_scan(last_query_id()))",
      "show tables ->> delete from t",
    ])
      expect(isReadOnlyQuery(text, "snowflake"), text).toBe(false);
    // Stage listings are Snowflake's alone.
    expect(isReadOnlyQuery("LIST @my_stage", "postgres")).toBe(false);
  });
});
