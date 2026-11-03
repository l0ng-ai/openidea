import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";

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
    debugScopes: vi.fn(() => ok([])),
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

import { executeAction, getAction } from "@/platform/actions";
import { intellijMacos } from "@/platform/keymaps/intellij-macos";
import type { DebugCapabilities } from "@/platform/ipc";
import { registerDebugActions } from "../actions";
import { breakpointsOf, loadBreakpoints } from "../breakpoints/store";
import { loadSpecialBreakpoints, removeAllSpecial, useSpecialBreakpoints } from "../breakpoints/special";
import { publishContext, updateExecutionPoint, useExecutionPoint, useDebug, type DebugSession } from "../state";
import { focusDebugView, blurDebugView } from "../ui/focusedView";
import { useOverlays } from "../ui/popoverStore";

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
