import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (p: unknown) => void = () => {};
  },
}));

const ipc = vi.hoisted(() => ({
  debugHeapCapture: vi.fn(),
  debugHeapOpen: vi.fn(),
  debugHeapClasses: vi.fn(),
  debugHeapClose: vi.fn(),
  cancelRequest: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

import type {
  DebugSessionId,
  HeapCaptureResult,
  HeapClassRow,
  HeapOpenResult,
  HeapProgress,
  HeapSnapshotInfo,
} from "@/platform/ipc";
import { provideEditorService, type EditorInput, type EditorService } from "@/workbench/contributions";
import { useDebug, type DebugSession } from "../state";
import { HEAP_KIND, heapInput } from "../heap/heapInput";
import {
  cancelCapture,
  captureHeap,
  closeHeapSnapshot,
  forgetHeapCapture,
  openHeapFile,
  progressFraction,
  retainedForSession,
  useHeap,
} from "../heap/heapState";

const SESSION = 3 as DebugSessionId;
const OTHER = 4 as DebugSessionId;

const info = (id: number, session: DebugSessionId = SESSION, createdMs = id): HeapSnapshotInfo => ({
  id,
  label: "12:30:00",
  origin: { kind: "captured", session, pid: 99, javaVersion: "21", takenWhileSuspended: true, dumpMs: 40 },
  summary: {
    objects: 10,
    reachableObjects: 9,
    reachableBytes: 900,
    unreachableObjects: 1,
    unreachableBytes: 100,
  } as HeapSnapshotInfo["summary"],
  createdMs,
});
const fileInfo = (id: number): HeapSnapshotInfo => ({
  ...info(id),
  origin: { kind: "file", path: "/tmp/a.hprof" },
});

const row = (name: string, retained: number, ambiguous = false): HeapClassRow => ({
  classIndex: 0,
  name,
  count: 1,
  shallow: 8,
  retained,
  unreachableCount: 0,
  ambiguous,
});

const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const fail = (message: string) => Promise.resolve({ status: "error" as const, error: { kind: "internal", message } });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type FakeChannel = { onmessage: (p: HeapProgress) => void };
let channel: FakeChannel | null;
let capture: ReturnType<typeof deferred<{ status: "ok"; data: HeapCaptureResult }>>;
let open: ReturnType<typeof deferred<{ status: "ok"; data: HeapOpenResult }>>;
const openInput = vi.fn(async (_input: EditorInput, _options?: unknown) => {});

const setStops = (stops: number, id: DebugSessionId = SESSION) =>
  useDebug.setState((s) => ({ sessions: { ...s.sessions, [id]: { id, stops } as DebugSession } }));

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useHeap.setState({ snapshots: {}, captures: {}, opening: null });
  useDebug.setState({ sessions: {}, stopSeq: 0, variablesEpoch: 0 });
  for (const m of Object.values(ipc)) m.mockReset();
  openInput.mockClear();
  provideEditorService({ openInput } as unknown as EditorService);
  channel = null;
  capture = deferred();
  open = deferred();
  ipc.debugHeapCapture.mockImplementation((_s: number, _r: number, ch: FakeChannel) => {
    channel = ch;
    return capture.promise;
  });
  ipc.debugHeapOpen.mockImplementation((_p: string, _r: number, ch: FakeChannel) => {
    channel = ch;
    return open.promise;
  });
  ipc.debugHeapClasses.mockReturnValue(ok([row("Node", 104)]));
  ipc.debugHeapClose.mockReturnValue(ok(null));
  ipc.cancelRequest.mockResolvedValue(null);
});

describe("captureHeap", () => {
  it("captures, stores the stop and opens the snapshot", async () => {
    setStops(4);
    const done = captureHeap(SESSION);
    await flush();
    const request = ipc.debugHeapCapture.mock.calls[0]![1];
    expect(useHeap.getState().captures[SESSION]).toEqual({ request, progress: null, error: null, unavailable: null });

    channel!.onmessage({ type: "dumping" });
    expect(useHeap.getState().captures[SESSION]!.progress).toEqual({ type: "dumping" });

    capture.resolve({ status: "ok", data: { status: "ready", snapshot: info(7) } });
    await done;

    const entry = useHeap.getState().snapshots[7]!;
    expect(entry.takenAtStop).toBe(4);
    expect(entry.classes).toEqual([row("Node", 104)]);
    expect(ipc.debugHeapClasses).toHaveBeenCalledWith(7);
    expect(openInput).toHaveBeenCalledTimes(1);
    expect(openInput.mock.calls[0]![0]).toEqual({
      kind: HEAP_KIND,
      key: "heap-snapshot:7",
      data: { id: 7, label: "12:30:00" },
    });
    expect(useHeap.getState().captures[SESSION]).toBeUndefined();
  });

  it("ignores a second capture while one runs", async () => {
    setStops(1);
    const first = captureHeap(SESSION);
    await captureHeap(SESSION);
    expect(ipc.debugHeapCapture).toHaveBeenCalledTimes(1);
    capture.resolve({ status: "ok", data: { status: "cancelled" } });
    await first;
  });

  it("runs captures of different sessions side by side", async () => {
    const a = captureHeap(SESSION);
    const b = captureHeap(OTHER);
    expect(ipc.debugHeapCapture).toHaveBeenCalledTimes(2);
    capture.resolve({ status: "ok", data: { status: "cancelled" } });
    await Promise.all([a, b]);
  });

  it("keeps the reason when the JVM cannot dump", async () => {
    const done = captureHeap(SESSION);
    capture.resolve({
      status: "ok",
      data: { status: "unavailable", reason: { kind: "dumpTimedOut", seconds: 30 } },
    });
    await done;
    const c = useHeap.getState().captures[SESSION]!;
    expect(c.unavailable).toEqual({ kind: "dumpTimedOut", seconds: 30 });
    expect(c.error).toBeNull();
    expect(openInput).not.toHaveBeenCalled();
    expect(useHeap.getState().snapshots).toEqual({});
  });

  it("starts again after a refusal", async () => {
    const first = captureHeap(SESSION);
    capture.resolve({ status: "ok", data: { status: "unavailable", reason: { kind: "dumpTimedOut", seconds: 30 } } });
    await first;
    capture = deferred();
    const second = captureHeap(SESSION);
    expect(ipc.debugHeapCapture).toHaveBeenCalledTimes(2);
    expect(useHeap.getState().captures[SESSION]!.unavailable).toBeNull();
    capture.resolve({ status: "ok", data: { status: "cancelled" } });
    await second;
  });

  it("records a failed request", async () => {
    ipc.debugHeapCapture.mockReturnValue(fail("boom"));
    await captureHeap(SESSION);
    expect(useHeap.getState().captures[SESSION]).toMatchObject({ error: "boom", unavailable: null });
  });

  it("clears the capture on cancel", async () => {
    const done = captureHeap(SESSION);
    await flush();
    const request = ipc.debugHeapCapture.mock.calls[0]![1];
    cancelCapture(SESSION);
    expect(ipc.cancelRequest).toHaveBeenCalledWith(request);
    capture.resolve({ status: "ok", data: { status: "cancelled" } });
    await done;
    expect(useHeap.getState().captures[SESSION]).toBeUndefined();
    expect(openInput).not.toHaveBeenCalled();
  });

  it("does not cancel when nothing runs", () => {
    cancelCapture(SESSION);
    expect(ipc.cancelRequest).not.toHaveBeenCalled();
  });

  it("opens the snapshot even when its class table cannot be read", async () => {
    ipc.debugHeapClasses.mockReturnValue(fail("no table"));
    const done = captureHeap(SESSION);
    capture.resolve({ status: "ok", data: { status: "ready", snapshot: info(7) } });
    await done;
    expect(useHeap.getState().snapshots[7]!.classes).toBeNull();
    expect(openInput).toHaveBeenCalledTimes(1);
    expect(useHeap.getState().captures[SESSION]).toMatchObject({ error: "no table" });
  });

  // Z3: a stop between the click and the reply means the dump may show another state.
  it("does not label a dump with a stop when the session moved before the reply", async () => {
    setStops(4);
    const done = captureHeap(SESSION);
    setStops(5);
    capture.resolve({ status: "ok", data: { status: "ready", snapshot: info(7) } });
    await done;
    expect(useHeap.getState().snapshots[7]!.takenAtStop).toBeNull();
    expect(retainedForSession(SESSION, 4)).toBeNull();
    expect(retainedForSession(SESSION, 5)).toBeNull();
  });

  it("keeps the snapshot when the session ended during the capture", async () => {
    setStops(4);
    const done = captureHeap(SESSION);
    useDebug.setState({ sessions: {} });
    forgetHeapCapture(SESSION);
    capture.resolve({ status: "ok", data: { status: "ready", snapshot: info(7) } });
    await done;
    expect(useHeap.getState().snapshots[7]!.takenAtStop).toBeNull();
    expect(useHeap.getState().captures[SESSION]).toBeUndefined();
  });
});

describe("forgetHeapCapture", () => {
  it("drops the session's capture and keeps the open snapshots", async () => {
    useHeap.setState({
      snapshots: { 7: { info: info(7), takenAtStop: 4, classes: null } },
      captures: { [SESSION]: { request: 1, progress: null, error: null, unavailable: null } },
    });
    forgetHeapCapture(SESSION);
    expect(useHeap.getState().captures).toEqual({});
    expect(useHeap.getState().snapshots[7]).toBeDefined();
  });

  it("lets a reply that arrives later change nothing", async () => {
    const done = captureHeap(SESSION);
    forgetHeapCapture(SESSION);
    capture.resolve({ status: "ok", data: { status: "unavailable", reason: { kind: "dumpTimedOut", seconds: 30 } } });
    await done;
    expect(useHeap.getState().captures).toEqual({});
  });
});

describe("retainedForSession", () => {
  const withSnapshot = (takenAtStop: number | null, classes: HeapClassRow[] | null, i = info(7)) =>
    useHeap.setState({ snapshots: { [i.id]: { info: i, takenAtStop, classes } } });

  it("retained per class only for the current stop", () => {
    withSnapshot(4, [row("Node", 104), row("Leaf", 8)]);
    setStops(4);
    expect(retainedForSession(SESSION, 4)).toEqual(
      new Map([
        ["Node", 104],
        ["Leaf", 8],
      ]),
    );
    setStops(5);
    expect(retainedForSession(SESSION, 4)).toBeNull();
    expect(retainedForSession(SESSION, 5)).toBeNull();
  });

  // Z1: only a stop of this session moves the key.
  it("is not moved by a global stop counter or a variables refresh", () => {
    withSnapshot(4, [row("Node", 104)]);
    setStops(4);
    useDebug.setState({ stopSeq: 9, variablesEpoch: 3 });
    expect(retainedForSession(SESSION, 4)).toEqual(new Map([["Node", 104]]));
  });

  // Z2: the Memory table the column sits in must come from the same stop as the dump.
  it("is null for a table from an earlier stop than the session's", () => {
    withSnapshot(4, [row("Node", 104)]);
    setStops(4);
    expect(retainedForSession(SESSION, 3)).toBeNull();
  });

  it("is null when the dump is from an earlier stop than the table", () => {
    withSnapshot(4, [row("Node", 104)]);
    setStops(5);
    expect(retainedForSession(SESSION, 5)).toBeNull();
  });

  it("is null while the class table is not loaded, and for an unknown session", () => {
    withSnapshot(4, null);
    setStops(4);
    expect(retainedForSession(SESSION, 4)).toBeNull();
    expect(retainedForSession(OTHER, 4)).toBeNull();
  });

  it("leaves out names shared by several classes", () => {
    withSnapshot(4, [row("Node", 104), row("Dup", 50, true)]);
    setStops(4);
    expect(retainedForSession(SESSION, 4)).toEqual(new Map([["Node", 104]]));
  });

  it("takes the latest snapshot of the session taken at that stop, and ignores other sessions and files", () => {
    setStops(4);
    useHeap.setState({
      snapshots: {
        1: { info: info(1, SESSION, 100), takenAtStop: 4, classes: [row("Node", 1)] },
        2: { info: info(2, SESSION, 200), takenAtStop: 4, classes: [row("Node", 2)] },
        3: { info: info(3, SESSION, 300), takenAtStop: 3, classes: [row("Node", 3)] },
        4: { info: info(4, OTHER, 400), takenAtStop: 4, classes: [row("Node", 4)] },
        5: { info: fileInfo(5), takenAtStop: null, classes: [row("Node", 5)] },
      },
    });
    expect(retainedForSession(SESSION, 4)).toEqual(new Map([["Node", 2]]));
  });
});

describe("progressFraction", () => {
  it("is null while dumping and counts six analysis phases", () => {
    expect(progressFraction(null)).toBeNull();
    expect(progressFraction({ type: "dumping" })).toBeNull();
    expect(progressFraction({ type: "analyzing", phase: "reading", done: 0, total: 10 })).toBe(0);
    expect(progressFraction({ type: "analyzing", phase: "dominators", done: 0, total: 1 })).toBeCloseTo(2 / 6);
    expect(progressFraction({ type: "analyzing", phase: "retained", done: 1, total: 2 })).toBeCloseTo(3.5 / 6);
    expect(progressFraction({ type: "analyzing", phase: "saving", done: 5, total: 5 })).toBe(1);
  });

  it("stays within 0..1 for an empty or overrun phase", () => {
    expect(progressFraction({ type: "analyzing", phase: "linking", done: 0, total: 0 })).toBeCloseTo(1 / 6);
    expect(progressFraction({ type: "analyzing", phase: "linking", done: 9, total: 3 })).toBeCloseTo(2 / 6);
  });
});

describe("openHeapFile", () => {
  it("opens a file, shows its progress and opens the snapshot", async () => {
    const done = openHeapFile("/tmp/a.hprof");
    await flush();
    const [path, request] = ipc.debugHeapOpen.mock.calls[0]!;
    expect(path).toBe("/tmp/a.hprof");
    expect(useHeap.getState().opening).toEqual({ request, progress: null });
    channel!.onmessage({ type: "analyzing", phase: "linking", done: 1, total: 2 });
    expect(useHeap.getState().opening!.progress).toEqual({ type: "analyzing", phase: "linking", done: 1, total: 2 });

    open.resolve({ status: "ok", data: { status: "ready", snapshot: fileInfo(8) } });
    await done;
    expect(useHeap.getState().opening).toBeNull();
    expect(useHeap.getState().snapshots[8]).toMatchObject({ takenAtStop: null, classes: [row("Node", 104)] });
    expect(openInput.mock.calls[0]![0].key).toBe("heap-snapshot:8");
  });

  it("ignores a second open while one runs", async () => {
    const first = openHeapFile("/tmp/a.hprof");
    await expect(openHeapFile("/tmp/b.hprof")).resolves.toBeNull();
    expect(ipc.debugHeapOpen).toHaveBeenCalledTimes(1);
    open.resolve({ status: "ok", data: { status: "cancelled" } });
    await first;
  });

  it("clears the progress and opens nothing when cancelled or refused for disk space", async () => {
    const first = openHeapFile("/tmp/a.hprof");
    open.resolve({ status: "ok", data: { status: "cancelled" } });
    await expect(first).resolves.toEqual({ status: "cancelled" });
    expect(useHeap.getState().opening).toBeNull();

    open = deferred();
    const second = openHeapFile("/tmp/a.hprof");
    open.resolve({ status: "ok", data: { status: "notEnoughDiskSpace", needed: 5, available: 1 } });
    await expect(second).resolves.toEqual({ status: "notEnoughDiskSpace", needed: 5, available: 1 });
    expect(useHeap.getState().opening).toBeNull();
    expect(openInput).not.toHaveBeenCalled();
  });

  it("clears the progress and rejects when the request fails", async () => {
    ipc.debugHeapOpen.mockReturnValue(fail("bad file"));
    await expect(openHeapFile("/tmp/a.hprof")).rejects.toThrow("bad file");
    expect(useHeap.getState().opening).toBeNull();
  });
});

describe("closeHeapSnapshot", () => {
  it("closing forgets the snapshot and tells the host", async () => {
    useHeap.setState({ snapshots: { 7: { info: info(7), takenAtStop: 4, classes: null } } });
    await closeHeapSnapshot(7);
    expect(useHeap.getState().snapshots[7]).toBeUndefined();
    expect(ipc.debugHeapClose).toHaveBeenCalledWith(7);
  });

  it("forgets the snapshot even when the host cannot close it", async () => {
    ipc.debugHeapClose.mockReturnValue(fail("gone"));
    useHeap.setState({ snapshots: { 7: { info: info(7), takenAtStop: 4, classes: null } } });
    await closeHeapSnapshot(7);
    expect(useHeap.getState().snapshots[7]).toBeUndefined();
  });

  it("is not brought back by a class table that arrives after the close", async () => {
    const classes = deferred<{ status: "ok"; data: HeapClassRow[] }>();
    ipc.debugHeapClasses.mockReturnValue(classes.promise);
    const done = captureHeap(SESSION);
    capture.resolve({ status: "ok", data: { status: "ready", snapshot: info(7) } });
    await flush();
    await closeHeapSnapshot(7);
    classes.resolve({ status: "ok", data: [row("Node", 1)] });
    await done;
    expect(useHeap.getState().snapshots[7]).toBeUndefined();
  });
});

describe("heapInput", () => {
  it("keys the tab by snapshot id", () => {
    expect(heapInput(info(7))).toEqual({
      kind: "heap-snapshot",
      key: "heap-snapshot:7",
      data: { id: 7, label: "12:30:00" },
    });
  });
});
