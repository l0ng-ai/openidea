import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorCorner } from "./api";

describe("editorCorner", () => {
  afterEach(() => vi.unstubAllGlobals());

  function viewWithCorner() {
    return new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "x".repeat(400), extensions: [] }),
    });
  }

  it("reserves the row's width as content padding so long lines can scroll clear (#2280)", () => {
    // jsdom never lays out or fires a real ResizeObserver; capture the callback.
    let notify: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          notify = () => cb();
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const view = viewWithCorner();
    const corner = editorCorner(view);
    // Empty row overlays nothing: no padding.
    expect(view.contentDOM.style.paddingRight).toBe("");
    const widget = document.createElement("div");
    corner.appendChild(widget);
    Object.defineProperty(corner, "offsetWidth", { configurable: true, value: 120 });
    notify!();
    expect(view.contentDOM.style.paddingRight).toBe("136px");
    // Emptied again, the content is allowed back under the corner.
    widget.remove();
    notify!();
    expect(view.contentDOM.style.paddingRight).toBe("");
    view.destroy();
  });

  it("still works where no ResizeObserver exists", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const view = viewWithCorner();
    editorCorner(view);
    expect(view.contentDOM.style.paddingRight).toBe("");
    view.destroy();
  });
});
