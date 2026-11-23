/**
 * On a touch screen the editor opens for reading: a tap moves the caret or picks a symbol and
 * a long press opens the context menu, without the on-screen keyboard (which would cover half
 * the screen) and without typing by accident. Edit (the editor tab row's pencil) turns every
 * editor to editing until Done.
 *
 * Reading makes the state read-only, so the commands and menu entries that check it (Paste,
 * Cut, editing actions) step aside as they do for a read-only file; a file that is read-only
 * itself stays so while editing.
 */
import { EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { create } from "zustand";
import { useFormFactor } from "@/platform/formFactor";
import { LONG_PRESS_MS } from "@/platform/longPress";

export const useTouchEditing = create<{ editing: boolean }>(() => ({ editing: false }));

export function setTouchEditing(editing: boolean) {
  useTouchEditing.setState({ editing });
}

const readingNow = () => useFormFactor.getState().touch && !useTouchEditing.getState().editing;

const setReading = StateEffect.define<boolean>();

const reading = StateField.define<boolean>({
  create: readingNow,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setReading)) value = e.value;
    return value;
  },
});

const follow = ViewPlugin.fromClass(
  class {
    private readonly off: Array<() => void>;
    constructor(private readonly view: EditorView) {
      this.apply();
      const apply = () => this.apply();
      // A long press would select a word and raise the system's Cut / Copy / Paste bar over
      // the editor's own menu: while reading, a press held that long selects nothing. A tap
      // still places the caret.
      let downAt = 0;
      const down = () => (downAt = Date.now());
      const noNativeSelection = (e: Event) => {
        if (this.view.state.field(reading) && Date.now() - downAt > LONG_PRESS_MS * 0.6) e.preventDefault();
      };
      view.contentDOM.addEventListener("pointerdown", down);
      view.contentDOM.addEventListener("selectstart", noNativeSelection);
      this.off = [
        useTouchEditing.subscribe(apply),
        useFormFactor.subscribe(apply),
        () => view.contentDOM.removeEventListener("pointerdown", down),
        () => view.contentDOM.removeEventListener("selectstart", noNativeSelection),
      ];
    }
    apply() {
      const now = readingNow();
      // `none` keeps the keyboard down while the content still takes the caret and selection.
      if (now) this.view.contentDOM.setAttribute("inputmode", "none");
      else this.view.contentDOM.removeAttribute("inputmode");
      if (this.view.state.field(reading) !== now) this.view.dispatch({ effects: setReading.of(now) });
    }
    destroy() {
      this.off.forEach((f) => f());
    }
  },
);

/** Lowest precedence: a read-only file's own `readOnly` comes first and wins. */
export const touchReadMode: Extension = Prec.lowest([
  reading,
  EditorState.readOnly.compute([reading], (s) => s.field(reading)),
  follow,
]);
