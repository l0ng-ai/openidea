/**
 * The tab's running marker (#3831): a plain command spins from start to end;
 * an interactive program (an agent CLI, a REPL, an editor) spins only while it
 * keeps producing output, not while it waits for input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ECHO_MS, OutputActivity, QUIET_MS, SUSTAIN_MS } from "./activity";
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
  ])("ignores %s", (_, times) => {
    const a = new OutputActivity();
    for (const t of times) {
      a.output(t);
      expect(a.active(t)).toBe(false);
    }
  });

  it("does not take the echo of typing for work", () => {
    const a = new OutputActivity();
    for (let t = 0; t < 5000; t += 200) {
      a.input(t);
      a.output(t + ECHO_MS - 1);
      expect(a.active(t + ECHO_MS - 1)).toBe(false);
    }
  });

  it("keeps working while the user types into a busy program", () => {
    const a = new OutputActivity();
    const end = stream(a, 0, 2000);
    a.input(end);
    a.output(end + 10);
    expect(a.active(end + 10)).toBe(true);
    expect(a.active(stream(a, end + ECHO_MS, 1000))).toBe(true);
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
    const working = onChange.mock.calls.map(([, s]) => (s as { working: boolean }).working);
    expect(working.filter((w, i) => w !== working[i - 1])).toEqual([true, false, true, false]);
  });
});
