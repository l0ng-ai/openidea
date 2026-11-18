import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";

let osClipboard = "";
vi.mock("@/platform/clipboard", () => ({
  writeClipboardText: vi.fn(async (text: string) => {
    osClipboard = text;
  }),
  readClipboardPlainText: vi.fn(async () => osClipboard),
}));

const { applyRcCommands, vimExtension } = await import("../engine");
const { parseVimrc } = await import("../rc");

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Vim and the system clipboard", () => {
  let view: EditorView | null = null;
  beforeEach(() => {
    osClipboard = "";
  });
  afterEach(() => {
    view?.destroy();
    view = null;
    applyRcCommands([]);
  });

  const open = (doc: string, rc = "") => {
    applyRcCommands(parseVimrc(rc).commands);
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({ parent, state: EditorState.create({ doc, extensions: vimExtension() }) });
    return getCM(view)!;
  };
  const keys = async (cm: ReturnType<typeof getCM>, seq: string) => {
    for (const k of seq) Vim.handleKey(cm as never, k, "user");
    await tick();
  };
  const doc = () => view!.state.doc.toString();

  it.each([
    { name: "explicit + register", rc: "", yank: '"+yy', put: '"+p' },
    { name: "explicit * register", rc: "", yank: '"*yy', put: '"*p' },
    { name: "clipboard+=unnamedplus", rc: "set clipboard+=unnamedplus", yank: "yy", put: "p" },
    { name: "clipboard=unnamed", rc: "set clipboard=unnamed", yank: "yy", put: "p" },
  ])("$name: yanks a line to the OS clipboard and puts it back linewise", async ({ rc, yank, put }) => {
    const cm = open("one\ntwo", rc);
    await keys(cm, yank);
    expect(osClipboard).toBe("one\n");
    await keys(cm, put);
    expect(doc()).toBe("one\none\ntwo");
  });

  it("puts text copied in another app characterwise", async () => {
    const cm = open("ab", "set clipboard=unnamedplus");
    osClipboard = "X\r\nY";
    await keys(cm, "p");
    expect(doc()).toBe("aX\nYb");
  });

  it("leaves the unnamed register alone without the option, and after the rc file drops it", async () => {
    let cm = open("one\ntwo");
    await keys(cm, "yy");
    expect(osClipboard).toBe("");

    cm = open("one\ntwo", "set clipboard=unnamedplus");
    applyRcCommands([]);
    await keys(cm, "dd");
    expect(osClipboard).toBe("");
  });

  it("deletes into the clipboard with unnamedplus", async () => {
    const cm = open("one two", "set clipboard^=unnamedplus");
    await keys(cm, "dw");
    expect(osClipboard).toBe("one ");
  });
});
