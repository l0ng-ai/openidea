import { afterEach, describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import { codeLenses } from "@/editor/api";
import { codeLensExtension } from "./codeLens";
import { guideVars, indentGuides } from "./indentGuides";

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

function mount(doc: string, extensions: Extension[] = []) {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [indentUnit.of("    "), indentGuides, ...extensions] }),
    parent: document.body,
  });
  return view;
}

const line = (v: EditorView, n: number) => v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")[n]!;

describe("indent guides", () => {
  it("draws one strip per enclosing block, without a column-0 guide (IDEA)", () => {
    expect(guideVars(0, 4)).toBeNull();
    expect(guideVars(1, 4)).toBeNull();
    expect(guideVars(3, 4)).toEqual({
      images: "var(--openidea-guide), var(--openidea-guide)",
      positions: "calc(6px + 4ch) 0, calc(6px + 8ch) 0",
    });
  });

  it("positions each guide the same way on lines of different depth", () => {
    const v = mount(SOURCE);
    expect(line(v, 1).classList.contains("cm-openidea-guides")).toBe(false);
    expect(line(v, 2).style.getPropertyValue("--openidea-guide-positions")).toBe("calc(6px + 4ch) 0");
    expect(line(v, 3).style.getPropertyValue("--openidea-guide-positions")).toBe(
      "calc(6px + 4ch) 0, calc(6px + 8ch) 0",
    );
  });

  it("keeps guides through blank lines inside a block", () => {
    const v = mount(SOURCE);
    expect(line(v, 4).style.getPropertyValue("--openidea-guide-positions")).toBe(
      "calc(6px + 4ch) 0, calc(6px + 8ch) 0",
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
    const [implLens, fnLens] = [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-openidea-lens")];
    expect(v.contentDOM.classList.contains("cm-openidea-guidesOn")).toBe(true);
    expect(fnLens!.style.getPropertyValue("--openidea-guide-positions")).toBe("calc(6px + 4ch) 0");
    expect(implLens!.style.getPropertyValue("--openidea-guide-positions")).toBe("");
  });
});
