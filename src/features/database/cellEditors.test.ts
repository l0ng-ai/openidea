import { describe, expect, it } from "vitest";
import { booleanLiterals, defaultLiteralOf, enumValuesOfType, isBooleanType, NULL_INPUT } from "./cellEditors";

describe("boolean cell editing", () => {
  it("detects the column types that edit as a boolean", () => {
    for (const type of ["boolean", "BOOLEAN", "bool", "tinyint(1)", "TINYINT(1)", "bit", "Bit"])
      expect(isBooleanType(type), type).toBe(true);
    for (const type of ["tinyint", "tinyint(4)", "int", "text", "bit varying", ""])
      expect(isBooleanType(type), type).toBe(false);
  });

  it("writes the literals the driver renders booleans with", () => {
    expect(booleanLiterals("postgres")).toEqual({ t: "t", f: "f" });
    expect(booleanLiterals("mysql")).toEqual({ t: "1", f: "0" });
    expect(booleanLiterals("sqlite")).toEqual({ t: "1", f: "0" });
    expect(booleanLiterals("sqlServer")).toEqual({ t: "1", f: "0" });
    expect(booleanLiterals("oracle")).toEqual({ t: "true", f: "false" });
    expect(booleanLiterals(undefined)).toEqual({ t: "true", f: "false" });
  });

  it("keeps the select editor's NULL option value off the cell alphabet", () => {
    expect(NULL_INPUT).not.toBe("");
    expect(NULL_INPUT.startsWith("\u0000")).toBe(true);
  });
});

describe("enum cell editing", () => {
  it("lists a MySQL ENUM type's values in definition order", () => {
    expect(enumValuesOfType("enum('a','b','c')")).toEqual(["a", "b", "c"]);
    expect(enumValuesOfType("ENUM( 'x' , 'y' )")).toEqual(["x", "y"]);
    expect(enumValuesOfType("enum('it''s','say \"hi\"','a,b')")).toEqual(["it's", 'say "hi"', "a,b"]);
    expect(enumValuesOfType("enum('')")).toEqual([""]);
  });

  it("rejects types that don't carry a value list", () => {
    for (const type of [
      "varchar(10)",
      "ENUM",
      "mood",
      "USER-DEFINED",
      "enum()",
      "enum('a',)",
      "enum(a)",
      "enum('a'",
      "enum('a','b",
    ])
      expect(enumValuesOfType(type), type).toBeNull();
  });
});

describe("Set DEFAULT", () => {
  it("uses plain string and number defaults as the cell's literal", () => {
    expect(defaultLiteralOf("'active'")).toBe("active");
    expect(defaultLiteralOf("'active'::character varying")).toBe("active");
    expect(defaultLiteralOf("''::text")).toBe("");
    expect(defaultLiteralOf("'it''s'")).toBe("it's");
    expect(defaultLiteralOf("42")).toBe("42");
    expect(defaultLiteralOf("-1.5")).toBe("-1.5");
    expect(defaultLiteralOf("+7")).toBe("+7");
  });

  it("rejects expression defaults the grid's pending edits cannot send", () => {
    for (const d of ["now()", "nextval('ids'::regclass)", "CURRENT_TIMESTAMP", "b'0'", "'a' || 'b'", "", "  "])
      expect(defaultLiteralOf(d), d).toBeNull();
  });
});
