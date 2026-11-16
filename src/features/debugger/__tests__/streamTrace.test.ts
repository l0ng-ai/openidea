import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (p: unknown) => void = () => {};
  },
}));

const ipc = vi.hoisted(() => ({
  debugStreamChains: vi.fn(),
  debugStreamTrace: vi.fn(),
  debugStreamTraceAbort: vi.fn(),
  cancelRequest: vi.fn(() => Promise.resolve()),
  debugStackTrace: vi.fn(),
  debugThreads: vi.fn(),
  debugScopes: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, ...ipc } };
});

const tab = vi.hoisted(() => ({ openStreamTraceTab: vi.fn() }));
vi.mock("../streams/streamTraceInput", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../streams/streamTraceInput")>()),
  ...tab,
}));

import type { DebugCapabilities, StackFrame, StreamChainInfo, StreamTraceResult, TraceProgress } from "@/platform/ipc";
import { getAction, isActionEnabled } from "@/platform/actions";
import { activate } from "../index";
import { handleDebugEvent, publishContext, useDebug, type DebugSession } from "../state";
import { useOverlays } from "../ui/popoverStore";
import { provideEditorService, provideNotificationService, type EditorService } from "@/workbench/contributions";
import {
  abortTrace,
  forgetStreamTrace,
  pickStreamChain,
  stopRecording,
  traceStreamChain,
} from "../streams/streamState";
import { isTracing, traceValuesOutdated, useStreamTrace } from "../streams/streamStore";
import { StreamChainChooser } from "../streams/StreamChainChooser";

const frame: StackFrame = { id: 10, name: "main", path: "/p/Main.java", line: 5, column: 4, presentationHint: null };

const session = {
  id: 1,
  name: "Main",
  adapter: "java-debug",
  parent: null,
  launch: null,
  process: null,
  status: "paused",
  stoppedThread: 1,
  stopReason: "breakpoint",
  stopDescription: null,
  threads: [{ id: 1, name: "main" }],
  selectedThread: 1,
  frames: [frame, { id: 11, name: "run", path: "/p/Main.java", line: 20, column: 0, presentationHint: null }],
  selectedFrame: 10,
  hits: 1,
  stops: 1,
  exitCode: null,
  caps: { streamTrace: true } as DebugCapabilities,
} as DebugSession;

const chain = (index: number, available = true): StreamChainInfo => ({
  index,
  range: { start: { line: 5, col: 4 + index }, end: { line: 7, col: 20 } },
  text: "nums.stream()\n    .map(x -> x * 2)\n    .toList()",
  steps: available ? ["map"] : [],
  terminal: available ? "toList" : "",
  available,
  ...(available ? {} : { reason: { kind: "lazyTerminal" as const, op: "iterator" } }),
});

const FAILED: StreamTraceResult = { status: "failed", detail: "no" };
const READY: StreamTraceResult = {
  status: "ready",
  chain: chain(0),
  steps: ["stream", "map"],
  records: [],
  links: [],
  terminal: { kind: "void" },
  banners: [],
  generation: 2,
};
const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const enabled = (id: string) => isActionEnabled(getAction(id)!);
const setSession = (p: Partial<DebugSession>) => {
  useDebug.setState((s) => ({ sessions: { 1: { ...s.sessions[1]!, ...p } } }));
  publishContext();
};
const notify = vi.fn();

let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  provideNotificationService({ notify });
  useStreamTrace.setState({ bySession: {} });
  useOverlays.setState({ streamChooser: null, streamAbort: null });
  dispose = activate();
  useDebug.setState({ sessions: { 1: session }, active: 1 });
  publishContext();
});
afterEach(() => {
  cleanup();
  dispose();
  useDebug.setState({ sessions: {}, active: null });
});

describe("Trace Stream Chain", () => {
  it("one available chain traces at once", async () => {
    ipc.debugStreamChains.mockReturnValue(ok([chain(0)]));
    ipc.debugStreamTrace.mockReturnValue(ok(FAILED));
    await traceStreamChain(1);
    expect(ipc.debugStreamChains).toHaveBeenCalledWith(1, frame, true);
    expect(ipc.debugStreamTrace).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      1,
      frame,
      0,
      chain(0).range,
      expect.anything(),
    );
    expect(tab.openStreamTraceTab).toHaveBeenCalledWith(1);
    expect(useOverlays.getState().streamChooser).toBeNull();
    expect(useStreamTrace.getState().bySession[1]?.result).toEqual(FAILED);
    expect(isTracing(1)).toBe(false);
  });

  it("several chains open the chooser", async () => {
    ipc.debugStreamChains.mockReturnValue(ok([chain(0), chain(1, false)]));
    await traceStreamChain(1);
    expect(useOverlays.getState().streamChooser).not.toBeNull();
    expect(useOverlays.getState().streamChooser?.chains).toHaveLength(2);
    expect(ipc.debugStreamTrace).not.toHaveBeenCalled();
  });

  it("tracing disables resume, steps and pause", async () => {
    const reply = deferred<{ status: "ok"; data: StreamTraceResult }>();
    ipc.debugStreamChains.mockReturnValue(ok([chain(0)]));
    ipc.debugStreamTrace.mockReturnValue(reply.promise);
    expect(enabled("debug.resume")).toBe(true);
    expect(enabled("debug.traceStreamChain")).toBe(true);
    const running = traceStreamChain(1);
    await settle();
    expect(isTracing(1)).toBe(true);
    expect(enabled("debug.resume")).toBe(false);
    expect(enabled("debug.stepOver")).toBe(false);
    expect(enabled("debug.traceStreamChain")).toBe(false);
    // Moving neither the program nor the trace, these stay available.
    expect(enabled("debug.showExecutionPoint")).toBe(true);
    expect(enabled("debug.jumpToSource")).toBe(true);
    // The trace resumes the program itself, so the session shows as running.
    setSession({ status: "running" });
    expect(enabled("debug.pause")).toBe(false);
    reply.resolve({ status: "ok", data: FAILED });
    await running;
    expect(isTracing(1)).toBe(false);
    expect(enabled("debug.pause")).toBe(true);
    setSession({ status: "paused" });
    expect(enabled("debug.resume")).toBe(true);
    expect(enabled("debug.stepOver")).toBe(true);
  });

  it("asks for the chains of a lower frame as not the top one", async () => {
    setSession({ selectedFrame: 11 });
    ipc.debugStreamChains.mockReturnValue(ok([chain(0, false)]));
    await traceStreamChain(1);
    expect(ipc.debugStreamChains).toHaveBeenCalledWith(1, session.frames[1], false);
  });

  it("says so when the line has no stream chain", async () => {
    ipc.debugStreamChains.mockReturnValue(ok([]));
    await traceStreamChain(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "No stream chain on this line" }));
    expect(ipc.debugStreamTrace).not.toHaveBeenCalled();
    expect(useOverlays.getState().streamChooser).toBeNull();
  });

  it("a progress message patches the running trace", async () => {
    const reply = deferred<{ status: "ok"; data: StreamTraceResult }>();
    ipc.debugStreamChains.mockReturnValue(ok([chain(0)]));
    ipc.debugStreamTrace.mockReturnValue(reply.promise);
    const running = traceStreamChain(1);
    await settle();
    const channel = ipc.debugStreamTrace.mock.calls[0]![6] as { onmessage: (p: TraceProgress) => void };
    const progress: TraceProgress = { phase: "running", records: 12, dropped: 0, elapsedMs: 40 };
    channel.onmessage(progress);
    expect(useStreamTrace.getState().bySession[1]?.progress).toEqual(progress);
    reply.resolve({ status: "ok", data: FAILED });
    await running;
  });

  it("a trace forgotten while it runs ignores its late reply", async () => {
    const reply = deferred<{ status: "ok"; data: StreamTraceResult }>();
    ipc.debugStreamChains.mockReturnValue(ok([chain(0)]));
    ipc.debugStreamTrace.mockReturnValue(reply.promise);
    const running = traceStreamChain(1);
    await settle();
    forgetStreamTrace(1);
    expect(isTracing(1)).toBe(false);
    reply.resolve({ status: "ok", data: FAILED });
    await running;
    expect(useStreamTrace.getState().bySession[1]).toBeUndefined();
  });

  it("the chooser closes when the stop or the selected frame changes", async () => {
    ipc.debugStreamChains.mockReturnValue(ok([chain(0), chain(1)]));
    await traceStreamChain(1);
    expect(useOverlays.getState().streamChooser?.frame).toBe(10);
    setSession({ selectedFrame: 11 });
    expect(useOverlays.getState().streamChooser).toBeNull();
    setSession({ selectedFrame: 10 });
    await traceStreamChain(1);
    setSession({ status: "running" });
    expect(useOverlays.getState().streamChooser).toBeNull();
  });

  it("a pick from a stale chooser says so instead of tracing", async () => {
    useOverlays.setState({ streamChooser: { session: 1, frame: 11, chains: [chain(0)] } });
    await pickStreamChain(chain(0));
    expect(ipc.debugStreamTrace).not.toHaveBeenCalled();
    expect(useOverlays.getState().streamChooser).toBeNull();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "The stop or the selected frame changed; trace the stream chain again" }),
    );
  });

  it("stop recording cancels the request", async () => {
    const reply = deferred<{ status: "ok"; data: StreamTraceResult }>();
    ipc.debugStreamChains.mockReturnValue(ok([chain(0)]));
    ipc.debugStreamTrace.mockReturnValue(reply.promise);
    const running = traceStreamChain(1);
    await settle();
    stopRecording(1);
    const request = ipc.debugStreamTrace.mock.calls[0]![1];
    expect(ipc.cancelRequest).toHaveBeenCalledWith(request);
    expect(useStreamTrace.getState().bySession[1]?.stoppedRecording).toBe(true);
    // The program keeps running after a stop: the trace still ends with a result.
    expect(isTracing(1)).toBe(true);
    reply.resolve({ status: "ok", data: FAILED });
    await running;
    expect(isTracing(1)).toBe(false);
  });

  it("abort asks the host to cancel the terminal operation", async () => {
    const reply = deferred<{ status: "ok"; data: StreamTraceResult }>();
    ipc.debugStreamChains.mockReturnValue(ok([chain(0)]));
    ipc.debugStreamTrace.mockReturnValue(reply.promise);
    ipc.debugStreamTraceAbort.mockReturnValue(ok({ kind: "interrupted" }));
    const running = traceStreamChain(1);
    await settle();
    await abortTrace(1);
    expect(ipc.debugStreamTraceAbort).toHaveBeenCalledWith(1);
    expect(ipc.cancelRequest).not.toHaveBeenCalled();
    expect(useStreamTrace.getState().bySession[1]?.abort).toEqual({ kind: "interrupted" });
    reply.resolve({ status: "ok", data: FAILED });
    await running;
  });

  it("another thread's stop during the trace is not the trace's stop", async () => {
    const openFile = vi.fn(() => Promise.resolve());
    provideEditorService({ openFile } as unknown as EditorService);
    ipc.debugStackTrace.mockReturnValue(ok([frame]));
    ipc.debugThreads.mockReturnValue(ok([{ id: 1, name: "main" }]));
    ipc.debugScopes.mockReturnValue(ok([]));
    const reply = deferred<{ status: "ok"; data: StreamTraceResult }>();
    ipc.debugStreamChains.mockReturnValue(ok([chain(0)]));
    ipc.debugStreamTrace.mockReturnValue(reply.promise);
    const running = traceStreamChain(1);
    await settle();
    const stopOf = (threadId: number) =>
      ({ kind: "stopped", threadId, reason: "exception", description: null, allThreadsStopped: false }) as const;
    setSession({ status: "running" });
    // An exception breakpoint on a worker: a stop of its own, revealed as usual.
    handleDebugEvent(1, stopOf(2));
    await settle();
    expect(openFile).toHaveBeenCalledTimes(1);
    setSession({ status: "running" });
    handleDebugEvent(1, stopOf(1));
    await settle();
    expect(openFile).toHaveBeenCalledTimes(1);
    reply.resolve({ status: "ok", data: READY });
    await running;
    const entry = () => useStreamTrace.getState().bySession[1]!;
    const live = () => useDebug.getState().sessions[1];
    expect(entry().endStop).toBe(live()!.stops);
    expect(traceValuesOutdated(entry(), live())).toBe(false);

    setSession({ status: "running" });
    expect(traceValuesOutdated(entry(), live())).toBe(true);
    handleDebugEvent(1, stopOf(1));
    await settle();
    expect(openFile).toHaveBeenCalledTimes(2);
    expect(traceValuesOutdated(entry(), live())).toBe(true);
  });

  it("an Abort dialog left open closes when its trace ends", async () => {
    const reply = deferred<{ status: "ok"; data: StreamTraceResult }>();
    ipc.debugStreamChains.mockReturnValue(ok([chain(0)]));
    ipc.debugStreamTrace.mockReturnValue(reply.promise);
    const running = traceStreamChain(1);
    await settle();
    useOverlays.setState({ streamAbort: 1 });
    reply.resolve({ status: "ok", data: FAILED });
    await running;
    expect(useOverlays.getState().streamAbort).toBeNull();
  });

  it("the chooser shows why a chain cannot be traced and traces only an available one", async () => {
    ipc.debugStreamChains.mockReturnValue(ok([chain(0, false), chain(1)]));
    ipc.debugStreamTrace.mockReturnValue(ok(FAILED));
    await traceStreamChain(1);
    render(createElement(StreamChainChooser));
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("iterator() and spliterator() do not run the pipeline");
    fireEvent.click(rows[0]!);
    expect(ipc.debugStreamTrace).not.toHaveBeenCalled();
    expect(useOverlays.getState().streamChooser).not.toBeNull();
    fireEvent.click(rows[1]!);
    await settle();
    expect(ipc.debugStreamTrace).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      1,
      frame,
      1,
      chain(1).range,
      expect.anything(),
    );
    expect(useOverlays.getState().streamChooser).toBeNull();
  });

  it("forget on session end", async () => {
    ipc.debugStreamChains.mockReturnValue(ok([chain(0)]));
    ipc.debugStreamTrace.mockReturnValue(ok(FAILED));
    await traceStreamChain(1);
    expect(useStreamTrace.getState().bySession[1]).toBeDefined();
    useDebug.setState({ sessions: {}, active: null });
    expect(useStreamTrace.getState().bySession[1]).toBeUndefined();
  });

  it("the stop a trace ends in leaves the trace tab in front; a later stop reveals its source", async () => {
    const openFile = vi.fn(() => Promise.resolve());
    provideEditorService({ openFile } as unknown as EditorService);
    ipc.debugStackTrace.mockReturnValue(ok([frame]));
    ipc.debugThreads.mockReturnValue(ok([{ id: 1, name: "main" }]));
    ipc.debugScopes.mockReturnValue(ok([]));
    const reply = deferred<{ status: "ok"; data: StreamTraceResult }>();
    ipc.debugStreamChains.mockReturnValue(ok([chain(0)]));
    ipc.debugStreamTrace.mockReturnValue(reply.promise);
    const running = traceStreamChain(1);
    await settle();
    const stop = { kind: "stopped", threadId: 1, reason: "step", description: null, allThreadsStopped: false } as const;
    setSession({ status: "running" });
    handleDebugEvent(1, stop);
    await settle();
    expect(openFile).not.toHaveBeenCalled();
    reply.resolve({ status: "ok", data: READY });
    await running;

    setSession({ status: "running" });
    handleDebugEvent(1, stop);
    await settle();
    expect(openFile).toHaveBeenCalledWith(frame.path, expect.objectContaining({ focus: false }));
  });

  it("a reply that comes before its stop still keeps that stop from revealing the source", async () => {
    const openFile = vi.fn(() => Promise.resolve());
    provideEditorService({ openFile } as unknown as EditorService);
    ipc.debugStackTrace.mockReturnValue(ok([frame]));
    ipc.debugThreads.mockReturnValue(ok([{ id: 1, name: "main" }]));
    ipc.debugScopes.mockReturnValue(ok([]));
    ipc.debugStreamChains.mockReturnValue(ok([chain(0)]));
    ipc.debugStreamTrace.mockReturnValue(ok(READY));
    await traceStreamChain(1);
    setSession({ status: "running" });
    handleDebugEvent(1, { kind: "stopped", threadId: 1, reason: "step", description: null, allThreadsStopped: false });
    await settle();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("action when clause", () => {
    expect(getAction("debug.traceStreamChain")!.when).toBe("debugCanTraceStream");
  });
});
