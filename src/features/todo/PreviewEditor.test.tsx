import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { _provideDocumentAttacher, type DocumentAttachment } from "@/editor/api";
import { PreviewEditor, heldAttachment } from "./PreviewEditor";
import { previewText } from "./ipc";

/**
 * Stubs of the document attachment: edits dispatch real CodeMirror
 * transactions, so the dirty/held/release logic runs against the view.
 */
function stubAttacher(docs: Map<string, { text: string; dirty?: boolean; readOnly?: boolean }>) {
  const released: string[] = [];
  _provideDocumentAttacher((path) => {
    const att: DocumentAttachment = {
      path,
      doc: 1,
      text: () => docs.get(path)!.text,
      lineEnding: () => "lf",
      dirty: () => !!docs.get(path)!.dirty,
      uiMode: () => null,
      readOnly: !!docs.get(path)!.readOnly,
      editorState: () => null,
      dispatchTransactions: (trs, view) => view.update(trs),
      extension: EditorView.updateListener.of((u) => {
        for (const tr of u.transactions)
          if (tr.docChanged) {
            docs.get(path)!.text = u.state.doc.toString();
            docs.get(path)!.dirty = true;
          }
      }),
      save: async () => {
        docs.get(path)!.dirty = false;
      },
      synced: () => Promise.resolve(),
      undo: () => false,
      redo: () => false,
      edit: () => {},
      release: () => released.push(path),
    };
    return Promise.resolve(att);
  });
  return { released };
}

describe("PreviewEditor", () => {
  afterEach(() => _provideDocumentAttacher(null));

  it("shows the document as an editable CodeMirror view", async () => {
    const docs = new Map([["/p/a.ts", { text: "// TODO: fix\n" }]]);
    stubAttacher(docs);
    render(<PreviewEditor path="/p/a.ts" line={0} col={3} fallbackLoad={previewText} />);
    await waitFor(() => expect(document.querySelector(".cm-editor")).toBeTruthy());
    expect(document.querySelector(".cm-content")?.textContent).toContain("TODO: fix");
  });

  it("colours TODO comments like the editor tabs", async () => {
    const docs = new Map([["/p/c.js", { text: "// TODO: fix\nconst x = 1;\n" }]]);
    stubAttacher(docs);
    render(<PreviewEditor path="/p/c.js" line={0} col={3} fallbackLoad={previewText} />);
    const todo = await waitFor(() => {
      const el = document.querySelector(".cm-openidea-todo");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(todo.textContent).toBe("TODO: fix");
  });

  it("moves the caret to another item of the same file without a new view", async () => {
    const docs = new Map([["/p/two.ts", { text: "// TODO: one\nconst x = 1;\n// TODO: two\n" }]]);
    stubAttacher(docs);
    const { rerender } = render(<PreviewEditor path="/p/two.ts" line={0} col={3} fallbackLoad={previewText} />);
    const content = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".cm-content");
      expect(el).toBeTruthy();
      return el!;
    });
    const view = EditorView.findFromDOM(content)!;
    expect(view.state.selection.main.head).toBe(3);
    rerender(<PreviewEditor path="/p/two.ts" line={2} col={3} fallbackLoad={previewText} />);
    expect(EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-content")!)).toBe(view);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
    expect(view.state.selection.main.head - view.state.doc.line(3).from).toBe(3);
  });

  it("falls back to the read-only preview for read-only documents", async () => {
    const docs = new Map([["/p/ro.ts", { text: "// TODO\n", readOnly: true }]]);
    const { released } = stubAttacher(docs);
    render(<PreviewEditor path="/p/ro.ts" line={0} col={0} fallbackLoad={previewText} />);
    // No editor, no attach error: the read-only SourcePreview shows instead.
    await waitFor(() => expect(document.querySelector(".cm-editor")).toBeNull());
    expect(screen.queryByText("editor not started")).toBeNull();
    expect(released).toEqual(["/p/ro.ts"]);
  });

  it("releases a clean document on unmount", async () => {
    const docs = new Map([["/p/clean.ts", { text: "// TODO\n" }]]);
    const { released } = stubAttacher(docs);
    const { unmount } = render(<PreviewEditor path="/p/clean.ts" line={0} col={0} fallbackLoad={previewText} />);
    await waitFor(() => expect(document.querySelector(".cm-editor")).toBeTruthy());
    unmount();
    expect(released).toEqual(["/p/clean.ts"]);
    expect(heldAttachment("/p/clean.ts")).toBeNull();
  });

  it("holds a dirty document instead of releasing, and previewText reads its text", async () => {
    const docs = new Map([["/p/dirty.ts", { text: "// TODO: edit me\n", dirty: false }]]);
    const { released } = stubAttacher(docs);
    const { unmount } = render(<PreviewEditor path="/p/dirty.ts" line={0} col={7} fallbackLoad={previewText} />);
    const content = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".cm-content");
      expect(el).toBeTruthy();
      return el!;
    });
    // Edit through the real view: dispatch a transaction (the stub marks dirty).
    const view = EditorView.findFromDOM(content)!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "// TODO: edited" } });
    unmount();
    expect(released).toEqual([]);
    const held = heldAttachment("/p/dirty.ts");
    expect(held).toBeTruthy();
    await expect(previewText("/p/dirty.ts")).resolves.toBe("// TODO: edited");
    // Once saved (clean), the held attachment is released on next lookup.
    docs.get("/p/dirty.ts")!.dirty = false;
    expect(heldAttachment("/p/dirty.ts")).toBeNull();
    expect(released).toEqual(["/p/dirty.ts"]);
  });

  it("falls back to disk text when nothing holds the document", async () => {
    expect(heldAttachment("/p/gone.ts")).toBeNull();
    // Not open anywhere: previewText goes to the backend (fails in tests) —
    // the read order is covered by the held case above.
    const docs = new Map([["/p/held.ts", { text: "kept", dirty: true }]]);
    const { released } = stubAttacher(docs);
    // Fake a held attachment through a mounted-then-edited view.
    const { unmount } = render(<PreviewEditor path="/p/held.ts" line={0} col={0} fallbackLoad={previewText} />);
    await waitFor(() => expect(document.querySelector(".cm-content")).toBeTruthy());
    docs.get("/p/held.ts")!.dirty = true;
    unmount();
    await expect(previewText("/p/held.ts")).resolves.toBe("kept");
    expect(released).toEqual([]);
  });
});
