import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { CompletionContext, autocompletion, completionStatus, hasNextSnippetField } from "@codemirror/autocomplete";
import {
  EXCLUSIVE_COMPLETION_KEY,
  expandLiveTemplateAtCaret,
  insertLiveTemplate,
  expandPostfixAtCaret,
  surroundWith,
  templateCompletionSource,
  templateEditorExtension,
} from "../editor";
import { closeChooser, useChooser } from "../popup/store";

const MODES: Record<string, string> = { typescript: "TypeScript", rust: "Rust", python: "Python", java: "Java" };

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  closeChooser();
});

async function editor(language: string, doc: string, cursor = doc.length, extra: Extension[] = []) {
  const support = await languages.find((l) => l.name === MODES[language])!.load();
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      support,
      EditorState.allowMultipleSelections.of(true),
      templateEditorExtension({
        doc: 1,
        path: `/p/src/Main.${language}`,
        language,
        uiMode: MODES[language]!,
        readOnly: false,
      }),
      ...extra,
    ],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  view = new EditorView({ state, parent: document.body });
  return view;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const press = (v: EditorView, key: string) => runScopeHandlers(v, new KeyboardEvent("keydown", { key }), "editor");
const tab = (v: EditorView) => press(v, "Tab");

describe("Tab expansion", () => {
  it("expands a live template abbreviation", async () => {
    const v = await editor("typescript", "function f() {\n  log");
    expect(tab(v)).toBe(true);
    await tick();
    expect(v.state.doc.toString()).toBe("function f() {\n  console.log();");
    expect(v.state.selection.main.head).toBe("function f() {\n  console.log(".length);
  });

  it("falls through when nothing matches", async () => {
    const v = await editor("typescript", "zzz");
    expect(expandLiveTemplateAtCaret(v)).toBe(false);
  });

  it("does not expand code templates inside comments", async () => {
    const v = await editor("typescript", "// log");
    expect(expandLiveTemplateAtCaret(v)).toBe(false);
  });

  it("expands todo with the language's comment start", async () => {
    const v = await editor("python", "x = 1\ntodo");
    expect(expandLiveTemplateAtCaret(v)).toBe(true);
    await tick();
    expect(v.state.doc.toString()).toBe("x = 1\n# TODO: ");
  });

  it("expands postfix templates replacing the expression", async () => {
    const v = await editor("rust", "fn main() {\n    items.iter().for");
    expect(expandPostfixAtCaret(v)).toBe(true);
    await tick();
    expect(v.state.doc.toString()).toBe("fn main() {\n    for item in items.iter() {\n      \n    }");
  });

  it("wraps compound expressions for .not and offers a chooser", async () => {
    const v = await editor("java", "class A { void f() { boolean b = x > y.not");
    expect(expandPostfixAtCaret(v)).toBe(true);
    const req = useChooser.getState().request!;
    expect(req.items.map((i) => i.label)).toEqual(["y", "x > y"]);
    req.onPick(req.items[1]!, "");
    await tick();
    expect(v.state.doc.toString()).toBe("class A { void f() { boolean b = !(x > y)");
  });
});

describe("surround with", () => {
  it("wraps the selected lines", async () => {
    const doc = "def f():\n    a()\n    b()\n";
    const v = await editor("python", doc);
    v.dispatch({ selection: EditorSelection.range(doc.indexOf("a()"), doc.indexOf("b()") + 3) });
    surroundWith(v);
    const req = useChooser.getState().request!;
    req.onPick(
      req.items.find((i) => i.label === "if")!,
      "",
    );
    await tick();
    expect(v.state.doc.toString()).toBe("def f():\n    if :\n      a()\n      b()\n    \n");
  });

  it("lists the language's surrounders with numeric mnemonics; a mnemonic key picks", async () => {
    const doc = "class A {\n  void f() {\n    a();\n  }\n}\n";
    const v = await editor("java", doc, doc.indexOf("a();"));
    surroundWith(v);
    const req = useChooser.getState().request!;
    expect(req.mnemonics).toBe(true);
    expect(req.items.slice(0, 3).map((i) => [i.mnemonic, i.label])).toEqual([
      ["1", "if"],
      ["2", "if / else"],
      ["3", "while"],
    ]);
    // Expression surrounders need a selection within the line.
    expect(req.items.some((i) => i.label === "(expr)")).toBe(false);
    req.onPick(req.items.find((i) => i.mnemonic === "9")!, "");
    await tick();
    expect(v.state.doc.toString()).toContain("synchronized (this) {");
  });

  it("offers expression surrounders for a selection inside a line", async () => {
    const doc = "fn main() {\n    let x = a + b;\n}\n";
    const v = await editor("rust", doc);
    v.dispatch({ selection: EditorSelection.range(doc.indexOf("a + b"), doc.indexOf("a + b") + 5) });
    surroundWith(v);
    const labels = useChooser.getState().request!.items.map((i) => i.label);
    expect(labels).toEqual(["(expr)", "!(expr)"]);
  });
});

describe("template fields", () => {
  const selected = (v: EditorView) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);

  it("Enter moves to the next field like Tab", async () => {
    const v = await editor("typescript", "fori");
    expect(tab(v)).toBe(true);
    await tick();
    expect(selected(v)).toBe("i");
    expect(press(v, "Enter")).toBe(true);
    expect(v.state.doc.toString()).toBe("for (let i = 0; i < .length; i++) {\n\t\n}".replace("\t", "  "));
    expect(v.state.selection.main.head).toBe("for (let i = 0; i < ".length);
  });

  it("Esc first drops the field's selection, then leaves the template", async () => {
    const v = await editor("typescript", "fori");
    tab(v);
    await tick();
    expect(press(v, "Escape")).toBe(true);
    expect(v.state.selection.main.empty).toBe(true);
    expect(hasNextSnippetField(v.state)).toBe(true);
    expect(press(v, "Escape")).toBe(true);
    expect(hasNextSnippetField(v.state)).toBe(false);
    // Outside a template Enter and Esc are left to the editor.
    expect(press(v, "Escape")).toBe(false);
  });
});

describe("⌘J Insert Live Template", () => {
  it("opens a lookup restricted to live templates and ends with it", async () => {
    const v = await editor("typescript", "function f() {\n  ", undefined, [autocompletion()]);
    const exclusive = () =>
      v.state
        .languageDataAt<(s: EditorState) => unknown>(EXCLUSIVE_COMPLETION_KEY, v.state.selection.main.head)
        .map((f) => f(v.state))
        .find(Boolean);
    expect(exclusive()).toBeUndefined();
    insertLiveTemplate(v);
    expect(completionStatus(v.state)).not.toBeNull();
    expect(exclusive()).toBeTypeOf("function");
    // No word before the caret: every applicable template, from the caret.
    const r = await templateCompletionSource(new CompletionContext(v.state, v.state.doc.length, true));
    expect(r?.from).toBe(v.state.doc.length);
    expect(r?.options.map((o) => o.label)).toEqual(expect.arrayContaining(["log", "fori"]));
    v.dispatch({ selection: EditorSelection.cursor(0) });
    await tick();
    expect(completionStatus(v.state)).toBeNull();
    expect(exclusive()).toBeUndefined();
  });
});

describe("completion source", () => {
  it("offers postfix templates after a dot", async () => {
    const v = await editor("typescript", "items.");
    const r = await templateCompletionSource(new CompletionContext(v.state, v.state.doc.length, false));
    expect(r?.from).toBe(6);
    expect(r?.options.map((o) => o.label)).toContain("for");
  });

  it("offers live templates for a word", async () => {
    const v = await editor("typescript", "lo");
    const r = await templateCompletionSource(new CompletionContext(v.state, 2, false));
    expect(r?.options.map((o) => o.label)).toContain("log");
  });
});
