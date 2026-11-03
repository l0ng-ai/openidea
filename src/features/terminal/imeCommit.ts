/**
 * Collapses the repeated data emissions of one IME commit.
 *
 * WebKitGTK + fcitx5 commit text without firing `compositionstart`, so xterm's `CompositionHelper`
 * never advances `_compositionPosition.start` and keeps appending the committed text to its hidden
 * textarea. A commit then reaches `onData` twice — once with the committed text, once with a stale
 * `value.substring(start)` — and the same text shows up in the terminal twice.
 *
 * One commit must send one chunk: take the first emission and drop the rest, then rebase the
 * textarea so the next commit starts from an empty value. IMEs that do report `compositionstart`
 * (macOS, IBus) keep xterm's own bookkeeping, so the gate stands down for them.
 */

/** How long a commit may stay open when its `compositionend` never arrives. */
export const IME_COMMIT_TIMEOUT_MS = 250;

export interface ImeScheduler {
  after(callback: () => void, ms: number): number;
  cancel(id: number): void;
}

const WINDOW_SCHEDULER: ImeScheduler = {
  after: (callback, ms) => window.setTimeout(callback, ms),
  cancel: (id) => window.clearTimeout(id),
};

export class ImeCommitGate {
  private open = false;
  private sent = false;
  private timer: number | null = null;
  private native = false;
  private readonly rebase: () => void;
  private readonly scheduler: ImeScheduler;

  constructor(rebase: () => void, scheduler: ImeScheduler = WINDOW_SCHEDULER) {
    this.rebase = rebase;
    this.scheduler = scheduler;
  }

  /** A commit starts: the IME's own keystroke (code 229) or its composition input event. */
  begin(): void {
    if (this.native || this.open) return;
    this.open = true;
    this.sent = false;
    this.timer = this.scheduler.after(() => this.close(), IME_COMMIT_TIMEOUT_MS);
  }

  /** The commit ended: let the emissions both of xterm's senders queued go out, then rebase. */
  finish(): void {
    if (!this.open) return;
    this.cancelTimer();
    this.timer = this.scheduler.after(() => this.close(), 0);
  }

  /** Whether this emission should reach the PTY. */
  accept(): boolean {
    if (!this.open) return true;
    if (this.sent) return false;
    this.sent = true;
    return true;
  }

  /** The IME reports composition events, so xterm needs no help — stay out of its way. */
  compositionStart(): void {
    this.native = true;
    this.cancelTimer();
    this.open = false;
    this.sent = false;
  }

  /** Ends the commit and rebases the textarea to an empty value. */
  close(): void {
    this.cancelTimer();
    if (!this.open) return;
    this.open = false;
    this.rebase();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.scheduler.cancel(this.timer);
    this.timer = null;
  }
}
