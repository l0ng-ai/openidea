/**
 * Temporary range highlight (styled in `theme.ts`) while a chooser moves its selection (the
 * expression / occurrences an Introduce refactoring would take, a postfix
 * template's target…), as in IDEA. Not part of the document state: any
 * edit clears it, and callers clear it when their popup closes.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

export interface HighlightRange {
  from: number;
  to: number;
  tone?: "removed";
}

const setTemporary = StateEffect.define<readonly HighlightRange[]>();

const mark = Decoration.mark({ class: "cm-lsp-chooser-highlight" });
const removed = Decoration.mark({ class: "cm-lsp-chooser-removed" });

const temporaryField = StateField.define<readonly HighlightRange[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTemporary)) return e.value;
    return tr.docChanged && value.length ? [] : value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (ranges) =>
      Decoration.set(
        ranges.filter((r) => r.from < r.to).map((r) => (r.tone === "removed" ? removed : mark).range(r.from, r.to)),
        true,
      ),
    ),
});

/** Highlights `ranges` until the next call, `clearTemporaryHighlight` or an edit; scrolls the first into view. */
export function highlightRanges(view: EditorView, ranges: readonly HighlightRange[], { scroll = true } = {}): void {
  const len = view.state.doc.length;
  const clamped = ranges
    .map((r) => ({ ...r, from: Math.max(0, Math.min(r.from, len)), to: Math.max(0, Math.min(r.to, len)) }))
    .sort((a, b) => a.from - b.from);
  const effects: StateEffect<unknown>[] = [setTemporary.of(clamped)];
  if (!view.state.field(temporaryField, false))
    effects.push(StateEffect.appendConfig.of(temporaryHighlightExtension()));
  const first = clamped[0];
  if (scroll && first) effects.push(EditorView.scrollIntoView(first.from, { y: "nearest" }));
  view.dispatch({ effects });
}

export function clearTemporaryHighlight(view: EditorView): void {
  const current = view.state.field(temporaryField, false);
  if (current?.length) view.dispatch({ effects: setTemporary.of([]) });
}

export function temporaryHighlights(view: EditorView): readonly HighlightRange[] {
  return view.state.field(temporaryField, false) ?? [];
}

export function temporaryHighlightExtension(): Extension {
  return [temporaryField];
}
