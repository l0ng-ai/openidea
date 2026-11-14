import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands, Location } from "@/platform/ipc";

const { lspGoto, lspGotoImplementation, cancelRequest } = vi.hoisted(() => ({
  lspGoto: vi.fn<typeof commands.lspGoto>(),
  lspGotoImplementation: vi.fn<typeof commands.lspGotoImplementation>(),
  cancelRequest: vi.fn<typeof commands.cancelRequest>(async () => {}),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  const fsReadText: typeof commands.fsReadText = async () => ({
    status: "error",
    error: { kind: "notFound", message: "not found" },
  });
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, lspGoto, lspGotoImplementation, cancelRequest, fsReadText },
  };
});
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<object>()),
  Channel: class {
    onmessage = () => {};
  },
}));

const files = await import("./files");
const { gotoTargets } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { useLspPopup, closePopup, openPopup } = await import("./popupStore");
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
  vi.restoreAllMocks();
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

  it("shows progress while the chooser's rows load after a quick answer, until the chooser opens", async () => {
    let finish!: (files: Map<string, string[]>) => void;
    vi.spyOn(files, "readManyFileLines").mockImplementationOnce(() => new Promise((r) => (finish = r)));
    lspGoto.mockResolvedValueOnce({ status: "ok", data: [at("/p/a.rs", 1), at("/p/b.rs", 2)] });
    const pending = gotoTargets(view, "definition");
    await vi.advanceTimersByTimeAsync(250);
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("Finding navigation target…");
    expect(listPopup()).toBeNull();
    finish(new Map());
    await pending;
    expect(listPopup()?.items).toHaveLength(2);
    expect(document.querySelector(".cm-lsp-hint")).toBeNull();
    closePopup();
  });

  it("shows progress while the first implementations' rows load, until the chooser opens", async () => {
    let finish!: (files: Map<string, string[]>) => void;
    vi.spyOn(files, "readManyFileLines").mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const search = slowImplementations();
    const pending = gotoTargets(view, "implementation");
    await vi.waitFor(() => expect(lspGotoImplementation).toHaveBeenCalled());
    search.first([at("/p/Own.java", 3)]);
    await vi.advanceTimersByTimeAsync(250);
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("Finding navigation target…");
    finish(new Map());
    await vi.waitFor(() => expect(listPopup()).not.toBeNull());
    expect(document.querySelector(".cm-lsp-hint")).toBeNull();
    search.resolve({ status: "ok", data: [at("/p/Own.java", 3), at("/p/Library.java", 8)] });
    await pending;
    closePopup();
  });

  it("replaces progress with the server error", async () => {
    const search = slowImplementations();
    const pending = gotoTargets(view, "implementation");
    await vi.advanceTimersByTimeAsync(250);
    search.resolve({ status: "error", error: { kind: "protocol", message: "Server timed out" } });
    await pending;
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("Server timed out");
    expect(openFile).not.toHaveBeenCalled();
  });
});

const at = (path: string, line: number): Location => ({
  path,
  range: { start: { line, col: 0 }, end: { line, col: 1 } },
  uri: null,
});

/** A Go to Implementation request answered when the test says: the first ones, then all. */
function slowImplementations() {
  let channel!: { onmessage: (locs: Location[]) => void };
  let resolve!: (result: Awaited<ReturnType<typeof commands.lspGotoImplementation>>) => void;
  lspGotoImplementation.mockImplementationOnce((_request, _doc, _pos, onPartial) => {
    channel = onPartial as unknown as typeof channel;
    return new Promise((r) => (resolve = r));
  });
  return {
    first: (locs: Location[]) => channel.onmessage(locs),
    resolve: (r: Parameters<typeof resolve>[0]) => resolve(r),
  };
}

const listPopup = () => {
  const popup = useLspPopup.getState().popup;
  return popup?.kind === "list" ? popup : null;
};

describe("Go to Implementation while the search goes on", () => {
  afterEach(() => {
    closePopup();
    cancelRequest.mockClear();
    lspGotoImplementation.mockReset();
  });

  it("opens the chooser with the implementations found first, then adds the rest", async () => {
    const search = slowImplementations();
    const pending = gotoTargets(view, "implementation");
    await vi.advanceTimersByTimeAsync(250);
    search.first([at("/p/Own.java", 3)]);
    await vi.waitFor(() => expect(listPopup()?.title).toBe("Choose Implementation of run (1 found, searching…)"));
    expect(listPopup()!.items.map((i) => i.label)).toEqual(["Own.java"]);
    expect(document.querySelector(".cm-lsp-hint")).toBeNull();

    search.resolve({ status: "ok", data: [at("/p/Library.java", 8), at("/p/Own.java", 3)] });
    await pending;
    expect(listPopup()?.title).toBe("Choose Implementation of run (2 found)");
    expect(listPopup()!.items.map((i) => i.label)).toEqual(["Own.java", "Library.java"]);
    expect(openFile).not.toHaveBeenCalled();
    expect(cancelRequest).not.toHaveBeenCalled();
  });

  it("cancels the search when the chooser closes", async () => {
    const search = slowImplementations();
    const pending = gotoTargets(view, "implementation");
    await vi.waitFor(() => expect(lspGotoImplementation).toHaveBeenCalled());
    search.first([at("/p/Own.java", 3)]);
    await vi.waitFor(() => expect(listPopup()).not.toBeNull());
    closePopup();
    expect(cancelRequest).toHaveBeenCalledExactlyOnceWith(lspGotoImplementation.mock.lastCall![0]);

    search.resolve({ status: "error", error: { kind: "cancelled", message: "cancelled" } });
    await pending;
    expect(listPopup()).toBeNull();
    expect(document.querySelector(".cm-lsp-hint")).toBeNull();
  });

  it("does not let a superseded implementation search replace a newer popup", async () => {
    const search = slowImplementations();
    const pending = gotoTargets(view, "implementation");
    await vi.waitFor(() => expect(lspGotoImplementation).toHaveBeenCalled());
    search.first([at("/p/Own.java", 3)]);
    await vi.waitFor(() => expect(listPopup()).not.toBeNull());
    lspGoto.mockResolvedValueOnce({ status: "ok", data: [at("/p/New.java", 2)] });
    await gotoTargets(view, "definition");
    openPopup({ kind: "list", anchor: { x: 0, y: 0 }, title: "Newer popup", items: [] });
    search.resolve({ status: "ok", data: [at("/p/Old.java", 8)] });
    await pending;
    expect(listPopup()?.title).toBe("Newer popup");
  });

  it("does not open a superseded chooser after its previews finish loading", async () => {
    let finish!: (files: Map<string, string[]>) => void;
    vi.spyOn(files, "readManyFileLines").mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const search = slowImplementations();
    const pending = gotoTargets(view, "implementation");
    await vi.waitFor(() => expect(lspGotoImplementation).toHaveBeenCalled());
    search.first([at("/p/Own.java", 3)]);
    lspGoto.mockResolvedValueOnce({ status: "ok", data: [at("/p/New.java", 2)] });
    await gotoTargets(view, "definition");
    openPopup({ kind: "list", anchor: { x: 0, y: 0 }, title: "Newer popup", items: [] });
    finish(new Map());
    await vi.advanceTimersByTimeAsync(0);
    expect(listPopup()?.title).toBe("Newer popup");
    search.resolve({ status: "ok", data: [at("/p/Old.java", 8)] });
    await pending;
    expect(listPopup()?.title).toBe("Newer popup");
  });

  it("goes to the only implementation when none came first", async () => {
    const search = slowImplementations();
    const pending = gotoTargets(view, "implementation");
    await vi.waitFor(() => expect(lspGotoImplementation).toHaveBeenCalled());
    search.resolve({ status: "ok", data: [at("/p/Library.java", 8)] });
    await pending;
    expect(listPopup()).toBeNull();
    expect(openFile).toHaveBeenCalledWith("/p/Library.java", { selection: { line: 8, col: 0 }, focus: true });
  });
});
