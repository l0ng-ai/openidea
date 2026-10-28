/** Minimum time between two fits while the host keeps resizing (a tool window drag). */
export const FIT_INTERVAL_MS = 100;
/** How long the size must stay put before the process behind the terminal is told. */
export const PROCESS_RESIZE_DELAY_MS = 150;

export interface FitScheduler {
  schedule(): void;
  /** Fits now, dropping any scheduled fit. */
  flush(): void;
  cancel(): void;
}

/**
 * Coalesces fit requests. An idle terminal fits on the next frame; while its host keeps
 * resizing it refits at most every FIT_INTERVAL_MS, and once more when the resizing
 * stops. Re-rendering xterm on every pointer move of a drag costs a frame each time.
 */
export function fitScheduler(fit: () => void): FitScheduler {
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let last = -Infinity;
  const cancel = () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = 0;
    timer = undefined;
    pending = false;
  };
  const run = () => {
    cancel();
    last = performance.now();
    fit();
  };
  return {
    schedule() {
      if (pending) return;
      pending = true;
      const wait = last + FIT_INTERVAL_MS - performance.now();
      if (wait > 0) {
        timer = setTimeout(run, wait);
        return;
      }
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
