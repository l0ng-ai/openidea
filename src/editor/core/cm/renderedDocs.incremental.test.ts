import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { java } from "@codemirror/lang-java";
import { history, undo } from "@codemirror/commands";
import { renderDocComments, renderedDocsExtension, renderedRanges } from "./renderedDocs";

let view: EditorView | null = null;
beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

const DOC = ["class Rooms {", "  int n;", "", "  /** Books a room. */", "  void book() {}", "}"].join("\n");

function open(doc = DOC, extra: ReturnType<typeof history>[] = []) {
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [java(), renderedDocsExtension, renderDocComments.of(true), ...extra],
    }),
    parent: document.body,
  });
  return view;
}

/** Types `text` at `at` the way a keystroke does. */
const type = (v: EditorView, at: number, text: string) =>
  v.dispatch({ changes: { from: at, insert: text }, userEvent: "input.type" });

/** What a full rebuild of the same text renders, in a fresh editor state. */
function fullRebuild(doc: string): Array<[number, number]> {
  return renderedRanges(
    EditorState.create({ doc, extensions: [java(), renderedDocsExtension, renderDocComments.of(true)] }),
  );
}

const pause = () => vi.advanceTimersByTime(300);

it("moves rendered comments along with text typed in code, and rebuilds once typing pauses", () => {
  const v = open();
  const [before] = renderedRanges(v.state);
  // `/*` in code makes everything after it a comment: a full rebuild would drop the doc
  // comment at once. Typing only moves it along until the pause.
  type(v, v.state.doc.line(2).from + 2, "/*");
  expect(renderedRanges(v.state)).toEqual([[before![0] + 2, before![1] + 2]]);
  pause();
  expect(renderedRanges(v.state)).toEqual(fullRebuild(v.state.doc.toString()));
  expect(renderedRanges(v.state)).toHaveLength(0);
});

it("renders a pasted comment at once", () => {
  const v = open();
  v.dispatch({
    changes: { from: v.state.doc.line(5).to + 1, insert: "  /** Pasted. */\n  void paste() {}\n" },
    userEvent: "input.paste",
  });
  expect(renderedRanges(v.state)).toHaveLength(2);
});

it("brings a deleted comment back rendered at once on undo", () => {
  const v = open(DOC, [history()]);
  const line = v.state.doc.line(4);
  v.dispatch({ changes: { from: line.from, to: line.to + 1 }, userEvent: "delete.selection" });
  expect(renderedRanges(v.state)).toHaveLength(0);
  undo(v);
  expect(renderedRanges(v.state)).toHaveLength(1);
});

it("rebuilds at once for a keystroke on a comment's line", () => {
  const v = open();
  // Code after the closing marker: the comment no longer has its line to itself.
  type(v, v.state.doc.line(4).to, " int x;");
  expect(renderedRanges(v.state)).toHaveLength(0);
});

it("still shows the source of a comment the caret lands in after fast typing", () => {
  const v = open();
  type(v, v.state.doc.line(2).from + 2, "xx");
  const at = v.state.doc.toString().indexOf("Books");
  v.dispatch({ selection: EditorSelection.cursor(at) });
  expect(renderedRanges(v.state)).toHaveLength(0);
});

it("after the pause, matches a full rebuild of the same text, whatever was typed", () => {
  // A seeded generator, so a failure replays.
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const lines = ["class A {"];
  for (let i = 0; i < 12; i++) lines.push(`  /** Doc ${i}. */`, `  void m${i}() {}`, "  /// line doc", "");
  lines.push("}");
  const v = open(lines.join("\n"));
  const keys = ["/", "*", "\n", "x", " ", "{", "}"];
  for (let i = 0; i < 400; i++) {
    const at = Math.floor(next() * (v.state.doc.length + 1));
    if (next() < 0.3 && at > 0) v.dispatch({ changes: { from: at - 1, to: at }, userEvent: "delete.backward" });
    else type(v, at, keys[Math.floor(next() * keys.length)]!);
    if (next() < 0.05) pause();
  }
  pause();
  expect(renderedRanges(v.state)).toEqual(fullRebuild(v.state.doc.toString()));
});
