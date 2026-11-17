/**
 * ⌘/Ctrl+wheel font zoom that ignores scroll inertia.
 *
 * WebViews don't expose macOS momentum phases, so a gesture is a run of wheel events
 * less than `GESTURE_GAP_MS` apart (momentum continues the run of the swipe that started it).
 * A run that started without ⌘/Ctrl (a scroll still coasting when ⌘ is pressed) never zooms
 * and keeps scrolling; a run that started with it never scrolls, and stops zooming once the
 * deltas keep shrinking, which is the inertia after the fingers left the trackpad.
 */

const GESTURE_GAP_MS = 150;
/** Consecutive shrinking deltas after which the rest of the run is inertia. */
const INERTIA_SHRINKS = 4;

type WheelLike = Pick<WheelEvent, "deltaY" | "metaKey" | "ctrlKey" | "timeStamp">;

let lastTime = Number.NEGATIVE_INFINITY;
let run = { zoom: false, prev: 0, shrinks: 0, inertia: false };
let lastEvent: WheelLike | null = null;
let lastResult: number | null = null;

/**
 * The font zoom step for a wheel event: `1` / `-1` to zoom in / out, `0` for an event of a
 * zoom gesture that must neither zoom nor scroll (its inertia, or ⌘/Ctrl released), `null`
 * for one that isn't a zoom (scroll as usual). Repeated calls for one event agree.
 */
export function wheelZoomStep(e: WheelLike): number | null {
  if (e === lastEvent) return lastResult;
  const mod = e.metaKey || e.ctrlKey;
  const abs = Math.abs(e.deltaY);
  if (e.timeStamp - lastTime > GESTURE_GAP_MS) {
    run = { zoom: mod, prev: abs, shrinks: 0, inertia: false };
  } else {
    run.shrinks = abs < run.prev ? run.shrinks + 1 : 0;
    run.prev = abs;
    if (run.shrinks >= INERTIA_SHRINKS) run.inertia = true;
  }
  lastTime = e.timeStamp;
  lastEvent = e;
  lastResult = !run.zoom ? null : !mod || e.deltaY === 0 || run.inertia ? 0 : e.deltaY < 0 ? 1 : -1;
  return lastResult;
}

// Track every wheel event, not only those reaching a zoom surface, so a scroll that started
// elsewhere and coasts into one is still known as a scroll.
if (typeof window !== "undefined") {
  window.addEventListener("wheel", (e) => void wheelZoomStep(e), {
    capture: true,
    passive: true,
  });
}

/** Tests: forget the current gesture. */
export function resetWheelZoomGesture(): void {
  lastTime = Number.NEGATIVE_INFINITY;
  lastEvent = null;
  lastResult = null;
}
