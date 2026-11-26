import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorSettings } from "@/platform/ipc";
import { resetDistractionFree, setDistractionFree } from "@/workbench/distractionFree";
import { distractionFreeExtension, lineNumbersExtension, prefsFor, prefsOf, stickyExtension } from "./setup";

afterEach(() => resetDistractionFree());

const settings = { appearance: { distractionFreeWidth: 100 } } as unknown as EditorSettings;

function mount(s: EditorSettings | undefined) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "fn main() {}\n",
      extensions: [
        lineNumbersExtension(s),
        distractionFreeExtension(s),
        prefsFor({ settings: s, path: "/p/a.rs", info: undefined, readOnly: false }),
      ],
    }),
  });
  return { view, dispose: () => (view.destroy(), parent.remove()) };
}

describe("editor in distraction free mode", () => {
  it("defaults the text width to 80 columns", () => {
    expect(prefsOf(undefined).appearance.distractionFreeWidth).toBe(80);
  });

  it("shows line numbers and the right margin normally", () => {
    const { view, dispose } = mount(undefined);
    expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(view.dom.classList.contains("cm-openidea-distractionFree")).toBe(false);
    expect(view.contentDOM.getAttribute("style") ?? "").toContain("background-image");
    dispose();
  });

  it("hides line numbers, gutter, margin guides and sticky lines and centres at the configured width", () => {
    setDistractionFree(true);
    const { view, dispose } = mount(settings);
    expect(view.dom.querySelector(".cm-lineNumbers")).toBeNull();
    expect(view.dom.classList.contains("cm-openidea-distractionFree")).toBe(true);
    expect(view.dom.style.getPropertyValue("--openidea-df-columns").trim()).toBe("100");
    expect(view.contentDOM.getAttribute("style") ?? "").not.toContain("background-image");
    expect(stickyExtension({} as EditorSettings, "markdown")).toEqual([]);
    dispose();
  });
});
