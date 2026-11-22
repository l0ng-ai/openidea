import type { Extension, Text } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { intentionsChanged, whenSynced, type EditorDocContext } from "@/editor/api";
import { setFileDiagnostics } from "@/editor/lsp/diagnostics";
import { commands, isTauri, nextRequestId, type Diagnostic, type RequestId } from "@/platform/ipc";
import { inspectionProfile, subscribeInspectionProfile } from "@/platform/inspections";
import { useProject } from "@/platform/project";

/** A backend check of a manifest file, published as one inspection's diagnostics. */
export interface ManifestCheck<T> {
  inspection: string;
  producer: string;
  fetch(doc: EditorDocContext, request: RequestId): Promise<T>;
  /** Shows a result computed for `text` (the view's current text); returns the file's diagnostics. */
  apply(view: EditorView, result: T, text: Text): Diagnostic[];
  /** The file's result went stale or its last editor closed. */
  reset?(path: string): void;
  /** Other reasons to check again (an install finished); returns the unsubscribe. */
  watch?(recheck: () => void): () => void;
  /** Check again when the editor gains focus (the environment may have changed meanwhile). */
  onFocus?: boolean;
}

export const checkEnabled = (inspection: string) => inspectionProfile()[inspection]?.enabled !== false;

const viewers = new Map<string, number>();

/** Runs `check` 500 ms after the file opens or changes, while its inspection is on. */
export function manifestCheck<T>(doc: EditorDocContext, check: ManifestCheck<T>): Extension {
  return ViewPlugin.define((view) => {
    if (!isTauri()) return {};
    const key = `${check.producer}\n${doc.path}`;
    viewers.set(key, (viewers.get(key) ?? 0) + 1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: RequestId | null = null;
    let sequence = 0;
    let disposed = false;
    const clear = () => {
      setFileDiagnostics(doc.path, check.producer, []);
      check.reset?.(doc.path);
    };
    const cancel = () => {
      sequence++;
      if (request !== null) void commands.cancelRequest(request);
      request = null;
    };
    const run = async () => {
      if (disposed || !checkEnabled(check.inspection)) return;
      const mine = sequence;
      const text = view.state.doc;
      const root = useProject.getState().project?.root;
      const id = nextRequestId();
      request = id;
      try {
        await whenSynced(view);
        if (mine !== sequence || disposed) return;
        const result = await check.fetch(doc, id);
        if (mine !== sequence || disposed || view.state.doc !== text || useProject.getState().project?.root !== root)
          return;
        setFileDiagnostics(doc.path, check.producer, check.apply(view, result, text));
      } catch {
        // Offline registries, missing interpreters and cancelled checks never interrupt editing.
      } finally {
        if (request === id) request = null;
      }
    };
    // Keeps the current diagnostics until the new result arrives.
    const recheck = () => {
      cancel();
      clearTimeout(timer);
      timer = setTimeout(() => void run(), 500);
    };
    const schedule = () => {
      clear();
      recheck();
    };
    schedule();
    const offProfile = subscribeInspectionProfile(() => {
      schedule();
      view.dispatch({ effects: intentionsChanged.of(null) });
    });
    const offWatch = check.watch?.(recheck);
    const offProject = useProject.subscribe((state, previous) => {
      if (state.project?.root !== previous.project?.root) {
        disposed = true;
        cancel();
        clearTimeout(timer);
        clear();
      }
    });
    return {
      update: (u) => {
        if (u.docChanged) schedule();
        else if (check.onFocus && u.focusChanged && view.hasFocus) recheck();
      },
      destroy: () => {
        disposed = true;
        cancel();
        clearTimeout(timer);
        offProfile();
        offWatch?.();
        offProject();
        const remaining = (viewers.get(key) ?? 1) - 1;
        if (remaining) viewers.set(key, remaining);
        else {
          viewers.delete(key);
          clear();
        }
      },
    };
  });
}
