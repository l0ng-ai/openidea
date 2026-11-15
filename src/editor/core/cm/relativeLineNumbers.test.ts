import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorSettings } from "@/platform/ipc";
import { lineNumbersExtension } from "./setup";

function numbers(mode: string, caretLine: number): string[] {
  const settings = { appearance: { lineNumbers: true, lineNumberMode: mode } } as unknown as EditorSettings;
  const doc = "a\nb\nc\nd\ne";
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [lineNumbersExtension(settings)] }),
  });
  view.dispatch({ selection: { anchor: view.state.doc.line(caretLine).from } });
  const out = [...view.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")]
    .filter((e) => e.style.visibility !== "hidden")
    .map((e) => e.textContent ?? "")
    .filter((t) => t !== "");
  view.destroy();
  parent.remove();
  return out;
}

describe("line number modes", () => {
  it("absolute numbers lines from 1", () => {
    expect(numbers("absolute", 3)).toEqual(["1", "2", "3", "4", "5"]);
  });
  it("relative shows distance and 0 on the caret line", () => {
    expect(numbers("relative", 3)).toEqual(["2", "1", "0", "1", "2"]);
  });
  it("hybrid keeps the absolute number on the caret line", () => {
    expect(numbers("hybrid", 3)).toEqual(["2", "1", "3", "1", "2"]);
  });
});
