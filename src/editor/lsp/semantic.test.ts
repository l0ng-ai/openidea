import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Prec, Text, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

// One `property` token over the whole word, as jdtls reports an instance field.
const lspSemanticTokens = vi.fn(async () => ({
  status: "ok" as const,
  data: { data: [0, 0, 13, 0, 0], tokenTypes: ["property"], tokenModifiers: [] as string[] },
}));

vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, lspSemanticTokens } };
});

const { semanticExtension, semanticRanges } = await import("./semantic");
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

describe("the `global` token modifier", () => {
  it("gives a `global` variable the cm-sem-global class", async () => {
    vi.useFakeTimers();
    lspSemanticTokens.mockResolvedValueOnce({
      status: "ok" as const,
      data: { data: [0, 0, 13, 0, 0b01], tokenTypes: ["variable"], tokenModifiers: ["global"] },
    });
    const view = await editor([semanticExtension()]);
    const span = view.contentDOM.querySelector(".cm-sem-global");
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe("nasProperties");
  });

  it("colors globals but keeps them out of the rainbow", () => {
    const doc = Text.of(["Config = {}", "print(Config)"]);
    const tokens = {
      data: [
        0,
        0,
        6,
        0,
        0b01, // `Config` (line 1): variable + global
        1,
        6,
        6,
        0,
        0b01, // `Config` (line 2): variable + global
      ],
      tokenTypes: ["variable"],
      tokenModifiers: ["global"],
    };
    const plain = semanticRanges(doc, tokens);
    expect(plain.map((r) => r.className)).toEqual(["cm-sem-global", "cm-sem-global"]);
    // NOT_LOCAL: globals stay out of the rainbow even with the setting on.
    const rainbow = semanticRanges(doc, tokens, true);
    expect(rainbow.map((r) => r.className)).toEqual(["cm-sem-global", "cm-sem-global"]);
  });

  it("keeps library globals on the builtin classes for the CSS to rank", () => {
    const doc = Text.of(["print(Config)"]);
    const tokens = {
      data: [
        0,
        0,
        5,
        1,
        0b11, // `print`: function + global + defaultLibrary
        0,
        6,
        6,
        0,
        0b11, // `Config`: variable + global + defaultLibrary
      ],
      tokenTypes: ["variable", "function"],
      tokenModifiers: ["global", "defaultLibrary"],
    };
    expect(semanticRanges(doc, tokens).map((r) => r.className)).toEqual([
      "cm-sem-function cm-sem-global cm-sem-builtin",
      "cm-sem-global cm-sem-builtin",
    ]);
  });

  it("still rainbows a plain local", () => {
    const doc = Text.of(["local value = 1"]);
    const tokens = { data: [0, 6, 5, 0, 0], tokenTypes: ["variable"], tokenModifiers: [] };
    const [range] = semanticRanges(doc, tokens, true);
    expect(range!.className).toMatch(/^cm-sem-rainbow-[1-5]$/);
  });
});
