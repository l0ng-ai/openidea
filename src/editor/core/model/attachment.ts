/**
 * Documents shown by views outside the tab system (the editable side of a
 * diff): local edits flow view → model → backend and other editors; edits
 * from elsewhere are mirrored into the view. See `attachDocument` in editor/api.
 */
import { Transaction, type Annotation, type ChangeSet } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import {
  _addEditor,
  _removeEditor,
  documentSynced,
  isExternalChange,
  remoteChange,
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

  return {
    path,
    text: () => model.sync.localText.toString(),
    readOnly: model.getMeta().readOnly || model.virtual,
    extension: [
      model.manager.workspaceHistory.extension(historyTarget),
      plugin,
      documentSynced.of(() => model.sync.whenIdle()),
      EditorView.updateListener.of((u) => {
        if (released || model.closed) return;
        for (const tr of u.transactions) if (tr.docChanged && !isExternalChange(tr)) model.onLocal(tr.changes, target);
      }),
    ],
    save: () => model.save("explicit"),
    release: () => {
      if (released) return;
      released = true;
      target.view = null;
      model.detach(target);
    },
  };
}
