import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorCorner } from "@/editor/api";
import { cornerInset } from "./cornerInset";

let view: EditorView;
let resize: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {
        resize = null;
      }
    },
  );
  view = new EditorView({
    state: EditorState.create({ doc: "const a = 1;", extensions: [cornerInset] }),
    parent: document.body,
  });
});

afterEach(() => {
  view.destroy();
  vi.unstubAllGlobals();
});

const inset = () => view.dom.style.getPropertyValue("--cm-corner-inset");

/** The corner's measured width arrives from the ResizeObserver, not from jsdom. */
function resizeTo(width: number) {
  const corner = view.dom.querySelector<HTMLElement>(".cm-openidea-corner");
  if (!corner) throw new Error("no corner");
  corner.getBoundingClientRect = () => ({ width }) as DOMRect;
  resize?.();
}

describe("corner inset", () => {
  it("leaves the corner's width plus a gap for the text: 20px check, 32+ with counts", () => {
    editorCorner(view);
    resizeTo(20);
    expect(inset()).toBe("24px");
    resizeTo(32);
    expect(inset()).toBe("36px");
  });

  it("clears the reserved room when the corner is empty", () => {
    editorCorner(view);
    resizeTo(20);
    resizeTo(0);
    expect(inset()).toBe("");
  });

  it("keeps at least half of the editor width for the text", () => {
    Object.defineProperty(view.scrollDOM, "clientWidth", { configurable: true, value: 200 });
    editorCorner(view);
    resizeTo(400);
    expect(inset()).toBe("100px");
  });

  it("does nothing without the extension", () => {
    const plain = new EditorView({ state: EditorState.create({ doc: "x" }), parent: document.body });
    expect(() => editorCorner(plain)).not.toThrow();
    expect(plain.dom.style.getPropertyValue("--cm-corner-inset")).toBe("");
    plain.destroy();
  });
});
