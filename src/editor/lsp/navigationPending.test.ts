import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands } from "@/platform/ipc";

const lspGoto = vi.hoisted(() => vi.fn<typeof commands.lspGoto>());
const indexGoto = vi.hoisted(() => vi.fn<typeof commands.indexGoto>());
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, lspGoto, indexGoto } };
});

const { gotoTargets, navigationExtension } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { provideEditorService } = await import("@/workbench/contributions");
const openFile = vi.fn(async () => {});
provideEditorService({ openFile } as never);

let view: EditorView;
beforeEach(() => {
  vi.useFakeTimers();
  openFile.mockClear();
  lspGoto.mockClear();
  indexGoto.mockClear();
  indexGoto.mockResolvedValue({ status: "ok", data: null });
  view = new EditorView({
    state: EditorState.create({
      doc: "run()",
      extensions: [
        lspDoc.of({ doc: 1, path: "/p/main.rs", language: "rust", uiMode: "Rust", readOnly: false }),
        navigationExtension(),
      ],
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

describe("⌘-hover link probing", () => {
  const target = { path: "/p/lib.rs", range: { start: { line: 3, col: 4 }, end: { line: 3, col: 7 } }, uri: null };
  /** ⌘-hover over the word at `pos` (jsdom has no layout, so the position is stubbed). */
  const hover = (pos = 0) => {
    vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
    view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, metaKey: true }));
  };

  it("underlines from the project index without a server round-trip", async () => {
    indexGoto.mockResolvedValueOnce({ status: "ok", data: { targets: [target], note: "certain" } });
    hover();
    await vi.advanceTimersByTimeAsync(50);
    expect(view.dom.querySelector(".cm-lsp-link")?.textContent).toBe("run");
    expect(indexGoto).toHaveBeenCalledExactlyOnceWith(1, { line: 0, col: 0 }, "run");
    expect(lspGoto).not.toHaveBeenCalled();
  });

  it("keeps probing the server when the index cannot answer", async () => {
    lspGoto.mockResolvedValueOnce({ status: "ok", data: [] });
    hover();
    await vi.advanceTimersByTimeAsync(50);
    expect(indexGoto).toHaveBeenCalledExactlyOnceWith(1, { line: 0, col: 0 }, "run");
    expect(lspGoto).toHaveBeenCalledExactlyOnceWith(1, { line: 0, col: 0 }, "definition");
    expect(view.dom.querySelector(".cm-lsp-link")).toBeNull();
  });
});
