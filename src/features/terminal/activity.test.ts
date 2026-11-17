/**
 * The tab's running marker (#3831): a plain command spins from start to end;
 * an interactive program (an agent CLI, a REPL, an editor) spins only while it
 * keeps producing output, not while it waits for input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DENSE_MS, ECHO_MS, OutputActivity, QUIET_MS, SUSTAIN_MS } from "./activity";
import { TerminalSession } from "./session";

const ipc = vi.hoisted(() => ({
  call: vi.fn(async (v: unknown) => v),
  commands: { termSpawn: vi.fn(), termKill: vi.fn(), termResize: vi.fn(), termIsBusy: vi.fn(), termWrite: vi.fn() },
}));
vi.mock("@/platform/ipc", () => ({ call: ipc.call, commands: ipc.commands, isTauri: () => true }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Channel: class {
    onmessage: ((chunk: string) => void) | null = null;
  },
}));

describe("output activity", () => {
  /** Output every `step` ms over `span` ms, starting at `from`. */
  const stream = (a: OutputActivity, from: number, span: number, step = 100) => {
    for (let t = from; t <= from + span; t += step) a.output(t);
    return from + span;
  };

  it("is at work once output is sustained, until it has been quiet", () => {
    const a = new OutputActivity();
    expect(a.active(0)).toBe(false);
    a.output(1000);
    expect(a.active(1000)).toBe(false);
    const end = stream(a, 1000, SUSTAIN_MS);
    expect(a.active(end)).toBe(true);
    expect(a.active(end + QUIET_MS)).toBe(true);
    expect(a.active(end + QUIET_MS + 1)).toBe(false);
    expect(a.quietAt).toBe(end + QUIET_MS);
  });

  it.each([
    ["one redraw (a resize, a status line)", [5000]],
    ["a burst shorter than the threshold", [5000, 5100, 5200]],
    ["separate redraws", [5000, 5000 + QUIET_MS + 1, 5000 + 2 * (QUIET_MS + 1)]],
    ["two redraws a moment apart", [5000, 5000 + SUSTAIN_MS + 100]],
    ["a clock ticking every second", Array.from({ length: 30 }, (_, i) => 5000 + i * 1000)],
    ["a monitor refreshing every 1.5 s", Array.from({ length: 30 }, (_, i) => 5000 + i * 1500)],
    ["output just too sparse", Array.from({ length: 30 }, (_, i) => 5000 + i * (DENSE_MS + 1))],
  ])("ignores %s", (_, times) => {
    const a = new OutputActivity();
    for (const t of times) {
      a.output(t);
      expect(a.active(t)).toBe(false);
    }
  });

  it.each([
    ["at once", 10],
    ["late, over a slow connection", ECHO_MS - 1],
  ])("does not take the echo of typing for work when it arrives %s", (_, delay) => {
    const a = new OutputActivity();
    for (let t = 0; t < 5000; t += 200) {
      a.input(t);
      a.output(t + delay);
      expect(a.active(t + delay)).toBe(false);
    }
  });

  it("keeps working while the user types into a busy program", () => {
    const a = new OutputActivity();
    stream(a, 0, 2000);
    // A follow-up typed for far longer than the quiet time, the program still redrawing.
    for (let t = 2000; t < 2000 + 4 * QUIET_MS; t += 100) {
      if (t % 200 === 0) a.input(t);
      a.output(t + 10);
      expect(a.active(t + 10)).toBe(true);
    }
  });

  it("keeps working on an elapsed-seconds counter alone", () => {
    const a = new OutputActivity();
    let t = stream(a, 0, 2000);
    for (let i = 0; i < 20; i++) {
      t += 1000;
      a.output(t);
      expect(a.active(t)).toBe(true);
    }
  });

  it("starts over after a reset", () => {
    const a = new OutputActivity();
    const end = stream(a, 0, 2000);
    a.reset();
    expect(a.active(end)).toBe(false);
  });
});

describe("the session's working state", () => {
  let session: TerminalSession;

  beforeEach(() => {
    vi.useFakeTimers();
    session = new TerminalSession({ key: "k", cwd: "/repo", onChange() {}, onFocus() {} });
  });
  afterEach(() => {
    session.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Writes `data`, then lets `ms` pass. */
  const feed = async (data: string, ms = 0) => {
    const written = new Promise<void>((resolve) => session.term.write(data, resolve));
    await vi.advanceTimersByTimeAsync(ms);
    await written;
  };
  /** A program redrawing every 100 ms for `ms`. */
  const redraw = async (ms: number) => {
    for (let t = 0; t < ms; t += 100) await feed("\r\x1b[K* Working", 100);
  };
  const C = "\x1b]133;C\x07";
  const D = "\x1b]133;D;0\x07";
  const PASTE_ON = "\x1b[?2004h";
  const PASTE_OFF = "\x1b[?2004l";

  it("is idle at the prompt, even while the prompt redraws", async () => {
    await feed(`${D}${PASTE_ON}$ `);
    await redraw(1000);
    expect(session.state).toMatchObject({ commandRunning: false, working: false });
  });

  it("keeps a plain command working from start to end, with or without output", async () => {
    await feed(`${PASTE_ON}$ sleep 30\r\n${PASTE_OFF}${C}`);
    expect(session.state.working).toBe(true);
    await feed("", 60_000);
    expect(session.state.working).toBe(true);
    await redraw(1000);
    await feed("", 60_000);
    expect(session.state.working).toBe(true);
    await feed(`${D}${PASTE_ON}$ `);
    expect(session.state).toMatchObject({ commandRunning: false, working: false });
  });

  it.each([
    ["an agent CLI (bracketed paste)", PASTE_ON, PASTE_OFF],
    ["a full-screen program (alternate screen)", "\x1b[?1049h", "\x1b[?1049l"],
  ])("follows the output of %s", async (_, enter, leave) => {
    await feed(`${PASTE_OFF}${C}`);
    expect(session.state.working).toBe(true);
    // The program starts and draws its screen once, then waits for input.
    await feed(`${enter}\x1b]0;Agent\x07> `, QUIET_MS + 10);
    expect(session.state).toMatchObject({ commandRunning: true, working: false });
    await feed("", 60_000);
    expect(session.state.working).toBe(false);

    // A turn: it redraws while it works, then falls silent.
    await redraw(SUSTAIN_MS + 200);
    expect(session.state.working).toBe(true);
    await redraw(3000);
    expect(session.state.working).toBe(true);
    await feed("", QUIET_MS + 10);
    expect(session.state).toMatchObject({ commandRunning: true, working: false });

    // A lone redraw between turns is not work.
    await feed("\r\x1b[K> ", QUIET_MS + 10);
    expect(session.state.working).toBe(false);

    await feed(`${leave}${D}`);
    expect(session.state).toMatchObject({ commandRunning: false, working: false });
  });

  it("does not count the echo of what the user types into an idle program", async () => {
    ipc.commands.termSpawn.mockImplementationOnce(async () => ({ id: 7, title: "zsh" }));
    await session.start();
    await feed(`${PASTE_OFF}${C}${PASTE_ON}> `, QUIET_MS + 10);
    for (let i = 0; i < 20; i++) {
      session.input("a");
      await feed("a", 100);
    }
    expect(session.state.working).toBe(false);
  });

  it.each([
    ["the alternate screen", "\x1b[?1049h"],
    ["bracketed paste", PASTE_ON],
  ])("ignores %s left on by an earlier program", async (_, enter) => {
    // Killed before it could restore the terminal; the shell's prompt returns.
    await feed(`${C}${enter}`);
    await feed(`${D}$ `);
    await feed(C);
    expect(session.state.working).toBe(true);
    await feed("", 60_000);
    expect(session.state.working).toBe(true);
  });

  it("starts over when a program run instead of a shell is restarted", async () => {
    session.dispose();
    session = new TerminalSession({
      key: "k",
      cwd: "/repo",
      onChange() {},
      onFocus() {},
      command: { program: "tool", args: [] },
    });
    ipc.commands.termSpawn.mockImplementation(async () => ({ id: 9, title: "tool" }));
    await session.start();
    expect(session.state).toMatchObject({ commandRunning: true, working: true });
    await feed(`${PASTE_ON}> `, QUIET_MS + 10);
    expect(session.state.working).toBe(false);
    session.exited(0);
    await vi.advanceTimersByTimeAsync(100);
    session.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toMatchObject({ status: "running", commandRunning: true, working: true });
  });

  it("leaves no timer behind when disposed", async () => {
    await feed(`${C}${PASTE_ON}> `);
    await redraw(1000);
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes the program's own progress report over its output", async () => {
    const PROGRESS = (state: number) => `\x1b]9;4;${state}\x07`;
    // Interactive and silent, but it reports work in flight.
    await feed(`${C}${PASTE_ON}> `, QUIET_MS + 10);
    expect(session.state.working).toBe(false);
    await feed(PROGRESS(3), 60_000);
    expect(session.state.working).toBe(true);
    // Still redrawing, but it reports being done.
    await feed(PROGRESS(0));
    await redraw(2000);
    expect(session.state.working).toBe(false);
    // The next command has reported nothing: its output counts again.
    await feed(`${PASTE_OFF}${D}${C}`);
    expect(session.state.working).toBe(true);
    // A plain command that cleared its report is done, too.
    await feed(PROGRESS(0));
    expect(session.state.working).toBe(false);
  });

  it("stops when the session exits", async () => {
    await feed(`${PASTE_OFF}${C}`);
    expect(session.state.working).toBe(true);
    session.exited(1);
    expect(session.state.working).toBe(false);
  });

  it("reports each change once", async () => {
    const onChange = vi.fn();
    session.rebind({ onChange, onFocus() {} });
    onChange.mockClear();
    await feed(`${PASTE_OFF}${C}${PASTE_ON}> `, QUIET_MS + 10);
    await redraw(3000);
    await feed("", QUIET_MS + 10);
    // Not once per write: the command starts, the program turns interactive, works, falls silent.
    expect(onChange.mock.calls.map(([, s]) => (s as { working: boolean }).working)).toEqual([true, false, true, false]);
  });
});
