/**
 * Whether the program in a terminal is at work, judged from its output (#3831).
 * An interactive program (an agent CLI, a REPL, an editor) is one long command
 * to the shell, so the command marks say nothing about it: it redraws
 * continuously while it works and falls silent while it waits for input.
 */

/** Output must keep coming this long to count: a single redraw (resize, focus, a status line) is not work. */
export const SUSTAIN_MS = 500;
/** "Keeps coming": no longer apart than this. A clock or a monitor refreshing every second is not work. */
export const DENSE_MS = 400;
/** Silence this long ends the work; an elapsed-seconds counter keeps it going. */
export const QUIET_MS = 1500;
/** Output this soon after a keystroke is its echo. */
export const ECHO_MS = 400;

export class OutputActivity {
  private streakStart: number | null = null;
  private lastOutput = 0;
  private lastInput = Number.NEGATIVE_INFINITY;

  input(now: number) {
    this.lastInput = now;
  }

  output(now: number) {
    // Typing into a program at work must not hide its output.
    const active = this.active(now);
    if (!active && now - this.lastInput < ECHO_MS) return;
    if (this.streakStart === null || now - this.lastOutput > (active ? QUIET_MS : DENSE_MS)) this.streakStart = now;
    this.lastOutput = now;
  }

  active(now: number): boolean {
    return (
      this.streakStart !== null && now - this.lastOutput <= QUIET_MS && this.lastOutput - this.streakStart >= SUSTAIN_MS
    );
  }

  /** When `active` turns false unless more output arrives. */
  get quietAt(): number {
    return this.lastOutput + QUIET_MS;
  }

  reset() {
    this.streakStart = null;
  }
}
