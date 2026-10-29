/**
 * Inline completion (LSP 3.18 `textDocument/inlineCompletion`): a server's
 * suggestion shown as gray text at the caret while typing (Settings › Editor ›
 * General › Inline Completion). Tab accepts it, Escape dismisses it, ⌥] / ⌥[
 * cycle through the server's variants and ⌘→ accepts the next word; typing what
 * it shows keeps it. Requests are debounced and cancelled (RequestId) as typing
 * goes on; only servers advertising `inlineCompletionProvider` are asked.
 */
import { completionStatus } from "@codemirror/autocomplete";
import { EditorSelection, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { registerActions, type Action } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { editorPrefs } from "@/platform/editorSettings";
import {
  call,
  commands,
  isCancelled,
  isTauri,
  nextRequestId,
  type Command,
  type InlineCompletionItem,
  type RequestId,
  unavailableText,
} from "@/platform/ipc";
import { activeEditor } from "@/editor/api";
import { docOf, isUnavailable, lspRequest } from "./lsp";
import { offsetToPos, rangeToOffsets } from "./positions";
import { showHint } from "./hint";
import { featureBackoff } from "./availability";

/** A suggestion in document offsets: `text` replaces `[from, to)`. */
export interface Suggestion {
  from: number;
  to: number;
  text: string;
  command: Command | null;
}

export interface Ghost {
  items: Suggestion[];
  index: number;
  /** Caret the ghost is shown at. */
  caret: number;
}

export const CONTEXT_KEY = "inlineCompletionVisible";
/** Debounce while typing when "show only when typing pauses" is off. */
const TYPING_DELAY = 75;
/** Back-off after "no server supports inline completion", per document. */
const BACKOFF_MS = 30_000;

export const setGhost = StateEffect.define<Ghost | null>();
const cycleGhost = StateEffect.define<1 | -1>();

/** The suggestion still applies at the caret: what was typed since is a prefix of it. */
function stillValid(state: EditorState, s: Suggestion): boolean {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const caret = sel.main.head;
  if (caret < s.from) return false;
  const typed = state.doc.sliceString(s.from, caret);
  return s.text.length > typed.length && s.text.startsWith(typed);
}

/** The text shown after the caret: the rest of the suggestion, without what already follows the caret and it replaces. */
export function ghostText(state: EditorState, s: Suggestion): string {
  const caret = state.selection.main.head;
  const rest = s.text.slice(caret - s.from);
  const after = s.to > caret ? state.doc.sliceString(caret, s.to) : "";
  return after && rest.endsWith(after) ? rest.slice(0, rest.length - after.length) : rest;
}

export const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGhost)) value = e.value;
      else if (e.is(cycleGhost) && value && value.items.length > 1)
        value = { ...value, index: (value.index + e.value + value.items.length) % value.items.length };
    }
    if (!value) return null;
    let items = value.items;
    if (tr.docChanged)
      items = items.map((s) => ({
        ...s,
        from: tr.changes.mapPos(s.from, -1),
        to: Math.max(tr.changes.mapPos(s.to, 1), tr.changes.mapPos(s.from, -1)),
      }));
    if (!tr.docChanged && !tr.selection && items === value.items) return value;
    if (completionStatus(tr.state) === "active") return null;
    const current = items[value.index];
    const valid = items.filter((s) => stillValid(tr.state, s));
    if (!valid.length) return null;
    const index = current && valid.includes(current) ? valid.indexOf(current) : 0;
    return { items: valid, index, caret: tr.state.selection.main.head };
  },
  provide: (f) =>
    EditorView.decorations.compute([f], (state) => {
      const g = state.field(f);
      const s = g?.items[g.index];
      const text = s ? ghostText(state, s) : "";
      if (!g || !text) return Decoration.none;
      const label = g.items.length > 1 ? `${g.index + 1}/${g.items.length}` : null;
      return Decoration.set([Decoration.widget({ widget: new GhostWidget(text, label), side: 1 }).range(g.caret)]);
    }),
});

class GhostWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly label: string | null,
  ) {
    super();
  }
  eq(other: GhostWidget) {
    return other.text === this.text && other.label === this.label;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-inline-ghost";
    el.textContent = this.text;
    if (this.label) el.title = `Suggestion ${this.label}`;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** Inline completion items → suggestions at `caret` of `state` (no range: inserted at the caret). */
export function toSuggestions(state: EditorState, caret: number, items: readonly InlineCompletionItem[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const item of items) {
    const { from, to } = item.range ? rangeToOffsets(state.doc, item.range) : { from: caret, to: caret };
    const s = { from, to, text: item.insertText, command: item.command };
    if (from <= caret && stillValid(state, s) && !out.some((o) => o.from === from && o.text === s.text)) out.push(s);
  }
  return out;
}

function enabledFor(language: string): boolean {
  const p = editorPrefs().inlineCompletion;
  return p.enabled && !p.disabledLanguages.includes(language);
}

const backoff = featureBackoff(BACKOFF_MS);
let focused: EditorView | null = null;
let inflight: RequestId | null = null;

function cancelInflight() {
  if (inflight !== null && isTauri()) void commands.cancelRequest(inflight);
  inflight = null;
}

/** Asks the servers for suggestions at the caret and shows them; false when there are none. */
export async function requestInline(view: EditorView, automatic: boolean): Promise<boolean> {
  const doc = docOf(view);
  const state = view.state;
  const sel = state.selection;
  if (!doc || sel.ranges.length !== 1 || !sel.main.empty || view.state.readOnly) return false;
  if (automatic && backoff.active(doc.doc)) return false;
  cancelInflight();
  const id = (inflight = nextRequestId());
  const caret = sel.main.head;
  try {
    const items = await lspRequest(
      () => commands.lspInlineCompletion(id, doc.doc, offsetToPos(state.doc, caret), automatic),
      () => inflight === id,
    );
    if (view.state.doc !== state.doc || !view.state.selection.eq(sel)) return false;
    const suggestions = toSuggestions(view.state, caret, items);
    view.dispatch({ effects: setGhost.of(suggestions.length ? { items: suggestions, index: 0, caret } : null) });
    return suggestions.length > 0;
  } catch (e) {
    if (isUnavailable(e)) backoff.mark(doc.doc);
    else if (!isCancelled(e)) console.debug("[lsp] inline completion", e);
    if (!automatic && !isCancelled(e)) throw e;
    return false;
  } finally {
    if (inflight === id) inflight = null;
  }
}

function publish(view: EditorView) {
  if (view.hasFocus) focused = view;
  if (focused === view) setContext(CONTEXT_KEY, view.hasFocus && !!view.state.field(ghostField, false));
}

const typedChange = (u: ViewUpdate) =>
  u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete"));

const inlinePlugin = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | undefined;
    constructor(private view: EditorView) {}
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) {
        clearTimeout(this.timer);
        cancelInflight();
      }
      if (u.docChanged && typedChange(u) && !u.state.field(ghostField)) this.schedule();
      if (
        u.focusChanged ||
        u.docChanged ||
        u.selectionSet ||
        u.startState.field(ghostField) !== u.state.field(ghostField)
      ) {
        if (u.focusChanged && !u.view.hasFocus && u.state.field(ghostField))
          queueMicrotask(() => {
            if (this.view.dom.isConnected && !this.view.hasFocus) dismissInline(this.view);
          });
        publish(u.view);
      }
    }
    schedule() {
      const doc = docOf(this.view);
      if (!doc || !enabledFor(doc.language) || !isTauri()) return;
      const p = editorPrefs().inlineCompletion;
      this.timer = setTimeout(
        () => {
          if (completionStatus(this.view.state) !== "active") void requestInline(this.view, true);
        },
        p.onlyOnPause ? p.pauseMs : TYPING_DELAY,
      );
    }
    destroy() {
      clearTimeout(this.timer);
      if (focused === this.view) {
        focused = null;
        setContext(CONTEXT_KEY, false);
      }
    }
  },
);

export function inlineCompletionExtension(): Extension {
  return [ghostField, inlinePlugin];
}

/** The next word of a suggestion's rest: leading spaces plus one word or run of punctuation. */
export function nextWord(rest: string): string {
  return /^\s*(?:[\p{L}\p{N}_$]+|[^\p{L}\p{N}_$\s]+)|^\s+/u.exec(rest)?.[0] ?? rest;
}

/** Accepts the shown suggestion (`word`: only its next word). False when none is shown. */
export function acceptInline(view: EditorView, word = false): boolean {
  const g = view.state.field(ghostField, false);
  const s = g?.items[g.index];
  if (!g || !s) return false;
  const caret = view.state.selection.main.head;
  if (word) {
    const chunk = nextWord(s.text.slice(caret - s.from));
    view.dispatch({
      changes: { from: caret, insert: chunk },
      selection: EditorSelection.cursor(caret + chunk.length),
      userEvent: "input.complete",
      scrollIntoView: true,
    });
    return true;
  }
  view.dispatch({
    changes: { from: s.from, to: Math.max(s.to, caret), insert: s.text },
    selection: EditorSelection.cursor(s.from + s.text.length),
    effects: setGhost.of(null),
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  const doc = docOf(view);
  if (s.command && doc && isTauri()) void call(commands.lspExecuteCommand(doc.doc, s.command)).catch(() => undefined);
  return true;
}

export function dismissInline(view: EditorView): boolean {
  if (!view.state.field(ghostField, false)) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
}

export function cycleInline(view: EditorView, dir: 1 | -1): boolean {
  if (!view.state.field(ghostField, false)) return false;
  view.dispatch({ effects: cycleGhost.of(dir) });
  return true;
}

const VISIBLE = `editorTextFocus && ${CONTEXT_KEY}`;

function onView(run: (view: EditorView) => unknown): Action["run"] {
  return () => {
    const view = activeEditor()?.view;
    if (view) void run(view);
  };
}

export function registerInlineCompletionActions(): () => void {
  const shown = (id: string, title: string, run: (v: EditorView) => unknown): Action => ({
    id,
    title,
    category: "Inline Completion",
    when: VISIBLE,
    run: onView(run),
  });
  return registerActions([
    {
      id: "editor.inlineCompletion.trigger",
      title: "Call Inline Completion",
      category: "Code",
      when: "editorTextFocus",
      keywords: ["ghost text", "inline suggestion"],
      run: onView(async (v) => {
        const doc = docOf(v);
        if (!doc || !enabledFor(doc.language)) return showHint(v, "Inline completion is off for this language");
        try {
          if (!(await requestInline(v, false))) showHint(v, "No inline suggestions");
        } catch (e) {
          showHint(v, isUnavailable(e) ? unavailableText(e) : String(e));
        }
      }),
    },
    shown("editor.inlineCompletion.accept", "Insert Inline Proposal", (v) => acceptInline(v)),
    shown("editor.inlineCompletion.acceptWord", "Insert Inline Proposal: Next Word", (v) => acceptInline(v, true)),
    shown("editor.inlineCompletion.dismiss", "Hide Inline Proposal", dismissInline),
    shown("editor.inlineCompletion.next", "Show Next Inline Proposal", (v) => cycleInline(v, 1)),
    shown("editor.inlineCompletion.previous", "Show Previous Inline Proposal", (v) => cycleInline(v, -1)),
  ]);
}
