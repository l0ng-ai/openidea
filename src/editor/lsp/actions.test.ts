import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { executeAction } from "@/platform/actions";
import { getContext, setContext, useContextKeys } from "@/platform/context";
import { _setFocusedCellEditor } from "@/editor/api";
import { registerLspActions } from "./actions";
import { registerInlineCompletionActions } from "./inlineCompletion";
import { editorController, useEditorStatus, useTabs } from "@/editor/core/controller";
import { initialTabsState } from "@/editor/core/model/tabs";

const { formatDocument, showIntentions, refactorThis, requestInline, showHint } = vi.hoisted(() => ({
  formatDocument: vi.fn(),
  showIntentions: vi.fn(),
  refactorThis: vi.fn(),
  requestInline: vi.fn(),
  showHint: vi.fn(),
}));
vi.mock("./format", async (original) => ({
  ...(await original<typeof import("./format")>()),
  formatDocument,
}));
vi.mock("./intentions", async (original) => ({
  ...(await original<typeof import("./intentions")>()),
  showIntentions,
}));
vi.mock("@/editor/refactor", async (original) => ({
  ...(await original<typeof import("@/editor/refactor")>()),
  refactorThis,
}));
vi.mock("./inlineCompletion", async (original) => ({
  ...(await original<typeof import("./inlineCompletion")>()),
  requestInline,
}));
vi.mock("./hint", async (original) => ({
  ...(await original<typeof import("./hint")>()),
  showHint,
}));

const ctrl = editorController();
let dispose: () => void;
beforeAll(() => {
  const lsp = registerLspActions();
  const inline = registerInlineCompletionActions();
  dispose = () => {
    inline();
    lsp();
  };
  ctrl.start();
});
afterAll(() => {
  ctrl.stop();
  dispose();
});
afterEach(() => {
  useTabs.setState(initialTabsState(), true);
  useEditorStatus.setState({ status: null });
  useContextKeys.setState({}, true);
  _setFocusedCellEditor(null);
  vi.clearAllMocks();
});

/** Mounts the text editor of an open tab (a background text tab, as in a split with a notebook). */
async function mountTextEditor(path = "/p/a.ts"): Promise<EditorView> {
  await ctrl.openFile(path, { focus: false });
  const slot = ctrl.activeSlot!;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = slot.mount(host);
  ctrl.onMounted(slot);
  return view;
}

/** A bare editor standing in for a focused notebook cell (the fact CellEditor publishes). */
function focusedCell(): { view: EditorView; clear: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({ doc: "x = 1\nprint(x)\n", parent: host });
  view.focus();
  if (!view.hasFocus) throw new Error("the jsdom view did not take focus");
  _setFocusedCellEditor(view);
  return {
    view,
    clear: () => {
      _setFocusedCellEditor(null);
      view.destroy();
      view.dom.remove();
    },
  };
}

describe("editor actions with a focused notebook cell", () => {
  it("run in the focused cell, not the last text tab", async () => {
    const textView = await mountTextEditor();
    const cell = focusedCell();
    setContext("projectOpen", true);
    try {
      ctrl.publishContext();
      expect(getContext().editorTextFocus).toBe(true);
      await executeAction("code.reformat");
      await executeAction("code.showIntentions");
      await executeAction("refactor.thisMenu");
      expect(formatDocument).toHaveBeenCalledWith(cell.view, { explicit: true });
      expect(showIntentions).toHaveBeenCalledWith(cell.view);
      expect(refactorThis).toHaveBeenCalledWith(cell.view, expect.any(Function));
      expect(showHint).not.toHaveBeenCalled();
      // The background text editor was not acted on (it is the view `activeEditor()` holds).
      expect(formatDocument).not.toHaveBeenCalledWith(textView, { explicit: true });
      expect(showIntentions).toHaveBeenCalledOnce();
    } finally {
      cell.clear();
      hostRemove(textView);
    }
  });

  it("keep running in the focused text editor when no cell editor is focused", async () => {
    const view = await mountTextEditor();
    setContext("projectOpen", true);
    view.focus();
    await vi.waitFor(() => expect(getContext().editorTextFocus).toBe(true));
    await executeAction("code.reformat");
    expect(formatDocument).toHaveBeenCalledWith(view, { explicit: true });
    expect(formatDocument).toHaveBeenCalledOnce();
  });

  it("target the focused cell for inline completion", async () => {
    const textView = await mountTextEditor();
    const cell = focusedCell();
    try {
      ctrl.publishContext();
      await executeAction("editor.inlineCompletion.trigger");
      await vi.waitFor(() => expect(showHint).toHaveBeenCalled());
      expect(showHint).toHaveBeenCalledWith(cell.view, expect.any(String));
      expect(showHint).not.toHaveBeenCalledWith(textView, expect.anything());
    } finally {
      cell.clear();
      hostRemove(textView);
    }
  });
});

function hostRemove(view: EditorView): void {
  const host = view.dom.parentElement;
  view.destroy();
  host?.remove();
}
