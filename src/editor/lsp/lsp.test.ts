import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, documentSynced, type EditorDocContext } from "@/editor/api";

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true };
});

const { lspRequest, reportLspError } = await import("./lsp");
const { IpcError } = await import("@/platform/ipc");

describe("lspRequest", () => {
  it("waits until open editors' edits reached the backend", async () => {
    let synced!: () => void;
    const pending = new Promise<void>((r) => (synced = r));
    const view = new EditorView({ state: EditorState.create({ extensions: documentSynced.of(() => pending) }) });
    const handle = { view, ctx: {} as EditorDocContext };
    _addEditor(handle);
    const run = vi.fn(async () => ({ status: "ok" as const, data: 1 }));
    const result = lspRequest(run);
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    synced();
    expect(await result).toBe(1);
    _removeEditor(handle);
    view.destroy();
  });
});

describe("reportLspError", () => {
  const unavailable = (message: string) => new IpcError({ kind: "unavailable", message });
  const hintText = () => document.querySelector(".cm-lsp-hint")?.textContent ?? null;

  it.each([
    ["jdtls doesn't support type hierarchy", "jdtls doesn't support type hierarchy"],
    ["pyright, ruff doesn't support code lens", "pyright, ruff doesn't support code lens"],
    ["no running language server supports rename", "No language server available"],
    ["jdtls is not running", "No language server available"],
  ])("explicit %s → %s", (message, shown) => {
    const view = new EditorView({ state: EditorState.create({ doc: "x" }), parent: document.body });
    reportLspError(view, unavailable(message), true);
    expect(hintText()).toBe(shown);
    view.destroy();
  });

  it("stays silent for background requests", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "x" }), parent: document.body });
    reportLspError(view, unavailable("jdtls doesn't support inlay hints"), false);
    expect(hintText()).toBeNull();
    view.destroy();
  });
});
