/**
 * An editor slot is one tab showing a text document in one pane. It owns the
 * tab's EditorState (selection, folds, undo history, scroll) and, while the
 * tab is visible, an EditorView. Background tabs keep only their state; views
 * are created on show and destroyed on hide, so many open tabs cost little.
 *
 * All slots of a document share its DocModel: local edits flow
 * slot → model → backend and are mirrored into the other slots.
 */
import {
  type Annotation,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  type Transaction,
  type ChangeSet,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import {
  _addEditor,
  _removeEditor,
  documentSynced,
  isExternalChange,
  type EditorDocContext,
  type TextEditorHandle,
} from "@/editor/api";
import { showContextMenu } from "@/ui";
import { baseExtensions, compartments, contributionExtensions } from "../cm/setup";
import { gutterMenuItems, inGutterMenuArea } from "../gutterMenu";
import type { DocModel } from "./document";
import type { WorkspaceHistoryTarget } from "./workspaceHistory";
import { isNavigation } from "./navHistory";

export interface SlotHost {
  onFocus(slot: EditorSlot): void;
  onBlur(slot: EditorSlot): void;
  /** `navigatedFrom`: the caret before a navigation transaction (mouse click, find, jump…). */
  onSelection(slot: EditorSlot, navigatedFrom?: { line: number; col: number }): void;
  onUserEdit(slot: EditorSlot, tr: Transaction): void;
  onContextMenu(slot: EditorSlot, e: MouseEvent): void;
  /** Escape in the editor (close the find bar…); return true when handled. */
  onEscape?(slot: EditorSlot): boolean;
}

export interface Reveal {
  anchor: number;
  head?: number;
  /** Scroll so the target is centred (IDEA navigation) instead of minimally. */
  center?: boolean;
}

export class EditorSlot {
  state: EditorState;
  private historyTarget: WorkspaceHistoryTarget;
  private detachHistory: () => void;
  view: EditorView | null = null;
  handle: TextEditorHandle | null = null;
  private scroll: StateEffect<unknown> | null = null;
  private pendingReveal: Reveal | null = null;
  /** First visible line (0-based) when the view was last unmounted. */
  private savedTopLine: number | undefined;
  private contributionsVersion: number;
  disposed = false;
  /** Focus the view as soon as it is mounted. */
  wantsFocus = false;
  /** View update observers (find bar counter, etc.). */
  readonly listeners = new Set<(u: ViewUpdate) => void>();

  constructor(
    readonly model: DocModel,
    readonly tabId: string,
    private host: SlotHost,
    init?: { from?: EditorSlot; reveal?: Reveal },
  ) {
    this.historyTarget = {
      path: model.path,
      state: () => this.currentState(),
      dispatch: (tr) => {
        if (this.view) this.view.dispatch(tr);
        else this.state = tr.state;
      },
    };
    const source = init?.from;
    this.state = EditorState.create({
      doc: model.sync.localText,
      selection: source ? source.currentState().selection : undefined,
      extensions: baseExtensions({
        ctx: model.ctx(),
        settings: model.settings(),
        info: model.info,
        language: model.language,
        docLength: model.sync.localText.length,
        indent: model.effectiveIndent(),
        wrapOverride: model.softWrapOverride,
        extra: this.slotExtensions(),
      }),
    });
    this.contributionsVersion = model.manager.contributionsVersion;
    if (source?.view) this.scroll = source.view.scrollSnapshot();
    else if (source) this.scroll = source.scroll;
    if (init?.reveal) this.pendingReveal = init.reveal;
    model.addSlot(this);
    this.detachHistory = model.manager.workspaceHistory.attach(this.historyTarget);
  }

  get ctx(): EditorDocContext {
    return this.model.ctx();
  }

  currentState(): EditorState {
    return this.view?.state ?? this.state;
  }

  private slotExtensions() {
    return [
      this.model.manager.workspaceHistory.extension(this.historyTarget),
      documentSynced.of(() => this.model.sync.whenIdle()),
      EditorView.updateListener.of((u) => {
        for (const l of this.listeners) l(u);
        if (u.focusChanged) {
          if (u.view.hasFocus) this.host.onFocus(this);
          else this.host.onBlur(this);
        }
      }),
      Prec.highest(keymap.of([{ key: "Escape", run: () => this.host.onEscape?.(this) ?? false }])),
      EditorView.domEventHandlers({
        contextmenu: (e) => {
          this.host.onContextMenu(this, e);
          return true;
        },
      }),
      ViewPlugin.define((view) => {
        // Gutters sit outside the content DOM. Gutter extensions with their own menu (breakpoints,
        // annotations) handle the event first and prevent its default.
        const onContextMenu = (e: MouseEvent) => {
          if (e.defaultPrevented || !inGutterMenuArea(e.target)) return;
          e.preventDefault();
          const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
          showContextMenu(e, gutterMenuItems(this, view.state.doc.lineAt(block.from).number - 1));
        };
        view.dom.addEventListener("contextmenu", onContextMenu);
        return { destroy: () => view.dom.removeEventListener("contextmenu", onContextMenu) };
      }),
    ];
  }

  // --- view lifecycle -------------------------------------------------------

  mount(parent: HTMLElement): EditorView {
    if (this.view) return this.view;
    this.syncContributions();
    const view = new EditorView({
      state: this.state,
      parent,
      dispatchTransactions: (trs, v) => this.onTransactions(trs, v),
    });
    this.view = view;
    if (this.scroll) view.dispatch({ effects: this.scroll });
    this.scroll = null;
    this.handle = { view, ctx: this.model.ctx() };
    _addEditor(this.handle);
    if (this.pendingReveal) {
      const r = this.pendingReveal;
      this.pendingReveal = null;
      this.reveal(r);
    }
    return view;
  }

  unmount() {
    const view = this.view;
    if (!view) return;
    this.savedTopLine = topLineOf(view);
    this.state = view.state;
    this.scroll = view.scrollSnapshot();
    if (this.handle) _removeEditor(this.handle);
    this.handle = null;
    this.view = null;
    view.destroy();
  }

  dispose() {
    if (this.disposed) return;
    this.detachHistory();
    this.unmount();
    this.disposed = true;
    this.model.removeSlot(this);
  }

  focus() {
    this.view?.focus();
  }

  // --- transactions ---------------------------------------------------------

  private onTransactions(trs: readonly Transaction[], view: EditorView) {
    view.update(trs);
    let selection = false;
    let navigatedFrom: { line: number; col: number } | undefined;
    for (const tr of trs) {
      if (!navigatedFrom && tr.selection && isNavigation(tr)) {
        const head = tr.startState.selection.main.head;
        const line = tr.startState.doc.lineAt(head);
        navigatedFrom = { line: line.number - 1, col: head - line.from };
      }
      if (tr.docChanged && !isExternalChange(tr)) {
        this.model.onLocal(tr.changes, this);
        if (
          tr.isUserEvent("input") ||
          tr.isUserEvent("delete") ||
          tr.isUserEvent("move") ||
          tr.isUserEvent("undo") ||
          tr.isUserEvent("redo")
        )
          this.host.onUserEdit(this, tr);
      }
      if (tr.selection || tr.docChanged) selection = true;
    }
    if (selection) this.host.onSelection(this, navigatedFrom);
  }

  /** Applies a transaction as if the user made it (synced, undoable). */
  dispatchLocal(spec: TransactionSpec) {
    if (this.view) {
      this.view.dispatch(spec);
      return;
    }
    const tr = this.state.update(spec);
    this.state = tr.state;
    if (tr.docChanged) this.model.onLocal(tr.changes, this);
  }

  /** Applies changes that are already in the model (other slot / backend). */
  applyExternal(changes: ChangeSet, annotations: Annotation<unknown>[]) {
    const spec: TransactionSpec = { changes, annotations };
    if (this.view) this.view.dispatch(spec);
    else this.state = this.state.update(spec).state;
  }

  /** Applies effects (reconfiguration) to the view or the stored state. */
  reconfigure(effects: StateEffect<unknown>[]) {
    if (!effects.length) return;
    if (this.view) this.view.dispatch({ effects });
    else this.state = this.state.update({ effects }).state;
    if (this.handle) this.handle.ctx = this.model.ctx();
  }

  /** Re-applies editor contributions if the registry changed since this state was built. */
  syncContributions(force = false) {
    const version = this.model.manager.contributionsVersion;
    if (!force && version === this.contributionsVersion) return;
    this.contributionsVersion = version;
    this.reconfigure([compartments.contributions.reconfigure(contributionExtensions(this.model.ctx()))]);
  }

  // --- selection --------------------------------------------------------------

  reveal(r: Reveal) {
    const len = this.currentState().doc.length;
    const anchor = Math.min(Math.max(0, r.anchor), len);
    const head = Math.min(Math.max(0, r.head ?? anchor), len);
    if (!this.view) {
      this.state = this.state.update({ selection: EditorSelection.single(anchor, head) }).state;
      this.pendingReveal = r;
      return;
    }
    this.view.dispatch({
      selection: EditorSelection.single(anchor, head),
      effects: EditorView.scrollIntoView(EditorSelection.range(anchor, head), {
        y: r.center === false ? "nearest" : "center",
      }),
      userEvent: "select.reveal",
    });
  }

  /** Caret and first visible line, for the persisted editor session. */
  viewState(): { anchor: number; head: number; topLine?: number } {
    const main = this.currentState().selection.main;
    const topLine = this.view ? topLineOf(this.view) : this.savedTopLine;
    return { anchor: main.anchor, head: main.head, ...(topLine !== undefined ? { topLine } : {}) };
  }

  /** Restores a saved caret / scroll position (session restore). */
  restoreView(v: { anchor: number; head: number; topLine?: number }) {
    const doc = this.currentState().doc;
    const selection = EditorSelection.single(
      Math.min(Math.max(0, v.anchor), doc.length),
      Math.min(Math.max(0, v.head), doc.length),
    );
    const scroll =
      v.topLine !== undefined
        ? EditorView.scrollIntoView(doc.line(Math.min(v.topLine + 1, doc.lines)).from, { y: "start" })
        : null;
    if (this.view) {
      this.view.dispatch({ selection, effects: scroll ? [scroll] : [] });
      return;
    }
    this.state = this.state.update({ selection }).state;
    if (scroll) {
      this.scroll = scroll;
      this.savedTopLine = v.topLine;
    }
  }

  caret(): { line: number; col: number; offset: number } {
    const s = this.currentState();
    const head = s.selection.main.head;
    const line = s.doc.lineAt(head);
    return { line: line.number - 1, col: head - line.from, offset: head };
  }
}

function topLineOf(view: EditorView): number {
  const block = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop));
  return view.state.doc.lineAt(block.from).number - 1;
}
