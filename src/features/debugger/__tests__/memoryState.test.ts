import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ debugJvmMemoryClasses: vi.fn() }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

import type { DebugSessionId, JvmMemoryResult } from "@/platform/ipc";
import { useDebug, type DebugSession } from "../state";
import { forgetMemory, isOutdated, refreshMemory, setMemoryQuery, useMemory } from "../memory/memoryState";

const ID = 7 as DebugSessionId;
const ready = (totalBytes: number): JvmMemoryResult => ({
  status: "ready",
  snapshot: {
    rows: [],
    totalInstances: 0,
    totalBytes,
    javaVersion: "21",
    takenWhileSuspended: true,
    hasBaseline: false,
    elapsedMs: 5,
  },
});
const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const fail = (message: string) => Promise.resolve({ status: "error" as const, error: { kind: "internal", message } });

const setStops = (stops: number) => useDebug.setState({ sessions: { [ID]: { id: ID, stops } as DebugSession } });

beforeEach(() => {
  useMemory.setState({ bySession: {} });
  useDebug.setState({ sessions: {}, stopSeq: 0 });
  ipc.debugJvmMemoryClasses.mockReset();
});

describe("refreshMemory", () => {
  it("stores the result and the stop it was taken at", async () => {
    setStops(4);
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(ready(10)));
    await refreshMemory(ID);
    const e = useMemory.getState().bySession[ID]!;
    expect(ipc.debugJvmMemoryClasses).toHaveBeenCalledWith(ID);
    expect(e.result).toEqual(ready(10));
    expect(e.takenAtStop).toBe(4);
    expect(e.loading).toBe(false);
    expect(e.error).toBeNull();
  });

  it("keeps the old snapshot and records the error on failure", async () => {
    ipc.debugJvmMemoryClasses.mockReturnValueOnce(ok(ready(10)));
    await refreshMemory(ID);
    ipc.debugJvmMemoryClasses.mockReturnValueOnce(fail("boom"));
    await refreshMemory(ID);
    const e = useMemory.getState().bySession[ID]!;
    expect(e.result).toEqual(ready(10));
    expect(e.error).toBe("boom");
    expect(e.loading).toBe(false);
  });

  it("keeps the last snapshot and its stop when a refresh is refused", async () => {
    setStops(1);
    ipc.debugJvmMemoryClasses.mockReturnValueOnce(ok(ready(10)));
    await refreshMemory(ID);
    setStops(2);
    const refused: JvmMemoryResult = { status: "unavailable", reason: { kind: "timedOut" } };
    ipc.debugJvmMemoryClasses.mockReturnValueOnce(ok(refused));
    await refreshMemory(ID);
    const e = useMemory.getState().bySession[ID]!;
    expect(e.result).toEqual(refused);
    expect(e.snapshot).toEqual((ready(10) as Extract<JvmMemoryResult, { status: "ready" }>).snapshot);
    // The table still shows the snapshot from stop 1, so it reads as outdated.
    expect(isOutdated(e, 2)).toBe(true);
  });

  it("ignores a second refresh while one is loading", async () => {
    let release!: (r: unknown) => void;
    ipc.debugJvmMemoryClasses.mockReturnValueOnce(new Promise((r) => (release = r)));
    const first = refreshMemory(ID);
    await refreshMemory(ID);
    expect(ipc.debugJvmMemoryClasses).toHaveBeenCalledTimes(1);
    expect(useMemory.getState().bySession[ID]!.loading).toBe(true);
    release({ status: "ok", data: ready(1) });
    await first;
    expect(useMemory.getState().bySession[ID]!.loading).toBe(false);
  });

  it("drops a result that lands after the session was forgotten", async () => {
    let release!: (r: unknown) => void;
    ipc.debugJvmMemoryClasses.mockReturnValueOnce(new Promise((r) => (release = r)));
    const pending = refreshMemory(ID);
    forgetMemory(ID);
    release({ status: "ok", data: ready(1) });
    await pending;
    expect(useMemory.getState().bySession[ID]).toBeUndefined();
  });
});

describe("query and staleness", () => {
  it("merges query patches and keeps them across refreshes", async () => {
    setMemoryQuery(ID, { filter: "map", desc: false });
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(ready(1)));
    await refreshMemory(ID);
    expect(useMemory.getState().bySession[ID]!.query).toEqual({
      filter: "map",
      sort: "bytes",
      desc: false,
      changedOnly: false,
    });
  });

  it("is outdated once another stop happened", async () => {
    setStops(2);
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(ready(1)));
    await refreshMemory(ID);
    const e = useMemory.getState().bySession[ID]!;
    expect(isOutdated(e, 2)).toBe(false);
    expect(isOutdated(e, 3)).toBe(true);
  });

  it("takes the stop count from its own session, not the global counter", async () => {
    setStops(2);
    useDebug.setState({ stopSeq: 50 });
    ipc.debugJvmMemoryClasses.mockReturnValue(ok(ready(1)));
    await refreshMemory(ID);
    expect(useMemory.getState().bySession[ID]!.takenAtStop).toBe(2);
  });

  it("forgets a session", async () => {
    setMemoryQuery(ID, { filter: "x" });
    forgetMemory(ID);
    expect(useMemory.getState().bySession[ID]).toBeUndefined();
  });
});
