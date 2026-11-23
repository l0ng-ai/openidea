import { describe, expect, it } from "vitest";
import { compareThreeTexts } from "../ThreePaneDiff";
import { diffDocument } from "../diffControls";
import { transferChunk } from "../diffOptions";
import { initialDiffRanges, mapDiffRange, type StagingRange } from "../stagingRange";

describe("staging range comparisons", () => {
  it("maps the scope through additions and edits without changing its other boundary", () => {
    const before = diffDocument("unrelated\na\nold\nb\nother");
    const after = diffDocument("another\nunrelated\na\nnew\nextra\nb\nother");
    const range = { from: 10, to: 17, line: 1, lines: 3 };
    const next = mapDiffRange(range, before, after)!;
    expect(next).toMatchObject({ line: 2, lines: 4 });
    expect(after.sliceString(next.from, next.to)).toBe("a\nnew\nextra\nb");
  });

  it("invalidates a range replaced together with its surrounding lines", () => {
    const before = diffDocument("unrelated\na\nold\nb\nother");
    const after = diffDocument("ZZZZZZ");
    expect(mapDiffRange({ from: 10, to: 17, line: 1, lines: 3 }, before, after)).toBeNull();
  });

  it("keeps an empty insertion point when removing the excerpt and its separator", () => {
    const before = diffDocument("existing\nonly");
    const after = diffDocument("existing");
    expect(mapDiffRange({ from: 9, to: 13, line: 1, lines: 1 }, before, after)).toEqual({
      from: 8,
      to: 8,
      line: 1,
      lines: 0,
    });
  });

  it("restores a deletion at EOF using the full document's separator", () => {
    const texts = ["outside\ncontext\ngone", "outside\ncontext\ngone", "outside\ncontext"] as const;
    const present = { start: 2, lines: 1, text: "gone" };
    const range: StagingRange = { indexVersion: "1", panes: [present, present, { start: 2, lines: 0, text: "" }] };
    const initial = compareThreeTexts(texts);
    const windows = initialDiffRanges(range, initial.docs, "1")!;
    const { docs, changes } = compareThreeTexts(texts, windows);
    const edit = transferChunk(changes[0]!.chunk, "a", docs[1], docs[2], {
      source: windows[1],
      destination: windows[2],
    });
    expect(docs[2].replace(edit.from, edit.to, diffDocument(edit.insert)).toString()).toBe(texts[1]);
  });

  it("rejects a stale marker when the index or displayed local lines have moved", () => {
    const present = { start: 1, lines: 1, text: "file" };
    const range: StagingRange = { indexVersion: "1", panes: [present, present, present] };
    const texts = ["context\nfile", "context\nfile", "context\nfile"] as const;
    const { docs } = compareThreeTexts(texts);
    expect(initialDiffRanges(range, docs, "2")).toBeNull();
    expect(initialDiffRanges(range, [docs[0], docs[1], diffDocument("moved\ncontext\nfile")], "1")).toBeNull();
  });
});
