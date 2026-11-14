import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

type Answer = { status: "ok"; data: unknown } | { status: "error"; error: { kind: string; message: string } };
const asked: Array<[number, number | null, string, string | null]> = [];
let answer: (expression: string) => Promise<Answer>;
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      debugEvaluateIn: (session: number, frame: number | null, expression: string, context: string | null) => {
        asked.push([session, frame, expression, context]);
        return answer(expression);
      },
    },
  };
});

const { useProject } = await import("@/platform/project");
const { LIVE_WATCH_INTERVAL_MS, liveWatchesApply, useLiveWatches } = await import("../js/liveWatches");
type Session = Parameters<typeof useLiveWatches>[0];

const session = (p: Record<string, unknown> = {}): Session =>
  ({ id: 3, name: "page", status: "running", caps: { liveEvaluate: true }, ...p }) as Session;
const value = (text: string) => ({ status: "ok" as const, data: { value: text, variablesReference: 0 } });
type Settings = ReturnType<typeof useProject.getState>["settings"];
const setLiveWatches = (on: boolean | null) =>
  useProject.setState({ settings: (on == null ? {} : { debugger: { liveWatches: on } }) as Settings });
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

beforeEach(() => {
  vi.useFakeTimers();
  asked.length = 0;
  answer = (expression) => Promise.resolve(value(`<${expression}>`));
  setLiveWatches(true);
});
afterEach(() => vi.useRealTimers());

describe("watches while the program runs", () => {
  it("evaluates each watch without a frame while the session runs", async () => {
    const { result } = renderHook(() => useLiveWatches(session(), ["a", "b"], true));
    await settle();
    expect(asked).toEqual([
      [3, null, "a", "watch"],
      [3, null, "b", "watch"],
    ]);
    expect(result.current.map((r) => [r.expression, (r.result as { value: string } | null)?.value, r.error])).toEqual([
      ["a", "<a>", null],
      ["b", "<b>", null],
    ]);
  });

  it("evaluates a multi-line watch as one expression", async () => {
    const multiline = "items\n  .filter((i) => i.done)\n  .length";
    renderHook(() => useLiveWatches(session(), [multiline, "b"], true));
    await settle();
    expect(asked.map((a) => a[2])).toEqual([multiline, "b"]);
  });

  it("refreshes every second and not faster", async () => {
    expect(LIVE_WATCH_INTERVAL_MS).toBe(1000);
    renderHook(() => useLiveWatches(session(), ["a"], true));
    await settle();
    expect(asked).toHaveLength(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(999)));
    expect(asked).toHaveLength(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)));
    expect(asked).toHaveLength(2);
  });

  it("skips a tick while the previous one is pending", async () => {
    answer = () => new Promise(() => {});
    renderHook(() => useLiveWatches(session({ id: 90 }), ["slow"], true));
    await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    expect(asked).toHaveLength(1);
  });

  it("does not start a second round in a session when the watch list changes during a slow one", async () => {
    let finish = () => {};
    answer = () => new Promise((resolve) => (finish = () => resolve(value("done"))));
    const { rerender } = renderHook(({ list }) => useLiveWatches(session({ id: 91 }), list, true), {
      initialProps: { list: ["slow"] },
    });
    await settle();
    rerender({ list: ["slow", "other"] });
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(asked).toEqual([[91, null, "slow", "watch"]]);
    // Once it has answered, the next tick asks for the list as it is now.
    answer = (expression) => Promise.resolve(value(`<${expression}>`));
    finish();
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(asked.slice(1).map((a) => a[2])).toEqual(["slow", "other"]);
  });

  it("is off until turned on in the settings", () => {
    setLiveWatches(null);
    expect(liveWatchesApply(session())).toBe(false);
    setLiveWatches(true);
    expect(liveWatchesApply(session())).toBe(true);
  });

  it("stops when hidden, paused, terminated, switched off or unsupported", async () => {
    const quiet: Array<[Session, boolean]> = [
      [session(), false],
      [session({ status: "paused" }), true],
      [session({ status: "terminated" }), true],
      [session({ caps: { liveEvaluate: false } }), true],
      [session({ caps: null }), true],
      [undefined, true],
    ];
    for (const [s, visible] of quiet) {
      const { result, unmount } = renderHook(() => useLiveWatches(s, ["a"], visible));
      await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
      expect(result.current).toEqual([]);
      unmount();
    }
    setLiveWatches(false);
    expect(liveWatchesApply(session())).toBe(false);
    const { result } = renderHook(() => useLiveWatches(session(), ["a"], true));
    await act(async () => void (await vi.advanceTimersByTimeAsync(2500)));
    expect(result.current).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("an evaluation error becomes the watch's error", async () => {
    answer = () =>
      Promise.resolve({ status: "error", error: { kind: "internal", message: "ReferenceError: x is not defined" } });
    const { result } = renderHook(() => useLiveWatches(session(), ["x"], true));
    await settle();
    expect(result.current).toEqual([{ expression: "x", result: null, error: "ReferenceError: x is not defined" }]);
  });

  it("drops a late answer of another session", async () => {
    let release: (a: Answer) => void = () => {};
    answer = () => new Promise<Answer>((resolve) => (release = resolve));
    const { result, rerender } = renderHook(({ s }) => useLiveWatches(s, ["a"], true), {
      initialProps: { s: session({ id: 3 }) },
    });
    await settle();
    answer = (expression) => Promise.resolve(value(`new ${expression}`));
    rerender({ s: session({ id: 4 }) });
    await settle();
    await act(async () => {
      release(value("old"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.map((r) => (r.result as { value: string } | null)?.value)).toEqual(["new a"]);
  });
});
