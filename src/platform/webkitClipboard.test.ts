import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { installWebKitClipboardGuard } from "./webkitClipboard";

const views: EditorView[] = [];
let dispose: () => void;
beforeEach(() => {
  dispose = installWebKitClipboardGuard();
});
afterEach(() => {
  dispose();
  views.splice(0).forEach((view) => view.destroy());
  document.body.replaceChildren();
});

function editor(anchor = 5, head = anchor) {
  const view = new EditorView({
    doc: "first\nsecond\nthird",
    selection: EditorSelection.single(anchor, head),
    parent: document.body,
  });
  views.push(view);
  view.focus();
  return view;
}

function key(target: HTMLElement, type = "keydown", init: KeyboardEventInit = { key: "x", ctrlKey: true }) {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function clipboard(target: HTMLElement, type = "cut") {
  const data = new Map<string, string>();
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clipboardData: { clearData: () => data.clear(), setData: data.set.bind(data) } });
  target.dispatchEvent(event);
  return data.get("text/plain");
}

describe("WebKitGTK clipboard events", () => {
  it.each([
    { key: "x", ctrlKey: true },
    { key: "Delete", shiftKey: true },
  ])("cuts only the caret line for one $key keydown and two cut events (#962)", (shortcut) => {
    const view = editor();
    key(view.contentDOM, "keydown", shortcut);
    expect(clipboard(view.contentDOM)).toBe("first");
    expect(clipboard(view.contentDOM)).toBeUndefined();
    expect(view.state.doc.toString()).toBe("second\nthird");
  });

  it.each([0, 2, 5, 6, 12, 18])("protects a caret at offset %i", (position) => {
    const view = editor(position);
    const line = view.state.doc.lineAt(position);
    const expected = view.state.doc.toString().slice(0, line.from) + view.state.doc.toString().slice(line.to + 1);
    key(view.contentDOM);
    expect(clipboard(view.contentDOM)).toBe(line.text);
    clipboard(view.contentDOM);
    expect(view.state.doc.toString()).toBe(expected);
  });

  it("preserves a selected-text cut and the following line", () => {
    const view = editor(0, 5);
    key(view.contentDOM);
    expect(clipboard(view.contentDOM)).toBe("first");
    clipboard(view.contentDOM);
    expect(view.state.doc.toString()).toBe("\nsecond\nthird");
  });

  it("cuts multiple caret lines once", () => {
    const view = editor();
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)) });
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(5), EditorSelection.cursor(12)]) });
    key(view.contentDOM);
    expect(clipboard(view.contentDOM)).toBe("first\nsecond");
    clipboard(view.contentDOM);
    expect(view.state.doc.toString()).toBe("third");
  });

  it("keeps a read-only document unchanged", () => {
    const view = editor();
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    key(view.contentDOM);
    expect(clipboard(view.contentDOM)).toBe("first");
    clipboard(view.contentDOM);
    expect(view.state.doc.toString()).toBe("first\nsecond\nthird");
  });

  it("suppresses duplicate copies without changing the document", () => {
    const view = editor();
    key(view.contentDOM, "keydown", { key: "c", ctrlKey: true });
    expect(clipboard(view.contentDOM, "copy")).toBe("first");
    expect(clipboard(view.contentDOM, "copy")).toBeUndefined();
    expect(view.state.doc.toString()).toBe("first\nsecond\nthird");
  });

  it.each(["cut", "copy"])("cancels the keypress fallback after the first %s", (type) => {
    const view = editor();
    const down = key(view.contentDOM);
    expect(down.defaultPrevented).toBe(false);
    clipboard(view.contentDOM, type);
    expect(down.defaultPrevented).toBe(true);
  });

  it("allows successive key presses and auto-repeat", () => {
    const view = editor();
    for (const repeat of [false, true]) {
      key(view.contentDOM, "keydown", { key: "x", ctrlKey: true, repeat });
      expect(clipboard(view.contentDOM)).toBe(repeat ? "second" : "first");
      clipboard(view.contentDOM);
    }
    expect(view.state.doc.toString()).toBe("third");
  });

  it.each(["keyup", "pointerdown", "blur"])("allows menu cuts after %s", (type) => {
    const view = editor();
    key(view.contentDOM);
    clipboard(view.contentDOM);
    if (type === "blur") window.dispatchEvent(new Event(type));
    else view.contentDOM.dispatchEvent(new Event(type, { bubbles: true }));
    expect(clipboard(view.contentDOM)).toBe("second");
  });

  it("does not suppress repeated menu cuts without a keydown", () => {
    const view = editor();
    expect(clipboard(view.contentDOM)).toBe("first");
    expect(clipboard(view.contentDOM)).toBe("second");
  });

  it("allows multiple explicit cuts from an action that handled its key", () => {
    const view = editor();
    view.contentDOM.addEventListener("keydown", (event) => event.preventDefault());
    key(view.contentDOM);
    expect(clipboard(view.contentDOM)).toBe("first");
    expect(clipboard(view.contentDOM)).toBe("second");
  });

  it("does not carry a key press into another editor", () => {
    const first = editor();
    const second = editor();
    key(first.contentDOM);
    clipboard(first.contentDOM);
    expect(clipboard(second.contentDOM)).toBe("first");
    expect(clipboard(second.contentDOM)).toBe("second");
  });

  it("does not intercept plain inputs or unrelated clipboard events", () => {
    const input = document.body.appendChild(document.createElement("input"));
    let cuts = 0;
    input.addEventListener("cut", () => cuts++);
    key(input);
    clipboard(input);
    clipboard(input);
    expect(cuts).toBe(2);
    const view = editor();
    let pastes = 0;
    view.contentDOM.addEventListener("paste", () => pastes++);
    key(view.contentDOM);
    for (let i = 0; i < 2; i++) view.contentDOM.dispatchEvent(new Event("paste", { bubbles: true }));
    expect(pastes).toBe(2);
  });

  it("removes the guard on disposal", () => {
    const view = editor();
    key(view.contentDOM);
    clipboard(view.contentDOM);
    dispose();
    expect(clipboard(view.contentDOM)).toBe("second");
  });
});
