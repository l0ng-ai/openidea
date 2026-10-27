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
});

describe("aggregates", () => {
  it("sums numbers and reports text min / max", () => {
    expect(aggregates(["10", null, "2.5", "7"])).toMatchObject({
      count: 4,
      distinct: 4,
      nulls: 1,
      sum: 19.5,
      avg: 6.5,
      median: 7,
      min: "2.5",
      max: "10",
    });
    expect(aggregates(["b", "a", "b"])).toMatchObject({ distinct: 2, sum: null, avg: null, min: "a", max: "b" });
  });
});

describe("chart series", () => {
  it("combines Y per X", () => {
    expect(chartSeries(rows, 1, 2, "sum")).toEqual([
      { label: "Shanghai", value: 12.5 },
      { label: "Beijing", value: 0 },
      { label: "<null>", value: 7 },
    ]);
    expect(chartSeries(rows, 1, 2, "count").map((p) => p.value)).toEqual([2, 1, 1]);
    expect(chartSeries(rows, 0, 2, "none").map((p) => p.label)).toEqual(["1", "3", "4"]);
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
