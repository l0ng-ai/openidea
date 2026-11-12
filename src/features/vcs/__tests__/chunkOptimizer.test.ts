import { diff } from "@codemirror/merge";
import { describe, expect, it } from "vitest";
import { changesBetween, optimizeLineChunks, unchangedBetween, type Unchanged } from "../chunkOptimizer";
import { mergeChanges } from "../mergeDiff3";

/** One character per distinct line, and the weight (characters other than blanks) of each. */
function encode(lines: readonly string[]) {
  return {
    text: lines.map((l) => String.fromCharCode(0x100 + [...new Set(ALL)].indexOf(l))).join(""),
    weights: lines.map((l) => l.replace(/\s/g, "").length),
  };
}
const BLOCK = ["if (a) {", "  x();", "}"];
const ALL = ["if (a) {", "  x();", "}", "if (b) {", "  y();", ""];

describe("optimizeLineChunks", () => {
  it("moves a block that starts in the middle of a copy to where the copy starts", () => {
    // The base has the block `if (a) {…}` then `if (b) {…}`; the left repeats the first block.
    // A diff may say the lines "}", "if (a) {", "  x();" were inserted after the first two.
    const base = [...BLOCK, "if (b) {", "  y();", "}"];
    const left = [...BLOCK, ...BLOCK, "if (b) {", "  y();", "}"];
    const a = encode(base);
    const b = encode(left);
    const misaligned: Unchanged[] = [
      { s1: 0, e1: 2, s2: 0, e2: 2 },
      { s1: 2, e1: 6, s2: 5, e2: 9 },
    ];
    const out = optimizeLineChunks(a.text, b.text, a.weights, b.weights, misaligned);
    // The inserted lines become a whole block: lines 0–3 of the left.
    expect(changesBetween(out, base.length, left.length)).toEqual([[0, 0, 0, 3]]);
  });

  it("leaves a change that already starts and ends at a blank line alone", () => {
    const base = ["a();", "", "b();"];
    const left = ["a();", "", "c();", "", "b();"];
    const a = encode(base.map((l) => (l === "a();" ? "if (a) {" : l === "b();" ? "  x();" : l)));
    const b = encode(
      left.map((l) => (l === "a();" ? "if (a) {" : l === "b();" ? "  x();" : l === "c();" ? "  y();" : l)),
    );
    const found: Unchanged[] = [
      { s1: 0, e1: 2, s2: 0, e2: 2 },
      { s1: 2, e1: 3, s2: 4, e2: 5 },
    ];
    expect(optimizeLineChunks(a.text, b.text, a.weights, b.weights, found)).toEqual(found);
  });

  it("only rearranges: the unchanged stretches stay equal, ordered, and as many lines", () => {
    let seed = 99;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const vocab = ["{", "}", "", "  a();", "  b();", "if (x) {", "return;", "  );"];
    const pick = () => vocab[Math.floor(rnd() * vocab.length)]!;
    for (let round = 0; round < 500; round++) {
      const base = Array.from({ length: Math.floor(rnd() * 25) }, pick);
      const side = [...base];
      for (let n = 1 + Math.floor(rnd() * 4); n > 0; n--) {
        const at = Math.floor(rnd() * (side.length + 1));
        if (rnd() < 0.5) side.splice(at, 1 + Math.floor(rnd() * 3));
        else side.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rnd() * 3) }, pick));
      }
      const pool = [...new Set([...base, ...side])];
      const code = (l: string) => String.fromCharCode(0x100 + pool.indexOf(l));
      const [a, b] = [base.map(code).join(""), side.map(code).join("")];
      const weights = (ls: string[]) => ls.map((l) => l.replace(/\s/g, "").length);
      const found = diff(a, b);
      const before = unchangedBetween(
        found.map((c) => [c.fromA, c.toA, c.fromB, c.toB]),
        a.length,
        b.length,
      );
      const after = optimizeLineChunks(a, b, weights(base), weights(side), before);
      const total = (rs: Unchanged[]) => rs.reduce((n, r) => n + r.e1 - r.s1, 0);
      expect(total(after), `round ${round}`).toBe(total(before));
      let p1 = 0;
      let p2 = 0;
      for (const r of after) {
        expect(r.e1 - r.s1).toBe(r.e2 - r.s2);
        expect(r.s1).toBeGreaterThanOrEqual(p1);
        expect(r.s2).toBeGreaterThanOrEqual(p2);
        for (let i = 0; i < r.e1 - r.s1; i++) expect(a[r.s1 + i], `round ${round}`).toBe(b[r.s2 + i]);
        [p1, p2] = [r.e1, r.e2];
      }
      expect(p1).toBeLessThanOrEqual(a.length);
    }
  });
});

describe("the merge with optimized changes", () => {
  it("puts an added function between its neighbours, not across their braces", () => {
    const base = ["a() {", "  x();", "}", "", "b() {", "  y();", "}", ""].map((l) => `${l}\n`).join("");
    const left = ["a() {", "  x();", "}", "", "c() {", "  z();", "}", "", "b() {", "  y();", "}", ""]
      .map((l) => `${l}\n`)
      .join("");
    const [added] = mergeChanges(left, base, base)!;
    expect(added!.base).toBe("");
    expect(added!.left.startsWith("c() {") || added!.left.startsWith("\nc() {")).toBe(true);
    expect(added!.left.trimEnd().endsWith("}")).toBe(true);
  });
});
