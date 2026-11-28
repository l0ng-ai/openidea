import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

const debug = vi.hoisted(() => ({
  startSession: vi.fn(),
  stopSession: vi.fn(async () => {}),
  store: null as unknown as { getState: () => { sessions: Record<number, { status: string }> } },
}));
const notebookDebugStart = vi.hoisted(() => vi.fn((...args: unknown[]) => args));

vi.mock("@/features/debugger/state", () => {
  debug.store = create(() => ({ sessions: {} as Record<number, { status: string }> }));
  return {
    startSession: debug.startSession,
    stopSession: debug.stopSession,
    useDebug: debug.store,
    isLive: (s?: { status: string }) => !!s && s.status !== "terminated",
  };
});
vi.mock("@/platform/ipc", () => ({
  call: async (value: unknown) => value,
  commands: { notebookDebugStart },
}));
vi.mock("@/platform/workflowSettings", () => ({
  workflowSettings: () => ({ debugger: { skipLibraryCode: true } }),
}));

import { debugCell } from "./debugCell";
import type { NotebookSession } from "./session";

function notebook(run: Promise<void>) {
  let running = false;
  const session = {
    path: "/p/a.ipynb",
    flush: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    getState: () => ({
      running,
      python: "/venv/bin/python",
      snapshot: {
        id: "nb-1",
        cells: [
          { id: "md", cellType: "markdown" },
          { id: "a", cellType: "code" },
          { id: "b", cellType: "code" },
        ],
      },
    }),
    execute: vi.fn(() => {
      running = true;
      return run.finally(() => (running = false));
    }),
  };
  return session;
}

const setStatus = (id: number, status: string) =>
  (debug.store as unknown as { setState: (s: object) => void }).setState({ sessions: { [id]: { status } } });

beforeEach(() => {
  vi.clearAllMocks();
  debug.startSession.mockImplementation(async (_launch, options: { start: () => Promise<unknown> }) => {
    await options.start();
    setStatus(7, "running");
    return 7;
  });
});

describe("Debug Cell", () => {
  it("starts a kernel debug session, runs the cell and ends the session after it", async () => {
    const session = notebook(Promise.resolve());
    await debugCell(session as unknown as NotebookSession, "b");
    const [launch, options] = debug.startSession.mock.calls[0]!;
    expect(launch).toMatchObject({ name: "a.ipynb [2]", adapter: "jupyter-kernel", request: "attach" });
    expect(options).toMatchObject({ rerunnable: false });
    expect(notebookDebugStart).toHaveBeenCalledWith("nb-1", "/venv/bin/python", "a.ipynb [2]", true);
    expect(session.execute).toHaveBeenCalledWith(["b"]);
    expect(debug.stopSession).toHaveBeenCalledWith(7);
    expect(session.interrupt).not.toHaveBeenCalled();
  });

  it("interrupts the cell when the debug session is stopped", async () => {
    let finish = () => {};
    const session = notebook(new Promise<void>((resolve) => (finish = resolve)));
    const done = debugCell(session as unknown as NotebookSession, "a");
    await vi.waitFor(() => expect(session.execute).toHaveBeenCalled());
    setStatus(7, "terminated");
    setStatus(7, "terminated");
    expect(session.interrupt).toHaveBeenCalledTimes(1);
    finish();
    await done;
    expect(debug.stopSession).not.toHaveBeenCalled();
  });

  it("runs nothing when the session does not start", async () => {
    debug.startSession.mockResolvedValueOnce(null);
    const session = notebook(Promise.resolve());
    await debugCell(session as unknown as NotebookSession, "a");
    expect(session.execute).not.toHaveBeenCalled();
  });
});
