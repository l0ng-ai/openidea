import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { typedImeCommit } from "@/platform/ime";
import { imeSyllableSpaces, retypeImeCommit } from "./imeCommit";

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.useRealTimers();
});

function editor(doc: string, cursors: number[]): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(cursors.map((c) => EditorSelection.cursor(c))),
      extensions: [EditorState.allowMultipleSelections.of(true), history(), imeSyllableSpaces],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function composition(view: EditorView, type: string, data: string) {
  view.contentDOM.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
}

describe("typedImeCommit", () => {
  it("drops the syllable spaces of a commit that is the raw composition text", () => {
    expect(typedImeCommit("ni hao", "ni hao")).toBe("nihao");
    expect(typedImeCommit("con so le", "con so le")).toBe("console");
  });

  it("keeps candidates and non-ASCII commits", () => {
    expect(typedImeCommit("你好", "ni hao")).toBe("你好");
    expect(typedImeCommit("nihao", "ni hao")).toBe("nihao");
    expect(typedImeCommit("に ほ", "に ほ")).toBe("に ほ");
  });
});

describe("editor IME commit", () => {
  it("rewrites a Pinyin input-source switch commit to the letters typed", () => {
    vi.useFakeTimers();
    const view = editor("x ni hao", [8]);
    composition(view, "compositionstart", "");
    composition(view, "compositionupdate", "ni hao");
    composition(view, "compositionend", "ni hao");
    vi.runAllTimers();
    expect(view.state.doc.toString()).toBe("x nihao");
    expect(view.state.selection.main.head).toBe(7);
  });

  it("leaves a candidate commit alone", () => {
    vi.useFakeTimers();
    const view = editor("x 你好", [4]);
    composition(view, "compositionupdate", "ni hao");
    composition(view, "compositionend", "你好");
    vi.runAllTimers();
    expect(view.state.doc.toString()).toBe("x 你好");
  });

  it("fixes every cursor that took the commit and joins the composition's undo step", () => {
    const view = editor("", [0]);
    view.dispatch({ changes: { from: 0, insert: "ni hao\nni hao" }, userEvent: "input.type.compose" });
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(6), EditorSelection.cursor(13)]) });
    expect(retypeImeCommit(view, "ni hao", "nihao")).toBe(true);
    expect(view.state.doc.toString()).toBe("nihao\nnihao");
    expect(view.state.selection.ranges.map((r) => r.head)).toEqual([5, 11]);
    undo(view);
    expect(view.state.doc.toString()).toBe("");
  });

  it("does nothing when the text before the cursor is no longer the commit", () => {
    const view = editor("ni ha", [5]);
    expect(retypeImeCommit(view, "ni hao", "nihao")).toBe(false);
    expect(view.state.doc.toString()).toBe("ni ha");
  });
});
