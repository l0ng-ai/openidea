/**
 * How long requests must stop before a terminal that keeps resizing (a tool window drag)
 * refits. A fit reflows the whole scrollback, so during the drag the pane only clips.
 */
export const FIT_SETTLE_MS = 120;
/** How long the size must stay put before the process behind the terminal is told. */
export const PROCESS_RESIZE_DELAY_MS = 150;

export interface FitScheduler {
  schedule(): void;
  /** Fits now, dropping any scheduled fit. */
  flush(): void;
  cancel(): void;
}

/**
 * Coalesces fit requests. An idle terminal fits on the next frame; while requests keep
 * coming (its host is being resized) it fits once, FIT_SETTLE_MS after the last one.
 */
export function fitScheduler(fit: () => void): FitScheduler {
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRequest = -Infinity;
  const cancel = () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = 0;
    timer = undefined;
  };
  const run = () => {
    cancel();
    fit();
  };
  return {
    schedule() {
      const now = performance.now();
      const resizing = now - lastRequest < FIT_SETTLE_MS;
      lastRequest = now;
      if (resizing) {
        cancel();
        timer = setTimeout(run, FIT_SETTLE_MS);
        return;
      }
      if (timer !== undefined) return;
      raf = requestAnimationFrame(run);
      // WebKit pauses rAF in background windows; don't leave the terminal unfitted until it is shown.
      timer = setTimeout(run, 100);
    },
    flush: run,
    cancel,
  };
}

/** Calls `report` once the size has stayed the same for PROCESS_RESIZE_DELAY_MS. */
export function settledResize(report: (cols: number, rows: number) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    resized(cols: number, rows: number) {
      clearTimeout(timer);
      timer = setTimeout(() => report(cols, rows), PROCESS_RESIZE_DELAY_MS);
    },
    cancel: () => clearTimeout(timer),
  };
}
