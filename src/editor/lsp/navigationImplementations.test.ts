import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands, Location, OutlineItem } from "@/platform/ipc";

// Python has no type hierarchy server: the IDE's inheritance graph answers implementations.
const graph = vi.hoisted(() => [
  { path: "/p/order.py", line: 0, col: 6, name: "Order", bases: [] },
  { path: "/p/online.py", line: 0, col: 6, name: "OnlineOrder", bases: ["Order"] },
]);
// The project index is the production entry: build one from the graph above so the
// tests never reach the IPC the real fetch needs.
vi.mock("@/editor/navigation/inheritanceGraph", async (orig) => {
  const real = await orig<typeof import("@/editor/navigation/inheritanceGraph")>();
  const index = real.inheritanceIndex(graph, { readFiles: async () => new Map() });
  const subclasses = await real.subclassMap(index);
  return {
    ...real,
    pythonInheritanceGraph: async () => graph,
    projectPythonIndex: async () => ({ classes: graph, index, subclasses: async () => subclasses }),
  };
});

const { lspGotoImplementation, docOutline, fsReadText } = vi.hoisted(() => ({
  lspGotoImplementation: vi.fn<typeof commands.lspGotoImplementation>(),
  docOutline: vi.fn<typeof commands.docOutline>(),
  fsReadText: vi.fn<typeof commands.fsReadText>(async () => ({
    status: "error",
    error: { kind: "notFound", message: "not found" },
  })),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, lspGotoImplementation, docOutline, fsReadText },
  };
});
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<object>()),
  Channel: class {
    onmessage = () => {};
  },
}));

const { gotoTargets } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { useLspPopup, closePopup } = await import("./popupStore");
const { provideEditorService } = await import("@/workbench/contributions");
const openFile = vi.fn(async () => {});
provideEditorService({ openFile } as never);

const range = (line: number, col: number) => ({ start: { line, col }, end: { line, col } });
const at = (path: string, line: number): Location => ({
  path,
  range: { start: { line, col: 0 }, end: { line, col: 1 } },
});

// class Order:
//     def save(self):
const OUTLINE: OutlineItem[] = [
  {
    name: "Order",
    detail: null,
    kind: "class",
    range: { start: { line: 0, col: 0 }, end: { line: 2, col: 8 } },
    selection_range: range(0, 6),
    children: [
      {
        name: "save",
        detail: null,
        kind: "method",
        range: { start: { line: 1, col: 4 }, end: { line: 2, col: 8 } },
        selection_range: range(1, 8),
        children: [],
      },
    ],
  },
];

let view: EditorView;
beforeEach(() => {
  vi.clearAllMocks();
  docOutline.mockResolvedValue({ status: "ok", data: OUTLINE });
  lspGotoImplementation.mockResolvedValue({ status: "ok", data: [] });
  view = new EditorView({
    state: EditorState.create({
      doc: "class Order:\n    def save(self):\n        pass\n",
      extensions: [lspDoc.of({ doc: 1, path: "/p/order.py", language: "python", uiMode: "Python", readOnly: false })],
    }),
    parent: document.body,
  });
  view.dispatch({ selection: { anchor: 6 } });
});
afterEach(() => {
  closePopup();
  view.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Go to Implementation on Python", () => {
  it("answers from the IDE's inheritance graph when the server finds none", async () => {
    await gotoTargets(view, "implementation");
    expect(openFile).toHaveBeenCalledWith("/p/online.py", { selection: { line: 0, col: 6 }, focus: true });
    expect(lspGotoImplementation).toHaveBeenCalledOnce();
  });

  it("merges the graph's implementations with the server's answer", async () => {
    lspGotoImplementation.mockResolvedValue({ status: "ok", data: [at("/p/other.py", 3)] });
    await gotoTargets(view, "implementation");
    const popup = useLspPopup.getState().popup;
    expect(popup?.kind).toBe("list");
    expect(popup?.kind === "list" ? popup.items : []).toHaveLength(2);
    expect(popup?.kind === "list" ? popup.title : null).toBe("Choose Implementation of Order (2 found)");
    expect(openFile).not.toHaveBeenCalled();
  });

  it("falls back to the graph when the server has no type hierarchy", async () => {
    lspGotoImplementation.mockResolvedValue({
      status: "error",
      error: { kind: "unavailable", message: "no type hierarchy" },
    });
    await gotoTargets(view, "implementation");
    expect(openFile).toHaveBeenCalledWith("/p/online.py", { selection: { line: 0, col: 6 }, focus: true });
  });
});
