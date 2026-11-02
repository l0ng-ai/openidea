/**
 * Live document state for Excalidraw editors, plus a helper to push visual
 * canvas edits back into the underlying CodeMirror JSON buffer.
 */
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import { registerEditorContribution } from "@/editor/api";
import { isExcalidrawPath } from "../fileKinds";

export interface LiveExcalidraw {
  text: string;
}

export const useLiveExcalidraw = create<Record<string, LiveExcalidraw | undefined>>(() => ({}));

const viewsByPath = new Map<string, Set<EditorView>>();

export function publishExcalidrawSource(path: string, text: string): void {
  useLiveExcalidraw.setState({ [path]: { text } });
}

export function getExcalidrawSource(path: string): LiveExcalidraw | undefined {
  return useLiveExcalidraw.getState()[path];
}

/**
 * Updates the underlying CodeMirror buffer for `path` so visual canvas edits
 * participate in dirty tracking, undo history, and autosave.
 */
export function writeExcalidrawSource(path: string, text: string): void {
  const set = viewsByPath.get(path);
  const primary = set ? [...set][0] : undefined;
  if (primary) {
    const current = primary.state.doc.toString();
    if (current !== text) {
      primary.dispatch({
        changes: { from: 0, to: primary.state.doc.length, insert: text },
      });
    }
  }
  publishExcalidrawSource(path, text);
}

function livePlugin(path: string) {
  return ViewPlugin.fromClass(
    class {
      constructor(private view: EditorView) {
        let set = viewsByPath.get(path);
        if (!set) {
          set = new Set();
          viewsByPath.set(path, set);
        }
        set.add(view);
        publishExcalidrawSource(path, view.state.doc.toString());
      }

      update(u: ViewUpdate) {
        if (u.docChanged) {
          publishExcalidrawSource(path, this.view.state.doc.toString());
        }
      }

      destroy() {
        const set = viewsByPath.get(path);
        if (set) {
          set.delete(this.view);
          if (set.size === 0) viewsByPath.delete(path);
        }
        publishExcalidrawSource(path, this.view.state.doc.toString());
      }
    },
  );
}

export function registerExcalidrawLiveSource(): () => void {
  return registerEditorContribution({
    id: "viewers.excalidrawLive",
    extensions: (ctx) => (!ctx.virtual && isExcalidrawPath(ctx.path) ? [livePlugin(ctx.path)] : []),
  });
}
