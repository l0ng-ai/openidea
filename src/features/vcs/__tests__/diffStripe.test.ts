import { afterEach, describe, expect, it } from "vitest";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { scrollbarMarks } from "@/editor/api";
import { diffOverview, diffScrollbarMarks } from "../cm";
import { mergeStripe, sideControls, syncSide, type MergeControls } from "../mergeGutters";
import { applyTo, mergeField, startMerge, type MergeChange } from "../mergeModel";

// One modified line, one inserted line, one deleted line.
const A = "one\ntwo\nthree\nfour\nfive\nsix";
const B = "one\nTWO\nthree\nnew\nfour\nsix";

const line = (text: string, n: number) =>
  text
    .split("\n")
    .slice(0, n - 1)
    .join("\n").length + (n > 1 ? 1 : 0);
const stripe = (type: "modified" | "inserted" | "deleted" | "conflict") => `var(--diff-${type}-stripe)`;
const marksOf = (state: EditorState) => state.facet(scrollbarMarks).map((m) => ({ from: m.from, color: m.color }));

let merge: MergeView | null = null;
afterEach(() => {
  merge?.destroy();
  merge = null;
});

const splitView = (extA = diffOverview("split"), extB = diffOverview("split")) =>
  (merge = new MergeView({ a: { doc: A, extensions: extA }, b: { doc: B, extensions: extB }, parent: document.body }));

describe("diff overview stripe (#1505)", () => {
  it.each([
    // The insertion has no lines on the left: a point where they would be; likewise the deletion on the right.
    { side: "a", text: A, lines: [2, 4, 5] },
    { side: "b", text: B, lines: [2, 4, 6] },
  ] as const)("marks every chunk of side-by-side pane $side in the chunk's type", ({ side, text, lines }) => {
    const view = splitView()[side];
    expect(marksOf(view.state)).toEqual([
      { from: line(text, lines[0]), color: stripe("modified") },
      { from: line(text, lines[1]), color: stripe("inserted") },
      { from: line(text, lines[2]), color: stripe("deleted") },
    ]);
    expect(diffScrollbarMarks(view.state, false)).toEqual(view.state.facet(scrollbarMarks));
  });

  it("marks the unified view's old lines deleted and new lines inserted, with no modified type", () => {
    const state = EditorState.create({
      doc: B,
      extensions: [unifiedMergeView({ original: A }), diffOverview("unified")],
    });
    expect(marksOf(state)).toEqual([
      { from: line(B, 2), color: stripe("inserted") },
      { from: line(B, 2), color: stripe("deleted") },
      { from: line(B, 4), color: stripe("inserted") },
      { from: line(B, 6), color: stripe("deleted") },
    ]);
    // The old lines' point sits on top of the new lines that replaced them.
    const [inserted, deleted] = state.facet(scrollbarMarks);
    expect(deleted!.priority).toBeGreaterThan(inserted!.priority ?? 0);
  });

  it("follows the chunks when the other side changes without a document change of its own", () => {
    const mv = splitView();
    mv.a.dispatch({ changes: { from: 0, to: mv.a.state.doc.length, insert: B } });
    expect(mv.b.state.facet(scrollbarMarks)).toEqual([]);
  });

  it("draws the aligned view's lane in the right pane over the shared scroller", () => {
    const mv = splitView([], diffOverview("aligned"));
    const lane = mv.b.dom.firstElementChild as HTMLElement;
    expect(lane.classList.contains("cm-openidea-overview-sticky")).toBe(true);
    expect(mv.dom.classList.contains("cm-openidea-overviewScroller")).toBe(true);
    expect(mv.a.dom.querySelector(".cm-openidea-overview")).toBeNull();
    mv.destroy();
    expect(mv.dom.classList.contains("cm-openidea-overviewScroller")).toBe(false);
    merge = null;
  });
});

describe("merge overview stripe (#1505)", () => {
  // Line 2: both sides changed it differently (conflict); line 4: left only; line 6: right deletes it.
  const base = "a\nb\nc\nd\ne\nf\ng";
  const left = "a\nB-left\nc\nD\ne\nf\ng";
  const right = "a\nB-right\nc\nd\ne\ng";
  const start = startMerge(left, base, right);
  const noop: MergeControls = { accept: () => {}, ignore: () => {}, resolveAutomatically: () => {} };
  const result = () =>
    EditorState.create({ doc: start.text, extensions: [mergeField.init(() => start.changes), mergeStripe("result")] });
  const sidePane = (side: "left" | "right", changes: readonly MergeChange[] = start.changes) =>
    EditorState.create({
      doc: side === "left" ? left : right,
      extensions: [sideControls(side, noop), mergeStripe(side)],
    }).update({ effects: syncSide.of(changes) }).state;

  it("marks every open change of the result by its type, conflicts on top", () => {
    const marks = result().facet(scrollbarMarks);
    expect(marks.map((m) => m.color)).toEqual([stripe("conflict"), stripe("modified"), stripe("deleted")]);
    expect(marks[0]!.priority).toBe(1);
  });

  it("marks on each side only the changes that side made", () => {
    expect(marksOf(sidePane("left"))).toEqual([
      { from: line(left, 2), color: stripe("conflict") },
      { from: line(left, 4), color: stripe("modified") },
    ]);
    expect(marksOf(sidePane("right"))).toEqual([
      { from: line(right, 2), color: stripe("conflict") },
      { from: line(right, 6), color: stripe("deleted") },
    ]);
  });

  it("drops a change once it is resolved, and a side's mark once that side is done", () => {
    let state = result();
    state = state.update(applyTo(state, [1], { type: "accept", side: "left", resolve: false })!).state;
    expect(state.facet(scrollbarMarks).map((m) => m.color)).toEqual([stripe("conflict"), stripe("deleted")]);
    expect(
      sidePane("left", state.field(mergeField))
        .facet(scrollbarMarks)
        .map((m) => m.color),
    ).toEqual([stripe("conflict")]);
  });
});
