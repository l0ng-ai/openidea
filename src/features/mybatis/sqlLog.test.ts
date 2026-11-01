import { describe, expect, it } from "vitest";
import { sqlFromMybatisLog } from "./sqlLog";

describe("sqlFromMybatisLog", () => {
  it("fills placeholders from a Preparing/Parameters pair", () => {
    const log = [
      "==>  Preparing: SELECT id, name FROM user WHERE id = ? AND status = ? AND name LIKE ?",
      "==> Parameters: 1(Long), 2(Integer), %a%(String)",
    ].join("\n");
    expect(sqlFromMybatisLog(log)).toBe(
      "SELECT id, name FROM user WHERE id = 1 AND status = 2 AND name LIKE '%a%';",
    );
  });

  it("turns null into NULL", () => {
    const log = ["==>  Preparing: UPDATE t SET v = ? WHERE id = ?", "==> Parameters: null, 7(Long)"].join("\n");
    expect(sqlFromMybatisLog(log)).toBe("UPDATE t SET v = NULL WHERE id = 7;");
  });

  it("keeps commas inside string values", () => {
    const log = ["==>  Preparing: INSERT INTO t (v) VALUES (?)", "==> Parameters: a, b(String)"].join("\n");
    expect(sqlFromMybatisLog(log)).toBe("INSERT INTO t (v) VALUES ('a, b');");
  });

  it("escapes single quotes in string values", () => {
    const log = ["==>  Preparing: SELECT * FROM t WHERE v = ?", "==> Parameters: O'Neil(String)"].join("\n");
    expect(sqlFromMybatisLog(log)).toBe("SELECT * FROM t WHERE v = 'O''Neil';");
  });

  it("keeps a statement without parameters as-is", () => {
    expect(sqlFromMybatisLog("==>  Preparing: SELECT 1")).toBe("SELECT 1;");
  });

  it("joins several statements with ;\\n\\n and terminates each with ;", () => {
    const log = [
      "==>  Preparing: SELECT * FROM a WHERE x = ?",
      "==> Parameters: 1(Long)",
      "==>  Preparing: DELETE FROM b",
    ].join("\n");
    expect(sqlFromMybatisLog(log)).toBe("SELECT * FROM a WHERE x = 1;\n\nDELETE FROM b;");
  });

  it("returns null for ordinary log text", () => {
    expect(sqlFromMybatisLog("2026-11-01 INFO Started Application\nsome other log")).toBeNull();
  });

  it("keeps short placeholders and ignores extra parameters", () => {
    const log = ["==>  Preparing: SELECT * FROM t WHERE a = ? AND b = ?", "==> Parameters: 1(Long)"].join("\n");
    expect(sqlFromMybatisLog(log)).toBe("SELECT * FROM t WHERE a = 1 AND b = ?;");
    const extra = ["==>  Preparing: SELECT ?", "==> Parameters: 1(Long), 2(Long)"].join("\n");
    expect(sqlFromMybatisLog(extra)).toBe("SELECT 1;");
  });

  it("tolerates log prefixes (timestamps) and blank lines", () => {
    const log = [
      "12:00:01.234 DEBUG c.e.Mapper - ==>  Preparing: SELECT * FROM t WHERE id = ?",
      "12:00:01.235 DEBUG c.e.Mapper - ==> Parameters: 42(Long)",
    ].join("\n");
    expect(sqlFromMybatisLog(log)).toBe("SELECT * FROM t WHERE id = 42;");
  });

  it("passes statements without a parameters line through unmodified", () => {
    const log = [
      "==>  Preparing: SELECT 1",
      "==>  Preparing: SELECT * FROM t WHERE id = ?",
      "==> Parameters: 9(Long)",
    ].join("\n");
    expect(sqlFromMybatisLog(log)).toBe("SELECT 1;\n\nSELECT * FROM t WHERE id = 9;");
  });
});
