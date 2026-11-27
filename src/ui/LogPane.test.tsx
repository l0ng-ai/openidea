import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useProject } from "@/platform/project";
import { LogPane, type LogLine } from "./LogPane";

type Push = (l: LogLine) => void;

function source() {
  const pushes: Push[] = [];
  const exits: ((code: number | null) => void)[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const start = vi.fn(
    (
      onLine: Push,
      _onError: (message: string) => void,
      _on: ReadonlySet<string>,
      onExit: (code: number | null) => void,
    ) => {
      pushes.push(onLine);
      exits.push(onExit);
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    },
  );
  const push = (text: string, stderr = false) => pushes.at(-1)!({ text, stderr });
  const exit = (code: number | null) => act(() => exits.at(-1)!(code));
  return { start, stops, push, exit };
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
  useProject.setState({ settings: null });
});

describe("LogPane", () => {
  it("drops output that arrives after the source was stopped", () => {
    const s = source();
    const { unmount } = render(<LogPane start={s.start} sourceKey="a" live ariaLabel="Log" />);
    const late = s.start.mock.calls.at(-1)![0];
    unmount();
    expect(() => late({ text: "late", stderr: false })).not.toThrow();
    expect(frames).toHaveLength(0);
  });

  it("says when the program finished, after its last lines", () => {
    const s = source();
    render(<LogPane start={s.start} sourceKey="a" live ariaLabel="Log" />);
    s.push("done");
    s.exit(3);
    expect(screen.getByRole("log").textContent).toBe("doneProcess finished with exit code 3");
  });

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
  it("shows ANSI colours and log level colours instead of escape codes", () => {
    useProject.setState({ settings: { console: { logColors: { enabled: true } } } as never });
    const s = source();
    render(<LogPane start={s.start} sourceKey="a" live ariaLabel="Log" />);
    s.push("\x1b[32mstarted\x1b[0m on port 8080");
    s.push("2026-11-21 ERROR boom");
    runFrames();
    const log = screen.getByRole("log", { name: "Log" });
    expect(log.textContent).not.toContain("\x1b");
    expect(screen.getByText("started")).toHaveStyle({ color: "var(--ansi-green)" });
    expect(screen.getByText("2026-11-21 ERROR boom").closest("div")!.style.color).not.toBe("");
  });

  it("stops following when scrolled up and follows again from Scroll to End", () => {
    const s = source();
    render(<LogPane start={s.start} sourceKey="a" live ariaLabel="Log" />);
    const end = screen.getByRole("button", { name: "Scroll to End" });
    expect(end).toHaveAttribute("aria-pressed", "true");
    const log = screen.getByRole("log", { name: "Log" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 100 });
    log.scrollTop = 200;
    fireEvent.scroll(log);
    expect(end).toHaveAttribute("aria-pressed", "false");
    s.push("more");
    runFrames();
    expect(log.scrollTop).toBe(200);
    fireEvent.click(end);
    expect(end).toHaveAttribute("aria-pressed", "true");
    expect(log.scrollTop).toBe(1000);
  });
});
