import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands, Location } from "@/platform/ipc";

const lspGoto = vi.hoisted(() => vi.fn<typeof commands.lspGoto>());
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, lspGoto } };
});
const { emitLocalIdeEvent } = await import("@/platform/ipc");
const { _emitEditorEvent } = await import("@/editor/api");
const { lspDoc } = await import("./lsp");
const { navigationExtension } = await import("./navigation");
const { requestNavigation, invalidateConfigurationNavigation, installConfigurationNavigationEvents } =
  await import("./configurationNavigation");

const target: Location = {
  path: "/p/Config.java",
  uri: null,
  range: { start: { line: 3, col: 4 }, end: { line: 3, col: 9 } },
};
const views: EditorView[] = [];
function editor(doc = 1, language = "yaml", text = "server:\n  port: 8080\n") {
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        lspDoc.of({ doc, path: `/p/${doc}.${language}`, language, uiMode: language, readOnly: false }),
        navigationExtension(),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
let off: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  invalidateConfigurationNavigation();
  lspGoto.mockReset().mockResolvedValue({ status: "ok", data: [target] });
  off = installConfigurationNavigationEvents();
});
afterEach(() => {
  off();
  views.splice(0).forEach((v) => v.destroy());
  vi.useRealTimers();
});

describe("configuration navigation result reuse", () => {
  it("shares an in-flight hover lookup with a click anywhere in the same key", async () => {
    let resolve!: (r: Awaited<ReturnType<typeof commands.lspGoto>>) => void;
    lspGoto.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const view = editor();
    const hover = requestNavigation(view, 10, "definition");
    const click = requestNavigation(view, 12, "definition");
    expect(click).toBe(hover);
    await vi.waitFor(() => expect(lspGoto).toHaveBeenCalledOnce());
    resolve({ status: "ok", data: [target] });
    expect(await click).toEqual([target]);
    expect(await requestNavigation(view, 11, "definition")).toEqual([target]);
    expect(lspGoto).toHaveBeenCalledOnce();
  });

  it("reuses results when the same document is shown again", async () => {
    const view = editor();
    await requestNavigation(view, 10, "definition");
    await requestNavigation(editor(), 11, "definition");
    expect(lspGoto).toHaveBeenCalledOnce();
  });

  it("keeps different keys and documents separate", async () => {
    const view = editor();
    await requestNavigation(view, 1, "definition");
    await requestNavigation(view, 10, "definition");
    await requestNavigation(editor(2), 10, "definition");
    expect(lspGoto).toHaveBeenCalledTimes(3);
  });

  it.each(["java", "typescript"])("leaves %s native navigation uncached", async (language) => {
    const view = editor(1, language, "value");
    await requestNavigation(view, 1, "definition");
    await requestNavigation(view, 1, "definition");
    expect(lspGoto).toHaveBeenCalledTimes(2);
  });

  it("does not mix definition with other navigation kinds", async () => {
    const view = editor();
    await requestNavigation(view, 10, "definition");
    await requestNavigation(view, 10, "typeDefinition");
    expect(lspGoto).toHaveBeenCalledTimes(2);
  });

  it("invalidates on edits to another open Java document, before its IPC sync", async () => {
    const view = editor();
    const java = editor(2, "java", "class Config {}");
    await requestNavigation(view, 10, "definition");
    java.dispatch({ changes: { from: 6, to: 12, insert: "Changed" } });
    await requestNavigation(view, 10, "definition");
    expect(lspGoto).toHaveBeenCalledTimes(2);
  });

  it.each([
    { type: "fsChanged", created: [], modified: ["/p/Config.java"], removed: [] },
    { type: "fsChanged", created: [], modified: [], removed: ["/p/Config.java"] },
    { type: "docPatched", doc: 2, baseVersion: 1, version: 2, changes: [] },
    { type: "languageServer", server: 1, name: "jdtls", status: "starting", message: null },
    { type: "lspRefresh", server: 1, kind: "codeLens" },
    { type: "excludedDirsChanged", dirs: ["/p/target"] },
  ] as const)("invalidates on $type", async (event) => {
    const view = editor();
    await requestNavigation(view, 10, "definition");
    emitLocalIdeEvent(event as Parameters<typeof emitLocalIdeEvent>[0]);
    await requestNavigation(view, 10, "definition");
    expect(lspGoto).toHaveBeenCalledTimes(2);
  });

  it("does not invalidate just because navigation opened a clean target", async () => {
    const view = editor();
    await requestNavigation(view, 10, "definition");
    _emitEditorEvent({ type: "docOpened", doc: 2, path: target.path, language: "java" });
    await requestNavigation(view, 10, "definition");
    expect(lspGoto).toHaveBeenCalledOnce();
    _emitEditorEvent({ type: "docClosed", doc: 2, path: target.path });
    await requestNavigation(view, 10, "definition");
    expect(lspGoto).toHaveBeenCalledTimes(2);
  });

  it("discards in-flight results when dependencies change", async () => {
    let resolve!: (r: Awaited<ReturnType<typeof commands.lspGoto>>) => void;
    lspGoto.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const view = editor();
    const pending = requestNavigation(view, 10, "definition");
    const rejected = expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    await vi.waitFor(() => expect(lspGoto).toHaveBeenCalledOnce());
    invalidateConfigurationNavigation();
    resolve({ status: "ok", data: [target] });
    await rejected;
    await requestNavigation(view, 10, "definition");
    expect(lspGoto).toHaveBeenCalledTimes(2);
  });

  it.each(["settled", "refresh"])("does not swallow an in-flight click on its own server %s event", async (event) => {
    let resolve!: (r: Awaited<ReturnType<typeof commands.lspGoto>>) => void;
    lspGoto.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const view = editor();
    const pending = requestNavigation(view, 10, "definition");
    await vi.waitFor(() => expect(lspGoto).toHaveBeenCalledOnce());
    if (event === "settled") {
      emitLocalIdeEvent({ type: "languageServer", server: 1, name: "jdtls", status: "busy", message: null });
      vi.setSystemTime(Date.now() + 1600);
      emitLocalIdeEvent({ type: "languageServer", server: 1, name: "jdtls", status: "ready", message: null });
    } else emitLocalIdeEvent({ type: "lspRefresh", server: 1, kind: "codeLens" });
    resolve({ status: "ok", data: [target] });
    expect(await pending).toEqual([target]);
    await requestNavigation(view, 10, "definition");
    expect(lspGoto).toHaveBeenCalledTimes(2);
  });

  it("does not retain errors or missing targets during import", async () => {
    const view = editor();
    lspGoto.mockResolvedValueOnce({ status: "error", error: { kind: "protocol", message: "timeout" } });
    await expect(requestNavigation(view, 10, "definition")).rejects.toThrow("timeout");
    lspGoto.mockResolvedValueOnce({ status: "ok", data: [] });
    expect(await requestNavigation(view, 10, "definition")).toEqual([]);
    expect(await requestNavigation(view, 10, "definition")).toEqual([target]);
    expect(lspGoto).toHaveBeenCalledTimes(3);
  });

  it("expires results when a server did not report a change", async () => {
    const view = editor();
    await requestNavigation(view, 10, "definition");
    vi.setSystemTime(Date.now() + 30_001);
    await requestNavigation(view, 10, "definition");
    expect(lspGoto).toHaveBeenCalledTimes(2);
  });

  it("bounds retained entries", async () => {
    const view = editor(1, "properties", Array.from({ length: 130 }, (_, i) => `key${i}=x\n`).join(""));
    for (let i = 1; i <= 130; i++) await requestNavigation(view, view.state.doc.line(i).from, "definition");
    await requestNavigation(view, 0, "definition");
    expect(lspGoto).toHaveBeenCalledTimes(131);
  });

  it("bounds retained locations even for large multi-target answers", async () => {
    const view = editor();
    lspGoto.mockResolvedValueOnce({ status: "ok", data: Array.from({ length: 4097 }, () => target) });
    await requestNavigation(view, 10, "definition");
    await requestNavigation(view, 10, "definition");
    expect(lspGoto).toHaveBeenCalledTimes(2);
  });
});
