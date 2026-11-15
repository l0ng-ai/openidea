import { describe, expect, it } from "vitest";
import type { LiveTemplate } from "../live/model";
import { surroundEntries, surroundersFor } from "../live/surrounders";

const template = (id: string, abbrev: string): LiveTemplate => ({
  id,
  abbrev,
  group: "User",
  description: "",
  body: "$SELECTION$",
  contexts: ["java"],
});

describe("surround with entries", () => {
  it("numbers surrounders 1-9, 0, then letters", () => {
    const java = surroundersFor("java", { lines: true, inline: false });
    expect(java.length).toBeGreaterThan(10);
    const entries = surroundEntries(java, []);
    expect(entries.slice(0, 12).map((e) => e.mnemonic)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "0",
      "A",
      "B",
    ]);
  });

  it("gives templates the first abbreviation character not taken yet", () => {
    const surrounders = surroundersFor("java", { lines: true, inline: false }).slice(0, 11); // 1-9, 0, A
    const entries = surroundEntries(surrounders, [template("t1", "T"), template("t2", "at"), template("t3", "ta")]);
    expect(entries.slice(11).map((e) => [e.mnemonic, e.mnemonicIndex])).toEqual([
      ["T", 0],
      [null, null],
      [null, null],
    ]);
  });

  it("wraps Zig in its brace syntax without a negation", () => {
    const descriptions = (lines: boolean, inline: boolean) =>
      surroundersFor("zig", { lines, inline }).map((s) => s.description);
    expect(descriptions(true, false)).toEqual(
      expect.arrayContaining(["if", "if / else", "while", "for", "defer", "test"]),
    );
    // Zig has no `!` operator.
    expect(descriptions(true, true)).not.toContain("!(expr)");
    expect(descriptions(false, true)).toEqual(["(expr)"]);
  });

  it("filters statement and expression surrounders by the selection", () => {
    const kinds = (lines: boolean, inline: boolean) =>
      new Set(surroundersFor("typescript", { lines, inline }).map((s) => s.kind));
    expect(kinds(true, false)).toEqual(new Set(["statement"]));
    expect(kinds(false, true)).toEqual(new Set(["expression"]));
    expect(kinds(true, true)).toEqual(new Set(["statement", "expression"]));
    expect(surroundersFor("plaintext", { lines: true, inline: false })).toEqual([]);
  });
});
