import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { codeFolding, foldEffect, foldService, foldable, foldedRanges } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import {
  backendFoldingChanged,
  backendFolds,
  enclosingFoldRange,
  expandToLevelEffects,
  foldSelectionEffects,
  foldsFromRanges,
  foldingExtension,
  foldToExpand,
  setBackendFolds,
} from "./folding";

/** Folds `{ … }` blocks whose header line ends with `{`. */
const braces = foldService.of((state, from, to) => {
  const line = state.doc.lineAt(from);
  if (!line.text.trimEnd().endsWith("{")) return null;
  let depth = 0;
  for (let pos = to - 1; pos < state.doc.length; pos++) {
    const ch = state.doc.sliceString(pos, pos + 1);
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return { from: to, to: pos };
  }
  return null;
});

const text = "fn a() {\n    if x {\n        y();\n    }\n    z();\n}\n";
const make = () => EditorState.create({ doc: text, extensions: [braces, codeFolding()] });

describe("enclosingFoldRange", () => {
  it("folds the caret line's own region first", () => {
    const s = make();
    const r = enclosingFoldRange(s, s.doc.line(2).from + 2)!;
    expect(s.doc.lineAt(r.from).number).toBe(2);
  });

  it("folds the innermost enclosing region from inside a body", () => {
    const s = make();
    expect(s.doc.lineAt(enclosingFoldRange(s, s.doc.line(3).from + 9)!.from).number).toBe(2);
    expect(s.doc.lineAt(enclosingFoldRange(s, s.doc.line(5).from + 4)!.from).number).toBe(1);
  });

  it("moves outward once the inner region is folded", () => {
    let s = make();
    const inner = enclosingFoldRange(s, s.doc.line(3).from + 9)!;
    s = s.update({ effects: foldEffect.of(inner) }).state;
    expect(s.doc.lineAt(enclosingFoldRange(s, s.doc.line(2).from + 2)!.from).number).toBe(1);
  });
});

describe("foldToExpand", () => {
  it("expands the outermost fold hiding the caret first", () => {
    let s = make();
    const inner = enclosingFoldRange(s, s.doc.line(3).from + 9)!;
    s = s.update({ effects: foldEffect.of(inner) }).state;
    const outer = enclosingFoldRange(s, s.doc.line(3).from + 9)!;
    s = s.update({ effects: foldEffect.of(outer) }).state;
    expect(foldToExpand(s, s.doc.line(3).from + 9)).toEqual(outer);
  });

  it("expands a fold on the caret line when the caret is on its header", () => {
    let s = make();
    const inner = enclosingFoldRange(s, s.doc.line(2).from + 2)!;
    s = s.update({ effects: foldEffect.of(inner) }).state;
    expect(foldToExpand(s, s.doc.line(2).from + 2)).toEqual(inner);
    expect(foldToExpand(s, s.doc.line(5).from + 2)).toBeNull();
  });
});

describe("foldsFromRanges", () => {
  const fold = (start_line: number, end_line: number) => ({ start_line, end_line, kind: "region" as const });

  it("collapses an import group beginning with a multiline statement to import only", () => {
    const s = EditorState.create({
      doc: [
        "import Widget, {",
        "  Formatter,",
        "  parseValue,",
        "} from './format.js';",
        "import { render } from './view.js';",
        "",
      ].join("\n"),
      extensions: [foldingExtension(false)],
    });
    const ranges = [{ start_line: 0, end_line: 4, kind: "imports" as const }];
    const [f] = foldsFromRanges(s, ranges);
    expect(f).toEqual({ from: "import ".length, to: s.doc.line(5).to, kind: "imports" });
    const state = s.update({ effects: setBackendFolds.of(ranges) }).state;
    expect(foldable(state, state.doc.line(1).from, state.doc.line(1).to)).toEqual({ from: f!.from, to: f!.to });
    const view = new EditorView({ state, parent: document.createElement("div") });
    view.dispatch({ effects: foldEffect.of({ from: f!.from, to: f!.to }) });
    expect(view.dom.querySelector(".cm-line")?.textContent).toBe("import …");
    view.destroy();
  });

  it("starts an Allman block's fold on its declaration line", () => {
    const s = EditorState.create({ doc: "namespace Demo\n{\n    class A\n    {\n    }\n}\n" });
    const folds = foldsFromRanges(s, [fold(1, 5), fold(3, 4)]);
    expect(folds.map((f) => [s.doc.lineAt(f.from).number, s.sliceDoc(f.to, f.to + 1)])).toEqual([
      [1, "}"],
      [3, "}"],
    ]);
  });

  it("hides the closing line of a multiline import at the end of an import run", () => {
    const s = EditorState.create({
      doc: [
        "import { ZodError } from 'zod'",
        "import { Library } from './library.js'",
        "import {",
        "  creationPromptVersion,",
        "  generateCreationIntent,",
        "  validateCreationIntent,",
        "  validationPromptVersion,",
        "  type CreationAgentConfig,",
        "  type CreationIntent,",
        "  type IntentValidation,",
        "} from './mastra/agents/creation-assistant.js'",
        "",
      ].join("\n"),
    });
    expect(foldsFromRanges(s, [{ start_line: 0, end_line: 10, kind: "imports" }])).toEqual([
      { from: s.doc.line(1).to, to: s.doc.line(11).to, kind: "imports" },
    ]);
  });

  it("keeps a bare closing delimiter of an import block visible", () => {
    const go = EditorState.create({ doc: 'package main\n\nimport (\n  "fmt"\n  "os"\n)\n' });
    expect(foldsFromRanges(go, [{ start_line: 2, end_line: 5, kind: "imports" }])).toEqual([
      { from: go.doc.line(3).to, to: go.doc.line(6).from, kind: "imports" },
    ]);
    const rust = EditorState.create({ doc: "use a::{\n  b,\n  c,\n};\n" });
    expect(foldsFromRanges(rust, [{ start_line: 0, end_line: 3, kind: "imports" }])).toEqual([
      { from: rust.doc.line(1).to, to: rust.doc.line(4).from, kind: "imports" },
    ]);
  });

  it("folds a custom region from its start marker through its end marker", () => {
    const s = EditorState.create({
      doc: "class A {\n  //region Fields\n  int a;\n  //endregion\n}\n",
      extensions: [EditorState.languageData.of(() => [{ commentTokens: { line: "//" } }]), foldingExtension(false)],
    });
    const [f] = foldsFromRanges(s, [fold(1, 3)]);
    expect(f).toMatchObject({ from: s.doc.line(2).from + 2, to: s.doc.line(4).to, custom: true });
    const view = new EditorView({
      state: s.update({ effects: setBackendFolds.of([fold(1, 3)]) }).state,
      parent: document.createElement("div"),
    });
    view.dispatch({ effects: foldEffect.of({ from: f!.from, to: f!.to }) });
    expect(view.dom.querySelector(".cm-foldPlaceholder")?.textContent).toBe("Fields");
    view.destroy();
  });

  it("keeps a brace line that follows a statement or comment", () => {
    const s = EditorState.create({ doc: "x();\n{\n    y();\n}\n// c\n{\n}\n" });
    expect(foldsFromRanges(s, [fold(1, 3), fold(5, 6)]).map((f) => s.doc.lineAt(f.from).number)).toEqual([2, 6]);
  });
});

describe("foldSelectionEffects (⌘.)", () => {
  it("folds the selection and expands it again from the caret", () => {
    let s = EditorState.create({ doc: text, selection: { anchor: 9, head: 30 }, extensions: [codeFolding()] });
    s = s.update({ effects: foldSelectionEffects(s), selection: { anchor: 30 } }).state;
    const folded: Array<[number, number]> = [];
    foldedRanges(s).between(0, s.doc.length, (a, b) => void folded.push([a, b]));
    expect(folded).toEqual([[9, 30]]);
    s = s.update({ effects: foldSelectionEffects(s) }).state;
    expect(foldedRanges(s).size).toBe(0);
  });
});

describe("expandToLevelEffects", () => {
  const folded = (s: EditorState) => {
    const out: number[] = [];
    foldedRanges(s).between(0, s.doc.length, (a) => void out.push(s.doc.lineAt(a).number));
    return out;
  };

  it("Expand All to Level 1 keeps top-level regions open and folds nested ones", () => {
    let s = make();
    s = s.update({ effects: expandToLevelEffects(s, 1, true) }).state;
    expect(folded(s)).toEqual([2]);
    s = s.update({ effects: expandToLevelEffects(s, 2, true) }).state;
    expect(folded(s)).toEqual([]);
  });

  it("Expand to Level counts from the region around the caret", () => {
    let s = make().update({ selection: { anchor: text.indexOf("y()") } }).state;
    s = s.update({ effects: expandToLevelEffects(s, 1, true) }).state;
    s = s.update({ selection: { anchor: text.indexOf("z()") } }).state;
    expect(folded(s.update({ effects: expandToLevelEffects(s, 2) }).state)).toEqual([]);
  });
});

describe("fold gutter chevrons", () => {
  const doc = ["def f():", '    """doc', "    more", '    """', "    pass"].join("\n");

  it("backendFoldingChanged fires when backend folds arrive, not on selection moves", () => {
    let changed = false;
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          foldingExtension(true),
          // The same predicate the fold gutter's foldingChanged hook uses.
          EditorView.updateListener.of((u) => {
            if (backendFoldingChanged(u)) changed = true;
          }),
        ],
      }),
      parent: document.body,
    });
    view.dispatch({ effects: setBackendFolds.of([{ start_line: 1, end_line: 3, kind: "comment" }]) });
    expect(changed).toBe(true);
    changed = false;
    view.dispatch({ selection: { anchor: 0 } });
    expect(changed).toBe(false);
    view.destroy();
  });

  it("the gutter shows a chevron after backend folds arrive", () => {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [foldingExtension(true)] }),
      parent: document.body,
    });
    const markers = () =>
      Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-foldGutter .cm-gutterElement")).map(
        (el) => el.firstElementChild?.className ?? "",
      );
    const before = markers();
    view.dispatch({ effects: setBackendFolds.of([{ start_line: 1, end_line: 3, kind: "comment" }]) });
    const after = markers();
    expect(after.join("|")).not.toBe(before.join("|"));
    view.destroy();
  });
});

describe("fold placeholder chip", () => {
  const doc = ["def f():", '    """doc', "    more", '    """', "    pass"].join("\n");

  function foldedView() {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [foldingExtension(true)] }),
      parent: document.body,
    });
    view.dispatch({ effects: setBackendFolds.of([{ start_line: 1, end_line: 3, kind: "comment" }]) });
    return view;
  }

  function folded(view: ReturnType<typeof foldedView>) {
    const out: Array<[number, number]> = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (a, b) => void out.push([a, b]));
    return out;
  }

  function fold(view: ReturnType<typeof foldedView>) {
    const [f] = view.state.field(backendFolds);
    view.dispatch({ effects: foldEffect.of({ from: f!.from, to: f!.to }) });
  }

  it("clicking the chip expands the fold, repeatedly", () => {
    const view = foldedView();
    for (let i = 0; i < 3; i++) {
      fold(view);
      const chip = view.dom.querySelector<HTMLElement>(".cm-foldPlaceholder");
      expect(chip, `iteration ${i}`).not.toBeNull();
      chip!.click();
      expect(folded(view), `iteration ${i}`).toEqual([]);
    }
    view.destroy();
  });

  it("a chip starting inside a comment still expands", () => {
    const view = foldedView();
    const [f] = view.state.field(backendFolds);
    expect(view.state.doc.sliceString(f!.from, f!.from + 3)).toBe('"""');
    fold(view);
    const chip = view.dom.querySelector<HTMLElement>(".cm-foldPlaceholder")!;
    chip.click();
    expect(folded(view)).toEqual([]);
    view.destroy();
  });

  it("the chip swallows mousedown so a caret move cannot replace it before the click", () => {
    const view = foldedView();
    fold(view);
    const chip = view.dom.querySelector<HTMLElement>(".cm-foldPlaceholder")!;
    // A mousedown must not reach the editor: CM turns it into a mouse selection
    // that moves the caret, and the caret change re-runs the inline blame refresh,
    // which rebuilds this line's DOM and detaches the chip between mousedown and
    // click, so the browser drops the click. jsdom cannot reproduce the DOM
    // replacement; this locks the handler contract.
    let reachedEditor = false;
    view.contentDOM.addEventListener("mousedown", () => (reachedEditor = true));
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    chip.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(reachedEditor).toBe(false);
    // The click still expands.
    chip.click();
    expect(folded(view)).toEqual([]);
    view.destroy();
  });
});

describe("comment placeholders", () => {
  it("folds JavaScript documentation through the syntax fallback", () => {
    const doc = "/**\n * Adds a user.\n * More detail.\n */\nfunction addUser() {}";
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [javascript(), foldingExtension(false)] }),
      parent: document.createElement("div"),
    });
    const first = view.state.doc.line(1);
    const range = foldable(view.state, first.from, first.to)!;
    view.dispatch({ effects: foldEffect.of(range) });
    expect(view.dom.querySelector(".cm-line")?.textContent).toBe("/** Adds a user. ...*/");
    view.dom.querySelector<HTMLElement>(".cm-foldPlaceholder")!.click();
    expect(foldedRanges(view.state).size).toBe(0);
    view.dispatch({ effects: setBackendFolds.of([{ start_line: 0, end_line: 3, kind: "comment" }]) });
    view.dispatch({ effects: foldEffect.of(foldable(view.state, first.from, first.to)!) });
    expect(view.dom.querySelector(".cm-line")?.textContent).toBe("/** Adds a user. ...*/");
    view.destroy();
  });

  it.each([
    ["/** Returns the visitor name.\n * This line is folded.\n */\nconst value = 1;", 2, "/**...*/"],
    [
      "/*\n * Ordinary block comment for comparison.\n * It is not a documentation comment.\n */\nconst value = 1;",
      3,
      "/* Ordinary block comment for comparison. ...*/",
    ],
  ])(
    "folds JavaScript block comments like IDEA with the syntax fallback and backend range in %s",
    (doc, endLine, expected) => {
      const view = new EditorView({
        state: EditorState.create({ doc, extensions: [javascript(), foldingExtension(false)] }),
        parent: document.createElement("div"),
      });
      const first = view.state.doc.line(1);
      view.dispatch({ effects: foldEffect.of(foldable(view.state, first.from, first.to)!) });
      expect(view.dom.querySelector(".cm-line")?.textContent).toBe(expected);
      view.dom.querySelector<HTMLElement>(".cm-foldPlaceholder")!.click();
      view.dispatch({ effects: setBackendFolds.of([{ start_line: 0, end_line: endLine, kind: "comment" }]) });
      view.dispatch({ effects: foldEffect.of(foldable(view.state, first.from, first.to)!) });
      expect(view.dom.querySelector(".cm-line")?.textContent).toBe(expected);
      view.destroy();
    },
  );

  function foldComment(doc: string, endLine: number) {
    const state = EditorState.create({ doc, extensions: [foldingExtension(false)] }).update({
      effects: setBackendFolds.of([{ start_line: 0, end_line: endLine, kind: "comment" }]),
    }).state;
    const view = new EditorView({ state, parent: document.createElement("div") });
    const range = view.state.field(backendFolds)[0]!;
    expect(foldable(view.state, view.state.doc.line(1).from, view.state.doc.line(1).to)).toEqual({
      from: range.from,
      to: range.to,
    });
    view.dispatch({ effects: foldEffect.of({ from: range.from, to: range.to }) });
    return { view, range };
  }

  it.each([
    ["/**\n * Adds a user.\n * More detail.\n */", 3, "/** Adds a user. ...*/"],
    ["/** Saves.\n * More detail.\n */", 2, "/**...*/"],
    ["/**ill-formed summary\n * More detail\n */", 2, "/**...*/"],
    ["/**\n * Saves.\n */", 2, "/** Saves. */"],
    ["/** Saves.\n *\n */", 2, "/**...*/"],
    ["/**\n */", 1, "/***/"],
    ["/*\n * Ordinary comment.\n * More detail.\n */", 3, "/* Ordinary comment. ...*/"],
    ["/*\n * Single summary.\n */", 2, "/* Single summary. */"],
    ["/**\n * 添加 😀 用户。\n * 更多说明。\n */", 3, "/** 添加 😀 用户。 ...*/"],
    ["/**\n * Builds `User` data.\n * @return the result\n */", 3, "/** Builds `User` data. ...*/"],
    [
      "/**\n * @param {number} count total\n * @returns {string} label\n */",
      3,
      "/** @param {number} count total ...*/",
    ],
    ["/**\n * @param int $count total\n * @return string label\n */", 3, "/** @param int $count total ...*/"],
    ["/**\n *\n * Late summary.\n */", 3, "/**...*/"],
    ["/// Adds a user.\n/// More detail.", 1, "/// Adds a user. ..."],
    ["///No space.\n///More detail.", 1, "///No space. ..."],
    ["///\n/// Summary.\n///", 2, "/// Summary. ..."],
    ["//! Module docs.\n//! More detail.", 1, "//! Module docs. ..."],
    ['"""Module docs.\nMore detail.\n"""', 2, '"""Module docs. ..."""'],
    ['@doc ~S"""\n  Function docs.\n  More detail.\n  """', 3, '@doc ~S""" Function docs. ..."""'],
  ])("shows the source syntax and summary for %s", (doc, endLine, expected) => {
    const { view } = foldComment(doc, endLine);
    expect(view.dom.querySelector(".cm-line")?.textContent).toBe(expected);
    view.dom.querySelector<HTMLElement>(".cm-foldPlaceholder")!.click();
    expect(foldedRanges(view.state).size).toBe(0);
    view.destroy();
  });

  it.each([
    ["// Ordinary comment.\n// More detail.", 1, "// Ordinary comment.…"],
    ["/// Docs.\n// Ordinary comment.", 1, "/// Docs.…"],
  ])("keeps the existing placeholder for line comments in %s", (doc, endLine, expected) => {
    const { view } = foldComment(doc, endLine);
    expect(view.dom.querySelector(".cm-line")?.textContent).toBe(expected);
    view.destroy();
  });

  it("preserves code following the closing marker", () => {
    const { view, range } = foldComment("/**\n * First.\n * More detail.\n */ int value;", 3);
    expect(view.state.doc.sliceString(range.to)).toBe(" int value;");
    expect(view.dom.querySelector(".cm-line")?.textContent).toBe("/** First. ...*/ int value;");
    view.destroy();
  });

  it("preserves indentation before a documentation comment", () => {
    const { view, range } = foldComment("  /**\n   * Summary.\n   */\n  class A {}", 2);
    expect(range.from).toBe(2);
    expect(view.dom.querySelector(".cm-line")?.textContent).toBe("  /** Summary. */");
    view.destroy();
  });
});
