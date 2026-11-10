/**
 * Collapses the repeated data emissions of one IME commit.
 *
 * WebKitGTK commits IME text with an inconsistent mix of events, and xterm's
 * `CompositionHelper` only copes with part of it:
 *
 * - A composed word (`你好`) reports `compositionstart`, so xterm records where the
 *   composition starts in its hidden textarea and sends the committed text once on
 *   `compositionend`.
 * - Text that the IME commits directly (punctuation such as `；` or `，`) reports
 *   `insertFromComposition` + `compositionend` **without** `compositionstart`. xterm then
 *   finalizes the *previous* composition's position: it sends the keydown's textarea diff
 *   first and, once `compositionend` runs, a stale `value.substring(start)` on top. That
 *   second emission is the duplicated suffix users see (typing `；你好，` sends `，` and then
 *   `好，`). Newer WebKitGTK delivers the same commits as `insertText` without any
 *   composition events, which xterm sends through its keydown path; the stale emission there
 *   carries the previous commit's text instead.
 *
 * One commit must send one text chunk, so the gate lets the first emission through and drops
 * the rest until the commit closes. Protocol replies and mouse reports bypass the gate.
 * A commit is delimited by the IME's own keystroke (code 229)
 * outside a composition, or by a composition input when the platform sends no keydown.
 * Commits that really compose are left to xterm: `compositionstart` stands the gate down for
 * that commit only — it must not disable the gate for the session, because the very next
 * punctuation commit still needs deduplication.
 *
 * xterm never clears its hidden textarea by itself, so every commit ends with a rebase: the
 * textarea is emptied after xterm's own senders have run, keeping the next commit from
 * carrying old text.
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
  private composing = false;
  private timer: number | null = null;
  private readonly rebase: () => void;
  private readonly scheduler: ImeScheduler;

  constructor(rebase: () => void, scheduler: ImeScheduler = WINDOW_SCHEDULER) {
    this.rebase = rebase;
    this.scheduler = scheduler;
  }

  /**
   * A commit starts: the IME's own keystroke (code 229) outside a composition.
   *
   * Always starts a fresh commit, even when the previous one is still inside its timeout:
   * two commits can arrive back to back, and the second must not be swallowed.
   */
  begin(): void {
    if (this.composing) return;
    this.cancelTimer();
    this.open = true;
    this.sent = false;
    this.timer = this.scheduler.after(() => this.close(), IME_COMMIT_TIMEOUT_MS);
  }

  /**
   * A composition input arrived. Opens a commit only when no commit is open: resetting
   * `sent` here would let the emissions already queued for this commit go out again.
   */
  input(): void {
    if (this.composing || this.open) return;
    this.open = true;
    this.sent = false;
    this.timer = this.scheduler.after(() => this.close(), IME_COMMIT_TIMEOUT_MS);
  }

  /**
   * An IME composition begins. xterm's own composition handling owns this commit, so the
   * gate stays out of its way — but only until the composition ends.
   */
  compositionStart(): void {
    this.composing = true;
    this.cancelTimer();
    this.open = false;
    this.sent = false;
  }

  /**
   * The composition — or, on WebKitGTK, a directly committed character — ended.
   * Bubble phase: xterm's own `compositionend` listener ran first and queued its send, so a
   * 0 ms close lands behind that emission and cannot cut the committed text off.
   */
  finish(): void {
    this.composing = false;
    this.cancelTimer();
    this.timer = this.scheduler.after(() => this.close(), 0);
  }

  /**
   * A keystroke the IME did not take (Enter, an arrow, a letter typed outside it): the commit
   * is over, and what that key sends must reach the PTY.
   */
  keystroke(): void {
    if (this.open && !this.composing) this.close();
  }

  /** Only text can be a duplicate commit; terminal replies and mouse reports must always reach the PTY. */
  accept(data: string): boolean {
    if (!this.open || data.startsWith("\x1b")) return true;
    if (this.sent) return false;
    this.sent = true;
    return true;
  }

  /** Ends the commit and rebases the textarea to an empty value. */
  close(): void {
    this.cancelTimer();
    // A new composition started before this close ran; its own finish will rebase.
    if (this.composing) return;
    this.open = false;
    this.sent = false;
    this.rebase();
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.scheduler.cancel(this.timer);
    this.timer = null;
  }
}
