import { beforeEach, describe, expect, it } from "vitest";
import type { DbColumnInfo } from "@/platform/ipc";
import { diagramModel, type DiagramTable } from "./erDiagram";
import {
  BADGE,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  autoLayout,
  linkPath,
  loadLayout,
  rowCenter,
  saveLayout,
  tableSize,
  type Box,
} from "./diagramLayout";

const col = (name: string, dataType = "int"): DbColumnInfo => ({
  name,
  dataType,
  nullable: false,
  default: null,
  primaryKey: false,
});
const table = (name: string, columns: DbColumnInfo[], unique: string[] = []): DiagramTable => ({
  id: "pg",
  schema: "public",
  name,
  details: {
    columns,
    indexes: unique.map((c) => ({ name: `${c}_key`, unique: true, columns: [c] })),
    foreignKeys: [],
    triggers: [],
  },
});
const node = (t: DiagramTable) => diagramModel([t]).nodes[0]!;
/** One unit per character. */
const measure = (text: string) => text.length;

describe("tableSize", () => {
  const wide = node(table("t", [col("a".repeat(200), "b".repeat(100))], ["a".repeat(200)]));

  it("fits the widest row, its markers included, and shows only the header when collapsed", () => {
    const open = tableSize(wide, false, measure);
    expect(open).toEqual({ w: 8 + 16 + 6 + 200 + 20 + 100 + BADGE + 8, h: HEADER_HEIGHT + ROW_HEIGHT });
    expect(tableSize(wide, true, measure)).toEqual({ w: open.w, h: HEADER_HEIGHT });
  });

  it("is never narrower than the minimum", () => {
    expect(tableSize(node(table("t", [col("a")])), false, measure).w).toBe(140);
  });
});

describe("rowCenter", () => {
  const n = node(table("t", [col("a"), col("b")]));
  const box: Box = { x: 0, y: 100, w: 140, h: 72 };

  it("is the column's row, or the header when collapsed or the column isn't listed", () => {
    expect(rowCenter(n, box, false, "b")).toBe(100 + HEADER_HEIGHT + ROW_HEIGHT * 1.5);
    expect(rowCenter(n, box, true, "b")).toBe(100 + HEADER_HEIGHT / 2);
    expect(rowCenter(n, box, false, "missing")).toBe(100 + HEADER_HEIGHT / 2);
  });
});

describe("linkPath", () => {
  const left: Box = { x: 0, y: 0, w: 100, h: 50 };
  const right: Box = { x: 300, y: 200, w: 100, h: 50 };

  it("joins facing sides through the middle of the gap", () => {
    expect(linkPath(left, 10, right, 220)).toBe("M100,10H200V220H300");
    expect(linkPath(right, 220, left, 10)).toBe("M300,220H200V10H100");
  });

  it("goes around the right side when the tables overlap horizontally, or for a table's link to itself", () => {
    const below: Box = { x: 50, y: 200, w: 100, h: 50 };
    expect(linkPath(left, 10, below, 220)).toBe("M100,10H174V220H150");
    expect(linkPath(left, 10, left, 30)).toBe("M100,10H124V30H100");
  });
});

describe("autoLayout", () => {
  it("places referenced tables left of the tables referencing them, without overlaps", async () => {
    const boxes = [
      { key: "orders", w: 160, h: 100 },
      { key: "users", w: 140, h: 60 },
      { key: "lines", w: 150, h: 80 },
      { key: "alone", w: 140, h: 40 },
    ];
    const placed = await autoLayout(boxes, [
      { from: "orders", to: "users" },
      { from: "lines", to: "orders" },
      { from: "lines", to: "lines" },
    ]);
    expect([...placed.keys()].sort()).toEqual(["alone", "lines", "orders", "users"]);
    const at = (k: string) => ({ ...placed.get(k)!, ...boxes.find((b) => b.key === k)! });
    expect(at("users").x + at("users").w).toBeLessThan(at("orders").x);
    expect(at("orders").x + at("orders").w).toBeLessThan(at("lines").x);
    for (const a of boxes)
      for (const b of boxes)
        if (a !== b) {
          const [p, q] = [at(a.key), at(b.key)];
          const apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
          expect(apart, `${a.key} / ${b.key}`).toBe(true);
        }
  });
});

describe("saved layouts", () => {
  const layout = (x: number) => ({ positions: { t: { x, y: 0 } }, hidden: ["h"], collapsed: ["c"] });
  beforeEach(() => localStorage.removeItem("openidea.database.diagrams"));

  it("restores what was saved for the same key", () => {
    saveLayout("a", layout(1));
    saveLayout("b", layout(2));
    saveLayout("a", layout(3));
    expect(loadLayout("a")).toEqual(layout(3));
    expect(loadLayout("b")).toEqual(layout(2));
    expect(loadLayout("c")).toBeNull();
  });

  it("forgets the least recently saved beyond 50 diagrams", () => {
    for (let i = 0; i < 51; i++) saveLayout(`k${i}`, layout(i));
    saveLayout("k1", layout(100));
    saveLayout("new", layout(101));
    expect(loadLayout("k0")).toBeNull();
    expect(loadLayout("k2")).toBeNull();
    expect(loadLayout("k1")).toEqual(layout(100));
    expect(loadLayout("k3")).toEqual(layout(3));
  });

  it("reads damaged storage as nothing saved", () => {
    for (const raw of ["{", '{"a":1}', "[null]", "[1]", '[["a",null]]', '[["a",{"positions":null}]]']) {
      localStorage.setItem("openidea.database.diagrams", raw);
      expect(loadLayout("a"), raw).toBeNull();
    }
    localStorage.setItem(
      "openidea.database.diagrams",
      '[null,["a",{"positions":{"t":{"x":"a","y":0},"u":{"x":1,"y":2}}}]]',
    );
    expect(loadLayout("a")).toEqual({ positions: { u: { x: 1, y: 2 } }, hidden: [], collapsed: [] });
    saveLayout("b", layout(1));
    expect(loadLayout("b")).toEqual(layout(1));
  });
});
