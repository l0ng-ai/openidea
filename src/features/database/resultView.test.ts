import { describe, expect, it } from "vitest";
import { exportData, type ExportData } from "./export";
import {
  formatOrderBy,
  guessSeparator,
  importEdits,
  parseDelimited,
  parseOrderBy,
  passesObjectFilter,
  type Cell,
} from "./model";
import { dropSql } from "./objects";
import {
  aggregates,
  cellMatcher,
  findCells,
  pageFetch,
  pageWindow,
  chartSeries,
  compareCells,
  distinctValues,
  niceTicks,
  toggleFilterValue,
  visibleRows,
  type LocalFilter,
} from "./resultView";

const rows: Cell[][] = [
  ["1", "Shanghai", "10"],
  ["2", "Beijing", null],
  ["3", "Shanghai", "2.5"],
  ["4", null, "7"],
];
const value = (r: number, c: number) => rows[r]?.[c] ?? null;

describe("exact numeric cell comparison", () => {
  it.each([
    ["9007199254740992", "9007199254740993"],
    ["9223372036854775806", "9223372036854775807"],
    ["-9007199254740993", "-9007199254740992"],
    ["-9223372036854775808", "-9223372036854775807"],
    ["1.0000000000000000001", "1.0000000000000000002"],
    ["-1.0000000000000000002", "-1.0000000000000000001"],
    ["0.99999999999999999999", "1.00000000000000000001"],
    ["12.00000000000000000001", "12.0000000000000000001"],
    ["1e400", "2e400"],
    ["-2e400", "-1e400"],
    ["1e-400", "2e-400"],
    ["-2e-400", "-1e-400"],
    ["0", "1e-400"],
    ["-1e-400", "-0"],
    ["1e9007199254740992", "1e9007199254740993"],
    ["1e-9007199254740993", "1e-9007199254740992"],
    ["9e999999999999999999999999", "1e1000000000000000000000000"],
    ["000.000000000000000000001", "0.000000000000000000002"],
    ["123456789012345678901234567890", "123456789012345678901234567891"],
    ["10", "9e1"],
  ])("orders %s before %s in both directions", (smaller, larger) => {
    expect(compareCells(smaller, larger)).toBeLessThan(0);
    expect(compareCells(larger, smaller)).toBeGreaterThan(0);
  });

  it.each([
    ["1", "01"],
    ["1", "1.000"],
    ["1", "10e-1"],
    ["1.25", "0012500E-4"],
    ["-1.25", "-125e-2"],
    ["0", "-0"],
    ["-0.000e999999999999999999999999", "00e-999999999999999999999999"],
    ["1e400", "10e399"],
    ["1e-400", "100e-402"],
    ["1e9007199254740993", "10e9007199254740992"],
  ])("keeps equivalent values equal: %s and %s", (a, b) => {
    expect(compareCells(a, b)).toBe(0);
    expect(compareCells(b, a)).toBe(0);
  });

  it("keeps NULL and non-numeric text ordering", () => {
    for (const text of ["", "NaN", "Infinity", "+1", ".5", "1.", "1e", "abc"]) {
      expect(compareCells(null, text)).toBeLessThan(0);
      expect(compareCells(text, null)).toBeGreaterThan(0);
      expect(compareCells(text, "2")).toBe(text < "2" ? -1 : 1);
      expect(compareCells(text, text)).toBe(0);
    }
  });

  it("compares long significant digits without expanding the exponent", () => {
    const prefix = `1${"0".repeat(20_000)}`;
    expect(compareCells(`${prefix}1e999999999999999999999999`, `${prefix}2e999999999999999999999999`)).toBeLessThan(0);
  });

  it("agrees with independent rational arithmetic across decimal scales and exponents", () => {
    let seed = 0x12345678;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const samples = Array.from({ length: 120 }, (_, i) => {
      const coefficient = (2n ** 60n + BigInt(random() % 2048)) * (i % 3 === 0 ? -1n : 1n);
      const scale = random() % 25;
      const exponent = (random() % 41) - 20;
      const digits = (coefficient < 0n ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
      const decimal = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
      return {
        text: `${coefficient < 0n ? "-" : ""}${decimal}e${exponent}`,
        numerator: coefficient * 10n ** BigInt(Math.max(0, exponent)),
        denominator: 10n ** BigInt(scale + Math.max(0, -exponent)),
      };
    });
    for (const a of samples) {
      for (const b of samples) {
        const left = a.numerator * b.denominator;
        const right = b.numerator * a.denominator;
        const expected = left === right ? 0 : left < right ? -1 : 1;
        expect(Math.sign(compareCells(a.text, b.text)), `${a.text} vs ${b.text}`).toBe(expected);
      }
    }
    const ordered = samples.toSorted((a, b) => compareCells(a.text, b.text));
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1]!;
      const b = ordered[i]!;
      expect(a.numerator * b.denominator <= b.numerator * a.denominator).toBe(true);
    }
  });
});

describe("local filter and sort", () => {
  it("compares numbers by value, NULL first", () => {
    expect(["10", "9", null, "abc"].sort(compareCells)).toEqual([null, "9", "10", "abc"]);
  });

  it("keeps the rows whose values are checked, then sorts them", () => {
    const filter: LocalFilter = new Map([[1, new Set<Cell>(["Shanghai", null])]]);
    expect(visibleRows(4, value, filter, null)).toEqual([0, 2, 3]);
    expect(visibleRows(4, value, filter, { column: 2, descending: true })).toEqual([0, 3, 2]);
    expect(visibleRows(4, value, new Map(), { column: 2, descending: false })).toEqual([1, 2, 3, 0]);
  });

  it("leaves rows past `fixed` (added rows) last and unfiltered", () => {
    const filter: LocalFilter = new Map([[1, new Set<Cell>(["Beijing"])]]);
    expect(visibleRows(4, value, filter, null, 3)).toEqual([1, 3]);
  });

  it("lists distinct values with counts and toggles them", () => {
    const d = distinctValues(4, value, 1);
    expect(d).toEqual([
      { value: null, count: 1 },
      { value: "Beijing", count: 1 },
      { value: "Shanghai", count: 2 },
    ]);
    const all = d.map((x) => x.value);
    let f = toggleFilterValue(new Map(), 1, all, "Beijing", false);
    expect([...f.get(1)!]).toEqual([null, "Shanghai"]);
    f = toggleFilterValue(f, 1, all, "Beijing", true);
    expect(f.has(1)).toBe(false);
  });

  it.each([false, true])("sorts exact values, preserving equal rows (descending: %s)", (descending) => {
    const cells: Cell[] = ["9007199254740993", "1.0000000000000000002", "9007199254740992", "1", "1.000", null];
    const order = visibleRows(cells.length, (r) => cells[r]!, new Map(), { column: 0, descending });
    expect(order).toEqual(descending ? [0, 2, 1, 3, 4, 5] : [5, 3, 4, 1, 2, 0]);
  });

  it("sorts after filtering and keeps newly added rows last", () => {
    const cells = ["9007199254740993", "9007199254740992", "1.0000000000000000002", "-999"];
    const filter: LocalFilter = new Map([[0, new Set([cells[0]!, cells[1]!])]]);
    expect(visibleRows(cells.length, (r) => cells[r]!, filter, { column: 0, descending: false }, 3)).toEqual([1, 0, 3]);
  });

  it("orders precise filter values before applying the limit and retains their counts", () => {
    const cells = ["9007199254740993", "9007199254740992", "9007199254740992", "1.0000000000000000002", "1"];
    expect(distinctValues(cells.length, (r) => cells[r]!, 0, 3)).toEqual([
      { value: "1", count: 1 },
      { value: "1.0000000000000000002", count: 1 },
      { value: "9007199254740992", count: 2 },
    ]);
  });
});

describe("aggregates", () => {
  it("sums numbers and reports text min / max", () => {
    expect(aggregates(["10", null, "2.5", "7"])).toMatchObject({
      count: 4,
      distinct: 4,
      nulls: 1,
      sum: "19.5",
      avg: "6.5",
      median: "7",
      min: "2.5",
      max: "10",
    });
    expect(aggregates(["b", "a", "b"])).toMatchObject({ distinct: 2, sum: null, avg: null, min: "a", max: "b" });
  });

  it.each([
    ["9007199254740992", "9007199254740993"],
    ["-9007199254740993", "-9007199254740992"],
    ["1.0000000000000000001", "1.0000000000000000002"],
    ["1e-400", "2e-400"],
    ["1e400", "2e400"],
  ])("preserves exact minimum %s and maximum %s", (min, max) => {
    expect(aggregates([max, null, min])).toMatchObject({ min, max });
  });

  it.each([
    [["9007199254740993"], "9007199254740993", "9007199254740993", "9007199254740993"],
    [["9007199254740993", "1"], "9007199254740994", "4503599627370497", "4503599627370497"],
    [["-9007199254740993", "1"], "-9007199254740992", "-4503599627370496", "-4503599627370496"],
    [["1.0000000000000000002", "1"], "2.0000000000000000002", "1.0000000000000000001", "1.0000000000000000001"],
    [["2", "3"], "5", "2.5", "2.5"],
    [["1", "2", "3", "4"], "10", "2.5", "2.5"],
    [["-1e-400", "2e-400"], "1e-400", "5e-401", "5e-401"],
    [["1e400", "2e400"], "3e400", "1.5e400", "1.5e400"],
    [["9007199254740993", "9007199254740992"], "18014398509481985", "9007199254740992.5", "9007199254740992.5"],
  ])("combines %s into the exact sum %s, average %s and median %s", (values, sum, avg, median) => {
    expect(aggregates(values)).toMatchObject({ sum, avg, median });
  });

  it("keeps the approximate total for values too far apart to combine exactly", () => {
    // The exponents are beyond ~10^308: the approximate doubles overflow to Infinity, as before.
    expect(aggregates(["1e2000000000", "1"])).toMatchObject({ sum: "Infinity", avg: "Infinity", median: "Infinity" });
  });
});

describe("chart series", () => {
  it("combines Y per X", () => {
    expect(chartSeries(rows, 1, 2, "sum")).toEqual([
      { label: "Shanghai", value: 12.5, text: "12.5" },
      { label: "Beijing", value: 0, text: "0" },
      { label: "<null>", value: 7, text: "7" },
    ]);
    expect(chartSeries(rows, 1, 2, "count").map((p) => [p.value, p.text])).toEqual([
      [2, "2"],
      [1, "1"],
      [1, "1"],
    ]);
    expect(chartSeries(rows, 0, 2, "none")).toEqual([
      { label: "1", value: 10, text: "10" },
      { label: "3", value: 2.5, text: "2.5" },
      { label: "4", value: 7, text: "7" },
    ]);
  });

  it("combines BIGINT values per X exactly while only the plot value approximates", () => {
    const grouped: Cell[][] = [
      ["a", "9007199254740993"],
      ["a", "-9007199254740992"],
      ["b", "9007199254740993"],
    ];
    expect(chartSeries(grouped, 0, 1, "sum")).toEqual([
      { label: "a", value: 1, text: "1" },
      { label: "b", value: 9007199254740992, text: "9007199254740993" },
    ]);
    expect(chartSeries(grouped, 0, 1, "avg").map((p) => p.text)).toEqual(["0.5", "9007199254740993"]);
    expect(chartSeries(grouped, 0, 1, "max").map((p) => p.text)).toEqual(["9007199254740993", "9007199254740993"]);
    expect(chartSeries(grouped, 0, 1, "min").map((p) => p.text)).toEqual(["-9007199254740992", "9007199254740993"]);
  });

  it("picks round ticks from zero", () => {
    expect(niceTicks(0, 3100)).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(niceTicks(-5, 5)).toEqual([-6, -4, -2, 0, 2, 4, 6]);
  });
});

describe("export options", () => {
  const data: ExportData = {
    columns: [
      { name: "id", type: "INTEGER" },
      { name: "city", type: "TEXT" },
    ],
    rows: [
      ["1", "Shanghai"],
      ["2", null],
    ],
    table: "customers",
    driver: "sqlite",
  };

  it("leaves the header out, adds row numbers and transposes", () => {
    const opts = { columnHeader: false, rowHeader: false, transpose: false };
    expect(exportData("csv", data, opts)).toBe("1,Shanghai\r\n2,");
    expect(exportData("csv", data, { ...opts, rowHeader: true, columnHeader: true })).toBe(
      "#,id,city\r\n1,1,Shanghai\r\n2,2,",
    );
    expect(exportData("tsv", data, { ...opts, columnHeader: true, transpose: true })).toBe(
      "id\t1\t2\ncity\tShanghai\t",
    );
    expect(exportData("csv", data)).toBe("id,city\r\n1,Shanghai\r\n2,");
    expect(exportData("onerow", data)).toBe("1, 'Shanghai', 2, NULL");
  });
});

describe("import from file", () => {
  it("parses quoted CSV and guesses the separator", () => {
    expect(parseDelimited('﻿a,"b ""q""",c\r\n1,"x,y",\n', ",")).toEqual([
      ["a", 'b "q"', "c"],
      ["1", "x,y", ""],
    ]);
    expect(guessSeparator("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(guessSeparator("a;b;c")).toBe(";");
  });

  it("maps columns by header name or position", () => {
    const parsed = [
      ["CITY", "nope", "id"],
      ["Shanghai", "x", "1"],
      ["", "", ""],
      ["", "y", "2"],
    ];
    const byName = importEdits(parsed, ["id", "city"], true, true);
    expect(byName.mapped).toEqual(["city", "id"]);
    expect(byName.edits).toEqual([
      {
        kind: "insert",
        values: [
          { column: "city", value: "Shanghai" },
          { column: "id", value: "1" },
        ],
      },
      {
        kind: "insert",
        values: [
          { column: "city", value: null },
          { column: "id", value: "2" },
        ],
      },
    ]);
    const byPosition = importEdits([["1", "a"]], ["id", "city", "extra"], false, false);
    expect(byPosition.edits).toEqual([
      {
        kind: "insert",
        values: [
          { column: "id", value: "1" },
          { column: "city", value: "a" },
        ],
      },
    ]);
  });
});

describe("ORDER BY field", () => {
  it("round-trips the sort and rejects unknown columns", () => {
    const cols = ["id", "Name"];
    expect(parseOrderBy('name desc, "id" ASC', cols)).toEqual([
      { column: "Name", descending: true },
      { column: "id", descending: false },
    ]);
    expect(
      formatOrderBy([
        { column: "Name", descending: true },
        { column: "id", descending: false },
      ]),
    ).toBe("Name DESC, id");
    expect(parseOrderBy("", cols)).toEqual([]);
    expect(parseOrderBy("nope", cols)).toBeNull();
  });
});

describe("object filter", () => {
  it("matches any of its patterns, ignoring case", () => {
    expect(passesObjectFilter("orders", "")).toBe(true);
    expect(passesObjectFilter("Order_Items", "order*, customers")).toBe(true);
    expect(passesObjectFilter("customers", "order* customers")).toBe(true);
    expect(passesObjectFilter("products", "order*,customers")).toBe(false);
  });
});

describe("dropping schema objects", () => {
  const opts = { ifExists: true, cascade: false };
  it("drops routines, triggers, sequences and materialized views per dialect", () => {
    expect(dropSql("postgres", { kind: "function", schema: "public", name: "f", arguments: "a integer" }, opts)).toBe(
      "drop function if exists public.f(a integer);",
    );
    expect(dropSql("mysql", { kind: "procedure", schema: "db", name: "p" }, opts)).toBe(
      "drop procedure if exists db.p;",
    );
    expect(dropSql("postgres", { kind: "trigger", schema: "s", name: "t", table: "x" }, opts)).toBe(
      "drop trigger if exists t on s.x;",
    );
    expect(dropSql("sqlite", { kind: "trigger", schema: "main", name: "t", table: "x" }, opts)).toBe(
      "drop trigger if exists t;",
    );
    expect(dropSql("postgres", { kind: "sequence", schema: "s", name: "q" }, opts)).toBe(
      "drop sequence if exists s.q;",
    );
    expect(dropSql("postgres", { kind: "materializedView", schema: "s", name: "m" }, opts)).toBe(
      "drop materialized view if exists s.m;",
    );
  });
});

describe("grid search", () => {
  const opts = { caseSensitive: false, wholeWord: false, regex: false };

  it("matches cell text with Match Case, Words and Regex", () => {
    const m = cellMatcher("shang", opts);
    expect(typeof m).toBe("function");
    const test = m as (v: string) => boolean;
    expect(test("Shanghai")).toBe(true);
    expect(test("Beijing")).toBe(false);
    expect((cellMatcher("shang", { ...opts, caseSensitive: true }) as (v: string) => boolean)("Shanghai")).toBe(false);
    const word = cellMatcher("23", { ...opts, wholeWord: true }) as (v: string) => boolean;
    expect(word("23")).toBe(true);
    expect(word("123")).toBe(false);
    expect(word("a 23 b")).toBe(true);
    const re = cellMatcher(String.raw`^\d\.\d$`, { ...opts, regex: true }) as (v: string) => boolean;
    expect(re("2.5")).toBe(true);
    expect(re("10")).toBe(false);
    // A dot is literal without Regex.
    expect((cellMatcher("2.5", opts) as (v: string) => boolean)("215")).toBe(false);
  });

  it("reports no query and a bad regex", () => {
    expect(cellMatcher("", opts)).toBeNull();
    expect(cellMatcher("(", { ...opts, regex: true })).toBe("invalid");
  });

  it("steps over astral characters on empty matches in Words mode", () => {
    for (const query of ["x*", "|", "^", String.raw`\d*`, String.raw`\b`]) {
      const m = cellMatcher(query, { ...opts, regex: true, wholeWord: true }) as (v: string) => boolean;
      expect(() => m("a😀b")).not.toThrow();
      expect(typeof m("😀")).toBe("boolean");
    }
  });

  it("finds the matching cells row by row, skipping NULL", () => {
    const m = cellMatcher("i", opts) as (v: string) => boolean;
    expect(findCells([0, 1, 2, 3], 3, value, m)).toEqual([
      { row: 0, col: 1 },
      { row: 1, col: 1 },
      { row: 2, col: 1 },
    ]);
    // Display rows are positions in `rows`.
    expect(findCells([3, 1], 3, value, m)).toEqual([{ row: 1, col: 1 }]);
  });
});

describe("result pages", () => {
  it("describes the rows of a page, IDEA style", () => {
    expect(pageWindow({ page: 0, pageSize: 500, rows: 500, hasMore: true, total: null })).toEqual({
      first: 1,
      last: 500,
      total: null,
      lastPage: null,
    });
    expect(pageWindow({ page: 1, pageSize: 500, rows: 1, hasMore: false, total: null })).toEqual({
      first: 501,
      last: 501,
      total: 501,
      lastPage: 1,
    });
    expect(pageWindow({ page: 0, pageSize: 100, rows: 100, hasMore: true, total: 1234 })).toMatchObject({
      total: 1234,
      lastPage: 12,
    });
    expect(pageWindow({ page: 0, pageSize: 100, rows: 0, hasMore: false, total: null })).toEqual({
      first: 0,
      last: 0,
      total: 0,
      lastPage: 0,
    });
  });

  it("slices the rows of a page from a fetch of every row up to it", () => {
    expect(pageFetch(0, 500)).toEqual({ maxRows: 500, skip: 0 });
    expect(pageFetch(2, 100)).toEqual({ maxRows: 100, skip: 200 });
  });
});
