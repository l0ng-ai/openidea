import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, GutterMarker } from "@codemirror/view";
import { SETTLE_MS, iconAreaExtension, iconAreaSource, mapLineStart } from "./iconArea";

class Dot extends GutterMarker {
  constructor(readonly name: string) {
    super();
  }
  override eq(other: GutterMarker) {
    return other instanceof Dot && other.name === this.name;
  }
  override toDOM() {
    const el = document.createElement("span");
    el.className = `dot dot-${this.name}`;
    return el;
  }
}

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

const DOC = "run()\nclass A implements B {}\n/** doc */\nend";
const lineStart = (state: EditorState, line: number) => state.doc.line(line).from;

function open(extra: Parameters<typeof iconAreaSource.of>[0][]) {
  view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [iconAreaExtension, ...extra.map((s) => iconAreaSource.of(s))] }),
    parent: document.body,
  });
  return view;
}

it("puts every source's icons in one column, in order within a line", () => {
  const v = open([
    {
      order: 50,
      markers: (view) =>
        RangeSet.of([new Dot("impl").range(lineStart(view.state, 1)), new Dot("impl").range(lineStart(view.state, 2))]),
    },
    { order: 10, markers: (view) => RangeSet.of([new Dot("run").range(lineStart(view.state, 1))]) },
  ]);
  expect(v.dom.querySelectorAll(".cm-gutter")).toHaveLength(1);
  const rows = [...v.dom.querySelectorAll(".cm-openidea-iconArea .cm-gutterElement")].filter((el) =>
    el.querySelector(".dot"),
  );
  expect(rows.map((el) => [...el.querySelectorAll(".dot")].map((d) => d.className))).toEqual([
    ["dot dot-run", "dot dot-impl"],
    ["dot dot-impl"],
  ]);
});

it("routes a press to the source that handles it", () => {
  const first = vi.fn(() => false);
  const second = vi.fn(() => true);
  const v = open([
    { order: 1, markers: (view) => RangeSet.of([new Dot("a").range(lineStart(view.state, 1))]), mousedown: first },
    { order: 2, markers: () => RangeSet.empty, mousedown: second },
  ]);
  fireEvent.mouseDown(v.dom.querySelector(".dot-a")!, { button: 0 });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

it("keeps an icon's width only while a source asks for it", () => {
  const empty = open([{ order: 1, markers: () => RangeSet.empty }]);
  expect(empty.dom.querySelector(".cm-openidea-iconSpacer")).toBeNull();
  empty.destroy();
  const v = open([{ order: 1, markers: () => RangeSet.empty, reserve: () => true }]);
  expect(v.dom.querySelector(".cm-openidea-iconArea .cm-openidea-iconSpacer")).toBeTruthy();
});

describe("while edits place icons again", () => {
  // Line numbers each source has an icon on, as set by the test.
  const setRun = StateEffect.define<number[]>();
  const setImpl = StateEffect.define<number[]>();
  const linesField = (effect: typeof setRun, initial: number[]) =>
    StateField.define<number[]>({
      create: () => initial,
      update: (value, tr) => tr.effects.find((e) => e.is(effect))?.value ?? value,
    });
  const run = linesField(setRun, [2]);
  const impl = linesField(setImpl, [2]);
  const dots = (name: string, field: StateField<number[]>) => (view: EditorView) =>
    RangeSet.of(view.state.field(field).map((l) => new Dot(name).range(lineStart(view.state, l))));

  const spacerIcons = (v: EditorView) => v.dom.querySelectorAll(".cm-openidea-iconSpacer").length;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function openTwoSources() {
    view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        extensions: [
          run,
          impl,
          iconAreaExtension,
          iconAreaSource.of({ order: 10, markers: dots("run", run) }),
          iconAreaSource.of({ order: 50, markers: dots("impl", impl) }),
        ],
      }),
      parent: document.body,
    });
    return view;
  }

  // Enter at the start of line 2: the run icon moves to line 3 first, the inheritance icon later.
  const pressEnter = (v: EditorView) => v.dispatch({ changes: { from: lineStart(v.state, 2), insert: "\n" } });

  it("keeps the widest line's width while a line's icons are apart, then narrows once they settle", () => {
    const v = openTwoSources();
    expect(spacerIcons(v)).toBe(2);

    pressEnter(v);
    v.dispatch({ effects: setRun.of([3]) });
    expect(spacerIcons(v)).toBe(2);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    v.dispatch({ effects: setImpl.of([3]) });
    expect(spacerIcons(v)).toBe(2);

    // An icon that really went away: the area narrows only after nothing changed for a while.
    v.dispatch({ effects: setImpl.of([]) });
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(spacerIcons(v)).toBe(2);
    vi.advanceTimersByTime(1);
    expect(spacerIcons(v)).toBe(1);
  });

  it("does not narrow while typing goes on", () => {
    const v = openTwoSources();
    v.dispatch({ effects: setImpl.of([]) });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(SETTLE_MS / 2);
      pressEnter(v);
      expect(spacerIcons(v)).toBe(2);
    }
    vi.advanceTimersByTime(SETTLE_MS);
    expect(spacerIcons(v)).toBe(1);
  });

  it("widens at once", () => {
    const v = openTwoSources();
    v.dispatch({ effects: setImpl.of([]) });
    vi.advanceTimersByTime(SETTLE_MS);
    expect(spacerIcons(v)).toBe(1);
    pressEnter(v);
    v.dispatch({ effects: setImpl.of([2]) });
    expect(spacerIcons(v)).toBe(2);
  });
});

it("moves a line's marker down with its text when Enter is pressed at the line's start", () => {
  const state = EditorState.create({ doc: "a\nclass B {}\nc" });
  const lineB = state.doc.line(2).from;
  const tr = state.update({ changes: { from: lineB, insert: "\n" } });
  expect(mapLineStart(tr, lineB)).toBe(tr.state.doc.line(3).from);
  const after = (from: number, insert: string, to = from) =>
    mapLineStart(state.update({ changes: { from, to, insert } }), lineB);
  // Other edits keep it at the start of its line.
  expect(after(lineB, "  ")).toBe(lineB);
  expect(after(1, "\nnew")).toBe(lineB + 4);
  expect(after(lineB + 5, "\n")).toBe(lineB);
  // Joined into the line above, it goes with its text.
  expect(after(1, "", lineB)).toBe(0);
});
