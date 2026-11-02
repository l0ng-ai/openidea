import { history, redo, undo } from "@codemirror/commands";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  applyNonConflicting,
  applyTo,
  canApply,
  changesIn,
  changesInSide,
  hasNonConflicting,
  hasSimple,
  isResolved,
  mergeField,
  mergeHistory,
  resolveSimple,
  revertResolved,
  startMerge,
  summarize,
  unresolved,
  type MergeAction,
} from "../mergeModel";

const lines = (...l: string[]) => l.map((x) => `${x}\n`).join("");

/** A merge editor's model on a plain editor state, with the history the real one has. */
function merge(left: string, base: string, right: string) {
  const start = startMerge(left, base, right);
  let state = EditorState.create({
    doc: start.text,
    extensions: [history(), mergeHistory, mergeField.init(() => start.changes)],
  });
  const view = {
    get state() {
      return state;
    },
    // The history commands dispatch a finished transaction, detached from the view.
    dispatch: (arg: Transaction | TransactionSpec) => {
      state = arg instanceof Transaction ? arg.state : state.update(arg).state;
    },
  };
  const run = (spec: TransactionSpec | null) => {
    expect(spec).not.toBeNull();
    view.dispatch(spec!);
  };
  return {
    view,
    get text() {
      return state.doc.toString();
    },
    get changes() {
      return state.field(mergeField);
    },
    act: (indexes: number[], action: MergeAction) => run(applyTo(state, indexes, action)),
    run,
    undo: () => undo(view),
    redo: () => redo(view),
  };
}

const base = lines("a", "b", "c", "d", "e", "f", "g");
const left = lines("a", "L", "c", "d", "e", "f", "G");
const right = lines("a", "R", "c", "D", "e", "f", "G");
// changes: 0 conflict (b / L / R), 1 right-only (d), 2 identical on both (g)

describe("the model", () => {
  it("starts from the base with every change pending", () => {
    const m = merge(left, base, right);
    expect(m.text).toBe(base);
    expect(m.changes.map((c) => c.kind)).toEqual(["conflict", "right", "both"]);
    expect(unresolved(m.view.state)).toHaveLength(3);
    expect(m.changes[0]).toMatchObject({ from: 2, to: 4 });
  });

  it("has no changes for identical versions, and one whole-file conflict for files too different to compare", () => {
    expect(merge(base, base, base).changes).toEqual([]);
    const many = (p: string) => Array.from({ length: 70_000 }, (_, i) => `${p}${i}`).join("\n");
    const big = merge(many("l"), many("b"), many("r"));
    expect(big.changes).toHaveLength(1);
    expect(big.changes[0]).toMatchObject({ kind: "conflict", from: 0 });
  });

  it("keeps what both sides did when the file is too different to compare and they agree", () => {
    const many = (p: string) => Array.from({ length: 70_000 }, (_, i) => `${p}${i}`).join("\n");
    const [b, same, other] = [many("b"), many("s"), many("o")];
    const agreed = merge(same, b, same);
    expect(agreed.changes).toHaveLength(1);
    expect(agreed.changes[0]!.kind).toBe("both");
    agreed.act([0], { type: "accept", side: "left", resolve: false });
    expect(agreed.text).toBe(same);
    // One side left the file as it was: the other's version is the change.
    expect(merge(b, b, other).changes[0]!.kind).toBe("right");
    expect(merge(b, b, b).changes).toEqual([]);
  });

  it("gives the position of a change in each version", () => {
    const m = merge(left, base, right);
    expect(left.slice(...m.changes[0]!.leftRange)).toBe("L\n");
    expect(right.slice(...m.changes[0]!.rightRange)).toBe("R\n");
  });
});

describe("accepting from a side", () => {
  it("takes the text, and leaves a conflict open for the other side", () => {
    const m = merge(left, base, right);
    m.act([0], { type: "accept", side: "left", resolve: false });
    expect(m.text).toBe(lines("a", "L", "c", "d", "e", "f", "g"));
    expect(m.changes[0]).toMatchObject({ oneside: true, done: { left: true, right: false } });
    expect(isResolved(m.changes[0]!)).toBe(false);
    expect(canApply(m.view.state.doc, m.changes[0]!, { type: "accept", side: "left", resolve: false })).toBe(false);
  });

  it("appends the other side after the first, in either order", () => {
    const m = merge(left, base, right);
    m.act([0], { type: "accept", side: "right", resolve: false });
    m.act([0], { type: "accept", side: "left", resolve: false });
    expect(m.text).toBe(lines("a", "R", "L", "c", "d", "e", "f", "g"));
    expect(isResolved(m.changes[0]!)).toBe(true);
    expect(m.changes[0]).toMatchObject({ from: 2, to: 6 });
  });

  it("starts a line of its own when the first side did not end its last line", () => {
    const m = merge("a\nL", "a\nb", "a\nR");
    m.act([0], { type: "accept", side: "left", resolve: false });
    m.act([0], { type: "accept", side: "right", resolve: false });
    expect(m.text).toBe("a\nL\nR");
  });

  it("settles the change at once when resolving using a side", () => {
    const m = merge(left, base, right);
    m.act([0], { type: "accept", side: "left", resolve: true });
    expect(m.text).toBe(lines("a", "L", "c", "d", "e", "f", "g"));
    expect(isResolved(m.changes[0]!)).toBe(true);
  });

  it("settles a conflict whose other side deleted the lines, there being nothing to append", () => {
    const m = merge(lines("a", "c"), lines("a", "b", "c"), lines("a", "B", "c"));
    m.act([0], { type: "accept", side: "right", resolve: false });
    expect(m.text).toBe(lines("a", "B", "c"));
    expect(isResolved(m.changes[0]!)).toBe(true);
  });

  it("applies a one-sided change from its side, and settles it from the other without a text change", () => {
    const m = merge(left, base, right);
    m.act([1], { type: "accept", side: "right", resolve: false });
    expect(m.text).toBe(lines("a", "b", "c", "D", "e", "f", "g"));
    const n = merge(left, base, right);
    n.act([1], { type: "accept", side: "left", resolve: false });
    expect(n.text).toBe(base);
    expect(isResolved(n.changes[1]!)).toBe(true);
  });

  it("keeps the other changes where they are as the text grows and shrinks", () => {
    const m = merge(left, base, right);
    m.act([0], { type: "accept", side: "right", resolve: false });
    m.act([0], { type: "accept", side: "left", resolve: false });
    m.act([1], { type: "accept", side: "right", resolve: false });
    m.act([2], { type: "accept", side: "left", resolve: false });
    expect(m.text).toBe(lines("a", "R", "L", "c", "D", "e", "f", "G"));
  });
});

describe("ignoring", () => {
  it("settles one side of a conflict and leaves the text; the other side then replaces it", () => {
    const m = merge(left, base, right);
    m.act([0], { type: "ignore", side: "left" });
    expect(m.text).toBe(base);
    expect(m.changes[0]).toMatchObject({ done: { left: true, right: false } });
    m.act([0], { type: "accept", side: "right", resolve: false });
    expect(m.text).toBe(lines("a", "R", "c", "d", "e", "f", "g"));
    expect(isResolved(m.changes[0]!)).toBe(true);
  });

  it("settles a conflict with the base when ignoring both sides", () => {
    const m = merge(left, base, right);
    m.act([0], { type: "ignore", side: null });
    expect(m.text).toBe(base);
    expect(isResolved(m.changes[0]!)).toBe(true);
  });

  it("settles a one-sided change whichever side ignores it", () => {
    const m = merge(left, base, right);
    m.act([1], { type: "ignore", side: "right" });
    expect(isResolved(m.changes[1]!)).toBe(true);
  });
});

describe("resolving automatically", () => {
  const b = "let a = 1 + b;\n";
  const l = "let x = 1 + b;\n";
  const r = "let a = 1 + 2;\n";

  it("merges a conflict whose sides changed different words", () => {
    const m = merge(l, b, r);
    expect(hasSimple(m.view.state)).toBe(true);
    m.act([0], { type: "auto", side: "base" });
    expect(m.text).toBe("let x = 1 + 2;\n");
    expect(isResolved(m.changes[0]!)).toBe(true);
  });

  it("does not touch a conflict the user edited, or one already partly decided", () => {
    const m = merge(l, b, r);
    m.view.dispatch({ changes: { from: 0, insert: "// " } });
    expect(canApply(m.view.state.doc, m.changes[0]!, { type: "auto", side: "base" })).toBe(false);
    expect(hasSimple(m.view.state)).toBe(false);
    const n = merge(l, b, r);
    n.act([0], { type: "ignore", side: "left" });
    expect(hasSimple(n.view.state)).toBe(false);
  });

  it("does not offer it for a conflict of the same word", () => {
    const m = merge("let x = 1;\n", "let a = 1;\n", "let y = 1;\n");
    expect(hasSimple(m.view.state)).toBe(false);
    expect(applyTo(m.view.state, [0], { type: "auto", side: "base" })).toBeNull();
  });

  it("resolves the simple conflicts and the non-conflicting changes together, and no more", () => {
    const pad = (mid: string, end: string) => lines("1", "2", "3", "4", mid, "5", "6", "7", end);
    // 0: one side changed a line; 1: a real conflict.
    const m = merge(pad("x", "L"), pad("a", "b"), pad("a", "R"));
    m.run(resolveSimple(m.view.state));
    expect(m.text).toBe(pad("x", "b"));
    expect(m.changes.map(isResolved)).toEqual([true, false]);
  });
});

describe("applying the non-conflicting changes", () => {
  it("applies those of the chosen side only", () => {
    const m = merge(left, base, right);
    expect(hasNonConflicting(m.view.state, "left")).toBe(true);
    m.run(applyNonConflicting(m.view.state, "left"));
    // The right-only change is not the left's to apply; the identical one is.
    expect(m.text).toBe(lines("a", "b", "c", "d", "e", "f", "G"));
    expect(m.changes.map(isResolved)).toEqual([false, false, true]);
    expect(hasNonConflicting(m.view.state, "left")).toBe(false);
    expect(hasNonConflicting(m.view.state, "right")).toBe(true);
  });

  it("applies all of them from the base, and leaves conflicts", () => {
    const m = merge(left, base, right);
    m.run(applyNonConflicting(m.view.state, "base"));
    expect(m.text).toBe(lines("a", "b", "c", "D", "e", "f", "G"));
    expect(m.changes.map(isResolved)).toEqual([false, true, true]);
    expect(applyNonConflicting(m.view.state, "base")).toBeNull();
  });
});

describe("history", () => {
  it("undoes and redoes a resolution with the state of the change", () => {
    const m = merge(left, base, right);
    m.act([0], { type: "accept", side: "left", resolve: false });
    m.act([0], { type: "accept", side: "right", resolve: false });
    expect(isResolved(m.changes[0]!)).toBe(true);

    m.undo();
    expect(m.text).toBe(lines("a", "L", "c", "d", "e", "f", "g"));
    expect(m.changes[0]).toMatchObject({ oneside: true, done: { left: true, right: false }, from: 2, to: 4 });
    m.undo();
    expect(m.text).toBe(base);
    expect(m.changes[0]).toMatchObject({ oneside: false, done: { left: false, right: false }, from: 2, to: 4 });

    m.act([0], { type: "accept", side: "right", resolve: true });
    expect(m.text).toBe(lines("a", "R", "c", "d", "e", "f", "g"));
    m.undo();
    m.redo();
    expect(isResolved(m.changes[0]!)).toBe(true);
  });

  it("undoes an ignore, which changes no text", () => {
    const m = merge(left, base, right);
    m.act([1], { type: "ignore", side: "right" });
    m.undo();
    expect(isResolved(m.changes[1]!)).toBe(false);
    m.redo();
    expect(isResolved(m.changes[1]!)).toBe(true);
  });

  it("undoes a bulk resolution of several changes in one step", () => {
    const m = merge(left, base, right);
    m.run(applyNonConflicting(m.view.state, "base"));
    m.undo();
    expect(m.text).toBe(base);
    expect(m.changes.map(isResolved)).toEqual([false, false, false]);
    expect(m.changes.map((c) => c.from)).toEqual([2, 6, 12]);
  });
});

describe("reverting", () => {
  it("sends the settled changes back to the base and leaves the pending ones", () => {
    const m = merge(left, base, right);
    m.act([0], { type: "accept", side: "left", resolve: true });
    m.act([2], { type: "accept", side: "left", resolve: false });
    m.act([1], { type: "accept", side: "right", resolve: false });
    m.run(revertResolved(m.view.state));
    expect(m.text).toBe(base);
    expect(m.changes.map(isResolved)).toEqual([false, false, false]);
    expect(revertResolved(m.view.state)).toBeNull();
  });

  it("does not revert a conflict that is only half decided", () => {
    const m = merge(left, base, right);
    m.act([0], { type: "accept", side: "left", resolve: false });
    expect(revertResolved(m.view.state)).toBeNull();
  });
});

describe("editing the result", () => {
  it("keeps typing at the edge of a change inside it, and shifts the changes below", () => {
    const m = merge(left, base, right);
    m.view.dispatch({ changes: { from: 0, insert: "top\n" } });
    expect(m.changes[0]).toMatchObject({ from: 6, to: 8 });
    m.view.dispatch({ changes: { from: 8, insert: "x" } });
    expect(m.changes[0]).toMatchObject({ from: 6, to: 9 });
    // "c\n" lies between the first two changes.
    expect(m.changes[1]!.from).toBe(m.changes[0]!.to + 2);
  });
});

describe("selection", () => {
  it("finds the changes in the selected lines of the result", () => {
    const m = merge(left, base, right);
    const state = m.view.state;
    expect(changesIn(state, 2, 2)).toEqual([0]);
    expect(changesIn(state, 0, 0)).toEqual([]);
    // A caret at the start of the line after a change is not in the change.
    expect(changesIn(state, 4, 4)).toEqual([]);
    expect(changesIn(state, 0, state.doc.length)).toEqual([0, 1, 2]);
  });

  it("finds the changes in the selected lines of a side", () => {
    const m = merge(left, base, right);
    const sideDoc = EditorState.create({ doc: left }).doc;
    expect(changesInSide(m.view.state, "left", sideDoc, 2, 2)).toEqual([0]);
    // The left side did not change the second change, so it has nothing there.
    expect(changesInSide(m.view.state, "left", sideDoc, 6, 6)).toEqual([]);
  });

  it("finds an insertion at the point where it sits", () => {
    const m = merge(lines("a", "N", "b"), lines("a", "b"), lines("a", "b"));
    expect(changesIn(m.view.state, 2, 2)).toEqual([0]);
    expect(changesIn(m.view.state, 0, 0)).toEqual([]);
  });
});

describe("summary", () => {
  it("counts what is left and which toolbar commands have something to do (simple conflicts include the non-conflicting changes, as in IntelliJ)", () => {
    const m = merge(left, base, right);
    expect(summarize(m.view.state)).toEqual({
      pending: 3,
      conflicts: 1,
      left: true,
      all: true,
      right: true,
      simple: true,
      revert: false,
    });
    m.run(applyNonConflicting(m.view.state, "base"));
    expect(summarize(m.view.state)).toEqual({
      pending: 1,
      conflicts: 1,
      left: false,
      all: false,
      right: false,
      simple: false,
      revert: true,
    });
  });
});
