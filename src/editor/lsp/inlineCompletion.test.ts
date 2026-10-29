import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { InlineCompletionItem } from "@/bindings";

const ipc = vi.hoisted(() => ({
  lspInlineCompletion: vi.fn(),
  lspExecuteCommand: vi.fn(async () => ({ status: "ok" as const, data: null })),
  cancelRequest: vi.fn(async () => ({ status: "ok" as const, data: null })),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const {
  acceptInline,
  cycleInline,
  dismissInline,
  ghostField,
  ghostText,
  inlineCompletionExtension,
  nextWord,
  registerInlineCompletionActions,
  requestInline,
  toSuggestions,
} = await import("./inlineCompletion");
const { lspDoc } = await import("./lsp");

const item = (insertText: string, extra: Partial<InlineCompletionItem> = {}): InlineCompletionItem => ({
  insertText,
  range: null,
  filterText: null,
  command: null,
  server: 1,
  ...extra,
});

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.clearAllMocks();
});

function editor(doc: string, caret = doc.length) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(caret),
      extensions: [
        lspDoc.of({ doc: 3, path: "/p/a.rs", language: "rust", virtual: false } as never),
        inlineCompletionExtension(),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

const ghostDom = (v: EditorView) => v.dom.querySelector(".cm-inline-ghost")?.textContent ?? null;

async function suggest(view: EditorView, ...items: InlineCompletionItem[]) {
  ipc.lspInlineCompletion.mockResolvedValueOnce({ status: "ok", data: items });
  return requestInline(view, true);
}

describe("inline completion", () => {
  it("shows the server's suggestion as ghost text at the caret", async () => {
    const view = editor("let x = fo");
    expect(
      await suggest(view, item("foo(1);", { range: { start: { line: 0, col: 8 }, end: { line: 0, col: 10 } } })),
    ).toBe(true);
    expect(ipc.lspInlineCompletion.mock.calls[0]!.slice(1)).toEqual([3, { line: 0, col: 10 }, true]);
    expect(ghostDom(view)).toBe("o(1);");
  });

  it("stays while the typed text matches it and goes when it doesn't", async () => {
    const view = editor("let x = ");
    await suggest(view, item("foo()"));
    view.dispatch({ changes: { from: 8, insert: "f" }, selection: EditorSelection.cursor(9), userEvent: "input.type" });
    expect(ghostDom(view)).toBe("oo()");
    view.dispatch({
      changes: { from: 9, insert: "x" },
      selection: EditorSelection.cursor(10),
      userEvent: "input.type",
    });
    expect(view.state.field(ghostField)).toBeNull();
    expect(ghostDom(view)).toBeNull();
  });

  it("accepts the whole suggestion or its next word, and runs its command", async () => {
    const view = editor("x = ");
    const command = { title: "accepted", command: "ghost.accepted", arguments: [] };
    await suggest(view, item("compute(a, b)", { command }));
    expect(acceptInline(view, true)).toBe(true);
    expect(view.state.doc.toString()).toBe("x = compute");
    expect(ghostDom(view)).toBe("(a, b)");
    expect(acceptInline(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("x = compute(a, b)");
    expect(view.state.selection.main.head).toBe(17);
    expect(view.state.field(ghostField)).toBeNull();
    expect(ipc.lspExecuteCommand).toHaveBeenCalledWith(3, command);
    expect(acceptInline(view)).toBe(false);
  });

  it("cycles through variants and dismisses", async () => {
    const view = editor("a");
    const range = { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } };
    await suggest(view, item("abc", { range }), item("axe", { range }));
    expect(ghostDom(view)).toBe("bc");
    cycleInline(view, 1);
    expect(ghostDom(view)).toBe("xe");
    cycleInline(view, 1);
    expect(ghostDom(view)).toBe("bc");
    cycleInline(view, -1);
    expect(ghostDom(view)).toBe("xe");
    expect(dismissInline(view)).toBe(true);
    expect(ghostDom(view)).toBeNull();
    expect(dismissInline(view)).toBe(false);
  });

  it("drops suggestions that don't fit the caret, and trims text the suggestion replaces", () => {
    const state = EditorState.create({ doc: "f()", selection: EditorSelection.cursor(2) });
    const range = { start: { line: 0, col: 0 }, end: { line: 0, col: 3 } };
    const found = toSuggestions(state, 2, [item("f(a)", { range }), item("g(b)", { range }), item("f(a)", { range })]);
    expect(found).toHaveLength(1);
    // `)` follows the caret and ends the suggestion: only `a` is new.
    expect(ghostText(state, found[0]!)).toBe("a");
    expect(ghostText(state, { ...found[0]!, text: "f(a, b) + 1" })).toBe("a, b) + 1");
  });

  it("splits the next word like IDEA", () => {
    expect(nextWord("foo(bar)")).toBe("foo");
    expect(nextWord("(bar)")).toBe("(");
    expect(nextWord("  bar baz")).toBe("  bar");
    expect(nextWord("   ")).toBe("   ");
  });
});

describe("inline completion without a provider", () => {
  const unavailable = (message: string) => ({
    status: "error" as const,
    error: { kind: "unavailable" as const, message },
  });
  const hintText = () => document.querySelector(".cm-lsp-hint")?.textContent ?? null;

  async function invoke(view: EditorView) {
    const { useEditorRegistry } = await import("@/editor/api");
    const { getAction } = await import("@/platform/actions");
    useEditorRegistry.setState({ active: { view, ctx: view.state.facet(lspDoc)! } as never });
    const off = registerInlineCompletionActions();
    void getAction("editor.inlineCompletion.trigger")!.run({ ctx: {} } as never);
    off();
  }

  it.each([
    [
      "names the running server that lacks it",
      "jdtls doesn't support inline completion",
      "jdtls doesn't support inline completion",
    ],
    [
      "says no server runs when none does",
      "no running language server supports inline completion",
      "No language server available",
    ],
  ])("on explicit invocation %s", async (_, message, shown) => {
    const view = editor("String s = ");
    ipc.lspInlineCompletion.mockResolvedValueOnce(unavailable(message));
    await invoke(view);
    await vi.waitFor(() => expect(hintText()).toBe(shown));
  });

  it("stays silent while typing", async () => {
    const view = editor("String s = ");
    ipc.lspInlineCompletion.mockResolvedValue(unavailable("jdtls doesn't support inline completion"));
    expect(await requestInline(view, true)).toBe(false);
    view.dispatch({ changes: { from: 11, insert: "x" }, userEvent: "input.type" });
    await new Promise((r) => setTimeout(r, 120));
    expect(hintText()).toBeNull();
    expect(ghostDom(view)).toBeNull();
    ipc.lspInlineCompletion.mockReset();
  });
});
