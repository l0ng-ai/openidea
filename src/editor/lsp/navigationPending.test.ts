import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands } from "@/platform/ipc";

const lspGoto = vi.hoisted(() => vi.fn<typeof commands.lspGoto>());
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, lspGoto } };
});

const { gotoTargets } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { provideEditorService } = await import("@/workbench/contributions");
const openFile = vi.fn(async () => {});
provideEditorService({ openFile } as never);

let view: EditorView;
beforeEach(() => {
  vi.useFakeTimers();
  openFile.mockClear();
  view = new EditorView({
    state: EditorState.create({
      doc: "run()",
      extensions: [lspDoc.of({ doc: 1, path: "/p/main.rs", language: "rust", uiMode: "Rust", readOnly: false })],
    }),
    parent: document.body,
  });
});
afterEach(() => {
  view.destroy();
  vi.useRealTimers();
});

describe("slow navigation feedback", () => {
  it("shows progress while finding a definition, then opens the target and clears the hint", async () => {
    let resolve!: (result: Awaited<ReturnType<typeof commands.lspGoto>>) => void;
    lspGoto.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const pending = gotoTargets(view, "definition");
    await vi.advanceTimersByTimeAsync(250);
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("Finding navigation target…");
    expect(openFile).not.toHaveBeenCalled();
    resolve({
      status: "ok",
      data: [{ path: "/p/lib.rs", range: { start: { line: 3, col: 4 }, end: { line: 3, col: 7 } }, uri: null }],
    });
    await pending;
    expect(openFile).toHaveBeenCalledWith("/p/lib.rs", { selection: { line: 3, col: 4 }, focus: true });
    expect(document.querySelector(".cm-lsp-hint")).toBeNull();
  });

  it("replaces progress with the server error", async () => {
    let resolve!: (result: Awaited<ReturnType<typeof commands.lspGoto>>) => void;
    lspGoto.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const pending = gotoTargets(view, "implementation");
    await vi.advanceTimersByTimeAsync(250);
    resolve({ status: "error", error: { kind: "protocol", message: "Server timed out" } });
    await pending;
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("Server timed out");
    expect(openFile).not.toHaveBeenCalled();
  });
});
