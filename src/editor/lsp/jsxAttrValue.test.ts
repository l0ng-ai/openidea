import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";

const ipc = vi.hoisted(() => ({
  lspHover: vi.fn(),
  cancelRequest: vi.fn<(id: number) => Promise<void>>(async () => {}),
}));
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const { attrValueKind, isStringLikeType, jsxAttrValueExtension } = await import("./jsxAttrValue");
const { lspDoc } = await import("./lsp");

const ctx = { doc: 3, path: "/p/a.tsx", language: "typescriptreact", uiMode: "TSX", readOnly: false };
const views: EditorView[] = [];
const hover = (sig: string) => ({
  status: "ok" as const,
  data: { contents: { kind: "markdown", value: "```typescript\n" + sig + "\n```" }, range: null },
});

function editor(text: string, language = "typescriptreact") {
  const at = text.indexOf("|");
  const view = new EditorView({
    state: EditorState.create({
      doc: text.replace("|", ""),
      selection: EditorSelection.cursor(at),
      extensions: [
        javascript({ jsx: true, typescript: true }),
        history(),
        lspDoc.of({ ...ctx, language }),
        jsxAttrValueExtension(language),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function show(view: EditorView): string {
  const doc = view.state.doc.toString();
  const head = view.state.selection.main.head;
  return doc.slice(0, head) + "|" + doc.slice(head);
}

/** Types `ch` through the real input handlers. */
function type(v: EditorView, ch: string) {
  const r = v.state.selection.main;
  const insert = () => v.state.update(v.state.replaceSelection(ch), { userEvent: "input.type" });
  if (!v.state.facet(EditorView.inputHandler).some((h) => h(v, r.from, r.to, ch, insert))) v.dispatch(insert());
}

beforeEach(() => {
  vi.useFakeTimers();
  ipc.lspHover.mockReset();
  ipc.cancelRequest.mockClear();
});
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.useRealTimers();
});

describe("isStringLikeType", () => {
  it("accepts strings, string literals and template literal types", () => {
    expect(isStringLikeType("string")).toBe(true);
    expect(isStringLikeType("string | undefined")).toBe(true);
    expect(isStringLikeType('"primary" | "secondary" | undefined')).toBe(true);
    expect(isStringLikeType("'a|b' | 'c'")).toBe(true);
    expect(isStringLikeType("`btn-${string}`")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isStringLikeType("number")).toBe(false);
    expect(isStringLikeType("string | number")).toBe(false);
    expect(isStringLikeType("() => void")).toBe(false);
    expect(isStringLikeType("ReactNode")).toBe(false);
    expect(isStringLikeType("any")).toBe(false);
    expect(isStringLikeType("undefined")).toBe(false);
    expect(isStringLikeType("Record<string, string | number>")).toBe(false);
  });
});

describe("attrValueKind", () => {
  const md = (sig: string) => hover(sig).data.contents;

  it("reads DOM and component prop signatures", () => {
    expect(
      attrValueKind(md("(property) React.HTMLAttributes<HTMLDivElement>.className?: string | undefined"), "className"),
    ).toBe("quotes");
    expect(attrValueKind(md("(property) label: string"), "label")).toBe("quotes");
    expect(attrValueKind(md('(property) "aria-label"?: string | undefined'), "aria-label")).toBe("quotes");
    expect(
      attrValueKind(
        md('(property) React.HTMLAttributes<HTMLDivElement>["aria-label"]?: string | undefined'),
        "aria-label",
      ),
    ).toBe("quotes");
    expect(attrValueKind(md('(property) variant?: "ghost" | "primary" | undefined'), "variant")).toBe("quotes");
    expect(
      attrValueKind(md("(property) React.HTMLAttributes<HTMLDivElement>.tabIndex?: number | undefined"), "tabIndex"),
    ).toBe("braces");
    expect(attrValueKind(md("(property) count: number"), "count")).toBe("braces");
    expect(
      attrValueKind(
        md(
          "(property) React.DOMAttributes<HTMLButtonElement>.onClick?: React.MouseEventHandler<HTMLButtonElement> | undefined",
        ),
        "onClick",
      ),
    ).toBe("braces");
  });

  it("falls back to braces without a type", () => {
    expect(attrValueKind(null, "x")).toBe("braces");
    expect(attrValueKind({ kind: "markdown", value: "any" }, "x")).toBe("braces");
  });
});

describe("= after a JSX attribute name", () => {
  it("inserts quotes for a string prop, caret inside", async () => {
    ipc.lspHover.mockResolvedValue(hover("(property) label: string"));
    const v = editor("const a = <Btn label| />;");
    type(v, "=");
    expect(show(v)).toBe("const a = <Btn label=| />;");
    await vi.advanceTimersByTimeAsync(0);
    expect(show(v)).toBe('const a = <Btn label="|" />;');
    expect(ipc.lspHover).toHaveBeenCalledWith(expect.any(Number), 3, { line: 0, col: 15 });
  });

  it("inserts braces for other props, and undo takes the pair back first", async () => {
    ipc.lspHover.mockResolvedValue(hover("(property) count: number"));
    const v = editor("const a = <Btn count|>x</Btn>;");
    type(v, "=");
    await vi.advanceTimersByTimeAsync(0);
    expect(show(v)).toBe("const a = <Btn count={|}>x</Btn>;");
    undo(v);
    expect(v.state.doc.toString()).toBe("const a = <Btn count=>x</Btn>;");
  });

  it("falls back to braces when the server is unavailable or slow", async () => {
    ipc.lspHover.mockRejectedValue({ kind: "unavailable", message: "none" });
    const v = editor("const a = <Btn count| />;");
    type(v, "=");
    await vi.advanceTimersByTimeAsync(0);
    expect(show(v)).toBe("const a = <Btn count={|} />;");

    ipc.lspHover.mockReturnValue(new Promise(() => {}));
    const w = editor("const a = <Btn label| />;");
    type(w, "=");
    await vi.advanceTimersByTimeAsync(600);
    expect(show(w)).toBe("const a = <Btn label={|} />;");
    expect(ipc.cancelRequest).toHaveBeenCalled();
  });

  it("drops the pair once something else was typed", async () => {
    let answer!: (v: unknown) => void;
    ipc.lspHover.mockReturnValue(new Promise((r) => (answer = r)));
    const v = editor("const a = <Btn label| />;");
    type(v, "=");
    type(v, "x");
    answer(hover("(property) label: string"));
    await vi.advanceTimersByTimeAsync(0);
    expect(show(v)).toBe("const a = <Btn label=x| />;");
  });

  it("stays out where there is no value-less attribute name before the caret", () => {
    for (const text of [
      'const a = <Btn label|"x" />;',
      "const a = <Btn label|{x} />;",
      "const a = |;",
      'const a = <Btn label="x|" />;',
      "const a = <Btn {...p}| />;",
    ]) {
      const v = editor(text);
      type(v, "=");
      expect(ipc.lspHover).not.toHaveBeenCalled();
    }
  });

  it("is only installed for JSX languages", () => {
    const v = editor("const a = <Btn label| />;", "typescript");
    type(v, "=");
    expect(ipc.lspHover).not.toHaveBeenCalled();
  });
});
