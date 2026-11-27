/**
 * Calls `notify` for each listener of a broadcast. A listener that throws is
 * reported and skipped, so one feature's bug can't hide the broadcast from the rest.
 */
export function notifyEach<L>(listeners: Iterable<L>, notify: (listener: L) => void, what: string): void {
  for (const listener of listeners) {
    try {
      notify(listener);
    } catch (e) {
      console.error(`${what} listener failed`, e);
    }
  }
}
