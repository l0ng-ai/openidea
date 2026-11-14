import { beforeEach, describe, expect, it, vi } from "vitest";

const executeAction = vi.hoisted(() => vi.fn());
vi.mock("@/platform/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/actions")>()),
  executeAction,
}));

const ipc = vi.hoisted(() => {
  const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ok,
    cancelRequest: vi.fn((_request: number) => Promise.resolve()),
    javaBuildWorkspace: vi.fn((_module: string, _request?: number) => ok("succeeded" as string)),
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

const notes = vi.hoisted(
  () => [] as Array<{ level: string; title: string; body?: unknown; actions?: { label: string; run: () => void }[] }>,
);
vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return {
    ...real,
    notifications: () => ({ notify: (n: (typeof notes)[number]) => void notes.push(n) }),
    maybeEditorService: () => ({ saveAll: async () => undefined }),
  };
});

import { IpcError, type DebugCapabilities, type DebugSessionId } from "@/platform/ipc";
import { getContext } from "@/platform/context";
import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import {
  cancelHotSwapBuild,
  hotSwapMenuItems,
  hotSwapMessage,
  onHotCodeReplace,
  reloadChangedClasses,
} from "../hotswap";
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
    stops: 0,
    exitCode: null,
    caps: { hotCodeReplace } as DebugCapabilities,
  };
}

describe("HotSwap", () => {
  beforeEach(() => {
    notes.length = 0;
    executeAction.mockClear();
    ipc.cancelRequest.mockClear();
    ipc.javaBuildWorkspace.mockClear();
    ipc.debugRedefineClasses.mockReset();
    ipc.debugRedefineClasses.mockImplementation(() =>
      ipc.ok({ changedClasses: ["com.x.A", "com.x.B"], errorMessage: null }),
    );
    useDebug.setState({ sessions: { 1: session(1, true), 2: session(2, false) }, active: 1 });
    publishContext();
  });

  it("is enabled only with a session whose adapter can redefine classes", () => {
    expect(getContext().debugCanHotSwap).toBe(true);
    useDebug.setState({ sessions: { 2: session(2, false) }, active: 2 });
    publishContext();
    expect(getContext().debugCanHotSwap).toBe(false);
  });

  it("offers the reload in the editor menu of a Java file while a session can reload classes", () => {
    expect(hotSwapMenuItems(["/p/app/src/A.java"])).toEqual([{ kind: "action", action: "debug.reloadChangedClasses" }]);
    expect(hotSwapMenuItems(["/p/app/pom.xml"])).toEqual([]);
    useDebug.setState({ sessions: { 2: session(2, false) }, active: 2 });
    expect(hotSwapMenuItems(["/p/app/src/A.java"])).toEqual([]);
  });

  it("builds, reloads in Java sessions and reports the count", async () => {
    await reloadChangedClasses();
    expect(ipc.javaBuildWorkspace).toHaveBeenCalledWith("/p/app", expect.any(Number));
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

  it("does not reload after a cancelled build", async () => {
    ipc.javaBuildWorkspace.mockImplementationOnce(() => ipc.ok("cancelled"));
    await reloadChangedClasses();
    expect(ipc.debugRedefineClasses).not.toHaveBeenCalled();
    expect(notes.at(-1)).toMatchObject({ level: "info", title: "Hot Swap cancelled" });
  });

  it("treats a cancellation error as cancellation and requires a restart before reloading", async () => {
    ipc.javaBuildWorkspace.mockRejectedValueOnce(new IpcError({ kind: "cancelled", message: "cancelled" }));
    await reloadChangedClasses();
    expect(ipc.debugRedefineClasses).not.toHaveBeenCalled();
    expect(notes.at(-1)).toMatchObject({ level: "info", title: "Hot Swap cancelled" });
    expect(getContext().debugHotSwapBuilding).toBe(false);
    cancelHotSwapBuild();
    expect(ipc.cancelRequest).not.toHaveBeenCalled();
    await reloadChangedClasses();
    expect(ipc.debugRedefineClasses).not.toHaveBeenCalled();
    expect(notes.at(-1)).toMatchObject({
      level: "error",
      title: "Hot Swap failed",
      body: expect.stringContaining("Restart"),
    });
    useDebug.setState({ sessions: { 1: session(1, true) } });
    await reloadChangedClasses();
    expect(ipc.debugRedefineClasses).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("keeps the first request when reloads overlap and stops at the cancelled module", async () => {
    const two = session(3, true);
    two.launch = { ...two.launch!, cwd: "/p/other" };
    useDebug.setState({ sessions: { 1: session(1, true), 3: two } });
    let finish!: (result: { status: "ok"; data: string }) => void;
    ipc.javaBuildWorkspace.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pending = reloadChangedClasses();
    await vi.waitFor(() => expect(ipc.javaBuildWorkspace).toHaveBeenCalledTimes(1));
    const request = ipc.javaBuildWorkspace.mock.calls[0]![1];
    expect(getContext().debugHotSwapBuilding).toBe(true);
    expect(notes.at(-1)).toMatchObject({ title: "Compiling changed classes…", actions: [expect.any(Object)] });
    await reloadChangedClasses();
    await reloadChangedClasses(false);
    expect(ipc.javaBuildWorkspace).toHaveBeenCalledTimes(1);
    cancelHotSwapBuild();
    cancelHotSwapBuild();
    expect(ipc.cancelRequest).toHaveBeenCalledExactlyOnceWith(request);
    // A success response racing the cancel must not reload partially compiled classes.
    finish({ status: "ok", data: "succeeded" });
    await pending;
    expect(ipc.javaBuildWorkspace).toHaveBeenCalledTimes(1);
    expect(ipc.debugRedefineClasses).not.toHaveBeenCalled();
    expect(notes.at(-1)).toMatchObject({ level: "info", title: "Hot Swap cancelled" });
    expect(getContext().debugHotSwapBuilding).toBe(false);
    cancelHotSwapBuild();
    expect(ipc.cancelRequest).toHaveBeenCalledTimes(1);
    await reloadChangedClasses();
    expect(ipc.javaBuildWorkspace).toHaveBeenCalledTimes(3);
    expect(ipc.debugRedefineClasses).not.toHaveBeenCalled();
    expect(useDebug.getState().sessions[3]?.hotSwapNeedsRestart).toBe(true);
  });

  it("does not report a partial reload after edit, cancel, edit, cancel, reload", async () => {
    // The cancelled builds wrote OrderBook.class, but the next build only reports OrderBookTest.
    ipc.javaBuildWorkspace.mockResolvedValueOnce({ status: "ok", data: "cancelled" });
    await reloadChangedClasses();
    ipc.javaBuildWorkspace.mockResolvedValueOnce({ status: "ok", data: "cancelled" });
    await reloadChangedClasses();
    ipc.debugRedefineClasses.mockResolvedValueOnce({
      status: "ok",
      data: { changedClasses: ["com.example.orders.OrderBookTest"], errorMessage: null },
    });
    await reloadChangedClasses();
    await reloadChangedClasses(false);
    expect(ipc.javaBuildWorkspace).toHaveBeenCalledTimes(3);
    expect(ipc.debugRedefineClasses).not.toHaveBeenCalled();
    expect(notes.slice(-2)).toEqual([
      expect.objectContaining({ level: "error", title: "Hot Swap failed", body: expect.stringContaining("Restart") }),
      expect.objectContaining({ level: "error", title: "Hot Swap failed", body: expect.stringContaining("Restart") }),
    ]);
  });

  it("invalidates all live Java sessions when a configuration's workspace build is cancelled", async () => {
    const one = { ...session(1, true), runConfig: { id: "one" } as NonNullable<DebugSession["runConfig"]> };
    const two = { ...session(3, true), runConfig: { id: "two" } as NonNullable<DebugSession["runConfig"]> };
    useDebug.setState({ sessions: { 1: one, 2: session(2, false), 3: two } });
    ipc.javaBuildWorkspace.mockResolvedValueOnce({ status: "ok", data: "cancelled" });
    await reloadChangedClasses(true, "one");
    await reloadChangedClasses(false, "two");
    expect(ipc.debugRedefineClasses).not.toHaveBeenCalled();
    expect(useDebug.getState().sessions[2]?.hotSwapNeedsRestart).toBeUndefined();
    useDebug.setState((state) => ({ sessions: { ...state.sessions, 4: session(4, true) } }));
    await reloadChangedClasses(false);
    expect(ipc.debugRedefineClasses).not.toHaveBeenCalled();
    useDebug.setState({ sessions: { 4: session(4, true) } });
    await reloadChangedClasses(false);
    expect(ipc.debugRedefineClasses).toHaveBeenCalledExactlyOnceWith(4);
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
    expect(hotSwapMessage(3, []).title).toBe("3 classes reloaded");
    expect(hotSwapMessage(3, ["boom"])).toMatchObject({ level: "error", body: "boom" });
  });

  it.each([0, 1, 3])("reports obsolete methods as a reload warning even with %s returned classes", (changed) => {
    expect(hotSwapMessage(changed, ["JVM contains obsolete methods"])).toMatchObject({
      level: "warning",
      title: "Classes reloaded",
      body: expect.stringContaining("Active frames keep running the old code"),
    });
    expect(hotSwapMessage(changed, ["JVM contains obsolete methods"], true).body).toContain(
      "bottom frame cannot be reset",
    );
  });

  it.each([
    "Failed to redefine classes: add method not implemented",
    "Failed to redefine classes: schema change not implemented",
    "Failed to redefine classes: JVM contains obsolete methods",
  ])("keeps a real failure even alongside obsolete methods: %s", (failure) => {
    for (const errors of [[failure], ["JVM contains obsolete methods", failure]]) {
      expect(hotSwapMessage(1, errors)).toMatchObject({ level: "error", title: "Hot Swap failed" });
    }
  });

  function pausedFrames(names: string[], restartFrame = true): DebugSession {
    return {
      ...session(1, true),
      status: "paused",
      caps: { hotCodeReplace: true, restartFrame } as DebugCapabilities,
      selectedThread: 1,
      selectedFrame: 11,
      frames: names.map((name, i) => ({
        id: 11 + i,
        name,
        path: "/p/App.java",
        line: 11,
        column: 0,
        presentationHint: null,
      })),
    };
  }

  it.each([
    [true, ["App.main(String[])"], false],
    [false, ["OrderBook.place()", "App.main(String[])"], false],
    [true, ["OrderBook.place()", "Native.call()[native method]"], false],
    [true, ["Native.call()[native method]", "App.main(String[])"], false],
    [true, ["OrderBook.place()", "App.main(String[])"], true],
  ])("offers Reset Frame only when supported and droppable (%s, %j)", async (supported, names, offered) => {
    useDebug.setState({ sessions: { 1: pausedFrames(names, supported) } });
    ipc.debugRedefineClasses.mockImplementationOnce(() =>
      ipc.ok({ changedClasses: [], errorMessage: "JVM contains obsolete methods" }),
    );
    await reloadChangedClasses(false);
    const note = notes.at(-1)!;
    expect(note).toMatchObject({ level: "warning", title: "Classes reloaded" });
    expect(note.actions).toHaveLength(offered ? 1 : 0);
    if (offered) {
      useDebug.setState({ active: 2 });
      note.actions![0]!.run();
      expect(executeAction).toHaveBeenCalledWith("debug.resetFrame");
      expect(useDebug.getState().active).toBe(1);
      expect(useDebug.getState().sessions[1]?.selectedFrame).toBe(11);
    }
  });

  it("does not reset a stale frame from an earlier suspension", async () => {
    const s = pausedFrames(["OrderBook.place()", "App.main(String[])"]);
    useDebug.setState({ sessions: { 1: s } });
    ipc.debugRedefineClasses.mockImplementationOnce(() =>
      ipc.ok({ changedClasses: [], errorMessage: "JVM contains obsolete methods" }),
    );
    await reloadChangedClasses(false);
    useDebug.setState({ sessions: { 1: { ...s, frames: [...s.frames] } } });
    notes.at(-1)!.actions![0]!.run();
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("maps java-debug's obsolete-method ERROR event to the same warning", () => {
    useDebug.setState({ sessions: { 1: pausedFrames(["App.main(String[])"]) } });
    onHotCodeReplace(1 as DebugSessionId, {
      kind: "hotCodeReplace",
      changeType: "ERROR",
      message: "JVM contains obsolete methods",
    });
    expect(notes.at(-1)).toMatchObject({
      level: "warning",
      title: "Classes reloaded",
      body: expect.stringContaining("bottom frame cannot be reset"),
      actions: [],
    });
  });

  it("does not let the obsolete-method event replace the response's real failure", async () => {
    ipc.debugRedefineClasses.mockImplementationOnce(async () => {
      onHotCodeReplace(1 as DebugSessionId, {
        kind: "hotCodeReplace",
        changeType: "ERROR",
        message: "JVM contains obsolete methods",
      });
      return ipc.ok({ changedClasses: [], errorMessage: "Failed to redefine classes: add method not implemented" });
    });
    await reloadChangedClasses(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ level: "error", title: "Hot Swap failed" });
  });

  it("translates the reload count with the sentence", async () => {
    await setLocale("zh");
    try {
      expect(hotSwapMessage(3, []).title).toBe("已重新加载 3 个类");
    } finally {
      _resetI18nForTests();
    }
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
