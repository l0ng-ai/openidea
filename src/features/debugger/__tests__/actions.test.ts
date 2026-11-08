import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const ipc = vi.hoisted(() => {
  const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
  return {
    ok,
    debugStep: vi.fn(() => ok(null)),
    debugResume: vi.fn(() => ok(null)),
    debugForceStepOver: vi.fn(() => ok(null)),
    debugRunTo: vi.fn(() => ok(null)),
    debugStepInTargets: vi.fn(() => ok([] as Array<{ id: number; label: string }>)),
    debugStepInTarget: vi.fn(() => ok(null)),
    debugRestartFrame: vi.fn(() => ok(null)),
    debugAttachableProcesses: vi.fn(() =>
      ok([
        { pid: 9, name: "node", commandLine: "node a.js", kind: "node", adapter: "js-debug", host: null, port: null },
      ]),
    ),
    debugStackTrace: vi.fn(() => ok([])),
    debugThreads: vi.fn(() => ok([])),
    debugJvmMemoryClasses: vi.fn(() => ok({ status: "unavailable", reason: { kind: "programExited" } })),
    debugJvmMemoryInstances: vi.fn(() => ok({ status: "ready", generation: 1, instances: [], truncated: false })),
    debugJvmMemoryFields: vi.fn(() => ok({ status: "ready", fields: [] })),
    debugJvmMemoryReferrers: vi.fn(() => ok({ status: "ready", referrers: [], truncated: false })),
    lspWorkspaceSymbols: vi.fn(() =>
      ok([
        {
          name: "Order",
          kind: "class",
          container: "com.x",
          location: { path: "/p/com/x/Order.java", range: { start: { line: 2, col: 13 }, end: { line: 2, col: 18 } } },
        },
      ]),
    ),
    debugScopes: vi.fn(() => ok([])),
    debugStart: vi.fn((_launch: { extraJson: string | null }) => ok(42)),
    debugSetBreakpoints: vi.fn(() => ok([])),
    debugBreakpointStates: vi.fn(() => ok([])),
    sdkPhpEffective: vi.fn(() => ok<string | null>("/opt/php81/bin/php")),
    sdkLocateTools: vi.fn((_names: string[], _near: string | null) =>
      ok({ tools: [{ name: "php", path: "/usr/bin/php" }], compileDir: "/tmp" }),
    ),
    sdkPhpXdebug: vi.fn((php: string, _cwd: string | null) =>
      ok({ php, phpVersion: "8.1.33", xdebug: null as string | null }),
    ),
  };
});

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const { ok: _ok, ...cmds } = ipc;
  return { ...real, commands: { ...real.commands, ...cmds } };
});

const editor = vi.hoisted(() => ({
  current: null as null | { ctx: { path: string; language: string }; view: { state: unknown } },
}));
vi.mock("@/editor/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/editor/api")>();
  return { ...real, activeEditor: () => editor.current };
});

const opened = vi.hoisted(() => [] as Array<{ path: string; focus: boolean | undefined }>);
vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return {
    ...real,
    maybeEditorService: () => ({
      openFile: async (path: string, o?: { focus?: boolean }) => void opened.push({ path, focus: o?.focus }),
      saveAll: async () => undefined,
    }),
  };
});

import { executeAction, getAction, isActionEnabled, registerActions } from "@/platform/actions";
import { clearContext, setContext } from "@/platform/context";
import { intellijMacos } from "@/platform/keymaps/intellij-macos";
import type { DebugCapabilities, RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { provideNotificationService } from "@/workbench/contributions";
import { registerDebugActions } from "../actions";
import { breakpointsOf, loadBreakpoints, toggleBreakpoint } from "../breakpoints/store";
import { loadSpecialBreakpoints, removeAllSpecial, useSpecialBreakpoints } from "../breakpoints/special";
import { publishContext, updateExecutionPoint, useExecutionPoint, useDebug, type DebugSession } from "../state";
import { focusDebugView, blurDebugView } from "../ui/focusedView";
import { useOverlays } from "../ui/popoverStore";
import { forgetMemory, selectMemoryClass } from "../memory/memoryState";
import { forgetInstances, setInstancesLead, showInstances, useInstances } from "../memory/instancesState";
import { InstancesPane } from "../memory/InstancesPane";

const caps = (p: Partial<DebugCapabilities> = {}): DebugCapabilities => ({
  restartFrame: false,
  stepInTargets: false,
  functionBreakpoints: false,
  dataBreakpoints: false,
  hotCodeReplace: false,
  setValue: true,
  conditionalBreakpoints: true,
  hitConditionalBreakpoints: true,
  logPoints: true,
  jvmMemory: false,
  jvmInstances: false,
  jvmHeap: false,
  ...p,
});

function paused(p: Partial<DebugSession> = {}) {
  const s: DebugSession = {
    id: 3,
    name: "app",
    adapter: "debugpy",
    parent: null,
    launch: null,
    process: null,
    status: "paused",
    stoppedThread: 1,
    stopReason: "breakpoint",
    stopDescription: null,
    threads: [{ id: 1, name: "main" }],
    selectedThread: 1,
    frames: [
      { id: 70, name: "parse", path: "/p/app.py", line: 2, column: 4, presentationHint: null },
      { id: 71, name: "run", path: "/p/app.py", line: 9, column: 0, presentationHint: null },
    ],
    selectedFrame: 71,
    hits: 1,
    stops: 0,
    exitCode: null,
    caps: caps(),
    ...p,
  };
  useDebug.setState({ sessions: { 3: s }, active: 3 });
  publishContext();
  updateExecutionPoint();
}

function caret(path: string, language: string, doc: string, line: number) {
  const state = EditorState.create({ doc });
  const pos = state.doc.line(line + 1).from;
  editor.current = {
    ctx: { path, language },
    view: { state: EditorState.create({ doc, selection: { anchor: pos } }) },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

let dispose: () => void;
beforeAll(() => {
  dispose = registerDebugActions();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterAll(() => {
  dispose();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
beforeEach(() => {
  vi.clearAllMocks();
  opened.length = 0;
  localStorage.clear();
  loadBreakpoints("/p");
  loadSpecialBreakpoints("/p");
  removeAllSpecial();
  useOverlays.setState({ smartStep: null, attach: null });
});

describe("debugger actions (IDEA parity)", () => {
  it("registers stable ids with IDEA's macOS shortcuts", () => {
    const expected: Record<string, string[] | undefined> = {
      "debug.attachToProcess": ["Alt+Shift+F5"],
      "debug.toggleTemporaryBreakpoint": ["Meta+Alt+Shift+F8"],
      "debug.forceStepOver": ["Alt+Shift+F8"],
      "debug.forceStepInto": ["Alt+Shift+F7"],
      "debug.smartStepInto": ["Shift+F7"],
      "debug.forceRunToCursor": ["Meta+Alt+F9"],
      "debug.showExecutionPoint": ["Alt+F10"],
      "debug.setValue": ["F2"],
      "debug.jumpToSource": ["F4", "Meta+Down"],
      "debug.resetFrame": undefined,
      "debug.memory.refresh": undefined,
      "debug.memory.showInstances": undefined,
      "debug.memory.jumpToSource": undefined,
      "debug.memory.showReferrers": undefined,
      "debug.memory.closeInstances": undefined,
      "debug.toggleMethodBreakpoint": undefined,
      "debug.toggleFieldWatchpoint": undefined,
    };
    for (const [id, keys] of Object.entries(expected)) {
      expect(getAction(id), id).toBeTruthy();
      expect(intellijMacos[id], id).toEqual(keys);
    }
    // F2 / F4 only act inside the debugger views, so the editor keeps its own.
    expect(getAction("debug.setValue")!.keyWhen).toBe("debugVariablesFocus");
    expect(getAction("debug.jumpToSource")!.keyWhen).toBe("debugFramesFocus || debugVariablesFocus");
  });

  it.each([
    ["debug.resume", "debugResume"],
    ["debug.stepOver", "debugStep"],
    ["debug.stepInto", "debugStep"],
    ["debug.stepOut", "debugStep"],
    ["debug.forceStepOver", "debugForceStepOver"],
    ["debug.forceStepInto", "debugStep"],
    ["debug.smartStepInto", "debugStep"],
    ["debug.runToCursor", "debugRunTo"],
    ["debug.forceRunToCursor", "debugRunTo"],
    ["debug.resetFrame", "debugRestartFrame"],
  ] as const)("%s clears the old execution point before its request", async (id, command) => {
    paused({ caps: caps({ restartFrame: true }) });
    caret("/p/app.py", "python", "a\nb\nc", 2);
    const request = ipc[command].mockImplementationOnce(() => {
      expect(useExecutionPoint.getState().path).toBeNull();
      expect(useDebug.getState().sessions[3]?.status).toBe("running");
      return ipc.ok(null);
    });
    await executeAction(id);
    expect(request).toHaveBeenCalledOnce();
  });

  it("Force Step Over / Force Step Into / Force Run to Cursor", async () => {
    paused();
    caret("/p/app.py", "python", "a\nb\nc\nd", 2);
    await executeAction("debug.forceStepOver");
    expect(ipc.debugForceStepOver).toHaveBeenCalledWith(3, 1);
    paused();
    await executeAction("debug.forceStepInto");
    expect(ipc.debugStep).toHaveBeenCalledWith(3, 1, "into");
    paused();
    await executeAction("debug.forceRunToCursor");
    expect(ipc.debugRunTo).toHaveBeenCalledWith(3, 1, "/p/app.py", 2, true);
    paused();
    await executeAction("debug.runToCursor");
    expect(ipc.debugRunTo).toHaveBeenLastCalledWith(3, 1, "/p/app.py", 2, false);
  });

  it("Smart Step Into: chooser for several calls, direct step for one, Step Into without support", async () => {
    paused({ caps: caps({ stepInTargets: true }) });
    ipc.debugStepInTargets.mockReturnValueOnce(
      ipc.ok([
        { id: 1, label: "str(i)" },
        { id: 2, label: "parse(str(i))" },
      ]),
    );
    await executeAction("debug.smartStepInto");
    await settle();
    expect(ipc.debugStepInTargets).toHaveBeenCalledWith(3, 71);
    expect(useOverlays.getState().smartStep?.targets.map((t) => t.label)).toEqual(["str(i)", "parse(str(i))"]);

    paused({ caps: caps({ stepInTargets: true }) });
    ipc.debugStepInTargets.mockReturnValueOnce(ipc.ok([{ id: 5, label: "parse()" }]));
    await executeAction("debug.smartStepInto");
    await settle();
    expect(ipc.debugStepInTarget).toHaveBeenCalledWith(3, 1, 5);

    paused({ caps: caps({ stepInTargets: false }) });
    await executeAction("debug.smartStepInto");
    await settle();
    expect(ipc.debugStep).toHaveBeenCalledWith(3, 1, "into");
  });

  it("Reset Frame restarts the selected frame when the adapter can", async () => {
    paused({ caps: caps({ restartFrame: false }) });
    await executeAction("debug.resetFrame");
    expect(ipc.debugRestartFrame).not.toHaveBeenCalled();
    paused({ caps: caps({ restartFrame: true }) });
    await executeAction("debug.resetFrame");
    expect(ipc.debugRestartFrame).toHaveBeenCalledWith(3, 71);
  });

  it("Refresh Memory View reads the class table of a session that supports it", async () => {
    const result = { status: "unavailable", reason: { kind: "programExited" } };
    ipc.debugJvmMemoryClasses.mockReturnValue(ipc.ok(result) as never);
    paused({ caps: caps({ jvmMemory: false }) });
    await executeAction("debug.memory.refresh");
    expect(ipc.debugJvmMemoryClasses).not.toHaveBeenCalled();
    paused({ caps: caps({ jvmMemory: true }) });
    await executeAction("debug.memory.refresh");
    await settle();
    expect(ipc.debugJvmMemoryClasses).toHaveBeenCalledWith(3);
  });

  it("Show Instances lists the selected Memory row of a paused session that can list instances", async () => {
    expect(getAction("debug.memory.showInstances")!.when).toBe("debugSessionPaused");
    selectMemoryClass(3, "com.x.Order");
    paused({ caps: caps({ jvmMemory: true, jvmInstances: false }) });
    await executeAction("debug.memory.showInstances");
    expect(ipc.debugJvmMemoryInstances).not.toHaveBeenCalled();
    paused({ caps: caps({ jvmMemory: true, jvmInstances: true }) });
    await executeAction("debug.memory.showInstances");
    expect(ipc.debugJvmMemoryInstances).toHaveBeenCalledWith(3, "com.x.Order", 1000);
    await executeAction("debug.memory.showInstances", "com.x.Line");
    expect(ipc.debugJvmMemoryInstances).toHaveBeenLastCalledWith(3, "com.x.Line", 1000);
    forgetInstances(3);
    forgetMemory(3);
  });

  it("Show Referrers runs for the lead row of the open instances list", async () => {
    paused({ caps: caps({ jvmMemory: true, jvmInstances: true }) });
    await executeAction("debug.memory.showReferrers");
    expect(ipc.debugJvmMemoryReferrers).not.toHaveBeenCalled();
    ipc.debugJvmMemoryInstances.mockReturnValueOnce(
      ipc.ok({
        status: "ready",
        generation: 4,
        instances: [{ kind: "object", id: 9, typeName: "com.x.Order" }],
        truncated: false,
      }) as never,
    );
    await showInstances(3, "com.x.Order");
    // No lead row yet.
    await executeAction("debug.memory.showReferrers");
    expect(ipc.debugJvmMemoryReferrers).not.toHaveBeenCalled();
    setInstancesLead(3, { key: "#0", ref: { generation: 4, id: 9 } });
    await executeAction("debug.memory.showReferrers");
    await settle();
    expect(ipc.debugJvmMemoryReferrers).toHaveBeenCalledWith(3, { generation: 4, id: 9 }, 50);
    expect(useInstances.getState().bySession[3]!.expanded).toEqual(["#0", "#0/referrers"]);
    // Objects from before the last stop cannot be read.
    ipc.debugJvmMemoryReferrers.mockClear();
    paused({ stops: 1, caps: caps({ jvmMemory: true, jvmInstances: true }) });
    await executeAction("debug.memory.showReferrers");
    expect(ipc.debugJvmMemoryReferrers).not.toHaveBeenCalled();
    forgetInstances(3);
  });

  it("Close Instances closes the open instances list", async () => {
    paused({ caps: caps({ jvmMemory: true, jvmInstances: true }) });
    await executeAction("debug.memory.closeInstances");
    await showInstances(3, "com.x.Order");
    expect(useInstances.getState().bySession[3]).toBeTruthy();
    await executeAction("debug.memory.closeInstances");
    expect(useInstances.getState().bySession[3]).toBeUndefined();
  });

  it("closes the instances pane of a session that has ended, from its button or the action", async () => {
    const jvm = caps({ jvmMemory: true, jvmInstances: true });
    ipc.debugJvmMemoryInstances.mockReturnValueOnce(
      ipc.ok({
        status: "ready",
        generation: 1,
        instances: [{ kind: "object", id: 9, typeName: "com.x.Order" }],
        truncated: false,
      }) as never,
    );
    paused({ caps: jvm });
    await showInstances(3, "com.x.Order");
    paused({ status: "terminated", caps: jvm });
    const session = useDebug.getState().sessions[3]!;
    render(createElement(InstancesPane, { session }));
    // Reading objects needs a paused program: both instance actions are off, the row button too.
    setInstancesLead(3, { key: "#0", ref: { generation: 1, id: 9 } });
    expect(await executeAction("debug.memory.showReferrers")).toBe(false);
    expect(await executeAction("debug.memory.showInstances", "com.x.Order")).toBe(false);
    expect(ipc.debugJvmMemoryReferrers).not.toHaveBeenCalled();
    expect(ipc.debugJvmMemoryInstances).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Show Referrers" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close Instances" }));
    await settle();
    expect(useInstances.getState().bySession[3]).toBeUndefined();
    expect(screen.queryByRole("tree")).toBeNull();

    await showInstances(3, "com.x.Order");
    expect(await executeAction("debug.memory.closeInstances")).toBe(true);
    expect(useInstances.getState().bySession[3]).toBeUndefined();
    cleanup();
  });

  it("Jump to Source opens the class of the open instances list", async () => {
    paused({ caps: caps({ jvmMemory: true, jvmInstances: true }) });
    setContext("projectOpen", true);
    await showInstances(3, "com.x.Order$Line");
    await executeAction("debug.memory.jumpToSource");
    await settle();
    expect(ipc.lspWorkspaceSymbols).toHaveBeenCalledWith(expect.anything(), "Order");
    expect(opened.at(-1)?.path).toBe("/p/com/x/Order.java");
    clearContext("projectOpen");
    forgetInstances(3);
  });

  it("Jump to Source still opens the class once the session has ended", async () => {
    paused({ caps: caps({ jvmMemory: true, jvmInstances: true }) });
    await showInstances(3, "com.x.Order$Line");
    paused({ status: "terminated", caps: caps({ jvmMemory: true, jvmInstances: true }) });
    setContext("projectOpen", true);
    expect(await executeAction("debug.memory.jumpToSource")).toBe(true);
    await settle();
    expect(opened.at(-1)?.path).toBe("/p/com/x/Order.java");
    clearContext("projectOpen");
    forgetInstances(3);
  });

  it("offers Refresh Memory View only for a live session of a JVM", () => {
    const refresh = getAction("debug.memory.refresh")!;
    expect(refresh.when).toBe("debugHasJvmMemory");
    paused({ adapter: "debugpy", caps: caps({ jvmMemory: false }) });
    expect(isActionEnabled(refresh)).toBe(false);
    paused({ caps: caps({ jvmMemory: true }) });
    expect(isActionEnabled(refresh)).toBe(true);
    paused({ status: "terminated", caps: caps({ jvmMemory: true }) });
    expect(isActionEnabled(refresh)).toBe(false);
  });

  it("Show Execution Point reveals the top frame with focus", async () => {
    paused();
    await executeAction("debug.showExecutionPoint");
    await settle();
    expect(useDebug.getState().sessions[3]!.selectedFrame).toBe(70);
    expect(opened.at(-1)).toEqual({ path: "/p/app.py", focus: true });
  });

  it("Jump to Source and Set Value go to the focused debugger view", async () => {
    paused();
    const setValue = vi.fn();
    const jump = vi.fn();
    focusDebugView({ view: "variables", setValue, jumpToSource: jump });
    await executeAction("debug.setValue");
    await executeAction("debug.jumpToSource");
    expect(setValue).toHaveBeenCalledOnce();
    expect(jump).toHaveBeenCalledOnce();
    blurDebugView("variables");
    // No view focused: the selected frame's source.
    await executeAction("debug.jumpToSource");
    await settle();
    expect(opened.at(-1)).toEqual({ path: "/p/app.py", focus: true });
  });

  it("puts no new breakpoint on a blank line", async () => {
    for (const action of ["debug.toggleBreakpoint", "debug.toggleTemporaryBreakpoint"]) {
      for (const line of [1, 2]) {
        caret("/p/a.py", "python", "x = 1\n\n   \ny = 2", line);
        await executeAction(action);
      }
      expect(breakpointsOf("/p/a.py"), action).toHaveLength(0);
    }
    // One placed before the line went blank can still be toggled off.
    toggleBreakpoint("/p/a.py", 1);
    caret("/p/a.py", "python", "x = 1\n\n   \ny = 2", 1);
    await executeAction("debug.toggleBreakpoint");
    expect(breakpointsOf("/p/a.py")).toHaveLength(0);
  });

  it("toggles temporary, method and field breakpoints at the caret", async () => {
    caret("/p/a.py", "python", "x = 1\ndef run():\n  pass", 0);
    await executeAction("debug.toggleTemporaryBreakpoint");
    expect(breakpointsOf("/p/a.py")[0]).toMatchObject({ line: 0, temporary: true });

    caret("/p/a.py", "python", "x = 1\ndef run():\n  pass", 1);
    await executeAction("debug.toggleMethodBreakpoint");
    expect(useSpecialBreakpoints.getState().methods).toMatchObject([{ name: "run", path: "/p/a.py", line: 1 }]);
    await executeAction("debug.toggleMethodBreakpoint");
    expect(useSpecialBreakpoints.getState().methods).toEqual([]);

    const java = "package a;\nclass A {\n  private int count;\n}";
    caret("/p/A.java", "java", java, 2);
    await executeAction("debug.toggleFieldWatchpoint");
    expect(useSpecialBreakpoints.getState().fields).toMatchObject([{ dataId: "a.A#count", accessType: "write" }]);
    // ⌘F8 on a Java declaration toggles the watchpoint off again.
    await executeAction("debug.toggleBreakpoint");
    expect(useSpecialBreakpoints.getState().fields).toEqual([]);
  });

  it("Attach to Process opens the popup and loads the process list", async () => {
    await executeAction("debug.attachToProcess");
    await settle();
    expect(ipc.debugAttachableProcesses).toHaveBeenCalled();
    expect(useOverlays.getState().attach?.processes?.map((p) => p.pid)).toEqual([9]);
  });

  it("Evaluate prefills the expression at the caret, or the whole selection", async () => {
    paused();
    const doc = "total = order.items\nfor i in x:\n  pass";
    editor.current = {
      ctx: { path: "/p/a.py", language: "python" },
      view: { state: EditorState.create({ doc, selection: { anchor: doc.indexOf("items") + 2 } }) },
    };
    await executeAction("debug.evaluate");
    expect(useOverlays.getState().evaluate?.expression).toBe("order.items");
    editor.current = {
      ctx: { path: "/p/a.py", language: "python" },
      view: { state: EditorState.create({ doc, selection: { anchor: 0, head: doc.indexOf("\n  pass") } }) },
    };
    await executeAction("debug.evaluate");
    expect(useOverlays.getState().evaluate?.expression).toBe("total = order.items\nfor i in x:");
  });
});

describe("PHP debugging without Xdebug", () => {
  const php: RunConfig = {
    id: "php:index",
    name: "index.php",
    kind: "php",
    command: "php",
    args: ["index.php"],
    cwd: null,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: "php-debug",
  };
  const notify = vi.fn();
  const settings = vi.fn();
  let unregister: () => void;
  beforeEach(() => {
    useProject.setState({ project: { root: "/p" } as never });
    provideNotificationService({ notify });
    unregister = registerActions([{ id: "file.settings", title: "Settings", run: ({ arg }) => settings(arg) }]);
  });
  afterEach(() => {
    unregister();
    useProject.setState({ project: null });
  });
  const runtime = () => JSON.parse(ipc.debugStart.mock.calls[0]![0].extraJson!).runtimeExecutable;

  it("warns that breakpoints are skipped and still starts the session", async () => {
    await executeAction("debug.startConfig", php);
    // In the session's folder, where a version manager's shim picks the PHP.
    expect(ipc.sdkPhpXdebug).toHaveBeenCalledWith("/opt/php81/bin/php", "/p");
    expect(ipc.debugStart).toHaveBeenCalledOnce();
    expect(runtime()).toBe("/opt/php81/bin/php");
    expect(notify).toHaveBeenCalledOnce();
    const n = notify.mock.calls[0]![0];
    expect(n).toMatchObject({ group: "run", level: "warning", key: "debug.phpXdebug" });
    expect(n.title).toBe("Xdebug is not loaded in PHP 8.1.33");
    expect(n.body).toContain("/opt/php81/bin/php");
    expect(n.body).toContain("Xdebug 3");
    expect(n.actions.map((a: { label: string }) => a.label)).toEqual(["Open PHP Settings"]);
    n.actions[0].run();
    expect(settings).toHaveBeenCalledWith("languages.php");
  });

  it("does not warn when the PHP loads Xdebug or the check fails", async () => {
    ipc.sdkPhpXdebug.mockImplementationOnce((p: string) => ipc.ok({ php: p, phpVersion: "8.3.14", xdebug: "3.4.7" }));
    await executeAction("debug.startConfig", php);
    ipc.sdkPhpXdebug.mockImplementationOnce(
      () =>
        Promise.resolve({
          status: "error",
          error: { kind: "unavailable", message: "cannot run", data: null },
        }) as never,
    );
    await executeAction("debug.startConfig", php);
    expect(ipc.sdkPhpXdebug).toHaveBeenCalledTimes(2);
    expect(ipc.debugStart).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("checks the php on the search path for the Default interpreter", async () => {
    ipc.sdkPhpEffective.mockImplementationOnce(() => ipc.ok(null));
    await executeAction("debug.startConfig", php);
    expect(ipc.sdkLocateTools).toHaveBeenCalledWith(["php"], null);
    expect(ipc.sdkPhpXdebug).toHaveBeenCalledWith("/usr/bin/php", "/p");
    expect(runtime()).toBeUndefined();
    expect(notify.mock.calls[0]![0].body).toContain("/usr/bin/php");
  });

  it("checks the PHP the command names, in the configuration's working directory", async () => {
    await executeAction("debug.startConfig", { ...php, command: "/opt/php83/bin/php", cwd: "web" });
    expect(ipc.sdkPhpXdebug).toHaveBeenCalledWith("/opt/php83/bin/php", "/p/web");
    expect(ipc.sdkLocateTools).not.toHaveBeenCalled();
  });
});

describe("output class breakpoint restrictions", () => {
  it.each([
    "debug.toggleBreakpoint",
    "debug.toggleTemporaryBreakpoint",
    "debug.toggleMethodBreakpoint",
    "debug.toggleFieldWatchpoint",
    "debug.runToCursor",
    "debug.forceRunToCursor",
  ])("blocks %s for a source-less output class", async (id) => {
    paused();
    const path = "file:///p/target/classes/p/C.class";
    caret(path, "java", "class C {\n int n;\n void run() {}\n}", 2);
    await executeAction(id);
    expect(breakpointsOf(path)).toHaveLength(0);
    expect(useSpecialBreakpoints.getState().methods).toHaveLength(0);
    expect(useSpecialBreakpoints.getState().fields).toHaveLength(0);
    expect(ipc.debugRunTo).not.toHaveBeenCalled();
  });
});
