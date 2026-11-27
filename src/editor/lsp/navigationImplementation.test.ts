import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands, Location } from "@/platform/ipc";

const { lspGoto, lspGotoImplementation } = vi.hoisted(() => ({
  lspGoto: vi.fn<typeof commands.lspGoto>(),
  lspGotoImplementation: vi.fn<typeof commands.lspGotoImplementation>(),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  const fsReadText: typeof commands.fsReadText = async () => ({
    status: "error",
    error: { kind: "notFound", message: "not found" },
  });
  const navInheritance: typeof commands.navInheritance = async () => ({ status: "ok", data: [] });
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, lspGoto, lspGotoImplementation, fsReadText, navInheritance },
  };
});
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<object>()),
  Channel: class {
    onmessage = () => {};
  },
}));

const { gotoTargets } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { closePopup } = await import("./popupStore");
const { invalidateConfigurationNavigation } = await import("./configurationNavigation");
const { provideEditorService } = await import("@/workbench/contributions");
const openFile = vi.fn(async (_path: string, _opts: unknown) => {});
provideEditorService({ openFile } as never);

const loc = (path: string, line = 1, col = 2): Location => ({
  path,
  uri: null,
  range: { start: { line, col }, end: { line, col: col + 3 } },
});
const ok = (data: Location[]) => ({ status: "ok" as const, data });
const declared = loc("/p/store.go");
const implementation = loc("/p/iface.go");

const TEXT = "package p\n\nfunc (s *Store) Search() {}\n";
const editor = (text: string, language: string, path: string) =>
  new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [lspDoc.of({ doc: 1, path, language, uiMode: language, readOnly: false })],
    }),
    parent: document.body,
  });

let view: EditorView;
beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigurationNavigation();
  lspGoto.mockResolvedValue(ok([]));
  lspGotoImplementation.mockResolvedValue(ok([]));
  view = editor(TEXT, "go", "/p/store.go");
});
afterEach(() => {
  view.destroy();
  closePopup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** Go to Implementation on `Search`, at the method's name. */
const gotoSearch = () => gotoTargets(view, "implementation", TEXT.indexOf("Search") + 2);

describe("Go to Implementation on a symbol nothing implements", () => {
  it("navigates to the declaration, like IDEA", async () => {
    lspGoto.mockResolvedValue(ok([declared]));
    await gotoSearch();
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(["/p/store.go"]);
    expect(lspGotoImplementation).toHaveBeenCalledOnce();
    expect(lspGoto.mock.calls.map(([, , kind]) => kind)).toEqual(["definition"]);
  });

  it("navigates when the server reports its failed search as an error", async () => {
    lspGotoImplementation.mockResolvedValue({
      status: "error",
      error: { kind: "protocol", message: "no interfaces implemented by this method" },
    });
    lspGoto.mockResolvedValue(ok([declared]));
    await gotoSearch();
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(["/p/store.go"]);
  });

  it("still navigates to the implementations when there are some", async () => {
    lspGotoImplementation.mockResolvedValue(ok([implementation]));
    await gotoSearch();
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(["/p/iface.go"]);
    expect(lspGoto).not.toHaveBeenCalled();
  });

  it("does not navigate onto the declaration the caret is already on", async () => {
    const at = TEXT.indexOf("Search");
    const col = at - (TEXT.lastIndexOf("\n", at) + 1);
    lspGoto.mockResolvedValue(
      ok([{ ...declared, range: { start: { line: 2, col }, end: { line: 2, col: col + 6 } } }]),
    );
    await gotoSearch();
    expect(openFile).not.toHaveBeenCalled();
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("No implementations found");
  });

  it("keeps the not-found hint when the declaration request fails", async () => {
    lspGoto.mockRejectedValue(new Error("timeout"));
    await gotoSearch();
    expect(openFile).not.toHaveBeenCalled();
    expect(document.querySelector(".cm-lsp-hint")?.textContent).toBe("No implementations found");
  });

  it("ignores the caret's own declaration among several targets", async () => {
    const at = TEXT.indexOf("Search");
    const col = at - (TEXT.lastIndexOf("\n", at) + 1);
    const self = { ...declared, range: { start: { line: 2, col }, end: { line: 2, col: col + 6 } } };
    lspGoto.mockResolvedValue(ok([self, loc("/p/other.go")]));
    await gotoSearch();
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(["/p/other.go"]);
  });

  it("keeps an unavailable server's error instead of inventing a target", async () => {
    lspGotoImplementation.mockResolvedValue({
      status: "error",
      error: { kind: "unavailable", message: "no implementation provider" },
    });
    lspGoto.mockResolvedValue(ok([declared]));
    await gotoSearch();
    expect(lspGoto).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    expect(document.querySelector(".cm-lsp-hint")).not.toBeNull();
  });

  it("navigates to a type's declaration from a usage", async () => {
    const text = "package p\n\nvar s Store\n";
    view.destroy();
    view = editor(text, "go", "/p/store.go");
    lspGoto.mockResolvedValue(ok([loc("/p/store.go", 0, 5)]));
    await gotoTargets(view, "implementation", text.indexOf("Store") + 2);
    expect(openFile).toHaveBeenCalledWith("/p/store.go", { selection: { line: 0, col: 5 }, focus: true });
  });

  it("covers Python, whose servers have no type hierarchy", async () => {
    const text = "class Order:\n    pass\n\nuse = Order\n";
    view.destroy();
    view = editor(text, "python", "/p/order.py");
    lspGoto.mockResolvedValue(ok([loc("/p/order.py", 0, 6)]));
    await gotoTargets(view, "implementation", text.lastIndexOf("Order") + 2);
    expect(openFile).toHaveBeenCalledWith("/p/order.py", { selection: { line: 0, col: 6 }, focus: true });
  });
});
