/**
 * In-place rename, as in IDEA: the
 * name is edited right in the editor and its occurrences in this file follow
 * as you type. ↵ / ⇥ (or leaving the name) commits through the language
 * server, Esc restores the old name; ⇧F6 again opens the rename dialog
 * (handled by `rename.ts`).
 *
 * The live edits are kept out of the undo history and the old text is put
 * back before the server renames, so the project-wide rename stays a single
 * undoable edit computed against the original document.
 */
import {
  Annotation,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type ChangeSet,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  showTooltip,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { isExternalChange } from "@/editor/api";

export interface Span {
  from: number;
  to: number;
}

export interface InplaceSession {
  /** The name being edited. */
  primary: Span;
  /** Its other occurrences in this file, kept equal to `primary`. */
  others: Span[];
  oldName: string;
  /** Advertisement under the name ("Press ⇧F6 to show dialog with more options"). */
  hint: string;
  /** Runs after the old text is back, with the typed name. */
  commit: (newName: string) => void;
  /** ⇧F6 again: the rename dialog, prefilled with the typed name. */
  dialog: (typed: string) => void;
  /** Name suggestions listed under the name; ↑ / ↓ put the previous / next one in (Introduce Variable). */
  suggestions?: readonly string[];
}

const startSession = StateEffect.define<InplaceSession>();
const endSession = StateEffect.define<null>();
/** Marks the session's own edits (mirroring, restoring). */
const inplaceEdit = Annotation.define<boolean>();

const mapSpan = (s: Span, changes: ChangeSet): Span => ({
  from: changes.mapPos(s.from, -1),
  to: changes.mapPos(s.to, 1),
});

const sessionField = StateField.define<InplaceSession | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(startSession)) return e.value;
      if (e.is(endSession)) return null;
    }
    if (!value || !tr.docChanged) return value;
    return {
      ...value,
      primary: mapSpan(value.primary, tr.changes),
      others: value.others.map((o) => mapSpan(o, tr.changes)),
    };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (s) => {
      if (!s) return Decoration.none;
      const ranges = [
        ...s.others.filter((o) => o.from < o.to).map((o) => occurrenceMark.range(o.from, o.to)),
        ...(s.primary.from < s.primary.to ? [primaryMark.range(s.primary.from, s.primary.to)] : []),
      ];
      return Decoration.set(ranges, true);
    }),
    showTooltip.from(f, (s): Tooltip | null =>
      s
        ? {
            pos: s.primary.from,
            above: false,
            create: (view) => {
              const dom = document.createElement("div");
              dom.className = "cm-lsp-hint cm-lsp-inplace-hint";
              dom.setAttribute("role", "status");
              if (s.suggestions?.length) {
                const current = view.state.sliceDoc(s.primary.from, s.primary.to);
                const list = document.createElement("ul");
                list.className = "cm-lsp-inplace-suggestions";
                list.setAttribute("aria-label", "Suggested names");
                for (const name of s.suggestions) {
                  const li = document.createElement("li");
                  li.textContent = name;
                  if (name === current) li.className = "cm-lsp-inplace-suggestion-active";
                  // A click puts the name in; a double click also finishes, like Enter.
                  li.addEventListener("mousedown", (e) => {
                    e.preventDefault();
                    putSuggestion(view, name);
                    if (e.detail >= 2) endInplaceRename(view, "commit");
                  });
                  li.addEventListener("dblclick", () => {
                    if (putSuggestion(view, name)) endInplaceRename(view, "commit");
                  });
                  list.appendChild(li);
                }
                dom.appendChild(list);
              }
              const hint = document.createElement("div");
              hint.textContent = s.hint;
              dom.appendChild(hint);
              return { dom };
            },
          }
        : null,
    ),
  ],
});

const primaryMark = Decoration.mark({ class: "cm-lsp-inplace cm-lsp-inplace-primary" });
const occurrenceMark = Decoration.mark({ class: "cm-lsp-inplace" });

/** True when every change of `changes` lies within `span` (boundaries included). */
export function changesWithin(changes: ChangeSet, span: Span): boolean {
  let inside = true;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA < span.from || toA > span.to) inside = false;
  });
  return inside;
}

/** Linked editing: an edit inside the name is repeated on every other occurrence. */
const mirror = EditorState.transactionFilter.of((tr) => {
  const s = tr.startState.field(sessionField, false);
  if (!s || !tr.docChanged || tr.annotation(inplaceEdit) || isExternalChange(tr)) return tr;
  if (!changesWithin(tr.changes, s.primary)) return tr;
  const primary = mapSpan(s.primary, tr.changes);
  const name = tr.newDoc.sliceString(primary.from, primary.to);
  const changes = s.others.map((o) => ({ ...mapSpan(o, tr.changes), insert: name }));
  return [tr, { changes, sequential: true, annotations: [inplaceEdit.of(true), Transaction.addToHistory.of(false)] }];
});

export function inplaceSession(state: EditorState): InplaceSession | null {
  return state.field(sessionField, false) ?? null;
}

export function inplaceRenameActive(state: EditorState): boolean {
  return !!inplaceSession(state);
}

/** Starts editing `primary` in place, its `others` linked; the name is preselected (IDEA's "Preselect old name"). */
export function startInplaceRename(view: EditorView, session: Omit<InplaceSession, "oldName">): void {
  const oldName = view.state.sliceDoc(session.primary.from, session.primary.to);
  view.dispatch({
    effects: startSession.of({ ...session, oldName }),
    selection: EditorSelection.range(session.primary.from, session.primary.to),
    scrollIntoView: true,
  });
}

/** Replaces the name being edited (and so its occurrences) with `name`, selected. */
export function putSuggestion(view: EditorView, name: string): boolean {
  const s = inplaceSession(view.state);
  if (!s) return false;
  const { from, to } = s.primary;
  view.dispatch({
    changes: { from, to, insert: name },
    selection: EditorSelection.range(from, from + name.length),
    annotations: Transaction.addToHistory.of(false),
  });
  return true;
}

/** ↑ / ↓ over the suggestions; false without any (the key then moves the caret, ending the session). */
export function cycleSuggestion(view: EditorView, delta: 1 | -1): boolean {
  const s = inplaceSession(view.state);
  const list = s?.suggestions;
  // An open lookup keeps the arrows.
  if (!s || !list?.length || completionStatus(view.state) === "active") return false;
  const current = view.state.sliceDoc(s.primary.from, s.primary.to);
  const i = list.indexOf(current);
  const next = list[i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length]!;
  return putSuggestion(view, next);
}

/**
 * Ends the session, putting the old name back everywhere. Returns the name
 * that was typed (null without a session). `commit` then runs the rename.
 */
export function endInplaceRename(view: EditorView, how: "commit" | "cancel" | "restore"): string | null {
  const s = inplaceSession(view.state);
  if (!s) return null;
  const typed = view.state.sliceDoc(s.primary.from, s.primary.to);
  const spans = [s.primary, ...s.others].sort((a, b) => a.from - b.from);
  const changes = view.state.changes(spans.map((o) => ({ ...o, insert: s.oldName })));
  const head = view.state.selection.main.head;
  const inName = Math.min(Math.max(0, head - s.primary.from), s.oldName.length);
  const caret = changes.mapPos(s.primary.from, -1) + inName;
  const insideName = head >= s.primary.from && head <= s.primary.to;
  view.dispatch({
    changes,
    effects: endSession.of(null),
    // Leaving the name keeps the caret where the user put it.
    selection: insideName ? EditorSelection.cursor(caret) : undefined,
    annotations: [inplaceEdit.of(true), Transaction.addToHistory.of(false)],
  });
  if (how === "commit") s.commit(typed);
  return typed;
}

/** Leaving the name (caret or an edit elsewhere) finishes the rename, like IDEA's template. */
const watcher = ViewPlugin.fromClass(
  class {
    constructor(private view: EditorView) {}
    update(u: ViewUpdate) {
      const s = inplaceSession(u.state);
      if (!s || !inplaceSession(u.startState)) return;
      const head = u.state.selection.main.head;
      const outside = head < s.primary.from || head > s.primary.to || u.state.selection.ranges.length > 1;
      const foreignEdit = u.transactions.some((tr) => {
        const before = inplaceSession(tr.startState);
        return (
          !!before &&
          tr.docChanged &&
          !tr.annotation(inplaceEdit) &&
          !isExternalChange(tr) &&
          !changesWithin(tr.changes, before.primary)
        );
      });
      if (outside || foreignEdit) queueMicrotask(() => endInplaceRename(this.view, "commit"));
    }
  },
);

const keys = Prec.highest(
  keymap.of([
    { key: "Enter", run: (v) => endInplaceRename(v, "commit") !== null },
    { key: "Tab", run: (v) => endInplaceRename(v, "commit") !== null },
    { key: "Escape", run: (v) => endInplaceRename(v, "cancel") !== null },
    // Undo while renaming restores the old name instead of undoing earlier edits.
    { key: "Mod-z", run: (v) => endInplaceRename(v, "cancel") !== null },
    { key: "ArrowDown", run: (v) => cycleSuggestion(v, 1) },
    { key: "ArrowUp", run: (v) => cycleSuggestion(v, -1) },
  ]),
);

export function inplaceRenameExtension(): Extension {
  return [sessionField, mirror, watcher, keys];
}
