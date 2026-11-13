import { afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeLenses } from "@/editor/api";
const ipc = vi.hoisted(() => ({
  lspCodeLens: vi.fn(),
  lspExecuteCommand: vi.fn(async () => ({ status: "ok", data: null })),
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: { ...(await original<typeof import("@/platform/ipc")>()).commands, ...ipc },
}));
const { serverCodeLenses } = await import("./serverCodeLens");
const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("renders LSP and plugin lens commands in the shared facet and invokes their commands", async () => {
  vi.useFakeTimers();
  const command = { title: "Run fixture", command: "openidea.plugin-language:p:run", arguments: ['"lens"'] };
  ipc.lspCodeLens.mockResolvedValue({
    status: "ok",
    data: [{ range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } }, command }],
  });
  const view = new EditorView({
    state: EditorState.create({
      doc: "x",
      extensions: serverCodeLenses({ doc: 1, path: "/p/a", language: "text", uiMode: null, readOnly: false }),
    }),
    parent: document.body,
  });
  views.push(view);
  await vi.advanceTimersByTimeAsync(400);
  const lenses = view.state.facet(codeLenses);
  expect(lenses.map((l) => l.title)).toEqual(["Run fixture"]);
  lenses[0]!.run!(view, new MouseEvent("click"));
  expect(ipc.lspExecuteCommand).toHaveBeenCalledWith(1, command);
});

it("keeps mapped lenses across edits instead of clearing them (#2710)", async () => {
  vi.useFakeTimers();
  ipc.lspCodeLens.mockResolvedValue({
    status: "ok",
    data: [
      {
        range: { start: { line: 1, col: 0 }, end: { line: 1, col: 3 } },
        command: { title: "Run test", command: "csharp.runTest", arguments: [] },
      },
    ],
  });
  const view = new EditorView({
    state: EditorState.create({
      doc: "a\nfoo\nb",
      extensions: serverCodeLenses({ doc: 1, path: "/p/a.cs", language: "csharp", uiMode: null, readOnly: false }),
    }),
    parent: document.body,
  });
  views.push(view);
  await vi.advanceTimersByTimeAsync(400);
  const before = view.state.facet(codeLenses);
  expect(before).toHaveLength(1);
  const posBefore = before[0]!.pos;
  // Insert a line above the lens — clearing on edit used to drop the block widget and jump scroll.
  view.dispatch({ changes: { from: 0, insert: "\n" } });
  const after = view.state.facet(codeLenses);
  expect(after).toHaveLength(1);
  expect(after[0]!.pos).toBe(posBefore + 1);
  expect(after[0]!.title).toBe("Run test");
});

it("leaves reference counts to Code Vision's usages", async () => {
  vi.useFakeTimers();
  const lens = (line: number, title: string) => ({
    range: { start: { line, col: 0 }, end: { line, col: 1 } },
    command: { title, command: "csharp.showReferences", arguments: [] },
  });
  ipc.lspCodeLens.mockResolvedValue({
    status: "ok",
    data: [lens(0, "3 Reference(s)"), lens(1, "1 reference"), lens(2, "12 references"), lens(3, "2 implementations")],
  });
  const view = new EditorView({
    state: EditorState.create({
      doc: "a\nb\nc\nd",
      extensions: serverCodeLenses({ doc: 1, path: "/p/a.cs", language: "csharp", uiMode: null, readOnly: false }),
    }),
    parent: document.body,
  });
  views.push(view);
  await vi.advanceTimersByTimeAsync(400);
  expect(view.state.facet(codeLenses).map((l) => l.title)).toEqual(["2 implementations"]);
});
