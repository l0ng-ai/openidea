import { afterEach, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { EditorState, RangeSet } from "@codemirror/state";
import { EditorView, GutterMarker } from "@codemirror/view";
import { iconAreaExtension, iconAreaSource } from "./iconArea";

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
