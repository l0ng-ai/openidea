/**
 * Coalesces PTY → xterm writes so fast output (btop, Claude animations) paints at a
 * capped rate instead of every chunk. While the document is hidden the cap drops
 * further — WebKitGTK still feeds IntersectionObserver-visible terminals on other
 * virtual desktops, and unbounded `term.write` kept burning CPU there (#4216).
 */

import type { TerminalMaxFps } from "@/platform/workflowSettings";

export type { TerminalMaxFps };

/** When the page is hidden, paint at most this often (4 FPS). */
export const HIDDEN_FLUSH_MS = 250;

export function flushIntervalMs(maxFps: TerminalMaxFps, hidden: boolean): number {
  if (hidden) return HIDDEN_FLUSH_MS;
  if (maxFps === "unlimited") return 0;
  const fps = Number(maxFps);
  return fps > 0 ? Math.round(1000 / fps) : 0;
}

export type OutputGateClock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
};

const browserClock: OutputGateClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => window.clearTimeout(id),
};

export type OutputGateOptions = {
  /** Current max FPS setting. */
  maxFps: () => TerminalMaxFps;
  /** Whether the document is hidden. */
  hidden: () => boolean;
  /** Deliver coalesced output to xterm. */
  write: (data: string) => void;
  clock?: OutputGateClock;
};

const visibilityListeners = new Set<() => void>();

/** Register a session's gate for `document.visibilitychange` (keeps index off the xterm path). */
export function watchOutputVisibility(onChange: () => void): () => void {
  visibilityListeners.add(onChange);
  return () => {
    visibilityListeners.delete(onChange);
  };
}

/** `visibilitychange`: flush or reschedule every live terminal output gate. */
export function notifyTerminalVisibility() {
  for (const listener of visibilityListeners) listener();
}

/** Buffers chunks and flushes them at the configured interval. */
export class OutputGate {
  private pending = "";
  private timer: number | null = null;
  private lastFlush = 0;
  private readonly clock: OutputGateClock;
  private readonly unwatch: () => void;

  constructor(private readonly opts: OutputGateOptions) {
    this.clock = opts.clock ?? browserClock;
    this.unwatch = watchOutputVisibility(() => this.onVisibilityChange());
  }

  push(chunk: string) {
    if (!chunk) return;
    this.pending += chunk;
    this.schedule();
  }

  /** Force a flush (becoming visible again, dispose). */
  flush() {
    this.cancelTimer();
    if (!this.pending) return;
    const data = this.pending;
    this.pending = "";
    this.lastFlush = this.clock.now();
    this.opts.write(data);
  }

  /** Drop buffered output without writing (restart / dispose after kill). */
  clear() {
    this.cancelTimer();
    this.pending = "";
  }

  dispose() {
    this.unwatch();
    this.flush();
  }

  /** `visibilitychange`: cancel a long hidden wait and flush / reschedule. */
  onVisibilityChange() {
    if (this.timer === null && !this.pending) return;
    this.cancelTimer();
    if (!this.opts.hidden()) {
      this.flush();
      return;
    }
    if (this.pending) this.schedule();
  }

  get buffered(): string {
    return this.pending;
  }

  private schedule() {
    if (this.timer !== null) return;
    const interval = flushIntervalMs(this.opts.maxFps(), this.opts.hidden());
    if (interval === 0) {
      this.flush();
      return;
    }
    const wait = Math.max(0, interval - (this.clock.now() - this.lastFlush));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private cancelTimer() {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
