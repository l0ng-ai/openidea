import { describe, expect, it } from "vitest";
import type { DbDriver } from "@/platform/ipc";
import { exportData, type ExportData, type ExportFormat } from "./export";

const data = (value: string, type = "NUMERIC", driver: DbDriver = "postgres"): ExportData => ({
  columns: [{ name: "value", type }],
  rows: [[value]],
  table: "numbers",
  driver,
});

const jsonNumber = (value: string) => `[\n  {\n    "value": ${value}\n  }\n]`;

describe("exact JSON number export", () => {
  it.each([
    ["9007199254740993", "BIGINT", "postgres"],
    ["9223372036854775807", "BIGINT", "postgres"],
    ["-9223372036854775808", "BIGINT", "sqlite"],
    ["18446744073709551615", "BIGINT UNSIGNED", "mysql"],
    ["-9007199254740993", "Int64", "clickhouse"],
    ["12345678901234567890123456789012345678", "NUMBER(38,0)", "snowflake"],
    ["1.0000000000000000002", "DECIMAL(38,19)", "sqlServer"],
    ["-1.0000000000000000002", "NUMERIC(38,19)", "postgres"],
    ["1234567890.12345678901234567890", "DECIMAL(38,20)", "mysql"],
    ["0.0000000000000000001", "NUMERIC", "postgres"],
    ["1e-400", "NUMERIC", "postgres"],
    ["1e-325", "NUMERIC", "postgres"],
    ["1e-9007199254740993", "NUMERIC", "postgres"],
    ["-2e-999999999999999999999", "NUMERIC", "postgres"],
    ["99999999999999999999.99999999999999999999", "NUMERIC", "postgres"],
    ["0.10000000000000000000000000001", "DECIMAL(38,29)", "mysql"],
    ["1.797693134862315708145274237317043567981e308", "DOUBLE", "mysql"],
    ["-2e-400", "NUMERIC", "postgres"],
    ["1.0000000000000000002E+100", "NUMERIC", "postgres"],
  ] as const)("preserves %s (%s, %s) as a JSON number", (value, type, driver) => {
    const json = exportData("json", data(value, type, driver));
    expect(json).toBe(jsonNumber(value));
    expect(typeof JSON.parse(json)[0].value).toBe("number");
  });

  it.each([
    ["+9007199254740993", "9007199254740993"],
    ["09007199254740993", "9007199254740993"],
    ["-09223372036854775807", "-9223372036854775807"],
    [" \t+001.0000000000000000002\n", "1.0000000000000000002"],
    [".0000000000000000001", "0.0000000000000000001"],
    ["-.0000000000000000001", "-0.0000000000000000001"],
    ["0001.", "1"],
    ["+001.25e-003", "1.25e-003"],
    ["1.e-400", "1e-400"],
    ["-000.0000000000000000001", "-0.0000000000000000001"],
    ["+.0000000000000000001E-400", "0.0000000000000000001E-400"],
  ])("normalizes %s to valid JSON without rounding", (value, expected) => {
    const json = exportData("json", data(value));
    expect(json).toBe(jsonNumber(expected));
    expect(typeof JSON.parse(json)[0].value).toBe("number");
  });

  it.each(["0", "-0", "-000.000e99999", "42", "-12.5", "+1", ".5", "1.", "", " \t ", "0x10", "0b10", "0o10"])(
    "keeps ordinary numeric coercion for %s",
    (value) => {
      expect(JSON.parse(exportData("json", data(value)))).toEqual([
        { value: JSON.parse(JSON.stringify(Number(value))) },
      ]);
    },
  );

  it.each(["NaN", "Infinity", "-Infinity", "1e400", "-1e999999999999999999999", "1e", '0,"injected":true', "1\n2"])(
    "keeps non-finite or invalid numeric text %s quoted",
    (value) => {
      expect(JSON.parse(exportData("json", data(value)))).toEqual([{ value }]);
    },
  );

  it.each(["TEXT", "VARCHAR(100)", "jsonb", "BOOLEAN", "POINT", "INTERVAL"])(
    "keeps numeric-looking %s as text",
    (type) => {
      expect(JSON.parse(exportData("json", data("9007199254740993", type)))).toEqual([{ value: "9007199254740993" }]);
    },
  );

  it.each(["", "unknown", "NULL"])("preserves exact numbers inferred from %s types", (type) => {
    expect(exportData("json", data("9007199254740993", type))).toBe(jsonNumber("9007199254740993"));
  });

  it("keeps a mixed unknown column as text", () => {
    const d = { ...data("9007199254740993", "unknown"), rows: [["9007199254740993"], ["text"]] };
    expect(JSON.parse(exportData("json", d))).toEqual([{ value: "9007199254740993" }, { value: "text" }]);
  });

  it("escapes column names and text and keeps NULL and missing cells", () => {
    const d: ExportData = {
      columns: [
        { name: 'a"\n', type: "TEXT" },
        { name: "empty", type: "NUMERIC" },
        { name: "missing", type: "TEXT" },
      ],
      rows: [['中文 \\ \t "quote"\n\u0000', null]],
      table: "numbers",
      driver: "postgres",
    };
    expect(exportData("json", d)).toBe(
      JSON.stringify([{ ['a"\n']: '中文 \\ \t "quote"\n\u0000', empty: null, missing: null }], null, 2),
    );
  });

  it("keeps duplicate columns last-wins, integer key order and literal __proto__ keys", () => {
    const d: ExportData = {
      columns: [
        { name: "2", type: "NUMERIC" },
        { name: "10", type: "TEXT" },
        { name: "1", type: "TEXT" },
        { name: "2", type: "TEXT" },
        { name: "__proto__", type: "TEXT" },
      ],
      rows: [["9007199254740993", "ten", "one", "9007199254740993", "literal"]],
      table: "numbers",
      driver: "postgres",
    };
    const row = Object.fromEntries([
      ["2", "9007199254740993"],
      ["10", "ten"],
      ["1", "one"],
      ["__proto__", "literal"],
    ]);
    const json = exportData("json", d);
    expect(json).toBe(JSON.stringify([row], null, 2));
    expect(Object.hasOwn(JSON.parse(json)[0], "__proto__")).toBe(true);
  });

  it("keeps empty results, zero-column rows and ignored extra cells", () => {
    expect(exportData("json", { ...data("1"), rows: [] })).toBe("[]");
    expect(exportData("json", { ...data("1"), columns: [], rows: [[], []] })).toBe("[\n  {},\n  {}\n]");
    expect(exportData("json", { ...data("1"), rows: [["1", "ignored"]] })).toBe(jsonNumber("1"));
  });

  it("keeps all-NULL inference samples from changing later values to numbers", () => {
    const rows = [...Array.from({ length: 50 }, () => [null]), ["9007199254740993"]];
    const json = exportData("json", { ...data("", "unknown"), rows });
    expect(JSON.parse(json)[50]).toEqual({ value: "9007199254740993" });
  });

  it("keeps numeric inference when later rows include text and NULL", () => {
    const rows = [...Array.from({ length: 50 }, () => ["9007199254740993"]), ["text"], [null]];
    const json = exportData("json", { ...data("", "unknown"), rows });
    expect(json.match(/"value": 9007199254740993/g)).toHaveLength(50);
    expect(JSON.parse(json).slice(50)).toEqual([{ value: "text" }, { value: null }]);
  });

  it("retains the exact numeric value when the last duplicate column is numeric", () => {
    const d: ExportData = {
      ...data(""),
      columns: [
        { name: "value", type: "TEXT" },
        { name: "value", type: "BIGINT" },
      ],
      rows: [["discarded", "9223372036854775807"]],
    };
    expect(exportData("json", d)).toBe(jsonNumber("9223372036854775807"));
  });

  it("agrees with independent integer arithmetic over 250 decimal scales and exponents", () => {
    let seed = 0x20261113;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const exponents = [-450, -400, -40, -1, 0, 1, 40, 200];
    for (let i = 0; i < 250; i++) {
      const absolute = 10n ** 36n + BigInt(random()) * 10n ** 27n + BigInt(random());
      const coefficient = i % 2 ? absolute : -absolute;
      const scale = (random() >>> 16) % 45;
      const exponent = exponents[(random() >>> 16) % exponents.length]!;
      const digits = absolute.toString().padStart(scale + 1, "0");
      const mantissa = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
      const sign = coefficient < 0n ? "-" : i % 3 ? "" : "+";
      const input = `\t${sign}${i % 5 ? "" : "00"}${mantissa}E${exponent >= 0 ? "+" : ""}${exponent} `;
      const json = exportData("json", data(input));
      expect(typeof JSON.parse(json)[0].value, input).toBe("number");
      const token = /"value": ([^\n]+)\n/.exec(json)![1]!;
      const [whole, exp = "0"] = token.toLowerCase().split("e");
      const point = whole!.indexOf(".");
      const actual = BigInt(whole!.replace(".", ""));
      const power = Number(exp) - (point < 0 ? 0 : whole!.length - point - 1);
      const expectedPower = exponent - scale;
      const common = Math.min(power, expectedPower);
      expect(actual * 10n ** BigInt(power - common), input).toBe(coefficient * 10n ** BigInt(expectedPower - common));
    }
  });

  it("writes long numbers without losing trailing digits or expanding exponents", () => {
    const value = `1.${"0".repeat(20_000)}1e-400`;
    expect(exportData("json", data(value))).toBe(jsonNumber(value));
  });
});

it.each<ExportFormat>(["csv", "tsv", "sql", "markdown", "onerow"])("%s retains exact numeric digits", (format) => {
  const value = "9223372036854775807";
  expect(exportData(format, data(value))).toContain(value);
});
