import { describe, expect, it } from "vitest";
import { formatJsonText, jsonNumber, parseJsonText, stringifyJson, toJsonValue } from "./losslessJson";

describe("jsonNumber", () => {
  it.each([
    ["9007199254740993", "9007199254740993"],
    ["1.0000000000000000002", "1.0000000000000000002"],
    ["1e-400", "1e-400"],
    ["1.0000000000000000002E+100", "1.0000000000000000002E+100"],
    [" \t+001.0000000000000000002\n", "1.0000000000000000002"],
    ["0001.", "1"],
    ["-0", "0"],
    ["1e", null],
    ["NaN", null],
  ])("normalizes %s to %s without rounding", (text, expected) => {
    expect(jsonNumber(text)).toBe(expected);
  });
});

describe("parseJsonText / stringifyJson", () => {
  it("parses and serializes like JSON.parse / JSON.stringify", () => {
    const text = '{"a":[1,2,{"b":null,"c":true}],"d":"\\u0041\\n","e":{}}';
    expect(stringifyJson(parseJsonText(text)!)).toBe(JSON.stringify(JSON.parse(text)));
    expect(stringifyJson(parseJsonText(text)!, 2)).toBe(JSON.stringify(JSON.parse(text), null, 2));
  });

  it("keeps number literals exact, without expanding them through Number", () => {
    const value = parseJsonText('{"id":9007199254740993,"amount":1.0000000000000000002,"tiny":1e-400}')!;
    expect(value).toEqual({
      t: "obj",
      entries: [
        ["id", { t: "num", text: "9007199254740993" }],
        ["amount", { t: "num", text: "1.0000000000000000002" }],
        ["tiny", { t: "num", text: "1e-400" }],
      ],
    });
    expect(JSON.parse(stringifyJson(value))).toEqual(JSON.parse('{"id":9007199254740993,"amount":1,"tiny":0}'));
  });

  it("rejects invalid JSON and accepts what JSON.parse accepts", () => {
    for (const bad of ["", "{", '{"a":}', "[1,]", "{'a':1}", "01", "+1", "1.", ".5", 'wrong "a" 1', '{"a":1}x']) {
      expect(parseJsonText(bad), bad).toBeNull();
      expect(formatJsonText(bad), bad).toBeNull();
    }
    for (const good of [
      '{"a":1}',
      "  [ 1 , 2 ]  ",
      '"\\ud834\\udd1e"',
      '"\\ud800"',
      "9007199254740993",
      "true",
      "null",
    ]) {
      expect(JSON.parse(stringifyJson(parseJsonText(good)!))).toEqual(JSON.parse(good));
    }
  });

  it("keeps the last value of a repeated key at its first position", () => {
    expect(parseJsonText('{"a":1,"b":2,"a":3}')).toEqual({
      t: "obj",
      entries: [
        ["a", { t: "num", text: "3" }],
        ["b", { t: "num", text: "2" }],
      ],
    });
  });

  it("keeps a long number whole", () => {
    const digits = "9007199254740993".repeat(20);
    expect(parseJsonText(`[${digits}]`)).toEqual({ t: "arr", items: [{ t: "num", text: digits }] });
  });
});

describe("toJsonValue", () => {
  it("converts plain JavaScript values", () => {
    expect(toJsonValue({ a: [1, "x", true, null], b: NaN })).toEqual({
      t: "obj",
      entries: [
        [
          "a",
          { t: "arr", items: [{ t: "num", text: "1" }, { t: "str", v: "x" }, { t: "bool", v: true }, { t: "null" }] },
        ],
        ["b", { t: "null" }],
      ],
    });
  });
});

describe("formatJsonText", () => {
  it("formats with exact numbers", () => {
    expect(formatJsonText('{"id":9007199254740993}')).toBe('{\n  "id": 9007199254740993\n}');
  });
});
