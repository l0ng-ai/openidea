import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { drawMergeDivider } from "../mergeDividers";
import { applyTo, mergeField, startMerge } from "../mergeModel";

const lines = (...l: string[]) => l.map((x) => `${x}\n`).join("");
const views: EditorView[] = [];

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
});

function view(doc: string, extensions: Extension = []) {
  const v = new EditorView({ state: EditorState.create({ doc, extensions }), parent: document.body });
  views.push(v);
  return v;
}

/** A divider the size the merge editor gives it (jsdom lays nothing out). */
function divider() {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 30,
    bottom: 600,
    width: 30,
    height: 600,
    toJSON: () => ({}),
  });
  return { el, svg: document.createElementNS("http://www.w3.org/2000/svg", "svg") };
}

const bands = (svg: SVGSVGElement) => [...svg.querySelectorAll(".cm-mergeBand")].map((p) => p.getAttribute("class"));

describe("merge dividers", () => {
  // #3876: a band joins each side change to where it lands in the result.
  it("draws a band per open change of each side, and drops a side's band once it is accepted", () => {
    const base = lines("a", "b", "c", "d", "e", "f", "g");
    const left = lines("a", "B", "c", "d", "e", "F1", "g");
    const right = lines("a", "b", "c", "D", "e", "F2", "g");
    const start = startMerge(left, base, right);
    const result = view(start.text, [mergeField.init(() => start.changes)]);
    const ours = view(left);
    const theirs = view(right);
    const l = divider();
    const r = divider();
    drawMergeDivider("left", ours, result, l.el, l.svg);
    drawMergeDivider("right", theirs, result, r.el, r.svg);
    expect(bands(l.svg)).toEqual(["cm-mergeBand cm-mergeBand-change", "cm-mergeBand cm-mergeBand-conflict"]);
    expect(bands(r.svg)).toEqual(["cm-mergeBand cm-mergeBand-change", "cm-mergeBand cm-mergeBand-conflict"]);

    result.dispatch(applyTo(result.state, [0], { type: "accept", side: "left", resolve: true })!);
    drawMergeDivider("left", ours, result, l.el, l.svg);
    drawMergeDivider("right", theirs, result, r.el, r.svg);
    expect(bands(l.svg)).toEqual(["cm-mergeBand cm-mergeBand-conflict"]);
    expect(bands(r.svg)).toEqual(["cm-mergeBand cm-mergeBand-change", "cm-mergeBand cm-mergeBand-conflict"]);
  });
});
