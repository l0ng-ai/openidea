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
