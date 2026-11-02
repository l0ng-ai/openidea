/**
 * Live document state for Excalidraw editors, plus helpers to push visual
 * canvas edits back into the underlying CodeMirror JSON buffer and autosave
 * them to disk.
 */
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import { onEditorEvent, registerEditorContribution, whenSynced, type EditorDocContext } from "@/editor/api";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { isExcalidrawPath } from "../fileKinds";

export interface LiveExcalidraw {
  text: string;
}

export const EXCALIDRAW_AUTOSAVE_DELAY_MS = 250;

export const useLiveExcalidraw = create<Record<string, LiveExcalidraw | undefined>>(() => ({}));

const viewsByPath = new Map<string, Set<EditorView>>();
const docContextByPath = new Map<string, EditorDocContext>();
const pendingCanvasEdits = new Map<string, string>();
const dirtyCanvasPaths = new Set<string>();
const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function publishExcalidrawSource(path: string, text: string): void {
  pendingCanvasEdits.delete(path);
  useLiveExcalidraw.setState({ [path]: { text } });
}

export function getExcalidrawSource(path: string): LiveExcalidraw | undefined {
  return useLiveExcalidraw.getState()[path];
}

function isAutoSaveEnabled(): boolean {
  const s = useProject.getState();
  const settings = s.settings ?? s.project?.settings;
  return settings?.files?.autoSave !== false;
}

export async function flushExcalidrawAutoSave(path: string): Promise<void> {
  const timer = autoSaveTimers.get(path);
  if (timer !== undefined) {
    clearTimeout(timer);
    autoSaveTimers.delete(path);
  }
  if (!dirtyCanvasPaths.has(path) || !isAutoSaveEnabled()) {
    return;
  }
  const set = viewsByPath.get(path);
  const primary = set ? [...set][0] : undefined;
  const ctx = docContextByPath.get(path);
  if (!primary || !ctx || ctx.readOnly || ctx.virtual) {
    return;
  }
  dirtyCanvasPaths.delete(path);
  try {
    await whenSynced(primary);
    await call(commands.docSave(ctx.doc));
  } catch {
    // Best-effort autosave; explicit Save / close guard still protects unsaved changes if disk write fails.
  }
}

export function scheduleExcalidrawAutoSave(path: string): void {
  const prev = autoSaveTimers.get(path);
  if (prev !== undefined) {
    clearTimeout(prev);
  }
  if (!isAutoSaveEnabled()) {
    return;
  }
  autoSaveTimers.set(
    path,
    setTimeout(() => {
      autoSaveTimers.delete(path);
      void flushExcalidrawAutoSave(path);
    }, EXCALIDRAW_AUTOSAVE_DELAY_MS),
  );
}

/**
 * Updates the underlying CodeMirror buffer for `path` so visual canvas edits
 * participate in dirty tracking, undo history, and autosave.
 */
export function writeExcalidrawSource(path: string, text: string): void {
  const set = viewsByPath.get(path);
  const primary = set ? [...set][0] : undefined;
  if (primary) {
    pendingCanvasEdits.delete(path);
    const current = primary.state.doc.toString();
    if (current !== text) {
      primary.dispatch({
        changes: { from: 0, to: primary.state.doc.length, insert: text },
        userEvent: "input",
      });
      dirtyCanvasPaths.add(path);
      scheduleExcalidrawAutoSave(path);
    }
    publishExcalidrawSource(path, text);
  } else {
    useLiveExcalidraw.setState({ [path]: { text } });
    pendingCanvasEdits.set(path, text);
    dirtyCanvasPaths.add(path);
  }
}

function livePlugin(ctx: EditorDocContext) {
  const { path } = ctx;
  return ViewPlugin.fromClass(
    class {
      constructor(private view: EditorView) {
        docContextByPath.set(path, ctx);
        let set = viewsByPath.get(path);
        if (!set) {
          set = new Set();
          viewsByPath.set(path, set);
        }
        set.add(view);
        const pending = pendingCanvasEdits.get(path);
        if (pending !== undefined) {
          pendingCanvasEdits.delete(path);
          if (pending !== view.state.doc.toString()) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: pending },
              userEvent: "input",
            });
            dirtyCanvasPaths.add(path);
            scheduleExcalidrawAutoSave(path);
          }
          publishExcalidrawSource(path, view.state.doc.toString());
        } else {
          publishExcalidrawSource(path, view.state.doc.toString());
        }
      }

      update(u: ViewUpdate) {
        if (u.docChanged) {
          publishExcalidrawSource(path, this.view.state.doc.toString());
        }
      }

      destroy() {
        if (dirtyCanvasPaths.has(path)) {
          void flushExcalidrawAutoSave(path);
        }
        const set = viewsByPath.get(path);
        if (set) {
          set.delete(this.view);
          if (set.size === 0) {
            viewsByPath.delete(path);
            docContextByPath.delete(path);
          }
        }
        publishExcalidrawSource(path, this.view.state.doc.toString());
      }
    },
  );
}

export function registerExcalidrawLiveSource(): () => void {
  const disposeContribution = registerEditorContribution({
    id: "viewers.excalidrawLive",
    extensions: (ctx) => (!ctx.virtual && isExcalidrawPath(ctx.path) ? [livePlugin(ctx)] : []),
  });
  const disposeEvents = onEditorEvent((e) => {
    if (e.type === "docSaved") {
      const timer = autoSaveTimers.get(e.path);
      if (timer !== undefined) {
        clearTimeout(timer);
        autoSaveTimers.delete(e.path);
      }
      dirtyCanvasPaths.delete(e.path);
    } else if (e.type === "docClosed" && !viewsByPath.has(e.path)) {
      const timer = autoSaveTimers.get(e.path);
      if (timer !== undefined) {
        clearTimeout(timer);
        autoSaveTimers.delete(e.path);
      }
      dirtyCanvasPaths.delete(e.path);
      pendingCanvasEdits.delete(e.path);
      docContextByPath.delete(e.path);
      useLiveExcalidraw.setState((s) => {
        if (!(e.path in s)) return s;
        const next = { ...s };
        delete next[e.path];
        return next;
      }, true);
    }
  });
  return () => {
    for (const timer of autoSaveTimers.values()) clearTimeout(timer);
    autoSaveTimers.clear();
    dirtyCanvasPaths.clear();
    disposeEvents();
    disposeContribution();
  };
}
