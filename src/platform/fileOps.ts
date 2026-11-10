/**
 * Files created / deleted by an explicit IDE action (New File, Copy, Delete,
 * file templates), as opposed to changes seen by the file watcher. VCS uses
 * this for Settings › Version Control › Confirmation.
 */
import type { FileMove } from "./ipc";

export interface FileOperation {
  kind: "created" | "deleted";
  paths: string[];
}

type Listener = (op: FileOperation) => void;
const listeners = new Set<Listener>();

export function notifyFileOperation(op: FileOperation) {
  for (const l of listeners) {
    try {
      l(op);
    } catch (e) {
      console.warn("file operation listener failed", e);
    }
  }
}

export function onFileOperation(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const moveListeners = new Set<(moves: readonly FileMove[]) => void | Promise<void>>();

/** Explicit moves (including Undo), before editors reopen at their new paths. */
export async function notifyFilesMoved(moves: readonly FileMove[]): Promise<void> {
  for (const listener of moveListeners) {
    try {
      await listener(moves);
    } catch (e) {
      console.warn("file move listener failed", e);
    }
  }
}

export function onFilesMoved(listener: (moves: readonly FileMove[]) => void | Promise<void>): () => void {
  moveListeners.add(listener);
  return () => moveListeners.delete(listener);
}
