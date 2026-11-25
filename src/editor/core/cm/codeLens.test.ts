import { describe, expect, it, vi } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { codeLenses } from "@/editor/api";
import { codeLensExtension, codeLensPositions, declarationStart, groupLenses, indentColumns } from "./codeLens";

const doc = (text: string) => EditorState.create({ doc: text });

describe("code lens layout", () => {
  it("places lenses above attributes, annotations and doc comments", () => {
    const s = doc(
      "mod a {\n    /// Docs\n    #[test]\n    #[ignore]\n    fn t() {}\n}\n@Test\nvoid x() {}\n/**\n * doc\n */\nfunction f() {}",
    );
    expect(s.doc.lineAt(declarationStart(s, 5)).number).toBe(2);
    expect(s.doc.lineAt(declarationStart(s, 8)).number).toBe(7);
    expect(s.doc.lineAt(declarationStart(s, 12)).number).toBe(9);
    expect(s.doc.lineAt(declarationStart(s, 1)).number).toBe(1);
  });

  it("groups lenses per line in order", () => {
    const s = doc("fn a() {}\nfn b() {}");
    const g = groupLenses(s, [
      { pos: 12, title: "Run", order: 200 },
      { pos: 3, title: "2 usages", order: 10 },
      { pos: 10, title: "1 usage", order: 10 },
      { pos: 99, title: "out of range" },
    ]);
    expect(g.map((x) => [x.lineFrom, x.lenses.map((l) => l.title)])).toEqual([
      [0, ["2 usages"]],
      [10, ["1 usage", "Run"]],
    ]);
  });

  it("measures indentation with tabs", () => {
    expect(indentColumns("\t  x", 4)).toBe(6);
    expect(indentColumns("    x", 4)).toBe(4);
  });
});

describe("code lens position", () => {
  const doc = "@contextmanager\ndef lifespan(app):\n    pass\n";
  const lenses = [
    { pos: 16, title: "1 usage", kind: "usages", order: 10 },
    { pos: 16, title: "Denis", kind: "author", order: 20 },
  ];
  const view = (positions: Record<string, "top" | "right">) =>
    new EditorView({
      state: EditorState.create({
        doc,
        extensions: [codeLensExtension, codeLenses.of(lenses), codeLensPositions.of(positions)],
      }),
      parent: document.body,
    });
  const texts = (els: NodeListOf<Element>) => [...els].map((e) => e.textContent);

  it("puts every lens on a row above the declaration by default, with no separators", () => {
    const v = view({});
    expect(texts(v.dom.querySelectorAll(".cm-openidea-lens"))).toEqual(["1 usageDenis"]);
    expect(v.dom.querySelector(".cm-openidea-lens")?.closest(".cm-line")).toBeNull();
    expect(v.dom.querySelector(".cm-openidea-lensInline")).toBeNull();
    v.destroy();
  });

  it("puts each kind where its setting says: usages at the line end, the author above", () => {
    const v = view({ usages: "right" });
    expect(texts(v.dom.querySelectorAll(".cm-openidea-lens"))).toEqual(["Denis"]);
    const inline = v.dom.querySelector(".cm-openidea-lensInline");
    expect(inline?.textContent).toBe("1 usage");
    expect(inline?.closest(".cm-line")?.textContent).toBe("@contextmanager1 usage");
    v.destroy();
  });

  it("puts both at the line end", () => {
    const v = view({ usages: "right", author: "right" });
    expect(v.dom.querySelector(".cm-openidea-lens")).toBeNull();
    expect(texts(v.dom.querySelectorAll(".cm-openidea-lensInline"))).toEqual(["1 usageDenis"]);
    v.destroy();
  });

  it("rebuilds the lens when its position changes in an open editor", () => {
    const positions = new Compartment();
    const v = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [codeLensExtension, codeLenses.of(lenses), positions.of(codeLensPositions.of({}))],
      }),
      parent: document.body,
    });
    v.dispatch({ effects: positions.reconfigure(codeLensPositions.of({ usages: "right", author: "right" })) });
    expect(v.dom.querySelector(".cm-openidea-lens")).toBeNull();
    expect(texts(v.dom.querySelectorAll(".cm-openidea-lensInline"))).toEqual(["1 usageDenis"]);
    v.dispatch({ effects: positions.reconfigure(codeLensPositions.of({})) });
    expect(v.dom.querySelector(".cm-openidea-lensInline")).toBeNull();
    expect(texts(v.dom.querySelectorAll(".cm-openidea-lens"))).toEqual(["1 usageDenis"]);
    v.destroy();
  });
});

describe("inline lens against a folded chip", () => {
  const doc = "def f():\n    pass\n";
  const lenses = [{ pos: 8, title: "1 usage", kind: "usages", order: 10 }];

  class FakeChip extends WidgetType {
    toDOM() {
      const el = document.createElement("span");
      el.className = "cm-foldPlaceholder";
      el.getBoundingClientRect = () => ({ width: 18 }) as DOMRect;
      return el;
    }
    override eq(other: WidgetType) {
      return other instanceof FakeChip;
    }
  }

  it("steps past a folded chip drawn after its anchor and back when it goes away", async () => {
    vi.useFakeTimers();
    const chip = new Compartment();
    const chipDeco = () =>
      EditorView.decorations.of(Decoration.set([Decoration.widget({ widget: new FakeChip(), side: 3 }).range(8)]));
    const v = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [codeLensExtension, codeLenses.of(lenses), codeLensPositions.of({ usages: "right" }), chip.of([])],
      }),
      parent: document.body,
    });
    const inline = v.dom.querySelector<HTMLElement>(".cm-openidea-lensInline")!;
    const inner = inline.firstElementChild as HTMLElement;
    await vi.advanceTimersByTimeAsync(10);
    expect(inner.style.left).toBe("");

    // The fold appears after the lens mounted; side 3 mirrors the production DOM order, where
    // CodeMirror draws the fold's replace widget after the side-1 line-end anchor.
    v.dispatch({ effects: chip.reconfigure(chipDeco()) });
    await vi.advanceTimersByTimeAsync(10);
    expect(inner.style.left).toBe("calc(var(--openidea-hint-offset) + 18px)");

    v.dispatch({ effects: chip.reconfigure([]) });
    await vi.advanceTimersByTimeAsync(10);
    expect(inner.style.left).toBe("");
    v.destroy();
    vi.useRealTimers();
  });
});
