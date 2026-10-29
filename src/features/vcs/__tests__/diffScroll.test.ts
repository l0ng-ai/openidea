import { describe, expect, it } from "vitest";
import { Chunk, MergeView } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { bandAt, bandPath, transferY, type Band } from "../diffScroll";

const doc = (s: string) => Text.of(s.split("\n"));
const LINE = 20;

/** The band at `y` of side `from` in two texts with every line LINE px tall. */
function bands(a: string, b: string) {
  const da = doc(a);
  const db = doc(b);
  const ext = (d: Text, from: number, to: number): [number, number] => {
    if (from > d.length) return [d.lines * LINE, d.lines * LINE];
    const top = (d.lineAt(from).number - 1) * LINE;
    return from >= to ? [top, top] : [top, d.lineAt(Math.min(to - 1, d.length)).number * LINE];
  };
  const chunks = Chunk.build(da, db);
  return (y: number, from: "a" | "b"): Band =>
    bandAt(
      chunks,
      (c) => ext(da, c.fromA, c.toA),
      (c) => ext(db, c.fromB, c.toB),
      da.lines * LINE,
      db.lines * LINE,
      y,
      from,
    );
}

describe("unaligned side-by-side scrolling", () => {
  // Right side inserts three lines after line 2 and changes line 5 into two lines.
  const a = "1\n2\n3\n4\n5\n6\n7";
  const b = "1\n2\nx\ny\nz\n3\n4\nfive\nfive'\n6\n7";
  const bandOf = bands(a, b);
  const at = (y: number, from: "a" | "b") => transferY([bandOf(y, from)], y, from);

  it("splits both documents into unchanged and changed bands", () => {
    const row = (x: Band) => [x.a0, x.a1, x.b0, x.b1, x.changed];
    expect([0, 39, 40, 79, 80, 99, 100, 139].map((y) => row(bandOf(y, "a")))).toEqual([
      [0, 40, 0, 40, false],
      [0, 40, 0, 40, false],
      [40, 80, 100, 140, false],
      [40, 80, 100, 140, false],
      [80, 100, 140, 180, true],
      [80, 100, 140, 180, true],
      [100, 140, 180, 220, false],
      [100, 140, 180, 220, false],
    ]);
    expect([0, 40, 99, 100, 140, 179, 180].map((y) => row(bandOf(y, "b")))).toEqual([
      [0, 40, 0, 40, false],
      [40, 40, 40, 100, true],
      [40, 40, 40, 100, true],
      [40, 80, 100, 140, false],
      [80, 100, 140, 180, true],
      [80, 100, 140, 180, true],
      [100, 140, 180, 220, false],
    ]);
  });

  it("maps unchanged text straight through", () => {
    expect(at(10, "a")).toBe(10);
    expect(at(50, "a")).toBe(110);
    expect(at(130, "a")).toBe(210);
    expect(at(210, "b")).toBe(130);
  });

  it("jumps over an insertion when scrolling the side without it", () => {
    expect(at(39, "a")).toBe(39);
    expect(at(40, "a")).toBe(100);
  });

  it("waits at the boundary while the inserted lines scroll by", () => {
    for (const y of [40, 60, 99]) expect(at(y, "b")).toBe(40);
  });

  it("follows line by line inside a change, then waits at the shorter end", () => {
    expect(at(150, "b")).toBe(90);
    expect(at(170, "b")).toBe(100);
    expect(at(90, "a")).toBe(150);
  });

  it("scales unchanged text of different heights (wrapped lines)", () => {
    const stretched = [{ a0: 0, a1: 100, b0: 0, b1: 200, changed: false }];
    expect(transferY(stretched, 50, "a")).toBe(100);
    expect(transferY(stretched, 50, "b")).toBe(25);
  });

  it("draws an empty side as a sliver on its boundary", () => {
    expect(bandPath(30, 40, 40, 40, 100)).toBe("M0 39C9 39 21 40 30 40L30 100C21 100 9 41 0 41Z");
  });

  it("can keep MergeView from padding the panes", () => {
    // UnalignedPanes replaces this (private) method; a rename upstream would bring the padding back.
    expect(typeof (MergeView.prototype as unknown as { measure: unknown }).measure).toBe("function");
  });
});
