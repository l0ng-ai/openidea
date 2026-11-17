// @vitest-environment node
import { describe, expect, it } from "vitest";
import { StreamLanguage } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { tomlParser } from "./toml";

const language = StreamLanguage.define(tomlParser);

const highlighter = tagHighlighter([
  { tag: t.keyword, class: "keyword" },
  { tag: t.string, class: "string" },
  { tag: t.number, class: "number" },
  { tag: t.standard(t.variableName), class: "builtin" },
  { tag: t.comment, class: "comment" },
  { tag: t.escape, class: "escape" },
  { tag: t.invalid, class: "invalid" },
]);

function highlighted(source: string) {
  const found: Array<[string, string]> = [];
  highlightTree(language.parser.parse(source), highlighter, (from, to, style) =>
    found.push([source.slice(from, to), style]),
  );
  return found;
}

describe("TOML highlighting", () => {
  // IntelliJ's colour settings demo (plugins/toml highlighterDemoText.toml). Its two escape lines
  // tag only the escapes; the keys and string bodies around them get KEY and STRING there too.
  it("colours IntelliJ's TOML demo like IntelliJ", () => {
    const demo = [
      "# This is a TOML document.",
      "",
      'title = "TOML Example"',
      'description = """',
      "    Multiline",
      "    description",
      '"""',
      "date = 2019-11-04T07:32:00-08:00",
      "",
      "[database]",
      'server = "192.168.1.1"',
      "ports = [ 8001, 8001, 8002 ]",
      '"connection_max" = 5000',
      "enabled = true",
      "",
      "[servers]",
      "alpha = { ip = '10.0.0.1', dc = \"eqdc10\" }",
      "beta = { ip = '10.0.0.2', dc = \"eqdc10\" }",
      "",
      "[clients]",
      'data = [ ["gamma", "delta"], [1.0, 2.0] ]',
      "",
      "hosts = [",
      '  "alpha",',
      '  "omega",',
      "]",
      "",
      'valid-escapes = """\\tline \\"1\\"',
      "    line\\u00202",
      "    line 3\\U0000002E",
      '"""',
      'invalid-escapes = "\\a \\u20 \\U0020"',
    ].join("\n");
    expect(highlighted(demo)).toEqual([
      ["# This is a TOML document.", "comment"],
      ["title", "keyword"],
      ['"TOML Example"', "string"],
      ["description", "keyword"],
      ['"""', "string"],
      ["    Multiline", "string"],
      ["    description", "string"],
      ['"""', "string"],
      ["date", "keyword"],
      ["2019-11-04T07:32:00-08:00", "builtin"],
      ["database", "keyword"],
      ["server", "keyword"],
      ['"192.168.1.1"', "string"],
      ["ports", "keyword"],
      ["8001", "number"],
      ["8001", "number"],
      ["8002", "number"],
      ['"connection_max"', "string"],
      ["5000", "number"],
      ["enabled", "keyword"],
      ["true", "builtin"],
      ["servers", "keyword"],
      ["alpha", "keyword"],
      ["ip", "keyword"],
      ["'10.0.0.1'", "string"],
      ["dc", "keyword"],
      ['"eqdc10"', "string"],
      ["beta", "keyword"],
      ["ip", "keyword"],
      ["'10.0.0.2'", "string"],
      ["dc", "keyword"],
      ['"eqdc10"', "string"],
      ["clients", "keyword"],
      ["data", "keyword"],
      ['"gamma"', "string"],
      ['"delta"', "string"],
      ["1.0", "number"],
      ["2.0", "number"],
      ["hosts", "keyword"],
      ['"alpha"', "string"],
      ['"omega"', "string"],
      ["valid-escapes", "keyword"],
      ['"""', "string"],
      ["\\t", "escape"],
      ["line ", "string"],
      ['\\"', "escape"],
      ["1", "string"],
      ['\\"', "escape"],
      ["    line", "string"],
      ["\\u0020", "escape"],
      ["2", "string"],
      ["    line 3", "string"],
      ["\\U0000002E", "escape"],
      ['"""', "string"],
      ["invalid-escapes", "keyword"],
      ['"', "string"],
      ["\\a", "invalid"],
      [" ", "string"],
      ["\\u", "invalid"],
      ["20 ", "string"],
      ["\\U", "invalid"],
      ['0020"', "string"],
    ]);
  });

  // IntelliJ's TomlHighlightingAnnotatorTest: numbers, dates and booleans can be keys too.
  it("colours numbers and dates as values and bare keys of any shape as keys", () => {
    expect(
      highlighted(
        [
          'k1= "foo"',
          'k2."k3".k4 = "bar"',
          '123 = "baz"',
          '2019-11-08 = "qqq"',
          "true = 1",
          "k5 = { k6 = 123, k7 = 2019-11-08 }",
          "[foo.bar]",
        ].join("\n"),
      ),
    ).toEqual([
      ["k1", "keyword"],
      ['"foo"', "string"],
      ["k2", "keyword"],
      ['"k3"', "string"],
      ["k4", "keyword"],
      ['"bar"', "string"],
      ["123", "keyword"],
      ['"baz"', "string"],
      ["2019-11-08", "keyword"],
      ['"qqq"', "string"],
      ["true", "keyword"],
      ["1", "number"],
      ["k5", "keyword"],
      ["k6", "keyword"],
      ["123", "number"],
      ["k7", "keyword"],
      ["2019-11-08", "builtin"],
      ["foo", "keyword"],
      ["bar", "keyword"],
    ]);
  });

  it.each([
    ["t = 07:32:00", [["07:32:00", "builtin"]]],
    // A time needs seconds: this is two numbers around a stray colon, as in IntelliJ's lexer.
    [
      "t = 07:32",
      [
        ["07", "number"],
        ["32", "number"],
      ],
    ],
    [
      "d = 2019-11-08 # c",
      [
        ["2019-11-08", "builtin"],
        ["# c", "comment"],
      ],
    ],
    ["d = 1979-05-27 07:32:00Z", [["1979-05-27 07:32:00Z", "builtin"]]],
    ["d = 1979-05-27T00:32:00.999999+07:00", [["1979-05-27T00:32:00.999999+07:00", "builtin"]]],
    ["n = +inf", [["+inf", "number"]]],
    ["n = 1_000", [["1_000", "number"]]],
    ["n = 6.626e-34", [["6.626e-34", "number"]]],
    ["n = 0xdead_beef", [["0xdead_beef", "number"]]],
    ["n = 0o755", [["0o755", "number"]]],
    ["n = 0b1101", [["0b1101", "number"]]],
    // Not a number (a hex digit has to follow `0x`) or not a boolean: a bare key to IntelliJ's lexer.
    ["n = 0x_1", [["0x_1", "keyword"]]],
    ["b = trueish", [["trueish", "keyword"]]],
    ["s = 'C:\\Users\\nodejs'", [["'C:\\Users\\nodejs'", "string"]]],
    ['s = """"q""""', [['""""q""""', "string"]]],
    ["s = ''''q''''", [["''''q''''", "string"]]],
    [
      's = "\\uD800"',
      [
        ['"', "string"],
        ["\\uD800", "invalid"],
        ['"', "string"],
      ],
    ],
    [
      's = "\\U0010FFFF\\U00110000"',
      [
        ['"', "string"],
        ["\\U0010FFFF", "escape"],
        ["\\U00110000", "invalid"],
        ['"', "string"],
      ],
    ],
    [
      's = "\\e"',
      [
        ['"', "string"],
        ["\\e", "invalid"],
        ['"', "string"],
      ],
    ],
    [
      's = "\\\\"',
      [
        ['"', "string"],
        ["\\\\", "escape"],
        ['"', "string"],
      ],
    ],
    // A line-ending backslash trims the line break in a multi-line basic string only.
    [
      's = """a \\\n  b"""',
      [
        ['"""a ', "string"],
        ["\\", "escape"],
        ['  b"""', "string"],
      ],
    ],
    // Whitespace may follow that backslash.
    [
      's = """a \\ \t\n  b"""',
      [
        ['"""a ', "string"],
        ["\\ \t", "escape"],
        ['  b"""', "string"],
      ],
    ],
    [
      's = "a \\\nb = 1',
      [
        ['"a ', "string"],
        ["\\", "invalid"],
        ["b", "keyword"],
        ["1", "number"],
      ],
    ],
    [
      "k = 'a'.b",
      [
        ["'a'", "string"],
        ["b", "keyword"],
      ],
    ],
    ["  [dependencies]", [["dependencies", "keyword"]]],
    ["[[bin]]", [["bin", "keyword"]]],
    [
      '[ "a b" . c ]',
      [
        ['"a b"', "string"],
        ["c", "keyword"],
      ],
    ],
    ["x = [{}, 1]", [["1", "number"]]],
    [
      "x = [{ a = 1 }, { b = [2, { c = 3 }] }]",
      [
        ["a", "keyword"],
        ["1", "number"],
        ["b", "keyword"],
        ["2", "number"],
        ["c", "keyword"],
        ["3", "number"],
      ],
    ],
    [
      'features = [\n  "derive", # serde\n  1,\n]\nb = true',
      [
        ['"derive"', "string"],
        ["# serde", "comment"],
        ["1", "number"],
        ["b", "keyword"],
        ["true", "builtin"],
      ],
    ],
    // A nested array at column 0 is no table header.
    [
      "x = [\n[1],\n[true]\n]\ny = 2",
      [
        ["1", "number"],
        ["true", "builtin"],
        ["y", "keyword"],
        ["2", "number"],
      ],
    ],
    // An unclosed array while typing: the next key line starts over.
    [
      'deps = [\n[package]\nname = "x"',
      [
        ["package", "keyword"],
        ["name", "keyword"],
        ['"x"', "string"],
      ],
    ],
    [
      'deps = [\nname = "x"',
      [
        ["name", "keyword"],
        ['"x"', "string"],
      ],
    ],
    // An unclosed single-line string ends with its line.
    [
      's = "abc\nk = 1',
      [
        ['"abc', "string"],
        ["k", "keyword"],
        ["1", "number"],
      ],
    ],
  ] as Array<[string, Array<[string, string]>]>)("colours %j", (source, values) => {
    const found = highlighted(source);
    const key = source.match(/^[A-Za-z0-9_-]+(?= ?=)/)?.[0];
    expect(found).toEqual(key ? [[key, "keyword"], ...values] : values);
  });
});
