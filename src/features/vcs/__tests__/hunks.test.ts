import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { LineHunk } from "@/bindings";
import { applyRollback, hunkAtLine, hunkKeys, hunksOverlapping, nextHunk, prevHunk, rollbackEdit } from "../hunks";
import { editorHunks, hunkAtPos, hunkField, hunksInSelection, setHunksEffect } from "../gutter";

const h = (
  kind: LineHunk["kind"],
  start: number,
  lines: number,
  oldStart: number,
  oldLines: number,
  oldText: string,
): LineHunk => ({
  kind,
  start,
  lines,
  oldStart,
  oldLines,
  oldText,
});

describe("rollbackEdit", () => {
  it("restores modified lines", () => {
    const cur = "a\nB\nc\n";
    expect(rollbackEdit(cur, h("modified", 1, 1, 1, 1, "b\n"))).toEqual({ from: 2, to: 4, insert: "b\n" });
    expect(applyRollback(cur, h("modified", 1, 1, 1, 1, "b\n"))).toBe("a\nb\nc\n");
  });

  it("removes added lines", () => {
    expect(applyRollback("a\nb\nx\nc\n", h("added", 1, 2, 1, 0, ""))).toBe("a\nc\n");
  });

  it("re-inserts deleted lines before the following line", () => {
    expect(applyRollback("a\nc\n", h("deleted", 1, 0, 1, 1, "b\n"))).toBe("a\nb\nc\n");
  });

  it("re-inserts lines deleted at the end of the file", () => {
    expect(applyRollback("a\n", h("deleted", 1, 0, 1, 1, "b\n"))).toBe("a\nb\n");
    expect(applyRollback("", h("deleted", 0, 0, 0, 1, "x\n"))).toBe("x\n");
  });

  it("keeps the original final-newline state", () => {
    // Last line without terminator, changed.
    expect(applyRollback("a\nB", h("modified", 1, 1, 1, 1, "b"))).toBe("a\nb");
    // A trailing newline was added to the last line.
    expect(applyRollback("a\nb\n", h("modified", 1, 1, 1, 1, "b"))).toBe("a\nb");
  });

  it("restores multi-line replacements of different size", () => {
    const cur = "1\nX\nY\nZ\n5\n";
    expect(applyRollback(cur, h("modified", 1, 3, 1, 2, "2\n3\n"))).toBe("1\n2\n3\n5\n");
  });
});

describe("hunk navigation", () => {
  const hunks = [h("modified", 2, 2, 2, 2, ""), h("deleted", 6, 0, 6, 1, ""), h("added", 9, 1, 8, 0, "")];
  it("finds the hunk under a line (deletions mark the following line)", () => {
    expect(hunkAtLine(hunks, 3)).toBe(hunks[0]);
    expect(hunkAtLine(hunks, 6)).toBe(hunks[1]);
    expect(hunkAtLine(hunks, 5)).toBeUndefined();
    // Deletion at the very end marks the last line.
    expect(hunkAtLine([h("deleted", 4, 0, 4, 1, "")], 3, 4)).toBeDefined();
  });
  it("wraps next / previous", () => {
    expect(nextHunk(hunks, 2)).toBe(hunks[1]);
    expect(nextHunk(hunks, 9)).toBe(hunks[0]);
    expect(prevHunk(hunks, 9)).toBe(hunks[1]);
    expect(prevHunk(hunks, 2)).toBe(hunks[2]);
  });
});

describe("hunksOverlapping", () => {
  const hunks = [h("modified", 1, 1, 1, 1, "x\n"), h("added", 4, 2, 4, 0, ""), h("deleted", 8, 0, 6, 2, "")];
  it("maps a diff chunk to backend hunk indices", () => {
    expect(hunksOverlapping(hunks, { fromA: 1, toA: 2, fromB: 1, toB: 2 })).toEqual([0]);
    expect(hunksOverlapping(hunks, { fromA: 4, toA: 4, fromB: 4, toB: 6 })).toEqual([1]);
    expect(hunksOverlapping(hunks, { fromA: 6, toA: 8, fromB: 8, toB: 8 })).toEqual([2]);
    // Old side unknown (HEAD diff): match on the new side only.
    expect(hunksOverlapping(hunks, { fromA: -1, toA: -1, fromB: 4, toB: 5 })).toEqual([1]);
    expect(hunksOverlapping(hunks, { fromA: -1, toA: -1, fromB: 2, toB: 3 })).toEqual([]);
  });
});

describe("gutter hunk state", () => {
  const withHunks = (doc: string, hunks: LineHunk[]) =>
    EditorState.create({ doc, extensions: [hunkField] }).update({ effects: setHunksEffect.of(hunks) }).state;

  it("tracks hunk extents through edits so rollback stays exact", () => {
    // HEAD: "a\nb\nc\n"; buffer modified line 2.
    let state = withHunks("a\nB\nc\n", [h("modified", 1, 1, 1, 1, "b\n")]);
    // Insert a line above the hunk.
    state = state.update({ changes: { from: 0, insert: "new\n" } }).state;
    const [hunk] = editorHunks(state);
    expect(state.sliceDoc(hunk!.from, hunk!.to)).toBe("B\n");
    const rolled = state.update({ changes: { from: hunk!.from, to: hunk!.to, insert: hunk!.oldText } }).state;
    expect(rolled.doc.toString()).toBe("new\na\nb\nc\n");
  });

  it("locates markers by line", () => {
    const state = withHunks("a\nc\nd\n", [h("deleted", 1, 0, 1, 1, "b\n"), h("added", 2, 1, 3, 0, "")]);
    expect(hunkAtPos(state, state.doc.line(2).from)?.kind).toBe("deleted");
    expect(hunkAtPos(state, state.doc.line(3).from)?.kind).toBe("added");
    expect(hunkAtPos(state, state.doc.line(1).from)).toBeUndefined();
  });
});

describe("change lane clicks", () => {
  it("opens the hunk popup from a mousedown on the lane (outside contentDOM)", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { changeLane } = await import("@/editor/core/cm/lanes");
    const { changeMarkers, setHunkPopupHooks } = await import("../gutter");
    const opened: string[] = [];
    setHunkPopupHooks({ open: (_v, hunk, path) => opened.push(`${hunk.kind}:${path}`), docChanged: () => {} });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "a\nB\nc\n",
        extensions: [changeLane, changeMarkers({ path: "/p/f.txt" } as Parameters<typeof changeMarkers>[0])],
      }),
    });
    view.dispatch({ effects: setHunksEffect.of([h("modified", 0, 1, 0, 1, "b\n")]) });
    const lane = view.dom.querySelector(".cm-openidea-lane")!;
    expect(view.contentDOM.contains(lane)).toBe(false);
    lane.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }),
    );
    expect(opened).toEqual(["modified:/p/f.txt"]);
    view.destroy();
    setHunkPopupHooks(null);
    parent.remove();
  });

  it("opens a deletion from the hit area above its line", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { changeLane } = await import("@/editor/core/cm/lanes");
    const { changeMarkers, setHunkPopupHooks } = await import("../gutter");
    const opened: string[] = [];
    setHunkPopupHooks({ open: (_v, hunk) => opened.push(hunk.kind), docChanged: () => {} });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "a\nc\n",
        extensions: [changeLane, changeMarkers({ path: "/p/f.txt" } as Parameters<typeof changeMarkers>[0])],
      }),
    });
    view.dispatch({ effects: setHunksEffect.of([h("deleted", 1, 0, 1, 1, "b\n")]) });
    const lane = view.dom.querySelector<HTMLElement>(".cm-openidea-lane")!;
    vi.spyOn(lane, "getBoundingClientRect").mockReturnValue({ left: 100, right: 104, top: 0, bottom: 100 } as DOMRect);
    const marker = view.dom.querySelector<HTMLElement>(".cm-openidea-laneDeleted")!;
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue({ left: 96, top: 14, width: 12, height: 12 } as DOMRect);
    const previous = view.lineBlockAt(view.state.doc.line(1).from);
    const deleted = view.lineBlockAt(view.state.doc.line(2).from);
    vi.spyOn(view, "lineBlockAtHeight").mockImplementation((height) => (height < 20 ? previous : deleted));
    marker.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 96, clientY: 17 }),
    );
    expect(opened).toEqual(["deleted"]);
    view.destroy();
    setHunkPopupHooks(null);
    parent.remove();
  });
});

describe("change markers in folds", () => {
  it("shows hidden hunks on the folded line and opens them from there", async () => {
    const { codeFolding, foldEffect } = await import("@codemirror/language");
    const { gutterLaneMarkers } = await import("@/editor/api");
    const { changeMarkers } = await import("../gutter");
    let state = EditorState.create({
      doc: "a\nb\nc\nd\ne\n",
      extensions: [codeFolding(), changeMarkers({ path: "/p/f.txt" } as Parameters<typeof changeMarkers>[0])],
    });
    // Line 4 ("d", 0-based 3) lost a line below it.
    state = state.update({ effects: setHunksEffect.of([h("deleted", 3, 0, 3, 1, "x\n")]) }).state;
    const at = (s: EditorState) => {
      const out: number[] = [];
      for (const set of s.facet(gutterLaneMarkers)) set.between(0, s.doc.length, (from) => void out.push(from));
      return out;
    };
    expect(at(state)).toEqual([state.doc.line(4).from]);
    // Fold lines 2–4 onto line 1.
    state = state.update({ effects: foldEffect.of({ from: state.doc.line(1).to, to: state.doc.line(4).to }) }).state;
    expect(at(state)).toEqual([state.doc.line(1).from]);
    expect(hunkAtPos(state, state.doc.line(1).from)?.kind).toBe("deleted");
  });
});

describe("hunkKeys", () => {
  it("identifies blocks by content, not position", () => {
    const a = hunkKeys("x\nB\nc\n", [h("modified", 1, 1, 1, 1, "b\n")]);
    // The same block two lines further down (lines inserted above it) keeps its key.
    const b = hunkKeys("new\nnew\nx\nB\nc\n", [h("added", 0, 2, 0, 0, ""), h("modified", 3, 1, 1, 1, "b\n")]);
    expect(b[1]).toBe(a[0]);
    expect(b[0]).not.toBe(b[1]);
    // Identical blocks get distinct keys.
    const twice = hunkKeys("B\nB\n", [h("modified", 0, 1, 0, 1, "b\n"), h("modified", 1, 1, 1, 1, "b\n")]);
    expect(twice[0]).not.toBe(twice[1]);
  });
});

describe("hunksInSelection (Rollback Lines)", () => {
  const hunks = [h("modified", 1, 1, 1, 1, "b\n"), h("deleted", 3, 0, 3, 1, "d\n"), h("added", 4, 1, 5, 0, "")];
  const at = (from: number, to = from) => {
    let state = EditorState.create({ doc: "a\nB\nc\ne\nX\n", extensions: hunkField });
    state = state.update({ effects: setHunksEffect.of(hunks), selection: EditorSelection.single(from, to) }).state;
    return hunksInSelection(state).map((x) => x.start);
  };
  it("takes the hunks on the caret's line or touched by the selection", () => {
    expect(at(0)).toEqual([]);
    expect(at(3)).toEqual([1]);
    // The deletion's marker is on the line after the removed block.
    expect(at(7)).toEqual([3]);
    expect(at(2, 9)).toEqual([1, 3, 4]);
  });
});
