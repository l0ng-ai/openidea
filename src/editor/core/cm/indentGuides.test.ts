import { afterEach, describe, expect, it, vi } from "vitest";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import { codeLenses } from "@/editor/api";
import type { EditorSettings } from "@/bindings";
import { codeLensExtension } from "./codeLens";
import {
  braceGuide,
  bracketGuideDepths,
  caretGuide,
  guideVars,
  indentGuides,
  rainbowIndentGuides,
} from "./indentGuides";
import { BracketScanner, rainbowBrackets } from "./rainbowBrackets";
import { heavyExtension } from "./setup";

const SOURCE = [
  "fn parse() {",
  "    for x in y {",
  "        if a {",
  "            push();",
  "",
  "            push();",
  "        }",
  "    }",
  "}",
].join("\n");

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

function mount(doc: string, extensions: Extension[] = [], guides: Extension = indentGuides, unit = "    ") {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [indentUnit.of(unit), guides, ...extensions] }),
    parent: document.body,
  });
  return view;
}

const line = (v: EditorView, n: number) => v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")[n]!;
const images = (el: HTMLElement) => el.style.getPropertyValue("--openidea-guide-images");
const positions = (el: HTMLElement) => el.style.getPropertyValue("--openidea-guide-positions");
/** Runs the measure phase, where code lens rows take their line's guides. */
const flush = (v: EditorView) => (v as unknown as { measure(): void }).measure();
const lineStyles = (v: EditorView) =>
  [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].map((l) => `${l.className}|${l.getAttribute("style")}`);

describe("indent guides", () => {
  it("draws one strip per enclosing block, without a column-0 guide (IDEA)", () => {
    expect(guideVars(0, 4)).toBeNull();
    expect(guideVars(1, 4)).toBeNull();
    expect(guideVars(3, 4)).toEqual({
      images: "var(--openidea-guide), var(--openidea-guide)",
      positions: "calc(0.5px + 4 * var(--openidea-space, 1ch)) 0, calc(0.5px + 8 * var(--openidea-space, 1ch)) 0",
    });
  });

  it("positions each guide the same way on lines of different depth", () => {
    const v = mount(SOURCE);
    expect(line(v, 1).classList.contains("cm-openidea-guides")).toBe(false);
    expect(line(v, 2).style.getPropertyValue("--openidea-guide-positions")).toBe(
      "calc(0.5px + 4 * var(--openidea-space, 1ch)) 0",
    );
    expect(line(v, 3).style.getPropertyValue("--openidea-guide-positions")).toBe(
      "calc(0.5px + 4 * var(--openidea-space, 1ch)) 0, calc(0.5px + 8 * var(--openidea-space, 1ch)) 0",
    );
  });

  it("keeps guides through blank lines inside a block", () => {
    const v = mount(SOURCE);
    expect(line(v, 4).style.getPropertyValue("--openidea-guide-positions")).toBe(
      "calc(0.5px + 4 * var(--openidea-space, 1ch)) 0, calc(0.5px + 8 * var(--openidea-space, 1ch)) 0",
    );
  });

  it("continues the guides of an annotated line through its code lens row", () => {
    const doc = "mod a {\n    impl B {\n        fn c() {}\n    }\n}";
    const v = mount(doc, [
      codeLensExtension,
      codeLenses.of([
        { pos: doc.indexOf("fn c"), title: "2 usages" },
        { pos: doc.indexOf("impl"), title: "1 usage" },
      ]),
    ]);
    flush(v);
    const [implLens, fnLens] = [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-openidea-lens")];
    expect(v.contentDOM.classList.contains("cm-openidea-guidesOn")).toBe(true);
    expect(fnLens!.style.getPropertyValue("--openidea-guide-positions")).toBe(
      "calc(0.5px + 4 * var(--openidea-space, 1ch)) 0",
    );
    expect(implLens!.style.getPropertyValue("--openidea-guide-positions")).toBe("");
  });
});

describe("the caret's indent guide", () => {
  const at = (lineNo: number, col: number) => {
    const state = EditorState.create({ doc: SOURCE });
    return state.update({ selection: { anchor: state.doc.line(lineNo).from + col } }).state;
  };

  it("is the guide in the caret's column whose block holds the caret line (IDEA)", () => {
    // `for` opens the guide at column 4, drawn on lines 3-7 (`if` … its `}`).
    expect(caretGuide(at(2, 4), 4)).toEqual({ level: 1, from: 3, to: 7 });
    expect(caretGuide(at(4, 4), 4)).toEqual({ level: 1, from: 3, to: 7 });
    expect(caretGuide(at(4, 8), 4)).toEqual({ level: 2, from: 4, to: 6 });
  });

  it("is none in column 0, between indent units, in text, or on the closing line", () => {
    expect(caretGuide(at(4, 0), 4)).toBeNull();
    expect(caretGuide(at(4, 6), 4)).toBeNull();
    expect(caretGuide(at(2, 12), 4)).toBeNull();
    expect(caretGuide(at(8, 4), 4)).toBeNull();
  });

  it("is the matched brace colour's guide while the caret is at a brace of a multi-line block", () => {
    const state = (pos: number) => EditorState.create({ doc: SOURCE, selection: { anchor: pos } });
    const forOpen = SOURCE.indexOf("{", SOURCE.indexOf("for"));
    // `for x in y {`: its guide is at column 4, on lines 3-7.
    expect(braceGuide(state(forOpen + 1), 4)).toEqual({ level: 1, from: 3, to: 7 });
    expect(braceGuide(state(forOpen), 4)).toEqual({ level: 1, from: 3, to: 7 });
    const forClose = SOURCE.lastIndexOf("    }") + 4;
    expect(braceGuide(state(forClose + 1), 4)).toEqual({ level: 1, from: 3, to: 7 });
    expect(braceGuide(state(SOURCE.indexOf("push")), 4)).toBeNull();
    expect(braceGuide(EditorState.create({ doc: "a {\n    b { c }\n}", selection: { anchor: 9 } }), 4)).toBeNull();
  });

  it("draws the brace guide over the caret's", () => {
    const v = mount(SOURCE);
    v.dispatch({ selection: { anchor: SOURCE.indexOf("{", SOURCE.indexOf("for")) + 1 } });
    expect(images(line(v, 3))).toBe("var(--openidea-guide-brace), var(--openidea-guide)");
  });

  it("draws that guide on its lines in the selected colour", () => {
    const v = mount(SOURCE);
    v.dispatch({ selection: { anchor: v.state.doc.line(4).from + 8 } });
    expect(images(line(v, 3))).toBe("var(--openidea-guide), var(--openidea-guide-active)");
    expect(images(line(v, 6))).toBe("var(--openidea-guide)");
    v.dispatch({ selection: { anchor: v.state.doc.line(4).from + 12 } });
    expect(images(line(v, 3))).toBe("var(--openidea-guide), var(--openidea-guide)");
  });
});

describe("rainbow indent guides", () => {
  it("gives each depth its own image, cycling through the five colours", () => {
    expect(guideVars(0, 4, true)).toBeNull();
    expect(guideVars(1, 4, true)).toBeNull();
    expect(guideVars(3, 4, true)).toEqual({
      images: "var(--openidea-guide-1), var(--openidea-guide-2)",
      positions: "calc(0.5px + 4 * var(--openidea-space, 1ch)) 0, calc(0.5px + 8 * var(--openidea-space, 1ch)) 0",
    });
    const deep = guideVars(8, 2, true)!;
    expect(deep.images.split(", ")).toEqual([1, 2, 3, 4, 5, 1, 2].map((n) => `var(--openidea-guide-${n})`));
    // Same strips at the same offsets as plain guides: only the colour changes.
    expect(deep.positions).toBe(guideVars(8, 2)!.positions);
  });

  it("leaves plain guides as they are", () => {
    expect(guideVars(8, 2)!.images.split(", ")).toEqual(Array(7).fill("var(--openidea-guide)"));
    const v = mount(SOURCE);
    expect(images(line(v, 3))).toBe("var(--openidea-guide), var(--openidea-guide)");
  });

  it("colours guides by depth in the editor, through blank lines too", () => {
    const v = mount(SOURCE, [], rainbowIndentGuides);
    expect(line(v, 1).classList.contains("cm-openidea-guides")).toBe(false);
    expect(images(line(v, 2))).toBe("var(--openidea-guide-1)");
    expect(images(line(v, 3))).toBe("var(--openidea-guide-1), var(--openidea-guide-2)");
    expect(images(line(v, 4))).toBe("var(--openidea-guide-1), var(--openidea-guide-2)");
    expect(positions(line(v, 4))).toBe(
      "calc(0.5px + 4 * var(--openidea-space, 1ch)) 0, calc(0.5px + 8 * var(--openidea-space, 1ch)) 0",
    );
    expect(images(line(v, 6))).toBe("var(--openidea-guide-1)");
  });

  it("counts depth in indent units, with tabs as with spaces", () => {
    const depth = 8;
    const body = (indent: string) => Array.from({ length: depth }, (_, i) => `${indent.repeat(i)}level${i}`).join("\n");
    const deepest = (v: EditorView) => line(v, depth - 1);
    const spaces = mount(body("  "), [], rainbowIndentGuides, "  ");
    const expected = [1, 2, 3, 4, 5, 1].map((n) => `var(--openidea-guide-${n})`).join(", ");
    expect(images(deepest(spaces))).toBe(expected);
    spaces.destroy();
    const tabs = mount(body("\t"), [EditorState.tabSize.of(4)], rainbowIndentGuides, "\t");
    expect(images(deepest(tabs))).toBe(expected);
    expect(positions(deepest(tabs)).split(/, (?=calc)/)[1]).toBe("calc(0.5px + 8 * var(--openidea-space, 1ch)) 0");
  });

  it("measures a column as the font's space width, so a proportional font keeps guides in the indentation", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const sample = this.textContent ?? "";
      const width = /^ +$/.test(sample) ? sample.length * 3.5 : 0;
      return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
    });
    try {
      const v = mount(SOURCE);
      (v as unknown as { measure(): void }).measure();
      expect(v.scrollDOM.style.getPropertyValue("--openidea-space")).toBe("3.5px");
      v.destroy();
      expect(v.scrollDOM.style.getPropertyValue("--openidea-space")).toBe("");
      view = undefined;
    } finally {
      rect.mockRestore();
    }
  });

  it("does not count a partial indent unit as a level", () => {
    const v = mount("a {\n       b\n}", [], rainbowIndentGuides);
    // 7 columns at a unit of 4: one level, no guide.
    expect(line(v, 1).classList.contains("cm-openidea-guides")).toBe(false);
  });

  it("switches colours in place when the setting is toggled", () => {
    const guides = new Compartment();
    view = new EditorView({
      state: EditorState.create({ doc: SOURCE, extensions: [indentUnit.of("    "), guides.of(indentGuides)] }),
      parent: document.body,
    });
    const plain = lineStyles(view);
    view.dispatch({ effects: guides.reconfigure(rainbowIndentGuides) });
    expect(images(line(view, 3))).toBe("var(--openidea-guide-1), var(--openidea-guide-2)");
    view.dispatch({ effects: guides.reconfigure(indentGuides) });
    expect(lineStyles(view)).toEqual(plain);
    view.dispatch({ effects: guides.reconfigure([]) });
    expect(view.contentDOM.querySelector(".cm-openidea-guides")).toBeNull();
  });

  it("colours the guides of code lens rows and follows the setting there", () => {
    const doc = "mod a {\n    impl B {\n        mod c {\n            fn d() {}\n        }\n    }\n}";
    const guides = new Compartment();
    view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          indentUnit.of("    "),
          guides.of(rainbowIndentGuides),
          codeLensExtension,
          codeLenses.of([{ pos: doc.indexOf("fn d"), title: "1 usage" }]),
        ],
      }),
      parent: document.body,
    });
    const lens = () => view!.contentDOM.querySelector<HTMLElement>(".cm-openidea-lens")!;
    flush(view);
    expect(images(lens())).toBe("var(--openidea-guide-1), var(--openidea-guide-2)");
    expect(positions(lens())).toBe(
      "calc(0.5px + 4 * var(--openidea-space, 1ch)) 0, calc(0.5px + 8 * var(--openidea-space, 1ch)) 0",
    );
    view.dispatch({ effects: guides.reconfigure(indentGuides) });
    flush(view);
    expect(images(lens())).toBe("var(--openidea-guide), var(--openidea-guide)");
    view.dispatch({ effects: guides.reconfigure([]) });
    expect(images(lens())).toBe("");
  });

  it("is installed by the setting, and only while indent guides are shown", () => {
    const render = (indentGuides: boolean, rainbowIndentGuides: boolean) => {
      const settings = { appearance: { indentGuides, rainbowIndentGuides } } as unknown as EditorSettings;
      const v = mount(SOURCE, [heavyExtension(SOURCE.length, settings)], []);
      const out = { on: v.contentDOM.classList.contains("cm-openidea-guidesOn"), images: images(line(v, 3)) };
      v.destroy();
      view = undefined;
      return out;
    };
    expect(render(true, false)).toEqual({ on: true, images: "var(--openidea-guide), var(--openidea-guide)" });
    expect(render(true, true)).toEqual({ on: true, images: "var(--openidea-guide-1), var(--openidea-guide-2)" });
    expect(render(false, true)).toEqual({ on: false, images: "" });
    expect(render(false, false)).toEqual({ on: false, images: "" });
  });
});

describe("rainbow guides of bracket blocks", () => {
  const bracket = (n: number) => `var(--openidea-guide-bracket-${n})`;
  const depth = (n: number) => `var(--openidea-guide-${n})`;

  it("takes the bracket colour for a level with a bracket block, the depth colour otherwise", () => {
    expect(guideVars(4, 4, true, 0, 0, [undefined, 1, undefined])!.images).toBe(
      [bracket(2), depth(2), depth(3)].join(", "),
    );
    // Plain guides stay plain; the caret's and the brace guide still win.
    expect(guideVars(3, 4, false, 0, 0, [undefined, 0, 1])!.images).toBe(
      "var(--openidea-guide), var(--openidea-guide)",
    );
    expect(guideVars(3, 4, true, 1, 2, [undefined, 0, 1])!.images).toBe(
      "var(--openidea-guide-active), var(--openidea-guide-brace)",
    );
  });

  it("colours each guide as the brace that opens its block, through blank lines", () => {
    const v = mount(SOURCE, [rainbowBrackets()], rainbowIndentGuides);
    // `for … {` is at bracket depth 1, `if a {` at 2.
    expect(images(line(v, 2))).toBe(bracket(2));
    expect(images(line(v, 3))).toBe([bracket(2), bracket(3)].join(", "));
    expect(images(line(v, 4))).toBe([bracket(2), bracket(3)].join(", "));
    expect(images(line(v, 6))).toBe(bracket(2));
  });

  it("follows bracket nesting where it differs from indentation", () => {
    const doc = ["x {", "    foo(bar(() => {", "        body", "    }))", "    call(", "        a,", "    )", "}"].join(
      "\n",
    );
    const v = mount(doc, [rainbowBrackets()], rainbowIndentGuides);
    // `{` after `x {`, `foo(`, `bar(`: depth 3, the first colour again; `call(` is at depth 1.
    expect(images(line(v, 2))).toBe(bracket(1));
    expect(images(line(v, 5))).toBe(bracket(2));
  });

  it("keeps the depth colour for indentation blocks (Python, YAML) and closed or partial brackets", () => {
    const python = ["class A:", "    def f(self):", "        return [", "            1,", "        ]"].join("\n");
    const v = mount(python, [rainbowBrackets()], rainbowIndentGuides);
    expect(images(line(v, 2))).toBe(depth(1));
    // The list opened by `return [` is a bracket block (depth 0) inside the indentation ones.
    expect(images(line(v, 3))).toBe([depth(1), bracket(1)].join(", "));
    v.destroy();
    const yaml = ["a:", "  b:", "    c: [1, 2]", "    d: 1"].join("\n");
    const y = mount(yaml, [rainbowBrackets()], rainbowIndentGuides, "  ");
    expect(images(line(y, 2))).toBe(depth(1));
  });

  it("works with tabs as with spaces", () => {
    const tabs = SOURCE.replace(/ {4}/g, "\t");
    const v = mount(tabs, [rainbowBrackets(), EditorState.tabSize.of(4)], rainbowIndentGuides, "\t");
    expect(images(line(v, 3))).toBe([bracket(2), bracket(3)].join(", "));
  });

  it("keeps the depth colours while rainbow brackets are off, and switches when they are toggled", () => {
    const brackets = new Compartment();
    const v = mount(SOURCE, [brackets.of([])], rainbowIndentGuides);
    expect(images(line(v, 3))).toBe([depth(1), depth(2)].join(", "));
    v.dispatch({ effects: brackets.reconfigure(rainbowBrackets()) });
    expect(images(line(v, 3))).toBe([bracket(2), bracket(3)].join(", "));
    v.dispatch({ effects: brackets.reconfigure([]) });
    expect(images(line(v, 3))).toBe([depth(1), depth(2)].join(", "));
  });

  it("follows the rainbow bracket palette length, also when it changes", () => {
    const doc = ["x {", "    foo(bar(() => {", "        body", "    }))", "}"].join("\n");
    const brackets = new Compartment();
    const v = mount(doc, [brackets.of(rainbowBrackets({ colors: 5 }))], rainbowIndentGuides);
    // `{` after `x {`, `foo(`, `bar(`: depth 3, the fourth of five colours; of two, the second.
    expect(images(line(v, 2))).toBe(bracket(4));
    v.dispatch({ effects: brackets.reconfigure(rainbowBrackets({ colors: 2 })) });
    expect(images(line(v, 2))).toBe(bracket(2));
  });

  it("updates after an edit that changes the nesting", () => {
    const v = mount(SOURCE, [rainbowBrackets()], rainbowIndentGuides);
    // `for x in y {` becomes `for x in (y) {`: same depth; then wrap the whole body in another block.
    v.dispatch({ changes: { from: 0, insert: "mod m {\n" } });
    expect(images(line(v, 4))).toBe([bracket(3), bracket(1)].join(", "));
    v.dispatch({ changes: { from: 0, to: "mod m {\n".length } });
    expect(images(line(v, 3))).toBe([bracket(2), bracket(3)].join(", "));
  });

  it("does not depend on where the computed range starts", () => {
    const state = EditorState.create({ doc: SOURCE, extensions: [indentUnit.of("    ")] });
    // The levels a line draws guides at (a blank line: those of the next line).
    const drawn = [0, 1, 2, 3, 3, 3, 2, 1, 0].map((levels) => Math.max(0, levels - 1));
    const depths = (first: number) =>
      bracketGuideDepths(state, new BracketScanner(), 4, first, state.doc.lines).map((levels, i) =>
        Array.from({ length: drawn[first - 1 + i]! }, (_, k) => levels[k + 1]),
      );
    const whole = depths(1);
    for (let first = 2; first <= state.doc.lines; first++) expect(depths(first)).toEqual(whole.slice(first - 1));
    // Line 4 (`push();`): level 1 belongs to `for` (depth 1), level 2 to `if` (depth 2).
    expect(whole[3]).toEqual([1, 2]);
  });

  it("continues the bracket colours of a line through its code lens row", () => {
    const doc = "mod a {\n    impl B {\n        mod c {\n            fn d() {}\n        }\n    }\n}";
    const lens = codeLenses.compute(["doc"], (s) => [{ pos: s.doc.toString().indexOf("fn d"), title: "1 usage" }]);
    const v = mount(doc, [rainbowBrackets(), codeLensExtension, lens], rainbowIndentGuides);
    const row = () => v.contentDOM.querySelector<HTMLElement>(".cm-openidea-lens")!;
    flush(v);
    expect(images(row())).toBe([bracket(2), bracket(3)].join(", "));
    expect(images(row())).toBe(images(line(v, 3)));
    // An edit that changes the nesting reaches the row too.
    v.dispatch({ changes: { from: 0, insert: "x {\n" } });
    flush(v);
    expect(images(line(v, 4))).toBe([bracket(3), bracket(1)].join(", "));
    expect(images(row())).toBe(images(line(v, 4)));
  });
});
