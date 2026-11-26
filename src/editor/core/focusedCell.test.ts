import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { executeAction, registerActions } from "@/platform/actions";
import { evaluateWhen, getContext, useContextKeys } from "@/platform/context";
import { installKeyboardDispatcher } from "@/platform/keymap";
import { _setFocusedCellEditor } from "@/editor/api";
import { TEXT_WHEN, registerEditorActions } from "./actions";
import { editorController, useEditorStatus, useTabs } from "./controller";
import { initialTabsState } from "./model/tabs";
import { columnModeField, isColumnMode } from "./cm/columnMode";

const toggleReadOnlyMock = vi.hoisted(() => vi.fn());
vi.mock("./fileAttributes", async (original) => ({
  ...(await original<typeof import("./fileAttributes")>()),
  toggleReadOnly: toggleReadOnlyMock,
}));

const ctrl = editorController();
let disposeActions: () => void;
beforeAll(() => {
  disposeActions = registerEditorActions();
  ctrl.start();
});
afterAll(() => {
  ctrl.stop();
  disposeActions();
});
afterEach(() => {
  useTabs.setState(initialTabsState(), true);
  useEditorStatus.setState({ status: null });
  useContextKeys.setState({}, true);
  _setFocusedCellEditor(null);
  toggleReadOnlyMock.mockClear();
});

/** A bare editor standing in for a focused notebook cell (the fact CellEditor publishes). */
function focusedCell(doc = "x = 1\n"): { view: EditorView; clear: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  // `columnModeField`: what a cell editor carries through its own extension list.
  const view = new EditorView({ doc, parent: host, extensions: columnModeField });
  view.focus();
  if (!view.hasFocus) throw new Error("the jsdom view did not take focus");
  _setFocusedCellEditor(view);
  return { view, clear: () => _setFocusedCellEditor(null) };
}

function disposeView(cell: { view: EditorView }): void {
  cell.view.destroy();
  cell.view.dom.remove();
}

describe("editor context keys with a focused notebook cell", () => {
  it("keeps the keys on while a cell editor has focus, with no text editor open", () => {
    const cell = focusedCell();
    try {
      ctrl.publishContext();
      expect(getContext().textEditorActive).toBe(true);
      expect(getContext().editorTextFocus).toBe(true);
      // Republishing (tab churn, pane focus) must not drop the keys.
      ctrl.publishContext();
      expect(getContext().textEditorActive).toBe(true);
      expect(getContext().editorTextFocus).toBe(true);
    } finally {
      cell.clear();
      disposeView(cell);
    }
  });

  it("lets a focused cell editor win over the mounted but unfocused text editor", async () => {
    await ctrl.openFile("/p/a.ts", { focus: false });
    const slot = ctrl.activeSlot!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const textView = slot.mount(host);
      ctrl.onMounted(slot);
      const cell = focusedCell();
      ctrl.publishContext();
      expect(getContext().editorTextFocus).toBe(true);
      expect(textView.hasFocus).toBe(false);
      cell.clear();
      disposeView(cell);
    } finally {
      host.remove();
    }
  });

  it("drops the keys once no cell editor has focus", () => {
    const cell = focusedCell();
    try {
      ctrl.publishContext();
      expect(getContext().textEditorActive).toBe(true);
      cell.clear();
      ctrl.publishContext();
      expect(getContext().textEditorActive).toBe(false);
      expect(getContext().editorTextFocus).toBe(false);
    } finally {
      disposeView(cell);
    }
  });

  it("keeps a text tab's own keys when no cell editor is focused", async () => {
    await ctrl.openFile("/p/a.ts", { focus: false });
    const slot = ctrl.activeSlot!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const view = slot.mount(host);
      ctrl.onMounted(slot);
      view.focus();
      ctrl.publishContext();
      expect(getContext().textEditorActive).toBe(true);
      expect(getContext().editorTextFocus).toBe(true);
    } finally {
      host.remove();
    }
  });
});

describe("editor actions in a focused notebook cell", () => {
  it("run in the focused cell editor, not the last text tab", async () => {
    await ctrl.openFile("/p/a.ts", { focus: false });
    const slot = ctrl.activeSlot!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const textView = slot.mount(host);
      ctrl.onMounted(slot);
      const cell = focusedCell();
      ctrl.publishContext();
      await executeAction("editor.toggleColumnSelection");
      expect(isColumnMode(cell.view.state)).toBe(true);
      expect(isColumnMode(textView.state)).toBe(false);
      cell.clear();
      disposeView(cell);
    } finally {
      host.remove();
    }
  });

  it("do not toggle the last text tab's read-only attribute", async () => {
    await ctrl.openFile("/p/a.ts", { focus: false });
    const slot = ctrl.activeSlot!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      slot.mount(host);
      ctrl.onMounted(slot);
      const cell = focusedCell();
      await executeAction("file.toggleReadOnly");
      expect(toggleReadOnlyMock).not.toHaveBeenCalled();
      // Without a focused cell the text editor is toggled, as before.
      cell.clear();
      ctrl.publishContext();
      await executeAction("file.toggleReadOnly");
      expect(toggleReadOnlyMock).toHaveBeenCalledOnce();
    } finally {
      host.remove();
    }
  });

  it("give the keyboard to the cell: ⌥⌘L reaches an editor action there", () => {
    const cell = focusedCell();
    ctrl.publishContext();
    const reformat = vi.fn();
    const disposeStub = registerActions([
      { id: "code.reformat", title: "Reformat Code", category: "Code", when: TEXT_WHEN, run: reformat },
    ]);
    const uninstall = installKeyboardDispatcher(window);
    try {
      const event = new KeyboardEvent("keydown", {
        key: "l",
        code: "KeyL",
        altKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      cell.view.contentDOM.dispatchEvent(event);
      expect(reformat).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
    } finally {
      uninstall();
      disposeStub();
      cell.clear();
      disposeView(cell);
    }
  });
});

describe("Copy Path with a notebook tab", () => {
  it("resolves the notebook tab's path while a cell editor has focus", () => {
    const paneId = useTabs.getState().activePane;
    useTabs.setState((s) => ({
      ...s,
      panes: {
        ...s.panes,
        [paneId]: {
          ...s.panes[paneId]!,
          tabs: [
            {
              id: "nb-1",
              input: { kind: "notebook", key: "notebook:/p/a.ipynb", path: "/p/a.ipynb" },
              preview: false,
              pinned: false,
            },
          ],
          active: "nb-1",
          mru: ["nb-1"],
        },
      },
    }));
    const cell = focusedCell();
    try {
      ctrl.publishContext();
      expect(ctrl.activePath()).toBe("/p/a.ipynb");
      expect(evaluateWhen("textEditorActive", getContext())).toBe(true);
    } finally {
      cell.clear();
    }
  });
});
