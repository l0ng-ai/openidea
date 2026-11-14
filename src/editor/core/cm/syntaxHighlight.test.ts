import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { highlightingFor, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { openideaHighlightStyle, parameter } from "./highlight";
import { findLanguageDescription, loadSupport } from "./languages";
import { setSyntaxHighlights, syntaxHighlightField } from "./syntaxHighlight";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

function marks(state: EditorState) {
  const out: { text: string; cls: string }[] = [];
  state.field(syntaxHighlightField).between(0, state.doc.length, (from, to, d) => {
    out.push({ text: state.doc.sliceString(from, to), cls: d.spec.class as string });
  });
  return out;
}

describe("syntaxHighlightField", () => {
  const create = () =>
    EditorState.create({
      doc: "def hi, do: :ok",
      extensions: [syntaxHighlighting(openideaHighlightStyle), syntaxHighlightField],
    });

  it("styles backend ranges with the active highlight style and maps them through edits", () => {
    let state = create();
    state = state.update({
      effects: setSyntaxHighlights.of({
        kinds: ["keyword", "atom", "functionCall"],
        data: [0, 3, 0, 4, 6, 2, 12, 15, 1, 99, 120, 0],
      }),
    }).state;
    const keyword = highlightingFor(state, [t.keyword]);
    const atom = highlightingFor(state, [t.atom]);
    expect(keyword).toBeTruthy();
    expect(marks(state)).toEqual([
      { text: "def", cls: keyword },
      { text: "hi", cls: highlightingFor(state, [t.function(t.variableName)]) },
      { text: ":ok", cls: atom },
    ]);

    state = state.update({ changes: { from: 0, insert: "  " } }).state;
    expect(marks(state).map((m) => m.text)).toEqual(["def", "hi", ":ok"]);
  });

  it("lets Kotlin declaration roles override the stream lexer's generic definition style", async () => {
    const support = await loadSupport(findLanguageDescription("Kotlin", "demo.kt")!);
    const view = new EditorView({
      parent: document.body,
      doc: "fun greet(prefix: String) {}",
      extensions: [support!, syntaxHighlightField, syntaxHighlighting(openideaHighlightStyle)],
    });
    views.push(view);
    view.dispatch({
      effects: setSyntaxHighlights.of({ kinds: ["function", "parameter"], data: [4, 9, 0, 10, 16, 1] }),
    });
    for (const [text, tag] of [
      ["greet", t.function(t.definition(t.variableName))],
      ["prefix", parameter],
    ] as const) {
      const cls = highlightingFor(view.state, [tag])!;
      const span = view.contentDOM.querySelector(`.${cls}`)!;
      expect(span.textContent).toBe(text);
      expect(span.children.length).toBe(0);
    }
  });
});
