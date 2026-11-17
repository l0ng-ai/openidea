/** Test helpers for the composer's editor (a CodeMirror view); plain text areas work too. */
import { act, fireEvent } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

function viewOf(box: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(box);
  if (!view) throw new Error("not a composer editor");
  return view;
}

/** Replaces the composer's text as typing would, caret at `caret` (the end by default). */
export function typeIn(box: HTMLElement, value: string, caret = value.length) {
  if (box instanceof HTMLTextAreaElement) {
    fireEvent.change(box, {
      target: { value, selectionStart: caret, selectionEnd: caret },
    });
    return;
  }
  const view = viewOf(box);
  act(() => {
    view.focus();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: caret },
      userEvent: "input.type",
    });
  });
}

/** Types `chars` at the caret, one at a time. */
export function typeChars(box: HTMLElement, chars: string) {
  const view = viewOf(box);
  act(() => view.focus());
  for (const ch of chars)
    act(() => {
      view.dispatch(view.state.replaceSelection(ch), {
        userEvent: "input.type",
      });
    });
}

export const textOf = (box: HTMLElement) =>
  box instanceof HTMLTextAreaElement ? box.value : viewOf(box).state.doc.toString();

export const caretOf = (box: HTMLElement) => viewOf(box).state.selection.main.head;

export function setCaret(box: HTMLElement, anchor: number, head = anchor) {
  const view = viewOf(box);
  act(() => {
    view.focus();
    view.dispatch({ selection: { anchor, head } });
  });
}
