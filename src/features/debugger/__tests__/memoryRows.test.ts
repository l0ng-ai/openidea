import { describe, expect, it } from "vitest";
import type { JvmClassRow } from "@/platform/ipc";
import { formatBytes, formatDelta, visibleRows, type RowQuery } from "../memory/rows";

const row = (name: string, instances: number, bytes: number, deltaInstances: number | null): JvmClassRow => ({
  name,
  module: null,
  instances,
  bytes,
  deltaInstances,
  deltaBytes: deltaInstances == null ? null : deltaInstances * 16,
  ambiguous: false,
});

const rows = [
  row("java.lang.String", 100, 2400, 0),
  row("java.util.HashMap$Node", 50, 1600, 5),
  row("com.example.Order", 10, 4000, -3),
  row("com.example.Customer", 20, 800, null),
];
const q: RowQuery = { filter: "", sort: "bytes", desc: true, changedOnly: false };
const names = (r: JvmClassRow[]) => r.map((x) => x.name);

describe("visibleRows", () => {
  it("filters by substring, case-insensitive", () => {
    expect(names(visibleRows(rows, { ...q, filter: "hashmap" }))).toEqual(["java.util.HashMap$Node"]);
  });

  it("keeps only non-zero instance deltas when changedOnly", () => {
    expect(names(visibleRows(rows, { ...q, changedOnly: true }))).toEqual([
      "com.example.Order",
      "java.util.HashMap$Node",
    ]);
  });

  it("sorts by delta with nulls last in both directions", () => {
    expect(names(visibleRows(rows, { ...q, sort: "deltaInstances", desc: true }))).toEqual([
      "java.util.HashMap$Node",
      "java.lang.String",
      "com.example.Order",
      "com.example.Customer",
    ]);
    expect(names(visibleRows(rows, { ...q, sort: "deltaInstances", desc: false }))).toEqual([
      "com.example.Order",
      "java.lang.String",
      "java.util.HashMap$Node",
      "com.example.Customer",
    ]);
  });

  it("sorts by name ascending and by instances descending", () => {
    expect(names(visibleRows(rows, { ...q, sort: "name", desc: false }))[0]).toBe("com.example.Customer");
    expect(names(visibleRows(rows, { ...q, sort: "instances" }))[0]).toBe("java.lang.String");
  });

  it("does not mutate its input", () => {
    const copy = [...rows];
    visibleRows(rows, { ...q, sort: "name", desc: false });
    expect(rows).toEqual(copy);
  });
});

describe("formatting", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(16_000_000)).toBe("15.3 MB");
  });

  it("rolls to the next unit instead of rounding up to 1024", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1_048_575)).toBe("1.0 MB");
  });

  it("formats deltas", () => {
    expect(formatDelta(null)).toBe("");
    expect(formatDelta(0)).toBe("0");
    expect(formatDelta(3)).toBe("+3");
    expect(formatDelta(-2)).toBe("−2");
    expect(formatDelta(4312)).toBe(`+${(4312).toLocaleString()}`);
    expect(formatDelta(-1500)).toBe(`−${(1500).toLocaleString()}`);
  });
});
