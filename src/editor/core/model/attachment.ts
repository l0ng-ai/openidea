/**
 * Documents shown by views outside the tab system (the editable side of a
 * diff): local edits flow view → model → backend and other editors; edits
 * from elsewhere are mirrored into the view. See `attachDocument` in editor/api.
 */
import { redo, undo } from "@codemirror/commands";
import { Transaction, type Annotation, type ChangeSet, type StateCommand } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  _addEditor,
  _removeEditor,
  documentSynced,
  isExternalChange,
  remoteChange,
  transientChange,
  type DocumentAttachment,
  type TextEditorHandle,
} from "@/editor/api";
import type { DocAttachmentTarget, DocumentManager } from "./document";

class AttachedView implements DocAttachmentTarget {
  view: EditorView | null = null;

  applyExternal(changes: ChangeSet, annotations: Annotation<unknown>[]) {
    this.view?.dispatch({ changes, annotations });
  }
}

export async function attachDocument(manager: DocumentManager, path: string): Promise<DocumentAttachment> {
  const model = await manager.acquire(path);
  const target = new AttachedView();
  model.attach(target);
  let released = false;
  const historyTarget = {
    path,
    state: () => target.view!.state,
    dispatch: (tr: Transaction) => target.view?.dispatch(tr),
  };

  const plugin = ViewPlugin.define((view) => {
    target.view = view;
    let detachHistory = () => {};
    let destroyed = false;
    queueMicrotask(() => {
      if (!destroyed) detachHistory = model.manager.workspaceHistory.attach(historyTarget);
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
        detachHistory();
        _removeEditor(handle);
        if (target.view === view) target.view = null;
      },
    };
  });

  /** Runs a history command where the document's history is (see `DocumentAttachment.undo`). */
  const historyCommand = (command: StateCommand): boolean => {
    const slot = model.primarySlot();
    if (slot?.view) return command(slot.view);
    if (slot)
      return command({
        state: slot.state,
        dispatch: (tr) => {
          slot.state = tr.state;
          if (tr.docChanged) model.onLocal(tr.changes, slot);
        },
      });
    return target.view ? command(target.view) : false;
  };

  return {
    path,
    doc: model.doc,
    text: () => model.sync.localText.toString(),
    dirty: () => model.getMeta().dirty,
    uiMode: () => model.getMeta().uiMode,
    readOnly: model.getMeta().readOnly || model.virtual,
    extension: [
      model.manager.workspaceHistory.extension(historyTarget),
      plugin,
      documentSynced.of(() => model.sync.whenIdle()),
      EditorView.updateListener.of((u) => {
        if (released || model.closed) return;
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
      // Into the document's history, like a typed edit: the text tab's when there is one.
      const slot = model.primarySlot();
      if (slot) slot.dispatchLocal({ changes, userEvent });
      else target.view?.dispatch({ changes, userEvent });
    },
    release: () => {
      if (released) return;
      released = true;
      target.view = null;
      model.detach(target);
    },
  };
}
