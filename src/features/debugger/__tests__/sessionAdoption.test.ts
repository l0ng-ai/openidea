import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { handleDebugEvent, resetSessions, startSession, useDebug } from "../state";

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
