import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { _addEditor, _removeEditor, documentSynced, viewShown } from "@/editor/api";
import type { InlayHint } from "@/bindings";

const ipc = vi.hoisted(() => ({ lspInlayHints: vi.fn() }));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});
const { inlayExtension } = await import("./inlay");
const { lspDoc } = await import("./lsp");
const { useProject } = await import("@/platform/project");
const { emitLocalIdeEvent } = await import("@/platform/ipc");
const views: EditorView[] = [];
const ok = (label: string) => ({
  status: "ok" as const,
  data: [
    {
      position: { line: 0, col: 5 },
      label,
      kind: "type",
      parts: [],
      paddingLeft: false,
      paddingRight: false,
      tooltip: null,
    },
  ] as InlayHint[],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const ctx = { doc: 71, path: "/p/a.rs", language: "rust", uiMode: "Rust", readOnly: false };
function editor(sync?: () => Promise<void>) {
  const view = new EditorView({
    state: EditorState.create({
      doc: "let x = 1;",
      extensions: [lspDoc.of(ctx), ...(sync ? [documentSynced.of(sync)] : []), inlayExtension()],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
const labels = (view: EditorView) => [...view.dom.querySelectorAll(".cm-lsp-inlay")].map((e) => e.textContent);
beforeEach(() => {
  vi.useFakeTimers();
  ipc.lspInlayHints.mockReset().mockResolvedValue(ok("current"));
  useProject.setState({ settings: { editor: { inlayHints: true } } as never });
});
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  useProject.setState({ settings: null });
  vi.useRealTimers();
});
describe("inlay request lifetime", () => {
  it("does not restore hints after they were disabled", async () => {
    const old = deferred<ReturnType<typeof ok>>();
    ipc.lspInlayHints.mockReturnValueOnce(old.promise);
    const view = editor();
    await vi.advanceTimersByTimeAsync(400);
    useProject.setState({ settings: { editor: { inlayHints: false } } as never });
    await vi.advanceTimersByTimeAsync(400);
    old.resolve(ok("stale"));
    await vi.advanceTimersByTimeAsync(1);
    expect(labels(view)).toEqual([]);
  });
  it("does not overwrite a newer server refresh with an older response", async () => {
    const old = deferred<ReturnType<typeof ok>>();
    ipc.lspInlayHints.mockReturnValueOnce(old.promise);
    const view = editor();
    await vi.advanceTimersByTimeAsync(400);
    emitLocalIdeEvent({ type: "lspRefresh", kind: "inlayHints", server: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(labels(view)).toEqual(["current"]);
    old.resolve(ok("stale"));
    await vi.advanceTimersByTimeAsync(1);
    expect(labels(view)).toEqual(["current"]);
  });
});

describe("obsolete inlay work", () => {
  it("invalidates immediately, before the next debounced request starts", async () => {
    const old = deferred<ReturnType<typeof ok>>();
    ipc.lspInlayHints.mockReturnValueOnce(old.promise);
    const view = editor();
    await vi.advanceTimersByTimeAsync(400);
    emitLocalIdeEvent({ type: "lspRefresh", kind: "inlayHints", server: 1 });
    old.resolve(ok("stale"));
    await vi.advanceTimersByTimeAsync(1);
    expect(labels(view)).toEqual([]);
    await vi.advanceTimersByTimeAsync(399);
    expect(labels(view)).toEqual(["current"]);
  });
  it("does not dispatch a response into a destroyed editor", async () => {
    const old = deferred<ReturnType<typeof ok>>();
    ipc.lspInlayHints.mockReturnValueOnce(old.promise);
    const view = editor();
    await vi.advanceTimersByTimeAsync(400);
    view.destroy();
    views.splice(views.indexOf(view), 1);
    const dispatch = vi.spyOn(view, "dispatch");
    old.resolve(ok("stale"));
    await vi.advanceTimersByTimeAsync(400);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("does not send obsolete requests after waiting for document synchronization", async () => {
    const synced = deferred<void>();
    const view = editor(() => synced.promise);
    const handle = { view, ctx };
    _addEditor(handle);
    try {
      await vi.advanceTimersByTimeAsync(400);
      expect(ipc.lspInlayHints).not.toHaveBeenCalled();
      view.destroy();
      views.splice(views.indexOf(view), 1);
      synced.resolve();
      await vi.advanceTimersByTimeAsync(400);
      expect(ipc.lspInlayHints).not.toHaveBeenCalled();
    } finally {
      _removeEditor(handle);
    }
  });
});

describe("retained editors", () => {
  it("keeps an in-flight response when the editor is detached then shown again", async () => {
    const pending = deferred<ReturnType<typeof ok>>();
    ipc.lspInlayHints.mockReturnValueOnce(pending.promise);
    const view = editor();
    await vi.advanceTimersByTimeAsync(400);
    view.dom.remove();
    pending.resolve(ok("retained"));
    await vi.advanceTimersByTimeAsync(1);
    document.body.append(view.dom);
    view.dispatch({ effects: viewShown.of(null) });
    await vi.advanceTimersByTimeAsync(400);
    expect(labels(view)).toEqual(["retained"]);
  });
  it("keeps work waiting for document synchronization when detached then shown again", async () => {
    const synced = deferred<void>();
    const view = editor(() => synced.promise);
    const handle = { view, ctx };
    _addEditor(handle);
    try {
      await vi.advanceTimersByTimeAsync(400);
      expect(ipc.lspInlayHints).not.toHaveBeenCalled();
      view.dom.remove();
      synced.resolve();
      await vi.advanceTimersByTimeAsync(1);
      document.body.append(view.dom);
      view.dispatch({ effects: viewShown.of(null) });
      await vi.advanceTimersByTimeAsync(400);
      expect(labels(view)).toEqual(["current"]);
    } finally {
      _removeEditor(handle);
    }
  });
});
