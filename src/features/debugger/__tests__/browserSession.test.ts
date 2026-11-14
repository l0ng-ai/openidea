import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchConfig } from "@/platform/ipc";
import { browserLaunch } from "../browser";
import { handleDebugEvent, resetSessions, startBrowserSession, useDebug } from "../state";

const ipc = vi.hoisted(() => {
  let next = 0;
  return {
    reset: () => (next = 0),
    debugStart: vi.fn(async (_launch: unknown) => ({ status: "ok", data: ++next })),
    debugStop: vi.fn(async (_id: number) => ({ status: "ok", data: null })),
    debugEvaluateIn: vi.fn(async (..._args: unknown[]) => ({
      status: "ok",
      data: { value: "", variablesReference: 0 },
    })),
  };
});
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const { reset: _reset, ...commands } = ipc;
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...commands } };
});

const launched = () => ipc.debugStart.mock.calls.map(([launch]) => JSON.parse((launch as LaunchConfig).extraJson!));
/** The adapter's own session for the page of browser launch `parent`. */
const pageOf = (parent: number, id: number) =>
  handleDebugEvent(id, { kind: "started", name: "page", adapter: "js-debug", parent });

beforeEach(() => {
  // Nothing live is left to stop: session ids start over, as after the backend restarts.
  useDebug.setState({ sessions: {}, active: null });
  resetSessions();
  ipc.reset();
  for (const mock of [ipc.debugStart, ipc.debugStop, ipc.debugEvaluateIn]) mock.mockClear();
});

describe("the browser of a project under the debugger", () => {
  it("is started once: a second launch sends its page to the new address and selects it", async () => {
    const first = await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "chrome", "/p"));
    pageOf(first!, 2);
    expect(useDebug.getState().active).toBe(2);

    useDebug.setState({ active: null });
    const again = await startBrowserSession(browserLaunch("b", "http://localhost:5173/cart", "chrome", "/p"));
    expect(again).toBe(first);
    expect(ipc.debugStart).toHaveBeenCalledTimes(1);
    expect(ipc.debugEvaluateIn).toHaveBeenCalledWith(2, null, 'location.assign("http://localhost:5173/cart")', "repl");
    expect(useDebug.getState().active).toBe(2);

    // The address it was started on: the page is where it is.
    ipc.debugEvaluateIn.mockClear();
    await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "chrome", "/p"));
    expect(ipc.debugEvaluateIn).not.toHaveBeenCalled();
  });

  it("is another one for another browser, another project, or after the first has ended", async () => {
    const first = await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "chrome", "/p"));
    pageOf(first!, 2);
    await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "edge", "/p"));
    await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "chrome", "/other"));
    expect(launched().map((l) => l.type)).toEqual(["pwa-chrome", "pwa-msedge", "pwa-chrome"]);
    handleDebugEvent(first!, { kind: "terminated" });
    await startBrowserSession(browserLaunch("a", "http://localhost:5173/", "chrome", "/p"));
    expect(ipc.debugStart).toHaveBeenCalledTimes(4);
  });
});
