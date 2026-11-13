import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Prec, Text } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { _emitEditorEvent, _provideCodePreview, _provideDocumentAttacher, setLibraryRoots } from "@/editor/api";
import { createMemoryBackend } from "@/editor/core/backend";
import { previewExtensions } from "@/editor/core/cm/preview";
import { attachDocument } from "@/editor/core/model/attachment";
import { DocumentManager, useDocMeta } from "@/editor/core/model/document";
import { EditorSlot, type SlotHost } from "@/editor/core/model/slot";

let manager: DocumentManager;
let backend: ReturnType<typeof createMemoryBackend>;
const commandKey = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
const path = "/p/a.txt";
const original = "fun a() {}\nval order = 1\norder()\n";
const host: SlotHost = {
  onFocus: () => {},
  onBlur: () => {},
  onSelection: () => {},
  onUserEdit: () => {},
  onContextMenu: () => {},
};
beforeEach(() => {
  backend = createMemoryBackend({ [path]: original });
  manager = new DocumentManager(backend, { settings: () => ({ files: { autoSave: false } }), notify: vi.fn() });
  manager.start();
  _provideDocumentAttacher((path, options) => attachDocument(manager, path, options));
  _provideCodePreview((path, editable) => previewExtensions(path, undefined, undefined, editable));
});
afterEach(() => {
  cleanup();
  for (const model of manager.byPath.values()) {
    model.setMeta({ dirty: false });
    _emitEditorEvent({ type: "docSaved", path: model.path, doc: model.doc });
    for (const slot of model.slots) slot.dispose();
  }
  manager.stop();
  _provideDocumentAttacher(null);
  _provideCodePreview(null);
  useDocMeta.setState({}, true);
});

async function preview(container: HTMLElement): Promise<EditorView> {
  await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
  let view: EditorView | null = null;
  await waitFor(() => {
    const content = container.querySelector<HTMLElement>(".cm-content");
    expect(content?.textContent).toContain("order");
    view = EditorView.findFromDOM(content!);
    expect(view).toBeTruthy();
  });
  return view!;
}

const { CodePreview, previewDecorations } = await import("../find/parts");

describe("CodePreview", () => {
  it("marks matches and the current line", () => {
    const doc = Text.of(["ab", "order order", "x"]);
    const set = previewDecorations(doc, 1, [
      {
        line: 1,
        ranges: [
          [0, 5],
          [6, 11],
        ],
      },
      { line: 2, ranges: [[0, 9]] },
      { line: 7, ranges: [[0, 1]] },
    ]);
    const out: string[] = [];
    set.between(0, doc.length, (from, to, d) => {
      out.push(`${from}-${to}:${(d.spec as { class: string }).class}`);
    });
    expect(out).toEqual([
      "3-3:cm-activeLine",
      "3-8:cm-openidea-searchResult",
      "9-14:cm-openidea-searchResult",
      "15-16:cm-openidea-searchResult",
    ]);
  });

  it("shows the file editable in an editor view with the matches highlighted", async () => {
    const { container } = render(<CodePreview path={path} line={1} highlights={[{ line: 1, ranges: [[4, 9]] }]} />);
    await preview(container);
    expect(container.querySelector(".cm-content")?.textContent).toContain("val order = 1");
    expect(container.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    expect(container.querySelector(".cm-openidea-searchResult")?.textContent).toBe("order");
  });

  it("nests matches inside syntax token spans, as find matches in an editor tab", async () => {
    // Like the syntax highlighter: a `Prec.high` mark with its own colour over "order".
    const token = Prec.high(
      EditorView.decorations.of(Decoration.set(Decoration.mark({ class: "token" }).range(15, 20))),
    );
    _provideCodePreview(async (path, editable) => [
      await previewExtensions(path, undefined, undefined, editable),
      token,
    ]);
    const { container } = render(<CodePreview path={path} line={1} highlights={[{ line: 1, ranges: [[4, 9]] }]} />);
    await preview(container);
    expect(container.querySelector(".token .cm-openidea-searchResult")?.textContent).toBe("order");
  });

  it.each([false, true])("shares edits, document undo and save with a tab (mounted: %s)", async (mounted) => {
    const model = await manager.acquire(path);
    const tab = new EditorSlot(model, "tab", host);
    if (mounted) tab.mount(document.createElement("div"));
    const { container, unmount } = render(
      <CodePreview path={path} line={1} highlights={[{ line: 1, ranges: [[4, 9]] }]} />,
    );
    const view = await preview(container);
    act(() => view.dispatch({ changes: { from: 0, insert: "// 😀\n" }, userEvent: "input.type" }));
    expect(tab.currentState().doc.toString()).toBe("// 😀\n" + original);
    expect(model.getMeta().dirty).toBe(true);
    expect(view.state.doc.lineAt(view.posAtDOM(container.querySelector(".cm-openidea-searchResult")!)).number).toBe(3);
    // The tab's Undo removes preview typing; the preview follows immediately.
    act(() => {
      undo({ state: tab.currentState(), dispatch: (tr) => tab.dispatchLocal(tr) });
    });
    expect(view.state.doc.toString()).toBe(original);
    act(() => {
      view.focus();
      fireEvent.keyDown(view.contentDOM, { key: "z", code: "KeyZ", keyCode: 90, ...commandKey, shiftKey: true });
    });
    expect(view.state.doc.toString()).toBe("// 😀\n" + original);
    act(() => fireEvent.keyDown(view.contentDOM, { key: "s", code: "KeyS", keyCode: 83, ...commandKey }));
    await waitFor(() => expect(model.getMeta().dirty).toBe(false));
    expect(backend.docs.get(model.doc)?.text).toBe(view.state.doc.toString());
    unmount();
    tab.dispose();
  });

  it("keeps dirty text and undo when the preview closes and reopens without a tab", async () => {
    const first = render(<CodePreview path={path} line={1} highlights={[]} />);
    const view = await preview(first.container);
    act(() => view.dispatch({ changes: { from: 0, insert: "edited\n" }, userEvent: "input.type" }));
    first.unmount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(manager.get(path)?.sync.localText.toString()).toBe("edited\n" + original);
    const second = render(<CodePreview path={path} line={1} highlights={[]} />);
    const reopened = await preview(second.container);
    expect(reopened.state.doc.toString()).toBe("edited\n" + original);
    act(() => {
      reopened.focus();
      fireEvent.keyDown(reopened.contentDOM, { key: "z", code: "KeyZ", keyCode: 90, ...commandKey });
    });
    expect(reopened.state.doc.toString()).toBe(original);
  });

  it("hands undo history to a newly opened tab and back when the tab closes", async () => {
    const { container } = render(<CodePreview path={path} line={1} highlights={[]} />);
    const view = await preview(container);
    act(() => view.dispatch({ changes: { from: 0, insert: "preview\n" }, userEvent: "input.type" }));
    const model = manager.get(path)!;
    let tab: EditorSlot;
    act(() => {
      tab = new EditorSlot(model, "new-tab", host);
    });
    act(() => undo({ state: tab!.currentState(), dispatch: (tr) => tab!.dispatchLocal(tr) }));
    expect(view.state.doc.toString()).toBe(original);
    act(() => redo({ state: tab!.currentState(), dispatch: (tr) => tab!.dispatchLocal(tr) }));
    act(() => tab!.dispose());
    act(() => {
      view.focus();
      fireEvent.keyDown(view.contentDOM, { key: "z", code: "KeyZ", keyCode: 90, ...commandKey });
    });
    expect(view.state.doc.toString()).toBe(original);
  });

  it("tracks tab edits and history while the dirty preview is unmounted", async () => {
    const model = await manager.acquire(path);
    const tab = new EditorSlot(model, "tab", host);
    const first = render(<CodePreview path={path} line={1} highlights={[]} />);
    const view = await preview(first.container);
    act(() => view.dispatch({ changes: { from: 0, insert: "preview\n" }, userEvent: "input.type" }));
    first.unmount();
    tab.dispatchLocal({ changes: { from: 0, insert: "tab\n" }, userEvent: "input.type" });
    tab.dispose();
    const second = render(<CodePreview path={path} line={1} highlights={[]} />);
    const restored = await preview(second.container);
    expect(restored.state.doc.toString()).toBe("tab\npreview\n" + original);
    act(() =>
      fireEvent(
        restored.contentDOM,
        new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true }),
      ),
    );
    expect(restored.state.doc.toString()).toBe(original);
  });

  it.each(["library", "archive", "binary", "large", "file"])("keeps %s documents read-only", async (kind) => {
    const clearRoots = kind === "library" ? setLibraryRoots("preview-test", ["/p"]) : () => {};
    const open = backend.open.bind(backend);
    vi.spyOn(backend, "open").mockImplementation(async (...args) => ({
      ...(await open(...args)),
      readOnly: kind !== "library",
      ...(kind === "large" ? { large: true } : {}),
    }));
    try {
      const { container } = render(<CodePreview path={path} line={1} highlights={[]} />);
      const view = await preview(container);
      expect(view.state.readOnly).toBe(true);
      expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
      act(() => view.dispatch({ changes: { from: 0, insert: "bad" }, userEvent: "input.type" }));
      expect(view.state.doc.toString()).toBe(original);
      expect(manager.get(path)?.getMeta().dirty).toBe(false);
    } finally {
      clearRoots();
    }
  });

  it("Enter inserts a newline; editing keys stay out of the results; Escape bubbles", async () => {
    const parentKey = vi.fn();
    const { container } = render(
      <div onKeyDown={parentKey}>
        <CodePreview path={path} line={0} highlights={[]} />
      </div>,
    );
    const view = await preview(container);
    act(() => {
      view.focus();
      fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter" });
    });
    expect(view.state.doc.lines).toBe(Text.of(original.split("\n")).lines + 1);
    act(() => fireEvent.keyDown(view.contentDOM, { key: "Backspace", code: "Backspace" }));
    expect(parentKey).not.toHaveBeenCalled();
    act(() => fireEvent.keyDown(view.contentDOM, { key: "Escape", code: "Escape" }));
    expect(parentKey).toHaveBeenCalledTimes(1);
  });
});
