import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

// One `property` token over the whole word, as jdtls reports an instance field.
const lspSemanticTokens = vi.fn(async () => ({
  status: "ok" as const,
  data: { data: [0, 0, 13, 0, 0], tokenTypes: ["property"], tokenModifiers: [] },
}));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, lspSemanticTokens } };
});

const { semanticExtension } = await import("./semantic");
const { lspDoc } = await import("./lsp");

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** A syntax-highlighter mark at the same precedence CodeMirror's `treeHighlighter` uses. */
const syntaxMark = (cls: string, from = 0, to = 13): Extension =>
  Prec.high(EditorView.decorations.of(Decoration.set([Decoration.mark({ class: cls }).range(from, to)])));

async function editor(extensions: Extension[]) {
  const view = new EditorView({
    state: EditorState.create({
      doc: "nasProperties",
      extensions: [
        lspDoc.of({ doc: 1, path: "/p/A.java", language: "java", uiMode: "Java", readOnly: false }),
        ...extensions,
      ],
    }),
  });
  document.body.append(view.dom);
  views.push(view);
  await vi.advanceTimersByTimeAsync(1000);
  return view;
}

describe("semantic decorations vs the syntax highlighter", () => {
  it("puts the semantic mark inside the syntax span, whichever is added last", async () => {
    vi.useFakeTimers();
    for (const extensions of [
      [semanticExtension(), syntaxMark("tok-variableName")],
      [syntaxMark("tok-variableName"), semanticExtension()],
    ]) {
      const view = await editor(extensions);
      const sem = view.contentDOM.querySelector(".cm-sem-property");
      expect(sem).not.toBeNull();
      // Inner nodes win their own colour: the field must not be wrapped by a
      // syntax span that re-sets `color`.
      expect(sem!.children.length).toBe(0);
      expect(lspSemanticTokens).toHaveBeenCalled();
      view.destroy();
    }
  });
});
