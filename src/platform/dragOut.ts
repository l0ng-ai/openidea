/**
 * Files dragged out of the window become an OS file drag, so the app they are dropped
 * on (Explorer, Finder, an SFTP client) copies them, as from IDEA's Project view (#2867).
 * Only a local project's files: a remote project's live on its server.
 */
import { call, commands, isTauri } from "./ipc";
import { isRemoteWindow } from "./remote";

/** The running drag, until it ends or the next press shows none is live. */
let running: object | null = null;
const pressed = () => {
  running = null;
};

/** Whether files can be dragged out of this window. */
export function canDragOut(): boolean {
  return isTauri() && !isRemoteWindow();
}

/**
 * Hands `paths` to an OS drag; call while the primary button is held, once the pointer
 * left the window. Resolves when the drag ends: true when another app took the files.
 */
export async function dragOut(paths: readonly string[]): Promise<boolean> {
  const drag = {};
  running = drag;
  // A backend that loses the drag never resolves; a fresh press means it is over anyway.
  window.addEventListener("pointerdown", pressed, true);
  try {
    return await call(commands.windowDragFiles([...paths]));
  } catch (e) {
    console.warn("could not drag files out", e);
    return false;
  } finally {
    if (running === drag) running = null;
    window.removeEventListener("pointerdown", pressed, true);
  }
}

/**
 * Whether a drag out of this window is running. An OS file drop meanwhile is the
 * dragged files coming back, which the window ignores instead of importing or
 * opening its own files.
 */
export function isDraggingOut(): boolean {
  return running !== null;
}
