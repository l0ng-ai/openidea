import { describe, expect, it } from "vitest";
import { diff3, mergeChanges, splitLines, splitWords, tryResolve, type TextChange } from "../mergeDiff3";

/** Deterministic pseudo-random numbers, so a failing case can be replayed. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** The text of `side` rebuilt from the base and the changes: it must give the version back. */
function rebuild(base: string, changes: readonly TextChange[], side: "left" | "right") {
  let out = "";
  let pos = 0;
  for (const c of changes) {
    out += base.slice(pos, c.baseFrom) + c[side];
    pos = c.baseTo;
  }
  return out + base.slice(pos);
}

const lines = (...l: string[]) => l.map((x) => `${x}\n`).join("");

describe("splitting", () => {
  it("keeps every character", () => {
    for (const text of ["", "a", "a\n", "a\n\nb", "a\r\nb\r\n", "foo(bar, 12) // ünï — 日本語\t x\r"]) {
      expect(splitLines(text).join("")).toBe(text);
      expect(splitWords(text).join("")).toBe(text);
    }
  });

  it("separates words, punctuation, blanks and line breaks", () => {
    expect(splitWords("foo(a, b)\n")).toEqual(["foo", "(", "a", ",", " ", "b", ")", "\n"]);
    expect(splitWords("a \t b\r\nc")).toEqual(["a", " \t ", "b", "\r\n", "c"]);
  });
});

describe("diff3", () => {
  it("keeps edits of both sides apart when unchanged tokens lie between them", () => {
    const clusters = diff3(["a", "X", "c", "d", "e"], ["a", "b", "c", "d", "e"], ["a", "b", "c", "d", "Y"]);
    expect(clusters).toEqual([
      { left: [1, 2], base: [1, 2], right: [1, 2] },
      { left: [4, 5], base: [4, 5], right: [4, 5] },
    ]);
  });

  it("joins edits that touch into one cluster", () => {
    const clusters = diff3(["a", "X", "c"], ["a", "b", "c"], ["a", "b", "Y"]);
    expect(clusters).toEqual([{ left: [1, 3], base: [1, 3], right: [1, 3] }]);
  });

  it("handles insertions at the same point and at the ends", () => {
    expect(diff3(["a", "L", "b"], ["a", "b"], ["a", "R", "b"])).toEqual([
      { left: [1, 2], base: [1, 1], right: [1, 2] },
    ]);
    expect(diff3(["L", "a"], ["a"], ["a", "R"])).toEqual([
      { left: [0, 1], base: [0, 0], right: [0, 0] },
      { left: [2, 2], base: [1, 1], right: [1, 2] },
    ]);
  });

  it("gives up on more distinct tokens than it can intern", () => {
    const many = Array.from({ length: 70_000 }, (_, i) => `t${i}`);
    expect(diff3(many, many, many)).toBeNull();
  });
});

describe("mergeChanges (line level)", () => {
  const base = lines("a", "b", "c", "d", "e", "f", "g");

  it("classifies one-sided, identical and conflicting changes", () => {
    const left = lines("a", "B", "c", "d", "e", "f", "G");
    const right = lines("a", "b", "c", "D", "e", "f", "G");
    const changes = mergeChanges(left, base, right)!;
    expect(changes.map((c) => c.kind)).toEqual(["left", "right", "both"]);
    expect(changes[0]).toMatchObject({ baseFrom: 2, baseTo: 4, left: "B\n", base: "b\n", right: "b\n" });

    // Changes of adjacent lines are one change, which conflicts, as in IntelliJ.
    const adjacent = mergeChanges(lines("a", "B", "c"), lines("a", "b", "c"), lines("a", "b", "C"))!;
    expect(adjacent.map((c) => c.kind)).toEqual(["conflict"]);

    const conflict = mergeChanges(lines("a", "L", "c"), lines("a", "b", "c"), lines("a", "R", "c"))!;
    expect(conflict.map((c) => c.kind)).toEqual(["conflict"]);
    expect(conflict[0]!.auto).toBeNull();
  });

  it("treats a deletion by both sides and equal insertions as agreement", () => {
    expect(mergeChanges(lines("a", "c"), lines("a", "b", "c"), lines("a", "c"))!.map((c) => c.kind)).toEqual(["both"]);
    expect(mergeChanges(lines("a", "N", "b"), lines("a", "b"), lines("a", "N", "b"))!.map((c) => c.kind)).toEqual([
      "both",
    ]);
  });

  it("classifies an insertion by one side, and an insertion against a change", () => {
    const [insert] = mergeChanges(lines("a", "N", "b"), lines("a", "b"), lines("a", "b"))!;
    expect(insert).toMatchObject({ kind: "left", base: "", left: "N\n", baseFrom: 2, baseTo: 2 });
    const [clash] = mergeChanges(lines("a", "N", "b"), lines("a", "b"), lines("a", "M", "b"))!;
    expect(clash!.kind).toBe("conflict");
    expect(clash!.auto).toBeNull();
  });

  it("does not resolve a conflict where one side deleted what the other changed", () => {
    const [c] = mergeChanges(lines("a", "c"), lines("a", "b", "c"), lines("a", "B", "c"))!;
    expect(c).toMatchObject({ kind: "conflict", auto: null });
  });

  it("offers the word-level merge of a conflict whose sides changed different words", () => {
    const [both] = mergeChanges("let x = 1 + b;\n", "let a = 1 + b;\n", "let a = 1 + 2;\n")!;
    expect(both).toMatchObject({ kind: "conflict", auto: "let x = 1 + 2;\n" });
  });

  it("reports no change for equal versions", () => {
    expect(mergeChanges(base, base, base)).toEqual([]);
    expect(mergeChanges("", "", "")).toEqual([]);
  });

  it("marks a line that gained its terminator as changed", () => {
    const [c] = mergeChanges("a\nb\n", "a\nb", "a\nb")!;
    expect(c).toMatchObject({ kind: "left", left: "b\n", base: "b" });
  });

  it("rebuilds both versions from the base and the changes, whatever the edits", () => {
    const rnd = random(7);
    const vocab = ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta", "theta"];
    const pick = () => vocab[Math.floor(rnd() * vocab.length)]!;
    for (let round = 0; round < 300; round++) {
      const baseLines = Array.from({ length: Math.floor(rnd() * 14) }, pick);
      const mutate = () => {
        const out = [...baseLines];
        for (let n = Math.floor(rnd() * 4); n > 0; n--) {
          const at = Math.floor(rnd() * (out.length + 1));
          const op = rnd();
          if (op < 0.34) out.splice(at, 1);
          else if (op < 0.67) out.splice(at, 0, `${pick()}!`);
          else if (at < out.length) out[at] = `${out[at]}?`;
        }
        return out;
      };
      const [l, b, r] = [lines(...mutate()), lines(...baseLines), lines(...mutate())];
      const changes = mergeChanges(l, b, r)!;
      expect(rebuild(b, changes, "left"), `round ${round}`).toBe(l);
      expect(rebuild(b, changes, "right"), `round ${round}`).toBe(r);
      for (const c of changes) {
        if (c.kind === "left") expect(c.right).toBe(c.base);
        if (c.kind === "right") expect(c.left).toBe(c.base);
        if (c.kind === "both") expect(c.left).toBe(c.right);
        if (c.kind === "conflict") expect(c.left).not.toBe(c.right);
      }
    }
  });
});

describe("tryResolve (word level)", () => {
  it("merges changes to different words", () => {
    expect(tryResolve("foo(1, b)", "foo(a, b)", "foo(a, 2)")).toBe("foo(1, 2)");
    expect(tryResolve("let x = 1;", "let a = 1;", "let a = 2;")).toBe("let x = 2;");
  });

  it("merges an edit at the start of a line with one at its end", () => {
    expect(tryResolve("const a = 1; // first", "var a = 1;", "var a = 1; // note")).toBeNull();
    expect(tryResolve("const a = 1;", "var a = 1;", "var a = 1; // note")).toBe("const a = 1; // note");
  });

  it("gives up when both sides changed the same word differently", () => {
    expect(tryResolve("let x = 1;", "let a = 1;", "let y = 1;")).toBeNull();
    expect(tryResolve("f(a)", "f(b)", "f(c)")).toBeNull();
  });

  it("gives up when the edits touch", () => {
    expect(tryResolve("x y", "a b", "a z")).toBeNull();
  });

  it("accepts identical changes", () => {
    expect(tryResolve("let x = 1;", "let a = 1;", "let x = 1;")).toBe("let x = 1;");
  });

  it("falls back to ignoring the width of blanks, keeping the changed side's blanks", () => {
    // The edits touch, so the exact pass fails; the blank-insensitive one merges them.
    expect(tryResolve("a  =  1", "a = 1", "a = 2")).toBe("a  =  2");
    expect(tryResolve("a   b c", "a b c", "a b  c")).toBe("a   b  c");
    expect(tryResolve("a  b", "a b", "a b")).toBe("a  b");
  });

  it("does not take a line break for a blank", () => {
    // Were a line break a blank, both sides would equal the base here and the merge would succeed.
    expect(tryResolve("a\nb", "a b", "a\n\nb")).toBeNull();
    expect(tryResolve("a\nb", "a b", "a b c")).toBe("a\nb c");
  });

  it("returns the changed side when only one side changed", () => {
    const rnd = random(11);
    const vocab = ["foo", "bar", "baz", "(", ")", ",", " ", "\n", "12", "x_1"];
    const pick = () => vocab[Math.floor(rnd() * vocab.length)]!;
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: 1 + Math.floor(rnd() * 20) }, pick).join("");
      const other = Array.from({ length: Math.floor(rnd() * 20) }, pick).join("");
      expect(tryResolve(other, base, base), `left ${round}`).toBe(other);
      expect(tryResolve(base, base, other), `right ${round}`).toBe(other);
      expect(tryResolve(other, base, other), `same ${round}`).toBe(other);
    }
  });

  it("is symmetric in the sides it can merge", () => {
    const rnd = random(5);
    const vocab = ["a", "b", "c", "d", "e", "f", " ", ","];
    const pick = () => vocab[Math.floor(rnd() * vocab.length)]!;
    for (let round = 0; round < 300; round++) {
      const tokens = Array.from({ length: 12 }, pick);
      const edit = (i: number) => tokens.map((t, k) => (k === i ? `${t}${t}` : t)).join("");
      const base = tokens.join("");
      const [i, j] = [Math.floor(rnd() * 12), Math.floor(rnd() * 12)];
      const ab = tryResolve(edit(i), base, edit(j));
      const ba = tryResolve(edit(j), base, edit(i));
      expect(ab === null, `round ${round}`).toBe(ba === null);
      if (ab !== null && Math.abs(i - j) > 1) expect(ab).toBe(ba);
    }
  });
});
