import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { PRESETS, useKeymap } from "@/platform/keymap";
import { usePlatform } from "@/platform/platformInfo";
import { multiCaretMouse } from "./multiCaret";

let view: EditorView;
const originalKeymap = useKeymap.getState();
const originalPlatform = usePlatform.getState();
const event = (init: MouseEventInit = {}) => new MouseEvent("mousedown", { button: 0, altKey: true, ...init });
const styles = (e: MouseEvent) => view.state.facet(EditorView.mouseSelectionStyle).map((style) => style(view, e));

beforeEach(() => {
  useKeymap.setState({ preset: "intellij-macos", overrides: {} });
  usePlatform.setState({ os: "macos" });
  view = new EditorView({
    state: EditorState.create({
      doc: "first\nsecond\nthird",
      extensions: [EditorState.allowMultipleSelections.of(true), multiCaretMouse],
    }),
    parent: document.body,
  });
  vi.spyOn(view, "posAtCoords").mockImplementation((coords) => coords.x);
  vi.spyOn(view, "coordsAtPos").mockReturnValue(null);
});
afterEach(() => {
  view.destroy();
  useKeymap.setState(originalKeymap);
  usePlatform.setState(originalPlatform);
});

describe("caret mouse bindings", () => {
  it.each(Object.keys(PRESETS))("%s keeps the default gesture", (preset) => {
    useKeymap.setState({ preset });
    expect(PRESETS[preset]!["editor.addOrRemoveCaret"]).toEqual(["Alt+Shift+Button1"]);
    expect(styles(event({ shiftKey: true }))[0]).not.toBeNull();
  });

  it("matches the complete stroke and only the left button", () => {
    expect(styles(event({ shiftKey: true }))[0]).not.toBeNull();
    for (const init of [{}, { shiftKey: true, ctrlKey: true }, { shiftKey: true, metaKey: true }, { button: 1 }]) {
      expect(styles(event(init))[0]).toBeNull();
    }
  });

  it("uses rebinding immediately and yields column selection to the caret gesture", () => {
    expect(styles(event())[1]).not.toBeNull();
    useKeymap.setState({ overrides: { "editor.addOrRemoveCaret": ["Alt+Button1"] } });
    expect(styles(event({ shiftKey: true }))[0]).toBeNull();
    const [caret, column] = styles(event({ clientX: 2 }));
    expect(column).toBeNull();
    expect(caret!.get(event({ clientX: 2 }), false, false).ranges.map((r) => r.head)).toEqual([0, 2]);
    const drag = caret!.get(event({ clientX: 8 }), false, false);
    expect(drag.ranges.map((r) => [r.anchor, r.head])).toEqual([
      [0, 0],
      [2, 8],
    ]);
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]) });
    const remove = styles(event({ clientX: 2 }))[0]!;
    expect(remove.get(event({ clientX: 2 }), false, false).ranges.map((r) => r.head)).toEqual([0]);
  });

  it("honours removal and restores Alt-drag column selection", () => {
    useKeymap.setState({ overrides: { "editor.addOrRemoveCaret": [] } });
    expect(styles(event({ shiftKey: true }))[0]).toBeNull();
    expect(styles(event())[0]).toBeNull();
    expect(styles(event())[1]).not.toBeNull();
    useKeymap.setState({ overrides: {} });
    expect(styles(event({ shiftKey: true }))[0]).not.toBeNull();
  });

  it("matches normalized Ctrl+Alt strokes as reported for right Alt on Windows", () => {
    useKeymap.setState({ overrides: { "editor.addOrRemoveCaret": ["alt+ctrl+button1"] } });
    expect(styles(event({ ctrlKey: true }))[0]).not.toBeNull();
    expect(styles(event())[0]).toBeNull();
  });

  it("preserves middle-button column selection except on Linux", () => {
    expect(styles(event({ button: 1, altKey: false }))[1]).not.toBeNull();
    usePlatform.setState({ os: "linux" });
    expect(styles(event({ button: 1, altKey: false }))[1]).toBeNull();
  });
});
