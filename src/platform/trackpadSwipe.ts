/**
 * macOS trackpad page swipes.
 *
 * The backend emits `openidea://swipe` to the window under the fingers (never `IdeEvent`: that one
 * is fanned out to every window of the project). The webview itself never sees the gesture, so
 * this is the only way a `SwipeLeft` / `SwipeRight` keymap binding can fire.
 */
import { dispatchGestureStroke, gestureStrokeOf, type SwipeGesture } from "./keymap";
import { isTauri } from "./ipc";

export const SWIPE_EVENT = "openidea://swipe";

export function isNativeSwipe(v: unknown): v is SwipeGesture {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return (
    (g.direction === "left" || g.direction === "right") &&
    ["metaKey", "ctrlKey", "altKey", "shiftKey"].every((k) => typeof g[k] === "boolean")
  );
}

type Recorder = (stroke: string) => void;

const recorders: Recorder[] = [];
let dispatchers = 0;

/** Runs the swipe's action, or hands its stroke to the newest open recorder. */
export function routeSwipe(payload: unknown): boolean {
  if (!isNativeSwipe(payload)) return false;
  const recorder = recorders.at(-1);
  if (recorder) {
    recorder(gestureStrokeOf(payload));
    return true;
  }
  return dispatchGestureStroke(payload);
}

let users = 0;
let registration: Promise<(() => void) | undefined> | undefined;

/** One window-scoped listener shared by the dispatcher and the recorders. */
function acquireListener(): () => void {
  if (!isTauri()) return () => {};
  if (users++ === 0) {
    registration = import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) =>
      // Window-scoped: a global `listen` would also receive other windows' swipes.
      getCurrentWebviewWindow().listen(SWIPE_EVENT, ({ payload }) => {
        if (dispatchers > 0 || recorders.length > 0) routeSwipe(payload);
      }),
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users > 0) return;
    const pending = registration;
    registration = undefined;
    void pending?.then((off) => off?.());
  };
}

/** Runs the actions bound to swipes in this window. Returns the uninstall function. */
export function installSwipeDispatch(): () => void {
  dispatchers++;
  const release = acquireListener();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    dispatchers--;
    release();
  };
}

/** Sends this window's swipes to `record` instead of running their actions (Settings › Keymap). */
export function captureSwipes(record: Recorder): () => void {
  recorders.push(record);
  const release = acquireListener();
  return () => {
    const i = recorders.lastIndexOf(record);
    if (i >= 0) recorders.splice(i, 1);
    release();
  };
}
