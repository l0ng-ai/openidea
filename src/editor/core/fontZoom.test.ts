import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { fontZoom, resetAllEditorsFontZoom, setFontZoom, stepAllEditorsFontZoom, wheelZoom } from "./cm/prefs";

const zoomOf = (view: EditorView) => view.state.field(fontZoom, false);

describe("shared editor font zoom (#2480)", () => {
  const handles: TextEditorHandle[] = [];
  const makeView = (extensions = [fontZoom, wheelZoom]) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ extensions }) });
    const handle = { view } as TextEditorHandle;
    useEditorRegistry.getState().editors.add(handle);
    handles.push(handle);
    return view;
  };
  beforeEach(() => resetAllEditorsFontZoom());
  afterEach(() => {
    for (const handle of handles) {
      useEditorRegistry.getState().editors.delete(handle);
      handle.view.destroy();
      handle.view.dom.parentElement?.remove();
    }
    handles.length = 0;
    resetAllEditorsFontZoom();
  });

  it("zooms every open editor from ⌘/Ctrl+wheel on one of them", () => {
    const first = makeView();
    const second = makeView();
    first.contentDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true, deltaY: -10 }));
    expect(zoomOf(first)).toBe(1);
    expect(zoomOf(second)).toBe(1);
    second.contentDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true, deltaY: 10 }));
    expect(zoomOf(first)).toBe(0);
    expect(zoomOf(second)).toBe(0);
  });

  it("ignores the wheel without ⌘/Ctrl", () => {
    const first = makeView();
    makeView();
    first.contentDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -10 }));
    expect(zoomOf(first)).toBe(0);
  });

  it("keeps the shared zoom within -6..36", () => {
    const first = makeView();
    const second = makeView();
    first.dispatch({ effects: setFontZoom.of(36) });
    stepAllEditorsFontZoom(first, 1);
    expect(zoomOf(first)).toBe(36);
    expect(zoomOf(second)).toBe(0);
    stepAllEditorsFontZoom(first, -1);
    expect(zoomOf(first)).toBe(35);
    expect(zoomOf(second)).toBe(35);
  });

  it("leaves views without the zoom field alone", () => {
    const first = makeView();
    const plain = makeView([]);
    stepAllEditorsFontZoom(first, 1);
    expect(zoomOf(first)).toBe(1);
    expect(zoomOf(plain)).toBeUndefined();
  });

  it("seeds newly opened editors and resets them all", () => {
    const first = makeView();
    stepAllEditorsFontZoom(first, 2);
    expect(zoomOf(makeView())).toBe(2);
    resetAllEditorsFontZoom();
    expect(zoomOf(first)).toBe(0);
    expect(zoomOf(makeView())).toBe(0);
  });
});
