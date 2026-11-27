import type { NotebookSnapshot } from "@/bindings";
import { registerPendingEdits } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { basename } from "@/platform/project";
import { lazyComponent } from "@/ui";
import {
  editorService,
  registerEditorKind,
  registerFileEditorProvider,
  registerToolWindow,
  registerUriOpener,
  toolWindowService,
  type EditorDocumentLifecycle,
} from "@/workbench/contributions";
import { isTauri } from "@/platform/ipc";
import { ProviderAcquisitions } from "@/workbench/providerAcquisition";
import { registerConversions } from "./convert";
import { closeNotebook, existingNotebookSession, notebookBackend, notebookSession, notebookSessions } from "./session";

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

const VARIABLES = "jupyterVariables";

export function activate(): () => void {
  const disposers = [
    registerConversions(),
    registerToolWindow({
      id: VARIABLES,
      title: "Jupyter Variables",
      icon: "file-jupyter",
      anchor: "bottom",
      // Listed under the stripe's "…" until first opened: most projects have no notebooks.
      stripe: "onUse",
      order: 28,
      component: lazyComponent(() => import("./VariablesView").then((m) => m.VariablesView)),
    }),
    registerActions([
      {
        id: "notebook.variables.show",
        title: "Jupyter Variables",
        category: "Tools",
        when: "projectOpen",
        run: () => toolWindowService().show(VARIABLES, true),
      },
    ]),
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
    // Language servers answer from the backend's copy of the cells.
    registerPendingEdits(() => Promise.all([...notebookSessions()].map((s) => s.settled())).then(() => {})),
    // Locations in cells (go to declaration, usages) carry the cell's URI.
    registerUriOpener({
      scheme: "vscode-notebook-cell",
      open: async (uri, { selection, ...options }) => {
        for (const session of notebookSessions()) {
          const cell = session.cellOfUri(uri);
          if (!cell) continue;
          // oxlint-disable-next-line no-await-in-loop -- the first matching session opens once and returns; opening every match would open unrelated editors.
          await editorService().openFile(session.path, options);
          session.reveal(cell, selection && { line: selection.line, col: selection.col });
          return;
        }
      },
    }),
  ];
  return () => disposers.reverse().forEach((dispose) => dispose());
}
