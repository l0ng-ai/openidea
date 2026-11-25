/**
 * Documents shown by views outside the tab system (the editable side of a
 * diff): local edits flow view → model → backend and other editors; edits
 * from elsewhere are mirrored into the view. See `attachDocument` in editor/api.
 */
import { history, historyField, redo, undo } from "@codemirror/commands";
import {
  ChangeSet,
  Compartment,
  EditorState,
  Transaction,
  type Annotation,
  type StateCommand,
} from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import {
  _addEditor,
  _removeEditor,
  documentSynced,
  isExternalChange,
  remoteChange,
  transientChange,
  type DocumentAttachment,
  type DocumentAttachmentOptions,
  type TextEditorHandle,
} from "@/editor/api";
import { useDocMeta, type DocAttachmentTarget, type DocumentManager } from "./document";
import { saveOnBlur } from "../saveOnBlur";
import { editorHistoryKeymap } from "../cm/baseKeymap";

class AttachedView implements DocAttachmentTarget {
  view: EditorView | null = null;
  forwarding = false;
  storedState: EditorState | null = null;
  history = new Compartment();
  readonly listeners = new Set<(changes: ChangeSet) => void>();
  historyState?: () => EditorState | null;
  adoptHistory?: (state: EditorState) => void;

  applyExternal(changes: ChangeSet, annotations: Annotation<unknown>[]) {
    if (this.forwarding) return;
    if (this.view) this.view.dispatch({ changes, annotations });
    else if (this.storedState) this.storedState = this.storedState.update({ changes, annotations }).state;
    for (const listener of this.listeners) listener(changes);
  }
}

export async function attachDocument(
  manager: DocumentManager,
  path: string,
  options: DocumentAttachmentOptions = {},
): Promise<DocumentAttachment> {
  const model = await manager.acquire(path);
  const target = new AttachedView();
  if (options.sharedHistory) {
    target.historyState = () => target.view?.state ?? target.storedState;
    target.adoptHistory = (state) => {
      const value = state.field(historyField, false);
      if (!value) return;
      for (const extension of [[], [history(), historyField.init(() => value)]]) {
        const effects = target.history.reconfigure(extension);
        if (target.view) target.view.dispatch({ effects });
        else if (target.storedState) target.storedState = target.storedState.update({ effects }).state;
      }
    };
  }
  model.attach(target);
  let released = false;
  let cancelBlurSave: (() => void) | undefined;
  let detachHistory: (() => void) | null = null;
  const historyTarget = {
    path,
    state: () => (target.view?.state ?? target.storedState)!,
    dispatch: (tr: Transaction) => {
      if (target.view) target.view.dispatch(tr);
      else target.storedState = tr.state;
    },
  };

  const plugin = ViewPlugin.define((view) => {
    target.view = view;
    let destroyed = false;
    queueMicrotask(() => {
      if (!destroyed && !detachHistory) detachHistory = model.manager.workspaceHistory.attach(historyTarget);
    });
    const handle: TextEditorHandle = { view, ctx: model.ctx() };
    _addEditor(handle);
    // The model may have moved on between `text()` and the view's creation.
    const current = model.sync.localText;
    if (!view.state.doc.eq(current))
      queueMicrotask(() => {
        if (target.view !== view) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: current },
          annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
        });
      });
    return {
      destroy() {
        destroyed = true;
        cancelBlurSave?.();
        if (!options.sharedHistory) {
          detachHistory?.();
          detachHistory = null;
        }
        _removeEditor(handle);
        if (target.view === view) {
          target.storedState = view.state;
          target.view = null;
        }
      },
    };
  });

  /** Runs a history command where the document's history is (see `DocumentAttachment.undo`). */
  const historyCommand = (command: StateCommand): boolean => {
    if (model.ctx().readOnly || released || model.closed) return false;
    const slot = model.primarySlot();
    if (slot?.view) return command(slot.view);
    if (slot) return command({ state: slot.state, dispatch: (tr) => slot.dispatchLocal(tr) });
    return target.view ? command(target.view) : false;
  };

  return {
    path,
    doc: model.doc,
    text: () => model.sync.localText.toString(),
    lineEnding: () => model.getMeta().lineEnding,
    uiMode: () => model.getMeta().uiMode,
    context: () => model.ctx(),
    get readOnly() {
      return model.getMeta().readOnly || model.virtual;
    },
    subscribeReadOnly: (listener) =>
      useDocMeta.subscribe((state, previous) => {
        if (state[model.path]?.readOnly !== previous[model.path]?.readOnly) listener();
      }),
    subscribeExternalChanges: (listener) => {
      target.listeners.add(listener);
      return () => void target.listeners.delete(listener);
    },
    editorState: () => target.view?.state ?? target.storedState,
    dispatchTransactions: (transactions, view) => {
      for (const tr of transactions) {
        const slot = options.sharedHistory && model.primarySlot();
        if (!slot || !tr.docChanged || isExternalChange(tr) || tr.annotation(transientChange)) {
          view.update([tr]);
          continue;
        }
        target.forwarding = true;
        try {
          view.update([tr]);
          slot.dispatchLocal({ changes: tr.changes, userEvent: tr.annotation(Transaction.userEvent) });
        } finally {
          target.forwarding = false;
        }
      }
    },
    extension: [
      EditorView.domEventHandlers({
        blur: (_event, view) => {
          cancelBlurSave?.();
          if (view.state.readOnly || !view.state.facet(EditorView.editable)) return;
          cancelBlurSave = saveOnBlur(
            () => view.hasFocus,
            () => {
              if (released || model.closed || manager.settings()?.files?.autoSave === false) return;
              void model.save("auto").catch((e) => console.warn(`autosave of ${path} failed`, e));
            },
          );
        },
      }),
      options.sharedHistory ? target.history.of(history()) : [],
      options.sharedHistory
        ? [
            keymap.of(
              editorHistoryKeymap.map((binding) => {
                if (binding.run === undo) return { ...binding, run: () => historyCommand(undo) };
                if (binding.run === redo) return { ...binding, run: () => historyCommand(redo) };
                return binding;
              }),
            ),
            EditorView.domEventHandlers({
              beforeinput: (event) => {
                if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return false;
                event.preventDefault();
                historyCommand(event.inputType === "historyUndo" ? undo : redo);
                return true;
              },
            }),
          ]
        : [],
      EditorState.changeFilter.of((tr) => isExternalChange(tr) || !model.ctx().readOnly),
      options.sharedHistory
        ? EditorState.transactionExtender.of((tr) =>
            model.primarySlot() && tr.docChanged && !isExternalChange(tr)
              ? { annotations: Transaction.addToHistory.of(false) }
              : null,
          )
        : [],
      model.manager.workspaceHistory.extension(historyTarget),
      plugin,
      documentSynced.of(() => model.sync.whenIdle()),
      EditorView.updateListener.of((u) => {
        if (released || model.closed || target.forwarding) return;
        for (const tr of u.transactions)
          if (tr.docChanged && !isExternalChange(tr) && !tr.annotation(transientChange))
            model.onLocal(tr.changes, target);
      }),
    ],
    save: (options) => model.save(options?.exact ? "exact" : "explicit"),
    synced: () => model.sync.whenIdle(),
    dirty: () => model.getMeta().dirty,
    undo: () => historyCommand(undo),
    redo: () => historyCommand(redo),
    edit: (changes, userEvent = "input") => {
      if (released || model.closed || model.ctx().readOnly) return;
      // Into the document's history, like a typed edit: the text tab's when there is one.
      const slot = model.primarySlot();
      if (slot) slot.dispatchLocal({ changes, userEvent });
      else if (target.view) target.view.dispatch({ changes, userEvent });
      else {
        const edit = ChangeSet.of(changes, model.sync.localText.length);
        if (edit.empty) return;
        target.applyExternal(edit, [Transaction.userEvent.of(userEvent)]);
        model.onLocal(edit, target);
      }
    },
    release: () => {
      if (released) return;
      released = true;
      cancelBlurSave?.();
      detachHistory?.();
      detachHistory = null;
      target.view = null;
      target.storedState = null;
      target.listeners.clear();
      model.detach(target);
    },
  };
}
