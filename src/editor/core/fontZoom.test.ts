import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEditorRegistry, type TextEditorHandle } from "@/editor/api";
import { useProject } from "@/platform/project";
import { fontZoom, resetAllEditorsFontZoom, setFontZoom, stepAllEditorsFontZoom, wheelZoom } from "./cm/prefs";
import { resetWheelZoomGesture } from "@/platform/wheelZoom";

const zoomOf = (view: EditorView) => view.state.field(fontZoom, false);

describe("editor font zoom (active editor by default, all editors when configured)", () => {
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
  beforeEach(() => {
    resetWheelZoomGesture();
    resetAllEditorsFontZoom();
    useProject.setState({ settings: null });
  });
  afterEach(() => {
    for (const handle of handles) {
      useEditorRegistry.getState().editors.delete(handle);
      handle.view.destroy();
      handle.view.dom.parentElement?.remove();
    }
    handles.length = 0;
    resetAllEditorsFontZoom();
    useProject.setState({ settings: null });
  });

  it("zooms only the active editor from ⌘/Ctrl+wheel by default (IDEA parity)", () => {
    const first = makeView();
    const second = makeView();
    first.contentDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true, deltaY: -10 }));
    expect(zoomOf(first)).toBe(1);
    expect(zoomOf(second)).toBe(0);
    expect(zoomOf(makeView())).toBe(0);
    second.contentDOM.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true, deltaY: 10 }));
    expect(zoomOf(first)).toBe(1);
    expect(zoomOf(second)).toBe(-1);
  });

  it("doesn't zoom from the inertia of a scroll when ⌘/Ctrl is pressed during it", () => {
    const view = makeView();
    const plain = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -40 });
    view.contentDOM.dispatchEvent(plain);
    const coasting = new WheelEvent("wheel", { bubbles: true, cancelable: true, metaKey: true, deltaY: -20 });
    view.contentDOM.dispatchEvent(coasting);
    expect(coasting.defaultPrevented).toBe(false);
    expect(zoomOf(view)).toBe(0);
  });

  it("zooms every open editor from ⌘/Ctrl+wheel when wheelZoomScope is 'all' (#2480)", () => {
    useProject.setState({ settings: { editor: { general: { wheelZoomScope: "all" } } } } as never);
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
