import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { languages } from "@codemirror/language-data";
import { completedSyntaxState } from "@/test/syntax";
import { BracketScanner, DEFAULT_RAINBOW_OPTIONS } from "./rainbowBrackets";
import { renderLineContent, selectedSpans } from "./stickyScroll";

describe("selectedSpans", () => {
  // the sticky line `def run():` at 100..110
  it("is empty when no range covers the line", () => {
    expect(selectedSpans([{ from: 0, to: 50 }], 100, 110)).toEqual([]);
    expect(selectedSpans([{ from: 105, to: 105 }], 100, 110)).toEqual([]);
    // a selection that ends at the line's start selects nothing on it
    expect(selectedSpans([{ from: 40, to: 100 }], 100, 110)).toEqual([]);
  });

  it("covers the whole line and runs past it for a selection through the line", () => {
    expect(selectedSpans([{ from: 0, to: 500 }], 100, 110)).toEqual([{ start: 0, end: 10, pastEnd: true }]);
  });

  it("covers part of the line", () => {
    expect(selectedSpans([{ from: 104, to: 107 }], 100, 110)).toEqual([{ start: 4, end: 7, pastEnd: false }]);
    expect(selectedSpans([{ from: 104, to: 300 }], 100, 110)).toEqual([{ start: 4, end: 10, pastEnd: true }]);
    expect(selectedSpans([{ from: 20, to: 103 }], 100, 110)).toEqual([{ start: 0, end: 3, pastEnd: false }]);
  });
});

describe("disjoint sticky selections", () => {
  it("keeps gaps between selected occurrences", () => {
    expect(
      selectedSpans(
        [
          { from: 101, to: 103 },
          { from: 107, to: 109 },
        ],
        100,
        110,
      ),
    ).toEqual([
      { start: 1, end: 3, pastEnd: false },
      { start: 7, end: 9, pastEnd: false },
    ]);
  });
});

describe("sticky line content", () => {
  /** `text` of each top-level node, with the rainbow class number of a bracket (`!` unmatched). */
  const render = (state: EditorState, lineNo: number, brackets = true) => {
    const line = state.doc.line(lineNo);
    const el = document.createElement("span");
    renderLineContent(state, lineNo, el, brackets ? new BracketScanner().marks(state, line.from, line.to) : []);
    return el;
  };
  const brackets = (el: HTMLElement) =>
    [...el.querySelectorAll("[class*=cm-rainbow-bracket]")].map(
      (e) => `${e.textContent}${e.className.replace("cm-rainbow-bracket-", "").replace("unmatched", "!")}`,
    );

  it("keeps the editor's rainbow bracket colours of the header", () => {
    const state = EditorState.create({ doc: "mod a {\n    fn b(c: [u8]) {\n        d\n    }\n}" });
    const el = render(state, 2);
    expect(el.textContent).toBe("    fn b(c: [u8]) {");
    expect(brackets(el)).toEqual(["(2", "[3", "]3", ")2", "{2"]);
    expect(brackets(render(state, 2, false))).toEqual([]);
  });

  it("follows the rainbow bracket palette length", () => {
    const state = EditorState.create({ doc: "a(b(c(d(e())))) {" });
    const el = document.createElement("span");
    const scanner = new BracketScanner({ ...DEFAULT_RAINBOW_OPTIONS, colors: 4 });
    renderLineContent(state, 1, el, scanner.marks(state, 0, state.doc.length), scanner.colors);
    expect(brackets(el).slice(0, 6)).toEqual(["(1", "(2", "(3", "(4", "(1", ")1"]);
  });

  it("wraps the token's highlight inside the bracket colour, as the editor does", async () => {
    const js = await languages.find((l) => l.name === "JavaScript")!.load();
    const state = completedSyntaxState(
      EditorState.create({ doc: "if (a) {\n  f('(', () => {\n  });\n}", extensions: js }),
    );
    const el = render(state, 2);
    expect(el.textContent).toBe("  f('(', () => {");
    // The `(` in the string is not a bracket.
    expect(brackets(el)).toEqual(["(2", "(3", ")3", "{3"]);
  });
});
