import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { codeFolding, foldEffect, foldService, foldedRanges } from "@codemirror/language";
import {
  enclosingFoldRange,
  expandToLevelEffects,
  foldSelectionEffects,
  foldToExpand,
  foldsFromRanges,
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
      extensions: EditorState.languageData.of(() => [{ commentTokens: { line: "//" } }]),
    });
    const [f] = foldsFromRanges(s, [fold(1, 3)]);
    expect(f).toMatchObject({ from: s.doc.line(2).from + 2, to: s.doc.line(4).to, custom: true });
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
