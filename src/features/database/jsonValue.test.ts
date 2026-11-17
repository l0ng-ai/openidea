import { describe, expect, it } from "vitest";
import { formatJson, initialJsonText, JSON_INLINE_LIMIT, isJsonColumn, isJsonValue, jsonErrorOf } from "./jsonValue";

describe("JSON column detection", () => {
  it("matches json, jsonb and MySQL JSON types", () => {
    for (const type of ["json", "jsonb", "JSON", "Json", "MYSQL_TYPE_JSON"]) expect(isJsonColumn(type)).toBe(true);
    for (const type of ["text", "_json", "jsonb[]", "notjson", "json_config"]) expect(isJsonColumn(type)).toBe(false);
    for (const type of ["VARIANT", "OBJECT", "ARRAY", "variant"]) expect(isJsonColumn(type)).toBe(true);
    for (const type of ["Array(Int32)", "VARCHAR(100)", "int4[]"]) expect(isJsonColumn(type)).toBe(false);
    expect(isJsonColumn("integer")).toBe(false);
    expect(isJsonColumn("")).toBe(false);
  });

  it("edits JSON columns as JSON, including null and invalid values", () => {
    expect(isJsonValue("jsonb", '{"a":1}')).toBe(true);
    expect(isJsonValue("json", null)).toBe(true);
    expect(isJsonValue("JSON", "not json at all")).toBe(true);
  });

  it("edits text cells as JSON only when they are JSON objects or arrays", () => {
    expect(isJsonValue("text", '{"a": 1}')).toBe(true);
    expect(isJsonValue("text", "  [1, 2] ")).toBe(true);
    expect(isJsonValue("text", '{"a": 1')).toBe(false);
    expect(isJsonValue("text", "123")).toBe(false);
    expect(isJsonValue("text", '"quoted"')).toBe(false);
    expect(isJsonValue("text", "hello {world")).toBe(false);
    expect(isJsonValue("text", "")).toBe(false);
    expect(isJsonValue("text", null)).toBe(false);
  });
});

describe("JSON validation", () => {
  it("accepts valid JSON and rejects blank values", () => {
    expect(jsonErrorOf('{"a": 1}')).toBeNull();
    expect(jsonErrorOf("[]")).toBeNull();
    expect(jsonErrorOf("true")).toBeNull();
    expect(jsonErrorOf("")).not.toBeNull();
    expect(jsonErrorOf("   ")).not.toBeNull();
  });

  it("reports the message and offset of the first syntax error", () => {
    const error = jsonErrorOf('{"a": 1,}');
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/JSON/i);
    expect(error!.pos).toBeGreaterThan(0);
    expect(error!.pos).toBeLessThanOrEqual('{"a": 1,}'.length);
    // An error without a parse position lands at the start.
    expect(jsonErrorOf("no json here")!.pos).toBe(0);
  });
});

describe("formatJson", () => {
  it("pretty-prints with two spaces and keeps scalars", () => {
    expect(formatJson('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
    expect(formatJson("123")).toBe("123");
    expect(formatJson('"text"')).toBe('"text"');
  });

  it("passes invalid text through unchanged", () => {
    expect(formatJson('{"a": 1')).toBe('{"a": 1');
    expect(formatJson("")).toBe("");
  });

  it("is stable over already formatted JSON", () => {
    const pretty = '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}';
    expect(formatJson(pretty)).toBe(pretty);
  });
});

it("formats without changing large numbers, duplicate keys or number spelling", () => {
  expect(formatJson('{"n":9007199254740993,"n":1e2}')).toBe('{\n  "n": 9007199254740993,\n  "n": 1e2\n}');
});

it("bounds automatic formatting and content detection for large values", () => {
  const text = '{"large":"' + "x".repeat(5_000_000) + '"}';
  expect(text.length).toBeGreaterThan(JSON_INLINE_LIMIT);
  expect(initialJsonText(text)).toBe(text);
  expect(isJsonValue("text", text)).toBe(false);
  expect(isJsonValue("json", text)).toBe(true);
});

it("reformats a 5 MB string without dropping any of its content", () => {
  const value = "x".repeat(5_000_000);
  expect(formatJson('{"large":"' + value + '"}')).toBe('{\n  "large": "' + value + '"\n}');
});
