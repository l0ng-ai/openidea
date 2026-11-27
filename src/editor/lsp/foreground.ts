/**
 * Requests the user is waiting for (Go to Declaration, ⌥↵, a refactoring, a quick fix) go before
 * background requests: Code Vision usage counts and the gutter markers cancel what they asked and
 * wait until the user's request is done, so the server answers it first.
 */
let running = 0;
const listeners = new Set<(foreground: boolean) => void>();

export function inForeground(): boolean {
  return running > 0;
}

/** Subscribes to a foreground request starting (`true`) and the last one finishing (`false`). */
export function onForeground(listener: (foreground: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Marks a request the user waits for as running; call the returned function once it is done. */
export function foregroundStarted(): () => void {
  if (running++ === 0) for (const l of listeners) l(true);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--running === 0) for (const l of listeners) l(false);
  };
}

/** Runs `request` as a foreground request until it settles. */
export async function foreground<T>(request: () => Promise<T>): Promise<T> {
  const done = foregroundStarted();
  try {
    return await request();
  } finally {
    done();
  }
}
