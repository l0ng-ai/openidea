import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentService, indentUnit } from "@codemirror/language";
import { closeBrackets, insertBracket } from "@codemirror/autocomplete";
import {
  autoIndentBackspace,
  insertTab,
  smartBackspace,
  smartBackspaceApplies,
  tabOut,
  tabOutOfScope,
} from "./smartKeys";

/** One unit (2) deeper after a (non-blank) line ending in `{`, one less on a line starting with `}`. */
const braces = indentService.of((cx, pos) => {
  let prev = cx.lineAt(pos, -1);
  do {
    if (prev.from === 0) return 0;
    prev = cx.lineAt(prev.from - 1, -1);
  } while (!prev.text.trim());
  const base = /^ */.exec(prev.text)![0].length;
  const own = cx.state.doc.lineAt(pos).text;
  return Math.max(0, base + (prev.text.trimEnd().endsWith("{") ? 2 : 0) - (/^\s*}/.test(own) ? 2 : 0));
});

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** `|` marks carets, `[`/`]` a selection. */
function make(text: string, extensions: Extension = [], unit = "  ") {
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
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        EditorState.tabSize.of(4),
        indentUnit.of(unit),
        extensions,
      ],
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

describe("tab", () => {
  it("inserts whitespace up to the next indent stop at each caret", () => {
    const v = make("ab|c\n|x");
    insertTab(v);
    expect(show(v)).toBe("ab  |c\n  |x");
  });

  it("counts wide characters as two columns towards the indent stop", () => {
    const v = make("a张|x\n张|y");
    insertTab(v);
    expect(show(v)).toBe("a张 |x\n张  |y");
  });

  it("inserts a tab character when the code style uses tabs", () => {
    const v = make("a|b", [], "\t");
    insertTab(v);
    expect(show(v)).toBe("a\t|b");
  });

  it("indents the lines of a selection", () => {
    const v = make("[a\nb]");
    insertTab(v);
    expect(v.state.doc.toString()).toBe("  a\n  b");
  });

  it("replaces a whitespace-only selection like a caret", () => {
    const v = make("a[  ]b");
    insertTab(v);
    expect(show(v)).toBe("a |b");
  });
});

describe("smart backspace", () => {
  it("applies in 'proper indent' mode except in indentation-based languages", () => {
    expect(smartBackspaceApplies("autoindent", "java")).toBe(true);
    expect(smartBackspaceApplies("autoindent", "python")).toBe(false);
    expect(smartBackspaceApplies("autoindent", "gdscript")).toBe(false);
    expect(smartBackspaceApplies("nearest", "java")).toBe(false);
  });

  it("goes back to the proper indent from deeper whitespace", () => {
    const v = make("f {\n        |x\n}", braces);
    smartBackspace(v);
    expect(show(v)).toBe("f {\n  |x\n}");
  });

  it("joins with the line above at the proper indent", () => {
    const v = make("f {\n  a\n  |b\n}", braces);
    smartBackspace(v);
    expect(show(v)).toBe("f {\n  a |b\n}");
  });

  it("moves text up over a blank line at its proper indent", () => {
    const v = make("f {\n  a\n\n  |b\n}", braces);
    smartBackspace(v);
    expect(show(v)).toBe("f {\n  a\n  |b\n}");
  });

  it("joins an empty line without leaving a space", () => {
    const v = make("f {\n  a\n  |\n}", braces);
    smartBackspace(v);
    expect(show(v)).toBe("f {\n  a|\n}");
  });

  it("leaves Backspace after text to the default", () => {
    const v = make("f {\n  a|b\n}", braces);
    expect(autoIndentBackspace(v.state, v.state.selection.main.head)).toBeNull();
    expect(smartBackspace(v)).toBe(false);
  });
});

describe("tab out of pairs", () => {
  const ext = [closeBrackets(), tabOut];
  const type = (v: EditorView, ch: string) => {
    const tr = insertBracket(v.state, ch);
    if (tr) v.dispatch(tr);
    else v.dispatch(v.state.update(v.state.replaceSelection(ch), { userEvent: "input.type" }));
  };

  it("steps over a closing bracket the editor inserted", () => {
    const v = make("f|", ext);
    type(v, "(");
    type(v, "x");
    expect(show(v)).toBe("f(x|)");
    expect(insertTab(v)).toBe(true);
    expect(show(v)).toBe("f(x)|");
    // Once out, Tab inserts whitespace again.
    insertTab(v);
    expect(show(v)).toBe("f(x)  |");
  });

  it("ignores closers the user typed", () => {
    const v = make("f(x|)", ext);
    expect(tabOutOfScope(v)).toBe(false);
  });

  it("keeps the pair through edits elsewhere while the caret is inside, else forgets it", () => {
    const v = make("a f|", ext);
    type(v, "(");
    v.dispatch({ changes: { from: 0, to: 1, insert: "bb" } });
    expect(show(v)).toBe("bb f(|)");
    v.dispatch({ selection: { anchor: 0 } });
    v.dispatch({ changes: { from: 0, insert: "c" }, selection: { anchor: 6 } });
    expect(tabOutOfScope(v)).toBe(false);
  });
});
