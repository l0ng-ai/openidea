import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { findLanguageDescription, loadSupport } from "../core/cm/languages";
import type { SemanticTokens } from "@/platform/ipc";
import type { EditorDocContext } from "@/editor/api";
import { lspDoc } from "./lsp";
import { semanticExtension } from "./semantic";

const requests = vi.hoisted(() => [] as Array<(tokens: SemanticTokens) => void>);
vi.mock("./lsp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lsp")>()),
  lspRequest: () => new Promise<SemanticTokens>((resolve) => requests.push(resolve)),
}));
vi.mock("./availability", () => ({
  featureBackoff: () => ({ active: () => false, mark: () => {} }),
  onLspRefresh: () => () => {},
}));

afterEach(() => {
  vi.useRealTimers();
  requests.length = 0;
});

describe("semantic colours while typing", () => {
  it("colours a newly completed builtin and parameters before any LSP response", async () => {
    const support = await loadSupport(findLanguageDescription("Python", "demo.py")!);
    vi.useFakeTimers();
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "def f(x):\n    pri",
        extensions: [support!, lspDoc.of({ doc: 92, language: "python" } as EditorDocContext), semanticExtension()],
      }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(view.dom.querySelector(".cm-sem-python-builtin")).toBeNull();
      view.dispatch({ changes: { from: view.state.doc.length, insert: "nt(x)" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(0);
      expect(view.dom.querySelector(".cm-sem-python-builtin")?.textContent).toBe("print");
      expect(view.dom.querySelectorAll(".cm-sem-parameter")).toHaveLength(2);
    } finally {
      view.destroy();
    }
  });

  it("retains mapped server colours until the delayed response arrives, while updating syntax colours", async () => {
    const support = await loadSupport(findLanguageDescription("Python", "demo.py")!);
    vi.useFakeTimers();
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "def f(x):\n    print(x)",
        extensions: [support!, lspDoc.of({ doc: 91, language: "python" } as EditorDocContext), semanticExtension()],
      }),
    });
    try {
      await vi.advanceTimersByTimeAsync(600);
      requests.shift()!({
        tokenTypes: ["function", "parameter"],
        tokenModifiers: ["defaultLibrary"],
        data: [1, 4, 5, 0, 1, 1, 10, 1, 1, 0],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(view.dom.querySelector(".cm-sem-python-builtin")?.textContent).toBe("print");
      expect(view.dom.querySelector(".cm-sem-parameter")?.textContent).toBe("x");

      view.dispatch({ changes: { from: 0, insert: "# comment\n" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(view.dom.querySelector(".cm-sem-python-builtin")?.textContent).toBe("print");
      expect(view.dom.querySelector(".cm-sem-parameter")?.textContent).toBe("x");
      expect(view.dom.querySelector(".cm-sem-python-definition")?.textContent).toBe("f");

      await vi.advanceTimersByTimeAsync(600);
      expect(requests).toHaveLength(1);
      expect(view.dom.querySelector(".cm-sem-python-builtin")?.textContent).toBe("print");
      requests.shift()!({
        tokenTypes: ["function", "parameter"],
        tokenModifiers: ["defaultLibrary"],
        data: [2, 4, 5, 0, 1, 2, 10, 1, 1, 0],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(view.dom.querySelector(".cm-sem-python-builtin")?.textContent).toBe("print");
    } finally {
      view.destroy();
    }
  });
});
