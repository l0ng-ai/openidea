import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { closeBrackets } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { validateEditorExtras } from "@/platform/editorSettings";
import { prefsExtension } from "./prefs";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** A TSX editor wired as the real one: language support (with `autoCloseTags`), closeBrackets and prefs. */
function make(text: string) {
  const at = text.indexOf("|");
  const view = new EditorView({
    state: EditorState.create({
      doc: text.replace("|", ""),
      selection: EditorSelection.cursor(at),
      extensions: [
        javascript({ jsx: true, typescript: true }),
        closeBrackets(),
        prefsExtension({
          prefs: validateEditorExtras({}),
          path: "",
          softWrap: false,
          showWhitespace: false,
          hardWrapAt: 120,
          readOnly: false,
          language: "typescriptreact",
        }),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function show(view: EditorView): string {
  const doc = view.state.doc.toString();
  const head = view.state.selection.main.head;
  return doc.slice(0, head) + "|" + doc.slice(head);
}

/** Types `text` one character at a time through the real input handlers. */
function type(v: EditorView, text: string) {
  for (const ch of text) {
    const r = v.state.selection.main;
    const insert = () => v.state.update(v.state.replaceSelection(ch), { userEvent: "input.type" });
    if (!v.state.facet(EditorView.inputHandler).some((h) => h(v, r.from, r.to, ch, insert))) v.dispatch(insert());
  }
}

describe("JSX tag auto-close", () => {
  it("closes an opening tag on `>`", () => {
    const v = make("const a = |;");
    type(v, "<div>");
    expect(show(v)).toBe("const a = <div>|</div>;");
  });

  it("closes components, member names and fragments", () => {
    const v = make("const a = |;");
    type(v, "<Foo.Bar>");
    expect(show(v)).toBe("const a = <Foo.Bar>|</Foo.Bar>;");
    const f = make("const a = |;");
    type(f, "<>");
    expect(show(f)).toBe("const a = <>|</>;");
  });

  it("closes after attributes, but not self-closing tags", () => {
    const v = make("const a = |;");
    type(v, '<div id="x">');
    expect(show(v)).toBe('const a = <div id="x">|</div>;');
    const s = make("const a = |;");
    type(s, "<Foo />");
    expect(show(s)).toBe("const a = <Foo />|;");
  });

  it("completes the closing tag on `</`", () => {
    const v = make("const a = <div>x|;");
    type(v, "</");
    expect(show(v)).toBe("const a = <div>x</div>|;");
  });
});
