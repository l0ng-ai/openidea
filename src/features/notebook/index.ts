import type { NotebookSnapshot } from "@/bindings";
import { basename } from "@/platform/project";
import { lazyComponent } from "@/ui";
import {
  registerEditorKind,
  registerFileEditorProvider,
  type EditorDocumentLifecycle,
} from "@/workbench/contributions";
import { isTauri } from "@/platform/ipc";
import { ProviderAcquisitions } from "@/workbench/providerAcquisition";
import { closeNotebook, existingNotebookSession, notebookBackend, notebookSession } from "./session";

const acquisitions = new ProviderAcquisitions<NotebookSnapshot>(
  (snapshot) => existingNotebookSession(snapshot.path)?.getState().snapshot?.id === snapshot.id,
  (snapshot) => notebookBackend.close(snapshot.id),
);

// Lifecycle calls must not create sessions for a tab which has never loaded.
const document: EditorDocumentLifecycle = {
  isDirty: (input) => !!input.path && !!existingNotebookSession(input.path)?.isDirty(),
  flush: async (input) => {
    if (input.path) await existingNotebookSession(input.path)?.flush();
  },
  save: async (input) => {
    if (input.path) await existingNotebookSession(input.path)?.save();
  },
  prepareClose: async (input) => {
    if (input.path) await existingNotebookSession(input.path)?.prepareClose();
  },
  cancelClose: (input) => {
    if (input.path) existingNotebookSession(input.path)?.cancelClose();
  },
  discard: async (input) => {
    if (input.path) await existingNotebookSession(input.path)?.discard();
  },
  close: async (input) => {
    if (input.path) await closeNotebook(input.path);
  },
  undo: async (input) => {
    if (input.path) await existingNotebookSession(input.path)?.undo();
  },
  redo: async (input) => {
    if (input.path) await existingNotebookSession(input.path)?.redo();
  },
};

export function activate(): () => void {
  const disposers = [
    registerEditorKind({
      kind: "notebook",
      restorable: true,
      document,
      component: lazyComponent(() => import("./NotebookEditor").then((m) => m.NotebookEditor)),
      title: (input) => basename(input.path ?? input.key),
      icon: () => "file",
    }),
    registerFileEditorProvider({
      id: "notebook",
      order: 5,
      resolve: async (path, context) => {
        if (!/\.ipynb$/i.test(path)) return null;
        let canonical = path;
        if (isTauri()) {
          try {
            // Resolve aliases before creating a tab/session, so the workbench's
            // last-reference lifecycle and our edit queue use the SAME identity.
            const lease = await acquisitions.acquire(() => notebookBackend.open(path));
            const snapshot = lease.value;
            canonical = snapshot.path;
            context.onAdmission(() => {
              // Do not reload/replace an already admitted shared edit queue.
              const session = existingNotebookSession(canonical);
              const current = session?.getState().snapshot;
              if (current && current.id !== snapshot.id)
                throw new Error("The notebook changed while opening the editor");
              if (!current) void (session ?? notebookSession(canonical)).load(snapshot);
              lease.admit();
            }, lease.rollback);
          } catch {
            // Invalid/unavailable notebooks still open the notebook error surface,
            // never silently fall through to an editable raw JSON document.
          }
        }
        return { kind: "notebook", key: `notebook:${canonical}`, path: canonical };
      },
    }),
  ];
  return () => disposers.reverse().forEach((dispose) => dispose());
}
