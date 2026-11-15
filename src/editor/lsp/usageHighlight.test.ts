import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Highlight, IdeError, Range } from "@/bindings";

type R<T> = Promise<{ status: "ok"; data: T } | { status: "error"; error: IdeError }>;
const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });

const cmd = {
  lspHover: vi.fn((): R<unknown> => ok(null)),
  lspDocumentLinks: vi.fn(() => ok([])),
  cancelRequest: vi.fn(() => ok(null)),
  lspDocumentHighlights: vi.fn((): R<Highlight[]> => ok([])),
};

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, ...cmd } };
});

const { navigationExtension, highlightUsages } = await import("./navigation");
const { lspDoc } = await import("./lsp");

const range = (line: number, col: number, endLine: number, endCol: number): Range => ({
  start: { line, col },
  end: { line: endLine, col: endCol },
});

// 0: int f() {          4: }
// 1:     return a      5: int g(String a) {
// 2:         .b()      6:     return a;
// 3:         .c();     7: }
const DOC = "int f() {\n    return a\n        .b()\n        .c();\n}\nint g(String a) {\n    return a;\n}";

const views: EditorView[] = [];
function editor(anchor = 0) {
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: { anchor },
      extensions: [
        lspDoc.of({ doc: 7, path: "/p/A.java", language: "java", uiMode: null, readOnly: false }),
        navigationExtension(),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
const lines = (v: EditorView) => [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];
const at = (line: number, col: number) => DOC.split("\n").slice(0, line).join("\n").length + (line ? 1 : 0) + col;
const click = (v: EditorView, pos: number) => v.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });

beforeEach(() => {
  cmd.lspDocumentHighlights.mockReset().mockImplementation(() => ok([]));
});
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

describe("highlights of the element at the caret", () => {
  it("paints a highlight over several lines as one block, as IDEA paints a text range", async () => {
    cmd.lspDocumentHighlights.mockImplementation(() => ok([{ range: range(1, 4, 3, 13), kind: "text" }]));
    const v = editor(at(1, 4));
    highlightUsages(v);
    await vi.waitFor(() => expect(lines(v)[1]!.classList.contains("cm-lsp-occurrence-tail")).toBe(true));
    // From `return` (column 4) to the right edge, the whole middle line, the last line up to `;`.
    expect(lines(v)[1]!.style.getPropertyValue("--lsp-occurrence-from")).toBe("calc(2.5px + 4ch)");
    expect(lines(v)[2]!.classList.contains("cm-lsp-occurrence")).toBe(true);
    const last = lines(v)[3]!.querySelector(".cm-lsp-occurrence")!;
    expect(last.textContent).toBe("        .c();");
    expect(lines(v)[0]!.className).not.toContain("cm-lsp-occurrence");
    expect(lines(v)[4]!.className).not.toContain("cm-lsp-occurrence");
  });

  it("keeps a single-line highlight on its text", async () => {
    cmd.lspDocumentHighlights.mockImplementation(() => ok([{ range: range(6, 11, 6, 12), kind: "read" }]));
    const v = editor(at(6, 11));
    highlightUsages(v);
    await vi.waitFor(() => expect(v.contentDOM.querySelectorAll(".cm-lsp-occurrence-read")).toHaveLength(1));
    expect(lines(v)[6]!.classList.contains("cm-lsp-occurrence")).toBe(false);
  });

  it("asks at once after a click, and after a pause for keyboard moves", async () => {
    const v = editor(0);
    click(v, at(6, 11));
    await vi.waitFor(() => expect(cmd.lspDocumentHighlights).toHaveBeenCalledTimes(1));
    v.dispatch({ selection: { anchor: at(6, 4) }, userEvent: "select" });
    await new Promise((r) => setTimeout(r, 20));
    expect(cmd.lspDocumentHighlights).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(cmd.lspDocumentHighlights).toHaveBeenCalledTimes(2));
  });

  it("shows the usages found before at once when the caret comes back to one", async () => {
    const a = [
      { range: range(5, 13, 5, 14), kind: "write" as const },
      { range: range(6, 11, 6, 12), kind: "read" as const },
    ];
    cmd.lspDocumentHighlights.mockImplementationOnce(() => ok(a));
    const v = editor(0);
    click(v, at(6, 11));
    await vi.waitFor(() => expect(v.contentDOM.querySelectorAll(".cm-lsp-occurrence")).toHaveLength(2));
    click(v, at(1, 4));
    await vi.waitFor(() => expect(v.contentDOM.querySelectorAll(".cm-lsp-occurrence")).toHaveLength(0));
    // The server is slow now: the remembered usages of `a` show without waiting for it.
    cmd.lspDocumentHighlights.mockImplementation(() => new Promise(() => {}));
    click(v, at(5, 13));
    await vi.waitFor(() => expect(v.contentDOM.querySelectorAll(".cm-lsp-occurrence")).toHaveLength(2));
  });

  it("forgets them after an edit", async () => {
    cmd.lspDocumentHighlights.mockImplementationOnce(() => ok([{ range: range(6, 11, 6, 12), kind: "read" }]));
    const v = editor(0);
    click(v, at(6, 11));
    await vi.waitFor(() => expect(v.contentDOM.querySelectorAll(".cm-lsp-occurrence")).toHaveLength(1));
    v.dispatch({ changes: { from: 0, insert: "\n" } });
    click(v, 0);
    await vi.waitFor(() => expect(v.contentDOM.querySelectorAll(".cm-lsp-occurrence")).toHaveLength(0));
    // Back on `a` with a slow server: the results of the document before the edit are not reused.
    cmd.lspDocumentHighlights.mockImplementation(() => new Promise(() => {}));
    click(v, at(6, 11) + 1);
    await vi.waitFor(() => expect(cmd.lspDocumentHighlights).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(v.contentDOM.querySelectorAll(".cm-lsp-occurrence")).toHaveLength(0);
  });
});
