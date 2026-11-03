import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StackFrame, Variable } from "@/platform/ipc";

const ipc = vi.hoisted(() => {
  const ok = <T>(data: T) => ({ status: "ok" as const, data });
  return {
    ok,
    debugCapabilities: vi.fn(async () => ok(null)),
    debugThreads: vi.fn(async () =>
      ok([
        { id: 5, name: "http-nio-8179-exec-5" },
        { id: 1, name: "main" },
      ]),
    ),
    debugStackTrace: vi.fn(async () => ok([] as StackFrame[])),
    debugScopes: vi.fn(async () => ok([{ name: "Locals", variablesReference: 10, expensive: false }])),
    debugVariables: vi.fn(async () => ok([] as Variable[])),
  };
});
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  const { ok: _ok, ...commands } = ipc;
  return { ...real, commands: { ...real.commands, ...commands } };
});
vi.mock("@/workbench/contributions", async (orig) => ({
  ...(await orig<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ openFile: vi.fn(async () => {}) }),
}));
import { adoptSession, handleDebugEvent, selectThread, resumeExecution, useDebug, useExecutionPoint } from "../state";

const path = "/proj/MsMemberUtils.java";
const frame = (line: number, id = 100): StackFrame => ({
  id,
  name: "queryMsTicket",
  path,
  line,
  column: 0,
  presentationHint: null,
});
const stopped = (threadId = 5, allThreadsStopped = false) =>
  handleDebugEvent(1, { kind: "stopped", threadId, allThreadsStopped, reason: "step", description: null });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDebug.setState({ sessions: {}, active: null, stopSeq: 0 });
  useExecutionPoint.setState({ path: null, line: 0, top: true, values: {} });
  adoptSession(1, { adapter: "java-debug" });
  ipc.debugStackTrace.mockResolvedValue(ipc.ok([frame(6840)]));
  ipc.debugVariables.mockResolvedValue(ipc.ok([]));
});

describe("execution point state", () => {
  it.each([false, true])("selects each stopped thread and its fresh top frame (all=%s)", async (all) => {
    stopped(5, all);
    await settle();
    expect(useExecutionPoint.getState()).toMatchObject({ path, line: 6840 });
    ipc.debugStackTrace.mockResolvedValueOnce(ipc.ok([frame(6842)]));
    stopped(5, all);
    await settle();
    expect(useDebug.getState().sessions[1]).toMatchObject({ selectedThread: 5, selectedFrame: 100 });
    expect(useExecutionPoint.getState()).toMatchObject({ path, line: 6842 });
    ipc.debugStackTrace.mockResolvedValueOnce(ipc.ok([frame(9)]));
    stopped(1, all);
    await settle();
    expect(useDebug.getState().sessions[1]?.selectedThread).toBe(1);
    expect(useExecutionPoint.getState()).toMatchObject({ path, line: 9 });
  });

  it("clears the old point while a new stack or selected thread is loading", async () => {
    stopped();
    await settle();
    const pending = deferred<ReturnType<typeof ipc.ok<StackFrame[]>>>();
    ipc.debugStackTrace.mockReturnValueOnce(pending.promise);
    stopped();
    expect(useExecutionPoint.getState().path).toBeNull();
    pending.resolve(ipc.ok([frame(6842)]));
    await settle();
    const other = deferred<ReturnType<typeof ipc.ok<StackFrame[]>>>();
    ipc.debugStackTrace.mockReturnValueOnce(other.promise);
    const selecting = selectThread(1, 1);
    expect(useExecutionPoint.getState().path).toBeNull();
    other.resolve(ipc.ok([frame(9)]));
    await selecting;
    expect(useExecutionPoint.getState().line).toBe(9);
  });

  it("ignores a stack response from an earlier stop on the same thread", async () => {
    const old = deferred<ReturnType<typeof ipc.ok<StackFrame[]>>>();
    ipc.debugStackTrace.mockReturnValueOnce(old.promise);
    stopped();
    ipc.debugStackTrace.mockResolvedValueOnce(ipc.ok([frame(6842)]));
    stopped();
    await settle();
    old.resolve(ipc.ok([frame(6840)]));
    await settle();
    expect(useExecutionPoint.getState()).toMatchObject({ path, line: 6842 });
    expect(useDebug.getState().sessions[1]?.frames[0]?.line).toBe(6842);
  });

  it("keeps the selected paused thread when only another thread continues", async () => {
    stopped();
    await settle();
    handleDebugEvent(1, { kind: "continued", threadId: 1, allThreadsContinued: false });
    expect(useExecutionPoint.getState().path).toBe(path);
    expect(useDebug.getState().sessions[1]?.status).toBe("paused");
    handleDebugEvent(1, { kind: "continued", threadId: 5, allThreadsContinued: false });
    expect(useExecutionPoint.getState().path).toBeNull();
  });

  it.each(["continued", "terminated"] as const)("clears the execution point on %s", async (kind) => {
    stopped();
    await settle();
    handleDebugEvent(1, kind === "continued" ? { kind, threadId: 5, allThreadsContinued: true } : { kind });
    expect(useExecutionPoint.getState()).toMatchObject({ path: null, values: {} });
  });

  it("retains locals whose names are Object.prototype properties", async () => {
    const names = Object.getOwnPropertyNames(Object.prototype);
    ipc.debugVariables.mockResolvedValueOnce(
      ipc.ok(
        names.map((name) => ({ name, value: "known", typeName: null, variablesReference: 0, evaluateName: name })),
      ),
    );
    stopped();
    await settle();
    for (const name of names) expect(Object.hasOwn(useExecutionPoint.getState().values, name), name).toBe(true);
  });
  it.each(["step", "continue"])("clears suspended data before a %s request resolves", async () => {
    stopped();
    await settle();
    const pending = deferred<void>();
    const request = vi.fn(() => {
      expect(useExecutionPoint.getState().path).toBeNull();
      expect(useDebug.getState().sessions[1]).toMatchObject({ status: "running", frames: [], selectedFrame: null });
      return pending.promise;
    });
    const result = resumeExecution(1, request);
    expect(request).toHaveBeenCalledOnce();
    ipc.debugStackTrace.mockResolvedValueOnce(ipc.ok([frame(6842)]));
    stopped();
    await settle();
    pending.resolve();
    await result;
    expect(useExecutionPoint.getState()).toMatchObject({ path, line: 6842 });
  });

  it("restores suspended data if the command fails without a newer event", async () => {
    stopped();
    await settle();
    await expect(
      resumeExecution(1, async () => {
        throw new Error("rejected");
      }),
    ).rejects.toThrow("rejected");
    expect(useDebug.getState().sessions[1]?.status).toBe("paused");
    expect(useExecutionPoint.getState()).toMatchObject({ path, line: 6840 });
  });

  it("does not restore an older stop when a failed command has already stopped again", async () => {
    stopped();
    await settle();
    let reject!: (e: Error) => void;
    const result = resumeExecution(
      1,
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    const rejected = expect(result).rejects.toThrow("rejected");
    ipc.debugStackTrace.mockResolvedValueOnce(ipc.ok([frame(6842)]));
    stopped();
    await settle();
    reject(new Error("rejected"));
    await rejected;
    expect(useExecutionPoint.getState()).toMatchObject({ path, line: 6842 });
  });

  it("discards locals from an earlier stop even when the frame ID is reused", async () => {
    const old = deferred<ReturnType<typeof ipc.ok<Variable[]>>>();
    ipc.debugVariables.mockReturnValueOnce(old.promise);
    stopped();
    await settle();
    ipc.debugStackTrace.mockResolvedValueOnce(ipc.ok([frame(6842)]));
    ipc.debugVariables.mockResolvedValueOnce(
      ipc.ok([{ name: "count", value: "42", typeName: null, variablesReference: 0, evaluateName: "count" }]),
    );
    stopped();
    await settle();
    old.resolve(ipc.ok([{ name: "count", value: "40", typeName: null, variablesReference: 0, evaluateName: "count" }]));
    await settle();
    expect(useExecutionPoint.getState().values.count).toBe("42");
  });
});
