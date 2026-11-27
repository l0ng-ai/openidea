import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchConfig, RunConfig } from "@/platform/ipc";
import { registerAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { handleDebugEvent, resetSessions, startSession, stopSession, useDebug } from "../state";

const ipc = vi.hoisted(() => {
  let next = 0;
  return {
    /** A backend process numbers its sessions from 1. */
    restart: () => (next = 0),
    debugStart: vi.fn(async (_launch: unknown) => ({ status: "ok", data: ++next })),
    debugStop: vi.fn(async (_id: number) => ({ status: "ok", data: null })),
  };
});
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  const { restart: _restart, ...commands } = ipc;
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...commands } };
});

const launch: LaunchConfig = {
  name: "pricing > withTax > adds the rate",
  adapter: "js-debug",
  request: "launch",
  program: null,
  args: [],
  cwd: "/p",
  env: {},
  extraJson: JSON.stringify({ type: "pwa-node", runtimeExecutable: "npm", runtimeArgs: ["run", "test"] }),
};

/** js-debug's session for a process the debuggee started (`startDebugging`). */
const child = (id: number, parent: number, name: string) =>
  handleDebugEvent(id, { kind: "started", name, adapter: "js-debug", parent });
const breakpoint = (id: number) =>
  handleDebugEvent(id, {
    kind: "stopped",
    threadId: 1,
    reason: "breakpoint",
    description: null,
    allThreadsStopped: false,
  });

beforeEach(() => {
  useDebug.setState({ sessions: {}, active: null });
  resetSessions();
  ipc.restart();
  useProject.setState({
    project: { root: "/p" } as ReturnType<typeof useProject.getState>["project"],
    settings: null,
  });
});

describe("sessions of a window whose backend changes", () => {
  it("adopts the children of a new session although an earlier backend used their ids", async () => {
    // The first backend: `npm run test` and the process js-debug attached to under it.
    expect(await startSession(launch)).toBe(1);
    child(2, 1, "npm-cli.js [100]");
    expect(useDebug.getState().sessions[2]?.parent).toBe(1);

    // The window reopens its project on another backend (a remote reconnect): ids start over.
    resetSessions();
    ipc.restart();
    expect(await startSession(launch)).toBe(1);
    child(2, 1, "npm-cli.js [200]");
    child(3, 2, "mocha.js [201]");
    breakpoint(3);

    const { sessions, active } = useDebug.getState();
    expect([sessions[2]?.name, sessions[2]?.parent]).toEqual(["npm-cli.js [200]", 1]);
    expect([sessions[3]?.name, sessions[3]?.parent, sessions[3]?.status]).toEqual(["mocha.js [201]", 2, "paused"]);
    expect(active).toBe(3);
  });

  it("still ignores late events of the sessions it forgot", async () => {
    await startSession(launch);
    child(2, 1, "npm-cli.js [100]");
    resetSessions();

    breakpoint(2);
    handleDebugEvent(1, { kind: "output", category: "stdout", output: "late\n" });
    expect(useDebug.getState().sessions).toEqual({});
    expect(useDebug.getState().console).toEqual({});
  });
});

describe("Attach to Node.js with Reconnect automatically", () => {
  const attach = (restart: boolean) =>
    startSession(
      { ...launch, name: "Attach", request: "attach" },
      { runConfig: { name: "Attach", kind: "node-remote", params: restart ? { restart: "true" } : {} } as RunConfig },
    );
  const ended = (id: number) => handleDebugEvent(id, { kind: "terminated" });

  it("shows the restarted process in place of the finished one, with its output", async () => {
    expect(await attach(true)).toBe(1);
    child(2, 1, "Remote Process [100]");
    handleDebugEvent(2, { kind: "output", category: "stderr", output: "Error: boom\n" });
    ended(2);
    // nodemon's next process has another pid.
    child(3, 1, "Remote Process [200]");
    handleDebugEvent(3, { kind: "output", category: "stdout", output: "listening\n" });
    const { sessions } = useDebug.getState();
    expect(Object.keys(sessions).map(Number)).toEqual([1, 3]);
    expect(sessions[1]?.status).toBe("running");
    await vi.waitFor(() =>
      expect(useDebug.getState().console[3]?.map((l) => l.text)).toEqual(["Error: boom\n", "listening\n"]),
    );
  });

  it("keeps finished processes of other sessions", async () => {
    await attach(false);
    child(2, 1, "Remote Process [0]");
    ended(2);
    child(3, 1, "Remote Process [0]");
    expect(Object.keys(useDebug.getState().sessions).map(Number)).toEqual([1, 2, 3]);
  });
});

describe("Python Debug Server", () => {
  const rc = { name: "Server", kind: "python-debug-server", params: { port: "5678" } } as unknown as RunConfig;
  const listen = { ...launch, name: "Server", adapter: "debugpy", request: "attach", extraJson: "{}" };
  /** `debugStart` answers once a program connects; until then the backend only announces the session. */
  function waitForProgram() {
    let connect!: (id: number) => void;
    ipc.debugStart.mockImplementationOnce(async () => {
      const id = await new Promise<number>((resolve) => (connect = resolve));
      return { status: "ok", data: id };
    });
    return (id: number) => connect(id);
  }
  const announce = (id: number) =>
    handleDebugEvent(id, { kind: "started", name: "Server", adapter: "debugpy", parent: null });

  beforeEach(() => ipc.debugStart.mockClear());

  it("waits for the program, then listens again in the same tab when it ends, keeping the output", async () => {
    const rerun = vi.fn(() => {
      waitForProgram();
      void startSession(listen, { runConfig: rc });
    });
    const dispose = registerAction({ id: "run.debugConfig", title: "Debug", run: rerun });
    try {
      const connect = waitForProgram();
      const started = startSession(listen, { runConfig: rc });
      await vi.waitFor(() => expect(ipc.debugStart).toHaveBeenCalled());
      announce(1);
      expect(useDebug.getState().sessions[1]).toMatchObject({ status: "starting", runConfig: rc });
      expect(
        useDebug
          .getState()
          .console[1]?.map((l) => l.text)
          .join(""),
      ).toMatch(/^Waiting for process connection on localhost:5678…\nAdd to the program: import debugpy;/);
      connect(1);
      expect(await started).toBe(1);
      expect(useDebug.getState().sessions[1]?.status).toBe("running");
      handleDebugEvent(1, { kind: "output", category: "stdout", output: "first\n" });

      handleDebugEvent(1, { kind: "terminated" });
      await vi.waitFor(() => expect(ipc.debugStart).toHaveBeenCalledTimes(2));
      expect(rerun).toHaveBeenCalledOnce();
      announce(2);
      const { sessions, console } = useDebug.getState();
      expect(Object.keys(sessions).map(Number)).toEqual([2]);
      expect(sessions[2]).toMatchObject({ status: "starting", runConfig: rc });
      const lines = console[2]?.map((l) => l.text) ?? [];
      expect(lines).toContain("first\n");
      // The previous output comes first, then what the new wait is for.
      expect(lines.at(-1)).toContain('debugpy.connect(("localhost", 5678))');
    } finally {
      dispose();
    }
  });

  it("does not listen again when a wait is cancelled", async () => {
    const rerun = vi.fn();
    const dispose = registerAction({ id: "run.debugConfig", title: "Debug", run: rerun });
    try {
      ipc.debugStart.mockImplementationOnce(
        async () => ({ status: "error", error: { kind: "cancelled", message: "cancelled" } }) as never,
      );
      const started = startSession(listen, { runConfig: rc });
      await vi.waitFor(() => expect(ipc.debugStart).toHaveBeenCalled());
      announce(1);
      expect(await started).toBeNull();
      handleDebugEvent(1, { kind: "terminated" });
      expect(rerun).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("stops listening when the user stops it", async () => {
    const rerun = vi.fn();
    const dispose = registerAction({ id: "run.debugConfig", title: "Debug", run: rerun });
    try {
      expect(await startSession(listen, { runConfig: rc })).toBe(1);
      await stopSession(1);
      handleDebugEvent(1, { kind: "terminated" });
      expect(useDebug.getState().sessions[1]?.status).toBe("terminated");
      expect(rerun).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
