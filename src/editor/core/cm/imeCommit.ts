/**
 * Switching macOS Pinyin to English mid-composition commits the composition as displayed,
 * with the spaces the IME shows between syllables (`ni hao` for `nihao`). The preedit is already
 * in the document by then, so the committed text is rewritten to the letters typed once
 * CodeMirror has read the commit. Candidate commits differ from the composition text and are
 * left alone; the terminal does the same in `features/terminal/imeInput.ts`.
 */
import { EditorSelection } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { typedImeCommit } from "@/platform/ime";

/** Replaces `committed` just before each cursor with `typed`, as part of the composition. */
export function retypeImeCommit(view: EditorView, committed: string, typed: string): boolean {
  if (view.composing) return false;
  const { state } = view;
  const ranges = state.selection.ranges;
  const matches = (r: (typeof ranges)[number]) =>
    r.empty && r.head >= committed.length && state.sliceDoc(r.head - committed.length, r.head) === committed;
  if (!ranges.some(matches)) return false;
  view.dispatch(
    state.changeByRange((r) =>
      matches(r)
        ? {
            changes: { from: r.head - committed.length, to: r.head, insert: typed },
            range: EditorSelection.cursor(r.head - committed.length + typed.length),
          }
        : { range: r },
    ),
    { userEvent: "input.type.compose" },
  );
  return true;
}

export const imeSyllableSpaces = ViewPlugin.fromClass(
  class {
    /** The composition text the IME displays, from the last `compositionupdate`. */
    composition = "";
    timer: ReturnType<typeof setTimeout> | undefined;
    constructor(readonly view: EditorView) {}
    destroy() {
      clearTimeout(this.timer);
    }
  },
  {
    eventHandlers: {
      compositionstart() {
        this.composition = "";
      },
      compositionupdate(e) {
        this.composition = e.data;
      },
      compositionend(e) {
        const committed = e.data;
        const typed = typedImeCommit(committed, this.composition);
        this.composition = "";
        if (typed === committed) return;
        // CodeMirror reads the commit from the DOM after this event (a microtask); fix it after that.
        clearTimeout(this.timer);
        this.timer = setTimeout(() => retypeImeCommit(this.view, committed, typed), 0);
      },
    },
  },
);
