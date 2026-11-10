import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeAction, Location } from "@/bindings";

const ipc = vi.hoisted(() => ({
  lspResolveCodeAction: vi.fn(),
  lspExecuteCodeAction: vi.fn(),
}));
const openFile = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
vi.mock("@/editor/api", async (orig) => ({
  ...(await orig<typeof import("@/editor/api")>()),
  whenAllSynced: async () => {},
}));
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  editorService: () => ({ openFile }),
}));

const { applyCodeAction } = await import("./intentions");
const { lspDoc } = await import("./lsp");

const open: Location = {
  path: "/p/app/Http/Controllers/DreamController.php",
  range: { start: { line: 11, col: 8 }, end: { line: 11, col: 10 } },
};
const action: CodeAction = {
  title: "Create invokable controller 'DreamController'",
  kind: "quickfix",
  server: 3,
  isPreferred: true,
  disabledReason: null,
  edit: { files: [], preconditions: [] },
  command: null,
  data: null,
  open,
};

const view = () =>
  new EditorView({
    state: EditorState.create({
      doc: "<?php\nRoute::get('123', 'dream');\n",
      extensions: [lspDoc.of({ doc: 7, path: "/p/routes/web.php", language: "php" } as never)],
    }),
  });

afterEach(() => vi.clearAllMocks());

describe("applying a code action that names a location", () => {
  it("opens the location the applied action returns, its range selected", async () => {
    ipc.lspExecuteCodeAction.mockResolvedValue({ status: "ok", data: { created: [], open } });
    const v = view();
    await applyCodeAction(v, action);
    expect(ipc.lspResolveCodeAction).not.toHaveBeenCalled();
    expect(ipc.lspExecuteCodeAction.mock.calls[0]!.slice(1)).toEqual([7, action, []]);
    expect(openFile).toHaveBeenCalledWith(open.path, { selection: { line: 11, col: 8, endLine: 11, endCol: 10 } });
    v.destroy();
  });

  it("opens the first created file when the action names no location", async () => {
    ipc.lspExecuteCodeAction.mockResolvedValue({ status: "ok", data: { created: ["/p/probe_test.go"], open: null } });
    const v = view();
    await applyCodeAction(v, { ...action, open: null });
    expect(openFile).toHaveBeenCalledWith("/p/probe_test.go");
    v.destroy();
  });
});
