import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "@/platform/actions";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { cursorCharRight, history, undo } from "@codemirror/commands";
import { nextOccurrence, occurrenceSearch } from "@/editor/core/cm/editing";
import { completedSyntaxState } from "@/test/syntax";
import { languages } from "@codemirror/language-data";
import {
  CompletionContext,
  autocompletion,
  completionStatus,
  hasNextSnippetField,
  snippet,
} from "@codemirror/autocomplete";
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
import { removeTemplate, saveTemplate } from "../live/store";

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
  view = new EditorView({ state: completedSyntaxState(state), parent: document.body });
  return view;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const press = (v: EditorView, key: string) => runScopeHandlers(v, new KeyboardEvent("keydown", { key }), "editor");
const tab = (v: EditorView) => press(v, "Tab");

function carets(v: EditorView, ...heads: number[]) {
  v.dispatch({
    selection: EditorSelection.create(
      heads.map((head) => EditorSelection.cursor(head)),
      heads.length - 1,
    ),
  });
}

describe("Tab expansion", () => {
  it("expands a live template abbreviation", async () => {
    const v = await editor("typescript", "function f() {\n  log");
    expect(tab(v)).toBe(true);
    await tick();
    expect(v.state.doc.toString()).toBe("function f() {\n  console.log();");
    expect(v.state.selection.main.head).toBe("function f() {\n  console.log(".length);
  });

  it("expands both occurrences selected with Alt+J twice and Right, then undoes them together", async () => {
    const doc = "function first() {\n  log\n}\nfunction second() {\n  log\n}";
    const v = await editor("typescript", doc, doc.indexOf("log") + 1, [history(), occurrenceSearch]);
    expect(nextOccurrence(v)).toBe("selected");
    expect(nextOccurrence(v)).toBe("added");
    expect(cursorCharRight(v)).toBe(true);
    const before = v.state.selection;
    expect(before.ranges.map((r) => r.head)).toEqual([doc.indexOf("log") + 3, doc.lastIndexOf("log") + 3]);

    expect(tab(v)).toBe(true);
    const expanded = doc.replaceAll("log", "console.log();");
    expect(v.state.doc.toString()).toBe(expanded);
    expect(v.state.selection.ranges.map((r) => r.head)).toEqual([
      expanded.indexOf("();") + 1,
      expanded.lastIndexOf("();") + 1,
    ]);
    expect(v.state.selection.mainIndex).toBe(before.mainIndex);
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(doc);
    expect(v.state.selection.eq(before)).toBe(true);
  });

  it("falls through when nothing matches", async () => {
    const v = await editor("typescript", "zzz");
    expect(expandLiveTemplateAtCaret(v)).toBe(false);
  });

  it("does not expand code templates inside comments", async () => {
    const v = await editor("typescript", "// log");
    expect(expandLiveTemplateAtCaret(v)).toBe(false);
  });

  it.each([
    ["different prefixes", "lo\nlog"],
    ["a comment", "// log\nlog"],
    ["a string", '"log"\nlog'],
    ["a postfix key", "value.log\nlog"],
    ["a postfix key at the main caret", "log\nvalue.log"],
  ])("leaves both carets to normal Tab handling with %s", async (_reason, doc) => {
    const v = await editor("typescript", doc);
    carets(v, doc.indexOf("\n") - (doc.startsWith('"') ? 1 : 0), doc.length);
    const before = v.state.selection;
    expect(tab(v)).toBe(false);
    expect(v.state.doc.toString()).toBe(doc);
    expect(v.state.selection).toBe(before);
  });

  it("applies a language-specific template at both Rust carets", async () => {
    const doc = "fn main() {\n  todo\n  todo\n}";
    const v = await editor("rust", doc);
    carets(v, doc.indexOf("todo") + 4, doc.lastIndexOf("todo") + 4);
    expect(tab(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(doc.replaceAll("todo", "// TODO: "));
    expect(v.state.selection.ranges.map((r) => r.head)).toEqual([v.state.doc.line(2).to, v.state.doc.line(3).to]);
  });

  it("offers one chooser for duplicate abbreviations and applies its choice at each caret", async () => {
    const id = "test.second-log";
    saveTemplate({
      id,
      group: "Test",
      abbrev: "log",
      description: "Warning log",
      body: "console.warn($END$);",
      contexts: ["typescript"],
    });
    try {
      const v = await editor("typescript", "log\nlog");
      carets(v, 3, 7);
      expect(tab(v)).toBe(true);
      const req = useChooser.getState().request!;
      expect(req.items).toHaveLength(2);
      req.onPick(
        req.items.find((i) => i.key === id)!,
        "",
      );
      expect(v.state.doc.toString()).toBe("console.warn();\nconsole.warn();");
      expect(v.state.selection.ranges).toHaveLength(2);
    } finally {
      removeTemplate(id);
    }
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

describe("Java .var", () => {
  it("runs Introduce Variable on the expression, ended as a statement", async () => {
    let seen: { doc: string; selected: string } | null = null;
    const dispose = registerAction({
      id: "refactor.extractVariable",
      title: "Introduce Variable…",
      run: () => {
        const sel = view!.state.selection.main;
        seen = { doc: view!.state.doc.toString(), selected: view!.state.sliceDoc(sel.from, sel.to) };
      },
    });
    try {
      const v = await editor(
        "java",
        "class A { void f() {\n  list.get(0).var\n} }",
        "class A { void f() {\n  list.get(0).var".length,
      );
      expect(expandPostfixAtCaret(v)).toBe(true);
      const req = useChooser.getState().request;
      if (req)
        req.onPick(
          req.items.find((i) => i.label === "list.get(0)")!,
          "",
        );
      await vi.waitFor(() => expect(seen).not.toBeNull());
      expect(seen).toEqual({ doc: "class A { void f() {\n  list.get(0);\n} }", selected: "list.get(0)" });
    } finally {
      dispose();
    }
  });

  it("falls back to the var template without Introduce Variable", async () => {
    const v = await editor(
      "java",
      "class A { void f() {\n  name().var\n} }",
      "class A { void f() {\n  name().var".length,
    );
    expect(expandPostfixAtCaret(v)).toBe(true);
    const req = useChooser.getState().request;
    if (req)
      req.onPick(
        req.items.find((i) => i.label === "name()")!,
        "",
      );
    await vi.waitFor(() => expect(v.state.doc.toString()).toContain("var name = name();"));
    expect(v.state.doc.toString()).toBe("class A { void f() {\n  var name = name();\n} }");
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
    req.onPick(
      req.items.find((i) => i.mnemonic === "9")!,
      "",
    );
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

  it("links fields and advances all carets through separately indented expansions", async () => {
    const doc = "function first() {\n  fori\n}\nfunction second() {\n    fori\n}";
    const v = await editor("typescript", doc, undefined, [history()]);
    carets(v, doc.indexOf("fori") + 4, doc.lastIndexOf("fori") + 4);
    const before = v.state.selection;
    expect(tab(v)).toBe(true);
    expect(v.state.selection.ranges.map((r) => v.state.sliceDoc(r.from, r.to))).toEqual(Array(6).fill("i"));
    expect(v.state.selection.mainIndex).toBe(3);
    expect(v.state.doc.line(3).text).toBe("    ");
    expect(v.state.doc.line(8).text).toBe("      ");

    v.dispatch(v.state.replaceSelection("idx"));
    expect(v.state.doc.toString().match(/\bidx\b/g)).toHaveLength(6);
    expect(press(v, "Enter")).toBe(true);
    expect(v.state.selection.ranges).toHaveLength(2);
    expect(v.state.selection.ranges.every((r) => v.state.sliceDoc(r.head, r.head + 7) === ".length")).toBe(true);
    expect(runScopeHandlers(v, new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }), "editor")).toBe(true);
    expect(v.state.selection.ranges).toHaveLength(6);
    expect(tab(v)).toBe(true);
    expect(tab(v)).toBe(true);
    expect(v.state.selection.ranges.map((r) => r.head)).toEqual([v.state.doc.line(3).to, v.state.doc.line(8).to]);
    expect(tab(v)).toBe(false);
    expect(undo(v)).toBe(true);
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(doc);
    expect(v.state.selection.eq(before)).toBe(true);
  });

  it("keeps matching field identities when a macro produces a value at only one caret", async () => {
    const id = "test.multicaret-macro";
    saveTemplate({
      id,
      group: "Test",
      abbrev: "mac",
      description: "Class macro",
      body: "log($NAME$, $VALUE$)$END$",
      contexts: ["typescript"],
      variables: [{ name: "NAME", expression: "className()", skipIfDefined: true }],
    });
    try {
      const doc = "mac\nclass A {\n  f() { mac }\n}";
      const v = await editor("typescript", doc);
      carets(v, 3, doc.lastIndexOf("mac") + 3);
      expect(tab(v)).toBe(true);
      expect(v.state.doc.toString()).toBe("log(, )\nclass A {\n  f() { log(A, ) }\n}");
      expect(v.state.selection.ranges.map((r) => v.state.sliceDoc(r.from, r.to))).toEqual(["", "A"]);
      expect(tab(v)).toBe(true);
      expect(v.state.selection.ranges).toHaveLength(2);
      expect(v.state.selection.ranges.every((r) => r.empty)).toBe(true);
    } finally {
      removeTemplate(id);
    }
  });

  it("Enter moves to the next field like Tab", async () => {
    const v = await editor("typescript", "fori");
    expect(tab(v)).toBe(true);
    await tick();
    expect(selected(v)).toBe("i");
    expect(press(v, "Enter")).toBe(true);
    expect(v.state.doc.toString()).toBe("for (let i = 0; i < .length; i++) {\n\t\n}".replace("\t", "  "));
    expect(v.state.selection.main.head).toBe("for (let i = 0; i < ".length);
  });

  it("leaves Enter to the editor in a completion's snippet", async () => {
    const v = await editor("typescript", "<dep");
    // An LSP tag completion: `<dependency>$1</dependency>$0`.
    snippet("<dependency>${1}</dependency>${0}")(v, { label: "dependency" }, 0, 4);
    expect(v.state.selection.main.head).toBe("<dependency>".length);
    expect(hasNextSnippetField(v.state)).toBe(true);
    expect(press(v, "Enter")).toBe(false);
    expect(tab(v)).toBe(true);
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
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

  it("applies a template completion to the same prefix at every caret", async () => {
    const v = await editor("typescript", "lo\nlo");
    carets(v, 2, 5);
    const r = await templateCompletionSource(new CompletionContext(v.state, 5, false));
    const option = r?.options.find((o) => o.label === "log");
    if (typeof option?.apply !== "function") throw new Error("Expected a live template completion");
    option.apply(v, option, r!.from, 5);
    expect(v.state.doc.toString()).toBe("console.log();\nconsole.log();");
    expect(v.state.selection.ranges).toHaveLength(2);
  });
});
