import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect, foldService, foldedRanges, indentService, indentUnit } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
  deleteLine,
  deleteWordBackward,
  duplicateLineOrSelection,
  moveStatementDown,
  moveStatementUp,
  nextOccurrence,
  occurrenceSearch,
  selectAllOccurrences,
  unselectOccurrence,
} from "./editing";
import { caretExtension, pasteReindentFilter } from "./prefs";
import { closesStringAt, skipClosingQuote } from "./smartKeys";
import {
  collapseAllEffects,
  collapseRecursivelyEffects,
  expandRecursivelyEffects,
  foldSelectionEffects,
} from "./folding";
import { columnModeExtension, extendBlock, toggleColumnMode } from "./columnMode";
import { nearestMark, unfoldAround } from "./lanes";
import { lineRangeSelection } from "./gutterDrag";
import { matchBraceTarget } from "./caretCommands";
import { overwriteField, toggleOverwrite } from "./overwrite";
import { validateEditorExtras } from "@/platform/editorSettings";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** `|` marks carets, `[`/`]` a selection. */
function make(text: string, extensions: Extension = []) {
  const ranges: ReturnType<typeof EditorSelection.cursor>[] = [];
  let doc = "";
  let anchor = -1;
  for (const ch of text) {
    if (ch === "|") ranges.push(EditorSelection.cursor(doc.length));
    else if (ch === "[") anchor = doc.length;
    else if (ch === "]") ranges.push(EditorSelection.range(anchor, doc.length));
    else doc += ch;
  }
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(ranges.length ? ranges : [EditorSelection.cursor(0)]),
      extensions: [EditorState.allowMultipleSelections.of(true), indentUnit.of("  "), occurrenceSearch, extensions],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function show(view: EditorView): string {
  const { doc, selection } = view.state;
  let out = doc.toString();
  for (const r of [...selection.ranges].sort((a, b) => b.from - a.from))
    out = r.empty
      ? out.slice(0, r.head) + "|" + out.slice(r.head)
      : out.slice(0, r.from) + "[" + out.slice(r.from, r.to) + "]" + out.slice(r.to);
  return out;
}

const javascript = await languages.find((l) => l.name === "JavaScript")!.load();

describe("Move Statement", () => {
  it("moves a multi-line statement as a whole, never one of its lines", () => {
    const v = make("function f() {\n  a();\n  |foo(\n    1,\n    2);\n}", javascript);
    moveStatementUp(v);
    expect(v.state.doc.toString()).toBe("function f() {\n  foo(\n    1,\n    2);\n  a();\n}");
    moveStatementDown(v);
    expect(v.state.doc.toString()).toBe("function f() {\n  a();\n  foo(\n    1,\n    2);\n}");
  });

  it("moves into a block past its header and out of it past its closing brace, re-indented", () => {
    const v = make("function f() {\n  |a();\n  if (x) {\n    b();\n  }\n}", javascript);
    moveStatementDown(v);
    expect(show(v)).toBe("function f() {\n  if (x) {\n    |a();\n    b();\n  }\n}");
    moveStatementDown(v);
    moveStatementDown(v);
    expect(show(v)).toBe("function f() {\n  if (x) {\n    b();\n  }\n  |a();\n}");
  });

  it("never carries a statement out of its function", () => {
    const v = make("function f() {\n  |a();\n}\nb();", javascript);
    moveStatementUp(v);
    expect(v.state.doc.toString()).toBe("function f() {\n  a();\n}\nb();");
    moveStatementDown(v);
    expect(v.state.doc.toString()).toBe("function f() {\n  a();\n}\nb();");
  });

  it("passes a neighbouring function as a whole", () => {
    const v = make("|a();\nfunction f() {\n  b();\n}", javascript);
    moveStatementDown(v);
    expect(v.state.doc.toString()).toBe("function f() {\n  b();\n}\na();");
  });
});

describe("occurrences", () => {
  it("⌃G from a caret selects the word, then whole-word matches after the last added one", () => {
    const v = make("fo|o foobar foo foo");
    expect(nextOccurrence(v)).toBe("selected");
    expect(show(v)).toBe("[foo] foobar foo foo");
    expect(nextOccurrence(v)).toBe("added");
    expect(show(v)).toBe("[foo] foobar [foo] foo");
  });

  it("matches inside words for a selection made by hand", () => {
    const v = make("[foo] foobar foo");
    nextOccurrence(v);
    expect(show(v)).toBe("[foo] [foo]bar foo");
  });

  it("reports nothing found once, then searches from the top", () => {
    const v = make("foo x [foo]");
    expect(nextOccurrence(v)).toBe("notFound");
    expect(nextOccurrence(v)).toBe("added");
    expect(show(v)).toBe("[foo] x [foo]");
  });

  it("⌃⌘G from a caret selects whole-word occurrences only", () => {
    const v = make("a|b abc ab");
    selectAllOccurrences(v);
    expect(show(v)).toBe("[ab] abc [ab]");
  });

  it("⌃⇧G keeps the whole-word run going", () => {
    const v = make("|ab abc ab ab");
    nextOccurrence(v);
    nextOccurrence(v);
    nextOccurrence(v);
    unselectOccurrence(v);
    nextOccurrence(v);
    expect(show(v)).toBe("[ab] abc [ab] [ab]");
  });
});

describe("folded lines", () => {
  const braces = foldService.of((state, from, to) => {
    const line = state.doc.lineAt(from);
    if (!line.text.endsWith("{")) return null;
    const close = state.doc.toString().indexOf("}", to);
    return close > to ? { from: to, to: close } : null;
  });
  const folded = () => {
    const v = make("x\nf() {\n  a;\n}\ny", [braces, codeFolding()]);
    v.dispatch({ effects: foldEffect.of({ from: 7, to: 13 }), selection: { anchor: 3 } });
    return v;
  };

  it("⌘D on a folded region's line duplicates the whole folded block", () => {
    const v = folded();
    duplicateLineOrSelection(v);
    expect(v.state.doc.toString()).toBe("x\nf() {\n  a;\n}\nf() {\n  a;\n}\ny");
    expect(v.state.selection.main.head).toBe(16);
  });

  it("⌘⌫ on a folded region's line deletes the whole folded block", () => {
    const v = folded();
    deleteLine(v);
    expect(v.state.doc.toString()).toBe("x\ny");
  });
});

describe("Delete to Word Start", () => {
  it("deletes the whitespace before the caret and the word before it", () => {
    const v = make("foo bar  |");
    deleteWordBackward(v);
    expect(show(v)).toBe("foo |");
    const w = make("a.b(|");
    deleteWordBackward(w);
    expect(show(w)).toBe("a.b|");
  });
});

describe("paste reformatting", () => {
  /** One unit deeper after a line ending in `{`. */
  const braceIndent = indentService.of((cx, pos) => {
    const line = cx.state.doc.lineAt(pos);
    if (line.number === 1) return 0;
    const prev = cx.state.doc.line(line.number - 1);
    const base = cx.lineIndent(prev.from);
    return prev.text.trimEnd().endsWith("{") ? base + 2 : base;
  });
  const paste = (v: EditorView, text: string) =>
    v.dispatch({
      changes: { from: v.state.selection.main.from, to: v.state.selection.main.to, insert: text },
      userEvent: "input.paste",
    });

  it("indents each pasted line (IDEA's default)", () => {
    const v = make("if {\n|\n}", [braceIndent, pasteReindentFilter("indentEachLine")]);
    paste(v, "a();\n      b();\n  c();");
    expect(v.state.doc.toString()).toBe("if {\n  a();\n  b();\n  c();\n}");
  });

  it("starts a block pasted at a line's indentation at the proper indent", () => {
    const v = make("if {\n|\n}", [braceIndent, pasteReindentFilter("indentBlock")]);
    paste(v, "a();\n    b();\n  c();");
    expect(v.state.doc.toString()).toBe("if {\n  a();\n    b();\n  c();\n}");
  });
});

describe("closing quotes", () => {
  it("steps over the closing quote of an existing string literal", () => {
    const v = make('f("ab|");', [javascript, skipClosingQuote]);
    expect(closesStringAt(v.state, v.state.selection.main.head, '"')).toBe(true);
    expect(closesStringAt(v.state, 2, '"')).toBe(false);
    const handled = v.state.facet(EditorView.inputHandler).some((h) => h(v, 5, 5, '"', () => v.state.update({})));
    expect(handled).toBe(true);
    expect(show(v)).toBe('f("ab"|);');
  });
});

describe("folding actions", () => {
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
  const text = "a {\n  b {\n    c;\n  }\n}\nd {\n}\n";
  const state = (sel?: { anchor: number; head?: number }) =>
    EditorState.create({ doc: text, selection: sel, extensions: [braces, codeFolding()] });
  const foldedOf = (s: EditorState) => {
    const out: number[] = [];
    foldedRanges(s).between(0, s.doc.length, (a) => void out.push(s.doc.lineAt(a).number));
    return out.sort((a, b) => a - b);
  };

  it("Collapse All folds nested regions too; with a selection only those inside it", () => {
    let s = state();
    s = s.update({ effects: collapseAllEffects(s) }).state;
    expect(foldedOf(s)).toEqual([1, 2, 6]);
    s = state({ anchor: 4, head: 21 });
    s = s.update({ effects: collapseAllEffects(s) }).state;
    expect(foldedOf(s)).toEqual([2]);
  });

  it("collapses and expands recursively", () => {
    let s = state({ anchor: 1 });
    s = s.update({ effects: collapseRecursivelyEffects(s, 1) }).state;
    expect(foldedOf(s)).toEqual([1, 2]);
    s = s.update({ effects: expandRecursivelyEffects(s, 1) }).state;
    expect(foldedOf(s)).toEqual([]);
  });

  it("⌘. folds a selection without its trailing line break and toggles the region at a caret", () => {
    let s = state({ anchor: 4, head: 23 });
    const fold = foldSelectionEffects(s)[0]!;
    expect(fold.is(foldEffect) && fold.value).toEqual({ from: 4, to: 22 });
    s = state({ anchor: 12 });
    s = s.update({ effects: foldSelectionEffects(s) }).state;
    expect(foldedOf(s)).toEqual([2]);
    s = s.update({ effects: foldSelectionEffects(s) }).state;
    expect(foldedOf(s)).toEqual([]);
  });
});

describe("column selection", () => {
  it("keeps the block in visual columns across tabs", () => {
    const v = make("\tab\n    cd", [columnModeExtension, EditorState.tabSize.of(4)]);
    v.dispatch({ selection: { anchor: 1 } });
    toggleColumnMode(v);
    extendBlock(v, 1, 0);
    extendBlock(v, 0, 1);
    expect(v.state.selection.ranges.map((r) => [r.anchor, r.head])).toEqual([
      [1, 2],
      [8, 9],
    ]);
  });
});

describe("error stripe", () => {
  it("picks the nearest mark within the tolerance", () => {
    const marks = [
      { top: 10, bottom: 12, pos: 1 },
      { top: 30, bottom: 32, pos: 2 },
    ];
    expect(nearestMark(marks, 15)?.pos).toBe(1);
    expect(nearestMark(marks, 27)?.pos).toBe(2);
    expect(nearestMark(marks, 21)).toBeNull();
  });

  it("unfolds what hides the target line", () => {
    const s = EditorState.create({ doc: "f {\n  x\n}", extensions: [codeFolding()] }).update({
      effects: foldEffect.of({ from: 3, to: 8 }),
    }).state;
    expect(unfoldAround(s, 0)).toHaveLength(1);
  });
});

describe("gutter drag", () => {
  it("selects whole lines in either direction", () => {
    const s = EditorState.create({ doc: "a\nb\nc\nd" });
    expect(lineRangeSelection(s, 2, 3).main).toMatchObject({ anchor: 2, head: 6 });
    expect(lineRangeSelection(s, 3, 1).main).toMatchObject({ anchor: 6, head: 0 });
    expect(lineRangeSelection(s, 4, 4).main).toMatchObject({ anchor: 6, head: 7 });
  });
});

describe("Move Caret to Matching Brace", () => {
  it("jumps between braces, else to the unclosed opening brace", () => {
    const s = EditorState.create({ doc: "f(a, [b], c)" });
    expect(matchBraceTarget(s, 1)).toBe(12);
    expect(matchBraceTarget(s, 12)).toBe(1);
    expect(matchBraceTarget(s, 3)).toBe(1);
  });
});

describe("overwrite mode", () => {
  it("replaces the characters after the caret, never the line break", () => {
    const v = make("ab|cd\nx", overwriteField);
    toggleOverwrite(v);
    expect(v.dom.classList.contains("cm-openidea-blockCaret")).toBe(true);
    const type = (text: string) =>
      v.state
        .facet(EditorView.inputHandler)
        .some((h) => h(v, v.state.selection.main.from, v.state.selection.main.to, text, () => v.state.update({})));
    type("XYZ");
    expect(show(v)).toBe("abXYZ|\nx");
  });
});

describe("smooth caret", () => {
  const caret = (appearance: object) => caretExtension(validateEditorExtras({ appearance }));

  it("marks the editor for smooth blinking and the chosen movement curve", () => {
    const v = make(
      "ab|c",
      caret({ smoothCaretBlinking: true, smoothCaretMovement: true, caretMovementStyle: "gliding" }),
    );
    expect(v.dom.classList.contains("cm-openidea-smoothCaretBlink")).toBe(true);
    expect(v.dom.classList.contains("cm-openidea-caretMotion-gliding")).toBe(true);
    const plain = make("ab|c", caret({ smoothCaretBlinking: false, smoothCaretMovement: false }));
    expect(plain.dom.className).not.toMatch(/smoothCaretBlink|caretMotion/);
  });

  it("glides selection-only moves and puts the caret in place at once when typing", () => {
    const v = make("ab|c", caret({ smoothCaretMovement: true }));
    const layer = v.scrollDOM.querySelector(".cm-cursorLayer")!;
    const flush = () => (v as unknown as { measure(): void }).measure();
    // jsdom has no layout: every caret is on screen.
    v.coordsAtPos = () => ({ left: 0, right: 0, top: 0, bottom: 10 });
    v.scrollDOM.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
    v.dispatch({ selection: { anchor: 1 } });
    flush();
    expect(layer.classList.contains("cm-openidea-caretGlide")).toBe(true);
    v.dispatch({ changes: { from: 1, insert: "x" }, selection: { anchor: 2 } });
    expect(layer.classList.contains("cm-openidea-caretGlide")).toBe(false);
  });
});
