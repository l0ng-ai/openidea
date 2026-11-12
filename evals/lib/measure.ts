/**
 * Timing one user action in the page: the action is run, then every animation frame checks
 * what the user would see. A condition true at the start of a frame is painted by it.
 */
import type { Page } from "@playwright/test";

/**
 * A check of the page, run in it every frame: self-contained (it is re-created from its
 * source), given the arguments passed to `track` and the editor state before the action.
 */
export type Check<A> = (arg: A, before: EditorSnapshot | null) => boolean;

export interface EditorSnapshot {
  path: string;
  head: number;
  line: number;
  word: string;
}

export interface Tracked {
  /** Something visible changed in answer to the action (popup, hint, spinner, caret / editor moved). */
  feedbackMs: number;
  /** The first result is shown. */
  firstResultMs: number;
  /** The final result is shown and nothing is loading. */
  completeMs: number;
}

export interface TrackSpec<A> {
  /** The action run (`actionArg` its argument), the file opened (`openFile`), or a check-like step in the page (`run`). */
  action?: string;
  actionArg?: unknown;
  openFile?: string;
  run?: (arg: A) => unknown;
  arg: A;
  first: Check<A>;
  done: Check<A>;
  /** Extra feedback beyond the default (popup, hint, status spinner, editor or caret changed). */
  feedback?: Check<A>;
  /**
   * For results with no loading indicator (gutter markers): done once `done` holds and
   * `signature` has not changed for `settleMs`; complete is when it last changed.
   */
  signature?: (arg: A) => unknown;
  settleMs?: number;
  timeoutMs: number;
}

export class TimeoutError extends Error {
  readonly partial: Partial<Tracked>;
  constructor(message: string, partial: Partial<Tracked>) {
    super(message);
    this.partial = partial;
  }
}

export async function track<A>(page: Page, spec: TrackSpec<A>): Promise<Tracked> {
  const r = await page.evaluate(
    ({ action, actionArg, openFile, run, arg, first, done, feedback, signature, settleMs, timeoutMs }) => {
      const w = window as unknown as {
        __openideaPerf: {
          runAction(id: string, arg?: unknown): Promise<boolean>;
          openFile(path: string): Promise<void>;
          editorState(): EditorSnapshot | null;
        };
      };
      const make = (src: string | null) =>
        src
          ? (new Function("arg", "before", `return (${src})(arg, before)`) as (a: unknown, b: unknown) => boolean)
          : null;
      const checks = { first: make(first)!, done: make(done)!, feedback: make(feedback) };
      const sign = signature
        ? (new Function("arg", `return JSON.stringify((${signature})(arg))`) as (a: unknown) => string)
        : null;
      let lastSig: string | null = null;
      let lastChange = 0;
      const before = w.__openideaPerf.editorState();
      const visible = (sel: string) =>
        [...document.querySelectorAll(sel)].some((el) => (el as HTMLElement).getClientRects().length > 0);
      const anyFeedback = () => {
        if (visible('.cm-lsp-hint, [data-testid="usages-popup"], [role="dialog"], [role="listbox"]')) return true;
        const now = w.__openideaPerf.editorState();
        if ((now?.path ?? null) !== (before?.path ?? null) || (now && before && now.head !== before.head)) return true;
        return checks.feedback?.(arg, before) ?? false;
      };
      const times: { feedbackMs?: number; firstResultMs?: number; completeMs?: number } = {};
      const t0 = performance.now();
      let failed: unknown = null;
      const started = run
        ? new Promise((resolve) => resolve(make(run)!(arg, before)))
        : openFile
          ? w.__openideaPerf.openFile(openFile)
          : w.__openideaPerf.runAction(action!, actionArg);
      void started.catch((e: unknown) => (failed = e));
      return new Promise<{ times: typeof times; timedOut: boolean; error: string | null }>((resolve) => {
        const tick = () => {
          const t = performance.now() - t0;
          try {
            if (times.feedbackMs === undefined && anyFeedback()) times.feedbackMs = t;
            if (times.firstResultMs === undefined && checks.first(arg, before)) times.firstResultMs = t;
            if (sign) {
              const sig = sign(arg);
              if (sig !== lastSig) {
                lastSig = sig;
                lastChange = t;
              }
            }
            const settled = !sign || t - lastChange >= (settleMs ?? 0);
            if (times.firstResultMs !== undefined && settled && checks.done(arg, before)) {
              // Session.reset waits out the time in which invoking it again widens it.
              if (action === "find.showUsages")
                (window as unknown as { __openideaEvalShowUsagesAt?: number }).__openideaEvalShowUsagesAt =
                  performance.now();
              times.completeMs = sign ? Math.max(lastChange, times.firstResultMs) : t;
              times.feedbackMs ??= t;
              return resolve({ times, timedOut: false, error: null });
            }
          } catch (e) {
            return resolve({ times, timedOut: false, error: String(e) });
          }
          if (failed) return resolve({ times, timedOut: false, error: String((failed as Error).message ?? failed) });
          if (t > timeoutMs) return resolve({ times, timedOut: true, error: null });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    {
      action: spec.action,
      actionArg: spec.actionArg,
      openFile: spec.openFile,
      run: spec.run?.toString() ?? null,
      arg: spec.arg,
      first: spec.first.toString(),
      done: spec.done.toString(),
      feedback: spec.feedback?.toString() ?? null,
      signature: spec.signature?.toString() ?? null,
      settleMs: spec.settleMs,
      timeoutMs: spec.timeoutMs,
    },
  );
  const what = spec.action ?? (spec.openFile ? `open ${spec.openFile}` : "step");
  if (r.error) throw new Error(`${what}: ${r.error}`);
  if (r.timedOut) {
    const seen =
      r.times.firstResultMs !== undefined
        ? "a first result but no final one"
        : r.times.feedbackMs !== undefined
          ? "feedback but no result"
          : "nothing";
    throw new TimeoutError(`${what} timed out after ${spec.timeoutMs} ms (${seen})`, r.times);
  }
  return r.times as Tracked;
}
