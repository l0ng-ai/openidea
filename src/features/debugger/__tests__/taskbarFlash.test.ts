import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => {
  const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ok,
    debugCapabilities: vi.fn(async () => ok(null)),
    debugThreads: vi.fn(async () => ok([{ id: 1, name: "main" }])),
    debugStackTrace: vi.fn(async () => ok([])),
    windowFlashTaskbar: vi.fn(async (_flash: boolean) => ok(null)),
  };
});
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const { ok: _ok, ...commands } = ipc;
  return { ...real, commands: { ...real.commands, ...commands } };
});

import { useProject } from "@/platform/project";
import { adoptSession, handleDebugEvent, useDebug } from "../state";
import { stopTaskbarFlash } from "../taskbarFlash";

const stopped = (reason: string) =>
  handleDebugEvent(1, { kind: "stopped", threadId: 1, reason, description: null, allThreadsStopped: false });
const flashes = () => ipc.windowFlashTaskbar.mock.calls.filter(([flash]) => flash).length;
const stops = () => ipc.windowFlashTaskbar.mock.calls.filter(([flash]) => !flash).length;
const hasFocus = vi.spyOn(document, "hasFocus");

beforeAll(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

beforeEach(() => {
  // Stop any flash left over from the previous test before the mock is cleared.
  stopTaskbarFlash();
  vi.clearAllMocks();
  useDebug.setState({ sessions: {}, active: null, stopSeq: 0 });
  useProject.setState({ settings: {} as never });
  adoptSession(1, { adapter: "java-debug" });
});

afterAll(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  hasFocus.mockRestore();
  useProject.setState({ settings: null });
});

describe("taskbar flash on a breakpoint in a background window", () => {
  it("flashes when a breakpoint stops an unfocused window", () => {
    hasFocus.mockReturnValue(false);
    stopped("breakpoint");
    expect(flashes()).toBe(1);
    expect(stops()).toBe(0);
  });

  it("does not flash when the window is focused", () => {
    hasFocus.mockReturnValue(true);
    stopped("breakpoint");
    expect(ipc.windowFlashTaskbar).not.toHaveBeenCalled();
  });

  it("does not flash for a stop that is not a breakpoint", () => {
    hasFocus.mockReturnValue(false);
    stopped("step");
    stopped("exception");
    expect(ipc.windowFlashTaskbar).not.toHaveBeenCalled();
  });

  it("does not re-request attention for repeated breakpoints while already flashing", () => {
    hasFocus.mockReturnValue(false);
    stopped("breakpoint");
    stopped("breakpoint");
    stopped("function breakpoint");
    expect(flashes()).toBe(1);
    expect(stops()).toBe(0);
  });

  it("stops the flash when the window is focused", () => {
    hasFocus.mockReturnValue(false);
    stopped("breakpoint");
    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    expect(flashes()).toBe(1);
    expect(stops()).toBe(1);
    // Further focus events send no more stops: the flash is forgotten. A breakpoint that
    // hits afterwards finds the window focused and does not flash again (criterion 3).
    window.dispatchEvent(new Event("focus"));
    stopped("breakpoint");
    expect(stops()).toBe(1);
    expect(flashes()).toBe(1);
    expect(ipc.windowFlashTaskbar).toHaveBeenCalledTimes(2);
  });

  it("stops the flash when the session resumes", () => {
    hasFocus.mockReturnValue(false);
    stopped("breakpoint");
    handleDebugEvent(1, { kind: "continued", threadId: 1, allThreadsContinued: true });
    expect(stops()).toBe(1);
  });

  it("stops the flash when the session terminates", () => {
    hasFocus.mockReturnValue(false);
    stopped("breakpoint");
    handleDebugEvent(1, { kind: "terminated" });
    expect(stops()).toBe(1);
  });

  it("does not flash when Focus application on breakpoint takes the window instead", () => {
    useProject.setState({ settings: { debugger: { focusAppOnBreakpoint: true } } as never });
    hasFocus.mockReturnValue(false);
    stopped("breakpoint");
    expect(ipc.windowFlashTaskbar).not.toHaveBeenCalled();
  });

  it("never touches the shell outside Tauri", () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    hasFocus.mockReturnValue(false);
    stopped("breakpoint");
    expect(ipc.windowFlashTaskbar).not.toHaveBeenCalled();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
});
