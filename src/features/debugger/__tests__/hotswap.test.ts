import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => {
  const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ok,
    javaBuildWorkspace: vi.fn(() => ok("succeed" as string)),
    debugRedefineClasses: vi.fn(() =>
      ok({ changedClasses: ["com.x.A", "com.x.B"], errorMessage: null as string | null }),
    ),
  };
});

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const { ok: _ok, ...cmds } = ipc;
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...cmds } };
});

const notes = vi.hoisted(() => [] as Array<{ level: string; title: string; body?: unknown; actions?: unknown[] }>);
vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return {
    ...real,
    notifications: () => ({ notify: (n: (typeof notes)[number]) => void notes.push(n) }),
    maybeEditorService: () => ({ saveAll: async () => undefined }),
  };
});

import type { DebugCapabilities, DebugSessionId } from "@/platform/ipc";
import { getContext } from "@/platform/context";
import { hotSwapMessage, onHotCodeReplace, reloadChangedClasses } from "../hotswap";
import { publishContext, useDebug, type DebugSession } from "../state";

function session(id: number, hotCodeReplace: boolean): DebugSession {
  return {
    id: id as DebugSessionId,
    name: "App",
    adapter: hotCodeReplace ? "java-debug" : "debugpy",
    parent: null,
    launch: {
      name: "App",
      adapter: "java-debug",
      request: "launch",
      program: null,
      args: [],
      cwd: "/p/app",
      env: {},
      extraJson: null,
    },
    process: null,
    status: "running",
    stoppedThread: null,
    stopReason: null,
    stopDescription: null,
    threads: [],
    selectedThread: null,
    frames: [],
    selectedFrame: null,
    hits: 0,
    exitCode: null,
    caps: { hotCodeReplace } as DebugCapabilities,
  };
}

describe("HotSwap", () => {
  beforeEach(() => {
    notes.length = 0;
    ipc.javaBuildWorkspace.mockClear();
    ipc.debugRedefineClasses.mockClear();
    useDebug.setState({ sessions: { 1: session(1, true), 2: session(2, false) }, active: 1 });
    publishContext();
  });

  it("is enabled only with a session whose adapter can redefine classes", () => {
    expect(getContext().debugCanHotSwap).toBe(true);
    useDebug.setState({ sessions: { 2: session(2, false) }, active: 2 });
    publishContext();
    expect(getContext().debugCanHotSwap).toBe(false);
  });

  it("builds, reloads in Java sessions and reports the count", async () => {
    await reloadChangedClasses();
    expect(ipc.javaBuildWorkspace).toHaveBeenCalledWith("/p/app");
    expect(ipc.debugRedefineClasses).toHaveBeenCalledTimes(1);
    expect(ipc.debugRedefineClasses).toHaveBeenCalledWith(1);
    expect(notes.at(-1)).toMatchObject({ level: "info", title: "2 classes reloaded" });
  });

  it("limits a configuration update to that configuration's debug session", async () => {
    const one = { ...session(1, true), runConfig: { id: "tomcat:one" } as NonNullable<DebugSession["runConfig"]> };
    const two = { ...session(2, true), runConfig: { id: "tomcat:two" } as NonNullable<DebugSession["runConfig"]> };
    useDebug.setState({ sessions: { 1: one, 2: two } });
    await reloadChangedClasses(false, "tomcat:two");
    expect(ipc.javaBuildWorkspace).not.toHaveBeenCalled();
    expect(ipc.debugRedefineClasses).toHaveBeenCalledTimes(1);
    expect(ipc.debugRedefineClasses).toHaveBeenCalledWith(2);
  });

  it("does not reload after a failed build", async () => {
    ipc.javaBuildWorkspace.mockImplementationOnce(() => ipc.ok("failed"));
    await reloadChangedClasses();
    expect(ipc.debugRedefineClasses).not.toHaveBeenCalled();
    expect(notes.at(-1)).toMatchObject({ level: "error", title: "Hot Swap failed" });
  });

  it("words results like IDEA", () => {
    expect(hotSwapMessage(0, []).title).toBe("Loaded classes are up to date. Nothing to reload.");
    expect(hotSwapMessage(1, []).title).toBe("1 class reloaded");
    expect(hotSwapMessage(3, ["boom"])).toMatchObject({ level: "error", body: "boom" });
  });

  it("offers a reload when java-debug reports a finished build", () => {
    // Past the quiet period after the reloads above (their own builds raise no prompt).
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    onHotCodeReplace(1 as DebugSessionId, { kind: "hotCodeReplace", changeType: "BUILD_COMPLETE", message: "" });
    expect(notes.at(-1)).toMatchObject({ title: "Classes changed" });
    expect(notes.at(-1)!.actions).toHaveLength(1);
    onHotCodeReplace(1 as DebugSessionId, { kind: "hotCodeReplace", changeType: "ERROR", message: "schema change" });
    expect(notes.at(-1)).toMatchObject({ level: "error", body: "schema change" });
    const before = notes.length;
    onHotCodeReplace(99 as DebugSessionId, { kind: "hotCodeReplace", changeType: "ERROR", message: "not ours" });
    expect(notes.length).toBe(before);
  });
});
