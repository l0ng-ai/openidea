import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { LogPane, type LogLine } from "./LogPane";

type Push = (l: LogLine) => void;

function source() {
  const pushes: Push[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const start = vi.fn((onLine: Push, _onError: (message: string) => void, _on: ReadonlySet<string>) => {
    pushes.push(onLine);
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  const push = (text: string, stderr = false) => pushes.at(-1)!({ text, stderr });
  return { start, stops, push };
}

let frames: FrameRequestCallback[] = [];
const runFrames = () =>
  act(() => {
    const run = frames;
    frames = [];
    run.forEach((f) => f(0));
  });

beforeEach(() => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => frames.push(fn));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LogPane", () => {
  it("appends lines and strips ANSI", () => {
    const s = source();
    render(<LogPane start={s.start} sourceKey="a" live ariaLabel="Log" />);
    s.push("\x1b[31mred\x1b[0m");
    runFrames();
    expect(screen.getByRole("log").textContent).toBe("red");
  });

  it("keeps the last 5000 lines", () => {
    const s = source();
    render(<LogPane start={s.start} sourceKey="a" live ariaLabel="Log" />);
    for (let i = 0; i <= 5000; i++) s.push(`line ${i}`);
    runFrames();
    const lines = screen.getByRole("log").children;
    expect(lines).toHaveLength(5000);
    expect(lines[0]?.textContent).toBe("line 1");
  });

  it("restarts the source when a toggle flips", () => {
    const s = source();
    render(
      <LogPane
        start={s.start}
        sourceKey="a"
        live
        ariaLabel="Log"
        toggles={[{ id: "timestamps", label: "Timestamps" }]}
      />,
    );
    expect(s.start).toHaveBeenCalledTimes(1);
    expect(s.start.mock.calls[0]?.[2]).toEqual(new Set());
    fireEvent.click(screen.getByRole("switch", { name: "Timestamps" }));
    expect(s.start).toHaveBeenCalledTimes(2);
    expect(s.start.mock.calls[1]?.[2]).toEqual(new Set(["timestamps"]));
    expect(s.stops.at(0)).toHaveBeenCalled();
  });

  it("stops the source on unmount", () => {
    const s = source();
    const { unmount } = render(<LogPane start={s.start} sourceKey="a" live ariaLabel="Log" />);
    unmount();
    expect(s.stops.at(0)).toHaveBeenCalled();
  });
});
