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
  });
});
