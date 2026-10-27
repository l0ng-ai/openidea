import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { closeBrackets } from "@codemirror/autocomplete";

const help = { signatures: [{ label: "f(a: number)", documentation: null, parameters: [[2, 11]] }], activeSignature: 0, activeParameter: 0 };
const lspSignatureHelp = vi.fn(async () => ({ status: "ok" as const, data: help }));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, lspSignatureHelp } };
});

const { signatureExtension, acceptsParameter, argumentSpans, argumentStop, parameterTabKeys, triggerSignatureHelp } = await import(
  "./signature"
);
const { lspDoc } = await import("./lsp");

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  lspSignatureHelp.mockClear();
});

function typeChar(view: EditorView, ch: string) {
  const { from, to } = view.state.selection.main;
  const insert = () => view.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  if (!view.state.facet(EditorView.inputHandler).some((h) => h(view, from, to, ch, insert))) view.dispatch(insert());
}

describe("parameter info auto-popup", () => {
  it("opens after typing `(` even when the closing paren is auto-inserted", async () => {
    vi.useFakeTimers();
    try {
      const view = new EditorView({
        state: EditorState.create({
          doc: "f",
          selection: { anchor: 1 },
          extensions: [closeBrackets(), lspDoc.of({ doc: 1, path: "/a.ts", language: "typescript", uiMode: null, readOnly: false }), signatureExtension()],
        }),
        parent: document.body,
      });
      views.push(view);
      typeChar(view, "(");
      expect(view.state.doc.toString()).toBe("f()");
      await vi.advanceTimersByTimeAsync(1000);
      expect(lspSignatureHelp).toHaveBeenCalledTimes(1);
      expect(view.dom.querySelector(".cm-lsp-signature b")?.textContent).toBe("a: number");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("acceptsParameter", () => {
  it("rejects overloads with too few parameters unless the last is variadic", () => {
    expect(acceptsParameter({ label: "println() : void", parameters: [] }, 0)).toBe(false);
    expect(acceptsParameter({ label: "println(Object x) : void", parameters: [[8, 16]] }, 0)).toBe(true);
    expect(acceptsParameter({ label: "println(Object x) : void", parameters: [[8, 16]] }, 1)).toBe(false);
    expect(acceptsParameter({ label: "format(String f, Object... a)", parameters: [[7, 15], [17, 28]] }, 4)).toBe(true);
  });
});

describe("argument navigation", () => {
  const at = (src: string) => ({ text: src.replace("|", ""), pos: src.indexOf("|") });
  const stop = (src: string, dir: 1 | -1) => {
    const { text, pos } = at(src);
    const to = argumentStop(text, pos, dir);
    return to === null ? null : `${text.slice(0, to)}|${text.slice(to)}`;
  };

  it("splits arguments at top-level commas, outside strings and nested brackets", () => {
    const text = 'f(a, g(b, c), "x, y", [1, 2])';
    expect(argumentSpans(text, 1).map((s) => text.slice(s.from, s.to))).toEqual(["a", "g(b, c)", '"x, y"', "[1, 2]"]);
    expect(argumentSpans("f()", 1)).toEqual([]);
  });

  it("moves to the start of the next / previous argument, not past the ends", () => {
    expect(stop("f(a|b, c)", 1)).toBe("f(ab, |c)");
    expect(stop("f(ab, c|)", -1)).toBe("f(|ab, c)");
    expect(stop("f(ab,| c)", 1)).toBeNull();
    expect(stop("f(ab, c|)", 1)).toBeNull();
    expect(stop("f(a, |)", -1)).toBe("f(|a, )");
    expect(stop("f(a, g(|x, y), z)", 1)).toBe("f(a, g(x, |y), z)");
    expect(stop('f("(", |b)', -1)).toBe('f(|"(", b)');
  });

  it("⇥ moves while parameter info is shown and is left alone otherwise", async () => {
    const text = "f(a, b)";
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        selection: { anchor: 3 },
        extensions: [
          lspDoc.of({ doc: 1, path: "/a.ts", language: "typescript", uiMode: null, readOnly: false }),
          signatureExtension(),
          parameterTabKeys,
        ],
      }),
      parent: document.body,
    });
    views.push(view);
    const tab = () =>
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", keyCode: 9, bubbles: true, cancelable: true }));
    expect(tab()).toBe(true); // not handled: no parameter info
    expect(view.state.selection.main.head).toBe(3);
    triggerSignatureHelp(view, true);
    await vi.waitFor(() => expect(view.dom.querySelector(".cm-lsp-signature")).not.toBeNull());
    expect(tab()).toBe(false);
    expect(view.state.selection.main.head).toBe(5);
  });
});
