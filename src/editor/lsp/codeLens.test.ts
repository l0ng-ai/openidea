import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { OutlineItem, References } from "@/platform/ipc";
import { _addEditor, _removeEditor, codeLenses, documentSynced } from "@/editor/api";

const ipc = vi.hoisted(() => ({
  docOutline: vi.fn(),
  lspReferences: vi.fn(),
  cancelRequest: vi.fn<(id: number) => Promise<void>>(async () => {}),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
const executeAction = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/platform/actions", () => ({ executeAction }));

const { lensTargets, usagesLensExtension } = await import("./codeLens");
const { lspDoc } = await import("./lsp");
const { useProject } = await import("@/platform/project");
const { emitLocalIdeEvent } = await import("@/platform/ipc");

const ctx = { doc: 7, path: "/p/a.rs", language: "rust", uiMode: "Rust", readOnly: false };
const views: EditorView[] = [];
const ok = <T>(data: T) => ({ status: "ok" as const, data });
const refs = (n: number, incomplete: References["incomplete"] = null) =>
  ok({
    locations: Array.from({ length: n }, () => ({ path: "/p/b.rs", range: item("x", "function", 0).range })),
    incomplete,
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function editor(count = 1, sync?: () => Promise<void>) {
  const view = new EditorView({
    state: EditorState.create({
      doc: Array.from({ length: count }, (_, i) => `fn f${i}() {}`).join("\n"),
      extensions: [lspDoc.of(ctx), usagesLensExtension(), ...(sync ? [documentSynced.of(sync)] : [])],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

const titles = (view: EditorView) => view.state.facet(codeLenses).map((l) => l.title);
const settle = () => vi.advanceTimersByTimeAsync(1000);

beforeEach(() => {
  vi.useFakeTimers();
  ipc.docOutline.mockReset().mockResolvedValue(ok([item("f0", "function", 0)]));
  ipc.lspReferences.mockReset().mockResolvedValue(refs(2));
  ipc.cancelRequest.mockClear();
  executeAction.mockClear();
  useProject.setState({
    settings: { editor: { inlay: { codeVisionUsages: true, codeVisionAuthor: false } } } as never,
  });
});

afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  useProject.setState({ settings: null });
  vi.useRealTimers();
});

const item = (name: string, kind: OutlineItem["kind"], line: number, children: OutlineItem[] = []): OutlineItem => {
  const r = { start: { line, col: 0 }, end: { line, col: 1 } };
  return { name, kind, detail: null, range: r, selection_range: r, children };
};

describe("usages lens targets", () => {
  it("skips callbacks and anonymous functions", () => {
    const items = [
      item("Cart", "class", 0, [
        item("count", "method", 1, [item("reduce() callback", "function", 2)]),
        item("<function>", "function", 3),
      ]),
    ];
    expect(lensTargets(items).map((t) => t.name)).toEqual(["Cart", "count"]);
  });
});

describe("background usage counts", () => {
  it("uses the server's existing scope and leaves full searches to the explicit action", async () => {
    const view = editor();
    await settle();
    expect(ipc.lspReferences).toHaveBeenCalledWith(expect.any(Number), 7, { line: 0, col: 0 }, false, false);
    expect(titles(view)).toEqual(["2 usages"]);
    view.state.facet(codeLenses)[0]!.run!(view, new MouseEvent("click"));
    expect(executeAction).toHaveBeenCalledWith("find.showUsages");
  });

  it("allows a full search even when the server's current scope has no usages", async () => {
    ipc.lspReferences.mockResolvedValue(refs(0));
    const view = editor();
    await settle();
    expect(titles(view)).toEqual(["no usages"]);
    view.state.facet(codeLenses)[0]!.run!(view, new MouseEvent("click"));
    expect(executeAction).toHaveBeenCalledWith("find.showUsages");
  });

  it("does not cache an incomplete count while indexing, and retries on server refresh", async () => {
    ipc.lspReferences.mockResolvedValueOnce(refs(0, "indexing"));
    const view = editor();
    await settle();
    expect(titles(view)).toEqual([]);
    emitLocalIdeEvent({ type: "lspRefresh", kind: "codeLens", server: 1 });
    await settle();
    expect(ipc.lspReferences).toHaveBeenCalledTimes(2);
    expect(titles(view)).toEqual(["2 usages"]);
  });

  it("cancels obsolete requests immediately on edits and ignores their late replies", async () => {
    const old = deferred<ReturnType<typeof refs>>();
    ipc.lspReferences.mockReturnValueOnce(old.promise);
    const view = editor();
    await settle();
    const request = ipc.lspReferences.mock.calls[0]![0];
    view.dispatch({ changes: { from: view.state.doc.length, insert: " " } });
    expect(ipc.cancelRequest).toHaveBeenCalledWith(request);
    await settle();
    expect(titles(view)).toEqual(["2 usages"]);
    old.resolve(refs(99));
    await settle();
    expect(titles(view)).toEqual(["2 usages"]);
  });

  it("retries incomplete counts when indexing ends without a code-lens refresh", async () => {
    ipc.lspReferences.mockResolvedValueOnce(refs(0, "indexing"));
    const view = editor();
    emitLocalIdeEvent({ type: "languageServer", server: 1, name: "rust-analyzer", status: "busy", message: null });
    await settle();
    expect(titles(view)).toEqual([]);
    await settle();
    emitLocalIdeEvent({ type: "languageServer", server: 1, name: "rust-analyzer", status: "ready", message: null });
    await settle();
    expect(ipc.lspReferences).toHaveBeenCalledTimes(2);
    expect(titles(view)).toEqual(["2 usages"]);
  });

  it("does not repeat complete counts when the server finishes other work", async () => {
    const view = editor();
    emitLocalIdeEvent({ type: "languageServer", server: 1, name: "rust-analyzer", status: "busy", message: null });
    await settle();
    await settle();
    emitLocalIdeEvent({ type: "languageServer", server: 1, name: "rust-analyzer", status: "ready", message: null });
    await settle();
    expect(ipc.lspReferences).toHaveBeenCalledTimes(1);
    expect(titles(view)).toEqual(["2 usages"]);
  });

  it("cancels all in-flight requests on destroy without starting the next batch", async () => {
    const pending = deferred<ReturnType<typeof refs>>();
    ipc.docOutline.mockResolvedValue(ok(Array.from({ length: 8 }, (_, i) => item(`f${i}`, "function", i))));
    ipc.lspReferences.mockReturnValue(pending.promise);
    const view = editor(8);
    await settle();
    expect(ipc.lspReferences).toHaveBeenCalledTimes(4);
    const requests = ipc.lspReferences.mock.calls.map(([id]) => id);
    view.destroy();
    views.splice(views.indexOf(view), 1);
    expect(ipc.cancelRequest.mock.calls.map(([id]) => id)).toEqual(requests);
    pending.resolve(refs(1));
    await settle();
    expect(ipc.lspReferences).toHaveBeenCalledTimes(4);
  });

  it("cancels pending counts when the feature is disabled", async () => {
    const pending = deferred<ReturnType<typeof refs>>();
    ipc.lspReferences.mockReturnValue(pending.promise);
    const view = editor();
    await settle();
    useProject.setState({
      settings: { editor: { inlay: { codeVisionUsages: false, codeVisionAuthor: false } } } as never,
    });
    expect(ipc.cancelRequest).toHaveBeenCalledWith(ipc.lspReferences.mock.calls[0]![0]);
    pending.resolve(refs(2));
    await settle();
    expect(titles(view)).toEqual([]);
  });

  it("does not send obsolete requests after waiting for document synchronization", async () => {
    const synced = deferred<void>();
    const view = editor(1, () => synced.promise);
    const handle = { view, ctx };
    _addEditor(handle);
    try {
      await settle();
      expect(ipc.docOutline).not.toHaveBeenCalled();
      view.destroy();
      views.splice(views.indexOf(view), 1);
      synced.resolve();
      await settle();
      expect(ipc.docOutline).not.toHaveBeenCalled();
      expect(ipc.lspReferences).not.toHaveBeenCalled();
      expect(ipc.cancelRequest).not.toHaveBeenCalled();
    } finally {
      _removeEditor(handle);
    }
  });
});
