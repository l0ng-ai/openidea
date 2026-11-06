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

describe("semanticRanges classification (gopls legend, absolute positions)", () => {
  // The subset of gopls v0.23's legend the classification depends on.
  const TYPES = ["namespace", "type", "parameter", "property", "variable", "function", "method"];
  const MODS = ["definition", "readonly", "static", "defaultLibrary"];
  type Row = [line: number, col: number, len: number, type: string, mods: string[]];
  const pack = (rows: Row[]) => ({
    data: rows.flatMap(([line, col, len, type, mods]) => [
      line,
      col,
      len,
      TYPES.indexOf(type),
      MODS.reduce((bits, mod, i) => (mods.includes(mod) ? bits | (1 << i) : bits), 0),
    ]),
    tokenTypes: TYPES,
    tokenModifiers: MODS,
  });
  /** `text: class list` per range, in document order. */
  const classify = (source: string, rows: Row[], language = "go", rainbow = false) => {
    const doc = EditorState.create({ doc: source }).doc;
    return semanticRanges(doc, pack(rows), rainbow, language).map(
      (r) => `${doc.sliceString(r.from, r.to)}: ${r.className}`,
    );
  };

  it("gopls consts (`variable`+`readonly`, no `static`) are constants", () => {
    expect(classify("const ErrNotFound = 1\n", [[0, 6, 11, "variable", ["definition", "readonly"]]])).toEqual([
      "ErrNotFound: cm-sem-constant cm-sem-declaration",
    ]);
  });

  it("gopls package-level vars (`variable`+`static`) are global variables", () => {
    expect(classify("var notes = 1\n", [[0, 4, 5, "variable", ["definition", "static"]]])).toEqual([
      "notes: cm-sem-global cm-sem-declaration cm-sem-static",
    ]);
  });

  it("package qualifiers get the namespace class", () => {
    expect(
      classify("fmt.Println(1)\n", [
        [0, 0, 3, "namespace", []],
        [0, 4, 7, "function", []],
      ]),
    ).toEqual(["fmt: cm-sem-namespace", "Println: cm-sem-function"]);
  });

  it("declarations vs calls of functions and methods", () => {
    expect(
      classify("func New() {}\ns.New()\n", [
        [0, 5, 3, "function", ["definition"]],
        [1, 0, 1, "parameter", []],
        [1, 2, 3, "method", []],
      ]),
    ).toEqual(["New: cm-sem-function cm-sem-declaration", "s: cm-sem-parameter", "New: cm-sem-function"]);
  });

  it("local variables carry no colour class unless rainbow is on", () => {
    const rows: Row[] = [
      [0, 0, 1, "variable", ["definition"]],
      [0, 5, 1, "variable", []],
    ];
    // The declaration mark is unstyled on its own; plain uses are dropped entirely.
    expect(classify("x := x\n", rows)).toEqual(["x: cm-sem-declaration"]);
    expect(classify("x := x\n", rows, "go", true).length).toBe(2);
  });

  it("`variable`+`readonly` only means constant for Go", () => {
    // A `const` local in TypeScript (`variable`+`readonly`, no `static`) keeps the plain variable
    // treatment outside Go.
    expect(classify("const x = 1\n", [[0, 6, 1, "variable", ["readonly"]]], "typescript")).toEqual([]);
  });

  it("`readonly`+`static` still means constant without the Go rule (rust-analyzer, jdtls)", () => {
    expect(classify("MAX = 1\n", [[0, 0, 3, "variable", ["definition", "readonly", "static"]]], "rust")).toEqual([
      "MAX: cm-sem-constant cm-sem-declaration cm-sem-static",
    ]);
  });

  it("instance fields keep the property class (jdtls shape)", () => {
    expect(classify("nasProperties\n", [[0, 0, 13, "property", []]], "java")).toEqual([
      "nasProperties: cm-sem-property",
    ]);
  });
});
