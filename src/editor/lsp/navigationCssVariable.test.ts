import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { commands, Location } from "@/platform/ipc";

// `var(--x)`: the CSS server only knows the open stylesheet, so a name declared here and in a
// theme file would answer just the local one; the project index lists both.
const { lspGoto, webGoto, readManyFileLines } = vi.hoisted(() => ({
  lspGoto: vi.fn<typeof commands.lspGoto>(),
  webGoto: vi.fn<typeof commands.webGoto>(),
  readManyFileLines: vi.fn(async () => new Map<string, string[] | null>()),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, lspGoto, webGoto } };
});
vi.mock("./files", async (orig) => ({ ...(await orig<typeof import("./files")>()), readManyFileLines }));

const { gotoTargets } = await import("./navigation");
const { lspDoc } = await import("./lsp");
const { closePopup, useLspPopup } = await import("./popupStore");
const { provideEditorService } = await import("@/workbench/contributions");
const openFile = vi.fn(async () => {});
provideEditorService({ openFile } as never);

const at = (path: string, line: number): Location => ({
  path,
  range: { start: { line, col: 2 }, end: { line, col: 6 } },
  uri: null,
});
const text = ":root { --bg: #fff; }\n.a { color: var(--bg); }\n";

let view: EditorView;
beforeEach(() => {
  vi.clearAllMocks();
  lspGoto.mockResolvedValue({ status: "ok", data: [at("/p/a.css", 0)] });
  view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [lspDoc.of({ doc: 1, path: "/p/a.css", language: "css", uiMode: "CSS", readOnly: false })],
    }),
    parent: document.body,
  });
  view.dispatch({ selection: { anchor: text.lastIndexOf("--bg") + 2 } });
});
afterEach(() => {
  closePopup();
  view.destroy();
  document.body.replaceChildren();
});

describe("go to declaration on var(--x)", () => {
  it("lists the declarations in every file, not only the server's local one", async () => {
    const targets = [at("/p/a.css", 0), at("/p/theme/dark.css", 4)];
    webGoto.mockResolvedValue({
      status: "ok",
      data: { reference: { kind: "cssVariable", name: "--bg", range: at("/p/a.css", 1).range }, targets },
    });
    await gotoTargets(view, "declaration");
    expect(webGoto).toHaveBeenCalledWith(1, { line: 1, col: 18 });
    expect(lspGoto).not.toHaveBeenCalled();
    const popup = useLspPopup.getState().popup;
    expect(popup?.kind).toBe("list");
    expect(popup && "title" in popup ? popup.title : null).toBe("Choose Declaration of '--bg' (2 found)");
    expect(popup && "items" in popup ? popup.items.map((i) => i.target) : null).toEqual([
      expect.objectContaining({ path: expect.stringMatching(/a\.css:1$/) }),
      expect.objectContaining({ path: expect.stringMatching(/dark\.css:5$/) }),
    ]);
    expect(openFile).not.toHaveBeenCalled();
  });
});
