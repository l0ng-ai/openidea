import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { getCM, Vim } from "@replit/codemirror-vim";
import { applyRcCommands, vimExtension } from "../engine";
import { parseVimrc } from "../rc";
import { functionTextObject } from "../textObjects";

const JAVA = `class A {
    int one() {
        return 1;
    }

    void two() {
        Runnable r = () -> { run(); };
    }
}
`;

const JS = "const f = (x) => x + 1;\nfunction g() { return f(2); }\n";

const slice = (state: EditorState, r: { from: number; to: number } | null) => r && state.doc.sliceString(r.from, r.to);

describe("function text objects", () => {
  it("finds the function around a position, whole or its body", () => {
    const state = EditorState.create({ doc: JAVA, extensions: java() });
    const at = JAVA.indexOf("return 1");
    expect(functionTextObject(state, at, false)).toMatchObject({ linewise: true });
    expect(slice(state, functionTextObject(state, at, false))).toBe("    int one() {\n        return 1;\n    }");
    expect(slice(state, functionTextObject(state, at, true))).toBe("        return 1;");
    expect(functionTextObject(state, at, true)).toMatchObject({ linewise: true });
    // On the method's name, and outside any method.
    expect(slice(state, functionTextObject(state, JAVA.indexOf("one"), false))).toContain("int one()");
    expect(functionTextObject(state, JAVA.indexOf("class"), false)).toBeNull();
  });

  it("takes a lambda first, then the enclosing method", () => {
    const state = EditorState.create({ doc: JAVA, extensions: java() });
    const at = JAVA.indexOf("run();");
    expect(slice(state, functionTextObject(state, at, false))).toBe("() -> { run(); }");
    expect(slice(state, functionTextObject(state, at, true))).toBe(" run(); ");
    expect(slice(state, functionTextObject(state, at, false, 2))).toContain("void two()");
    const lambda = functionTextObject(state, at, false)!;
    expect(slice(state, functionTextObject(state, at, false, 1, lambda))).toContain("void two()");
  });

  it("handles functions on one line and expression bodies", () => {
    const state = EditorState.create({ doc: JS, extensions: javascript() });
    expect(slice(state, functionTextObject(state, JS.indexOf("x + 1"), false))).toBe("(x) => x + 1");
    expect(slice(state, functionTextObject(state, JS.indexOf("x + 1"), true))).toBe("x + 1");
    expect(slice(state, functionTextObject(state, JS.indexOf("return"), false))).toBe("function g() { return f(2); }");
    expect(slice(state, functionTextObject(state, JS.indexOf("return"), true))).toBe(" return f(2); ");
  });
});

describe("af / if in Vim", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
    applyRcCommands([]);
  });

  const open = (doc: string, at: number) => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [vimExtension(), java()], selection: { anchor: at } }),
    });
    return getCM(view)!;
  };
  const keys = (cm: ReturnType<typeof getCM>, seq: string) => {
    for (const k of seq) Vim.handleKey(cm as never, k, "user");
  };

  it("deletes, changes and selects the function under the cursor", () => {
    let cm = open(JAVA, JAVA.indexOf("return 1"));
    keys(cm, "daf");
    expect(view!.state.doc.toString().startsWith("class A {\n\n    void two()")).toBe(true);

    cm = open(JAVA, JAVA.indexOf("return 1"));
    keys(cm, "dif");
    expect(view!.state.doc.toString()).toContain("int one() {\n    }");

    cm = open(JAVA, JAVA.indexOf("run();"));
    keys(cm, "vaf");
    const sel = view!.state.selection.main;
    expect(view!.state.sliceDoc(sel.from, sel.to)).toBe("() -> { run(); }");
    keys(cm, "af");
    const grown = view!.state.selection.main;
    expect(view!.state.sliceDoc(grown.from, grown.to)).toContain("void two() {");
  });

  it("leaves a and i alone in Normal mode and survives an rc reload", () => {
    let cm = open(JAVA, JAVA.indexOf("return 1"));
    applyRcCommands(parseVimrc("nnoremap x dd").commands);
    keys(cm, "daf");
    expect(view!.state.doc.toString()).not.toContain("one()");
    cm = open(JAVA, 0);
    keys(cm, "a");
    expect((cm as unknown as { state: { vim: { insertMode: boolean } } }).state.vim.insertMode).toBe(true);
  });
});
