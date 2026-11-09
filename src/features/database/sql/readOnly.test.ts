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
});
