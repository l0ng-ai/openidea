/**
 * Explicit navigation (Go to Declaration, Implementation, …) goes before background requests:
 * the gutter markers cancel what they asked and wait until the navigation is done, so the
 * server answers the user's request first.
 */
let running = 0;
const listeners = new Set<(navigating: boolean) => void>();

export function isNavigating(): boolean {
  return running > 0;
}

/** Subscribes to navigation starting (`true`) and the last one finishing (`false`). */
export function onNavigation(listener: (navigating: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Marks a navigation as running; call the returned function once it is done. */
export function navigationStarted(): () => void {
  if (running++ === 0) for (const l of listeners) l(true);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--running === 0) for (const l of listeners) l(false);
  };
}
