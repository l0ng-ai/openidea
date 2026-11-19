import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpBackgroundProject } from "./ipc";

const ipc = vi.hoisted(() => ({ mcpBackgroundProjects: vi.fn() }));
vi.mock("./ipc", async (original) => {
  const real = await original<typeof import("./ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

const { backgroundProjectState, useBackgroundProjects } = await import("./mcpBackground");
const { emitLocalIdeEvent } = await import("./ipc");

const project = (patch: Partial<McpBackgroundProject> = {}): McpBackgroundProject => ({
  root: "/projects/inventory",
  idleSeconds: 0,
  ...patch,
});
const ok = <T>(data: T) => ({ status: "ok" as const, data });

describe("background project state", () => {
  it("says a project is answering while a tool call is in flight", () => {
    expect(backgroundProjectState(project({ keptOpenBy: { kind: "request" } }))).toBe("Answering a request");
  });

  it("names the run that keeps an idle project loaded", () => {
    const state = backgroundProjectState(
      project({ idleSeconds: 900, keptOpenBy: { kind: "run", name: "dev server" } }),
    );
    expect(state).toBe("Kept open by the run dev server");
  });

  it("reports a request under a minute ago as just now", () => {
    expect(backgroundProjectState(project({ idleSeconds: 0, unloadsInSeconds: 1800 }))).toBe("Last request just now");
    expect(backgroundProjectState(project({ idleSeconds: 59, unloadsInSeconds: 1741 }))).toBe("Last request just now");
  });

  it("counts idle whole minutes from the first minute on", () => {
    expect(backgroundProjectState(project({ idleSeconds: 60 }))).toBe("Idle 1 min");
    expect(backgroundProjectState(project({ idleSeconds: 12 * 60 + 59 }))).toBe("Idle 12 min");
  });

  it("adds the minutes left before the unload, rounded up", () => {
    expect(backgroundProjectState(project({ idleSeconds: 720, unloadsInSeconds: 1080 }))).toBe(
      "Idle 12 min, unloads in 18 min",
    );
    expect(backgroundProjectState(project({ idleSeconds: 720, unloadsInSeconds: 61 }))).toBe(
      "Idle 12 min, unloads in 2 min",
    );
    expect(backgroundProjectState(project({ idleSeconds: 1790, unloadsInSeconds: 10 }))).toBe(
      "Idle 29 min, unloads in 1 min",
    );
  });

  it("leaves out the unload time for a project that is never unloaded", () => {
    expect(backgroundProjectState(project({ idleSeconds: 3600, unloadsInSeconds: null }))).toBe("Idle 60 min");
  });
});

describe("useBackgroundProjects", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ipc.mcpBackgroundProjects.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const mount = async () => {
    const view = renderHook(() => useBackgroundProjects());
    await act(async () => {});
    return view;
  };

  it("lists the projects the backend reports when it mounts", async () => {
    ipc.mcpBackgroundProjects.mockResolvedValue(ok([project()]));
    const { result } = await mount();
    expect(result.current.map((p) => p.root)).toEqual(["/projects/inventory"]);
  });

  it("lists nothing while the backend call fails", async () => {
    ipc.mcpBackgroundProjects.mockResolvedValue({
      status: "error",
      error: { kind: "internal", message: "x", data: null },
    });
    const { result } = await mount();
    expect(result.current).toEqual([]);
  });

  it("fetches again when the backend reports a change", async () => {
    ipc.mcpBackgroundProjects.mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([project()]));
    const { result } = await mount();
    expect(result.current).toEqual([]);
    await act(async () => emitLocalIdeEvent({ type: "mcpBackgroundProjectsChanged" }));
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(2);
    expect(result.current.map((p) => p.root)).toEqual(["/projects/inventory"]);
  });

  it("stops listening for changes when it unmounts", async () => {
    ipc.mcpBackgroundProjects.mockResolvedValue(ok([]));
    const { unmount } = await mount();
    unmount();
    await act(async () => emitLocalIdeEvent({ type: "mcpBackgroundProjectsChanged" }));
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(1);
  });

  it("polls every 30 seconds while a project is loaded", async () => {
    ipc.mcpBackgroundProjects.mockResolvedValue(ok([project()]));
    await mount();
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(3);
  });

  it("asks again every 3 seconds while a project answers a request, whose end reports nothing", async () => {
    ipc.mcpBackgroundProjects.mockResolvedValueOnce(ok([project({ keptOpenBy: { kind: "request" } })]));
    ipc.mcpBackgroundProjects.mockResolvedValue(ok([project({ idleSeconds: 2, unloadsInSeconds: 1798 })]));
    const view = await mount();
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(2);
    expect(view.result.current[0]?.keptOpenBy).toBeUndefined();
    // The request is over: back to the slow poll.
    await act(() => vi.advanceTimersByTimeAsync(27_000));
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(3);
  });

  it("does not poll while no project is loaded", async () => {
    ipc.mcpBackgroundProjects.mockResolvedValue(ok([]));
    await mount();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(1);
  });

  it("stops polling once the last project is unloaded", async () => {
    ipc.mcpBackgroundProjects.mockResolvedValueOnce(ok([project()])).mockResolvedValue(ok([]));
    const { result } = await mount();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(result.current).toEqual([]);
    const calls = ipc.mcpBackgroundProjects.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(calls);
  });

  it("advances both counters between fetches", async () => {
    ipc.mcpBackgroundProjects.mockResolvedValue(ok([project({ idleSeconds: 10, unloadsInSeconds: 120 })]));
    const { result } = await mount();
    expect(result.current[0]).toMatchObject({ idleSeconds: 10, unloadsInSeconds: 120 });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(result.current[0]).toMatchObject({ idleSeconds: 30, unloadsInSeconds: 100 });
    expect(ipc.mcpBackgroundProjects).toHaveBeenCalledTimes(1);
  });

  it("does not run the unload counter below zero or invent one for a project that is never unloaded", async () => {
    ipc.mcpBackgroundProjects.mockResolvedValue(
      ok([
        project({ root: "/projects/inventory", idleSeconds: 0, unloadsInSeconds: 5 }),
        project({ root: "/projects/billing", idleSeconds: 0, unloadsInSeconds: null }),
      ]),
    );
    const { result } = await mount();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(result.current[0]).toMatchObject({ idleSeconds: 20, unloadsInSeconds: 0 });
    expect(result.current[1]!.unloadsInSeconds).toBeNull();
  });

  it("keeps a project that something holds open at the idle time the backend gave", async () => {
    ipc.mcpBackgroundProjects.mockResolvedValue(ok([project({ idleSeconds: 3, keptOpenBy: { kind: "request" } })]));
    const { result } = await mount();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(result.current[0]!.idleSeconds).toBe(3);
  });
});
