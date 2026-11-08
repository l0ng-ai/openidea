import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  debugJvmMemoryInstances: vi.fn(),
  debugJvmMemoryFields: vi.fn(),
  debugJvmMemoryReferrers: vi.fn(),
  debugCapabilities: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => true, commands: { ...real.commands, ...ipc } };
});

import type {
  DebugSessionId,
  JvmFieldsResult,
  JvmInstancesResult,
  JvmObjectRef,
  JvmReferrersResult,
} from "@/platform/ipc";
import { adoptSession, handleDebugEvent, useDebug, type DebugSession } from "../state";
import {
  closeInstances,
  forgetInstances,
  instancesOutdated,
  loadFields,
  loadReferrers,
  showInstances,
  useInstances,
} from "../memory/instancesState";

const ID = 7 as DebugSessionId;
const CLASS = "com.x.Order";
const ref: JvmObjectRef = { generation: 2, id: 7 };

const instances = (generation = 2): JvmInstancesResult => ({
  status: "ready",
  generation,
  instances: [{ kind: "object", id: 7, typeName: CLASS }],
  truncated: false,
});
const fields: JvmFieldsResult = {
  status: "ready",
  fields: [{ name: "total", value: { kind: "primitive", typeName: "int", text: "3" } }],
};
const referrers: JvmReferrersResult = { status: "ready", referrers: [], truncated: false };
const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });
const fail = (message: string) => Promise.resolve({ status: "error" as const, error: { kind: "internal", message } });
const later = () => {
  let release!: (r: unknown) => void;
  const promise = new Promise((r) => (release = r));
  return { promise, release: (data: unknown) => release({ status: "ok", data }) };
};

const setStops = (stops: number) => useDebug.setState({ sessions: { [ID]: { id: ID, stops } as DebugSession } });
const entry = () => useInstances.getState().bySession[ID]!;

beforeEach(() => {
  useInstances.setState({ bySession: {} });
  useDebug.setState({ sessions: {}, active: null, stopSeq: 0 });
  for (const m of Object.values(ipc)) m.mockReset();
  ipc.debugCapabilities.mockResolvedValue({ status: "ok", data: null });
});

describe("showInstances", () => {
  it("stores the result and the stop it was taken at", async () => {
    setStops(3);
    ipc.debugJvmMemoryInstances.mockReturnValue(ok(instances()));
    await showInstances(ID, CLASS);
    expect(ipc.debugJvmMemoryInstances).toHaveBeenCalledWith(ID, CLASS, 1000);
    expect(entry()).toMatchObject({
      className: CLASS,
      result: instances(),
      takenAtStop: 3,
      loading: false,
      error: null,
      nodes: {},
    });
  });

  it("records the error and settles loading when the call fails", async () => {
    ipc.debugJvmMemoryInstances.mockReturnValue(fail("boom"));
    await showInstances(ID, CLASS);
    expect(entry()).toMatchObject({ className: CLASS, result: null, error: "boom", loading: false });
  });

  it("a new class replaces the previous instances and their nodes", async () => {
    ipc.debugJvmMemoryInstances.mockReturnValue(ok(instances()));
    ipc.debugJvmMemoryFields.mockReturnValue(ok(fields));
    await showInstances(ID, CLASS);
    await loadFields(ID, ref);
    expect(Object.keys(entry().nodes)).toEqual(["2:7"]);

    const next = instances(3);
    ipc.debugJvmMemoryInstances.mockReturnValue(ok(next));
    await showInstances(ID, "com.x.Line");
    expect(entry()).toMatchObject({ className: "com.x.Line", result: next, nodes: {} });
  });

  it("ignores a second request for the same class while it is loading", async () => {
    const pending = later();
    ipc.debugJvmMemoryInstances.mockReturnValueOnce(pending.promise);
    const first = showInstances(ID, CLASS);
    await showInstances(ID, CLASS);
    expect(ipc.debugJvmMemoryInstances).toHaveBeenCalledTimes(1);
    pending.release(instances());
    await first;
    expect(entry().result).toEqual(instances());
  });

  it("a late reply for a closed or replaced list is ignored", async () => {
    const closed = later();
    ipc.debugJvmMemoryInstances.mockReturnValueOnce(closed.promise);
    const afterClose = showInstances(ID, CLASS);
    closeInstances(ID);
    closed.release(instances());
    await afterClose;
    expect(useInstances.getState().bySession[ID]).toBeUndefined();

    const replaced = later();
    ipc.debugJvmMemoryInstances.mockReturnValueOnce(replaced.promise);
    const stale = showInstances(ID, CLASS);
    ipc.debugJvmMemoryInstances.mockReturnValueOnce(ok(instances(5)));
    await showInstances(ID, "com.x.Line");
    replaced.release(instances(4));
    await stale;
    expect(entry()).toMatchObject({ className: "com.x.Line", result: instances(5), loading: false });

    const forgotten = later();
    ipc.debugJvmMemoryInstances.mockReturnValueOnce(forgotten.promise);
    const gone = showInstances(ID, CLASS);
    forgetInstances(ID);
    forgotten.release(instances());
    await gone;
    expect(useInstances.getState().bySession[ID]).toBeUndefined();
  });

  it("a late node reply for a replaced list is ignored", async () => {
    ipc.debugJvmMemoryInstances.mockReturnValueOnce(ok(instances()));
    await showInstances(ID, CLASS);
    const slow = later();
    ipc.debugJvmMemoryFields.mockReturnValueOnce(slow.promise);
    const pending = loadFields(ID, ref);
    ipc.debugJvmMemoryInstances.mockReturnValueOnce(ok(instances(3)));
    await showInstances(ID, "com.x.Line");
    slow.release(fields);
    await pending;
    expect(entry().nodes).toEqual({});
  });

  it("a timed-out list can be retried", async () => {
    setStops(1);
    const timedOut: JvmInstancesResult = { status: "unavailable", reason: { kind: "timedOut" } };
    ipc.debugJvmMemoryInstances.mockReturnValueOnce(ok(timedOut));
    await showInstances(ID, CLASS);
    expect(entry()).toMatchObject({ result: timedOut, loading: false, error: null });

    ipc.debugJvmMemoryInstances.mockReturnValueOnce(ok(instances()));
    await showInstances(ID, CLASS);
    expect(ipc.debugJvmMemoryInstances).toHaveBeenCalledTimes(2);
    expect(entry()).toMatchObject({ result: instances(), loading: false });
  });
});

describe("loadFields", () => {
  beforeEach(async () => {
    ipc.debugJvmMemoryInstances.mockReturnValue(ok(instances()));
    await showInstances(ID, CLASS);
  });

  it("loadFields keys nodes by generation and id", async () => {
    ipc.debugJvmMemoryFields.mockReturnValue(ok(fields));
    await loadFields(ID, ref);
    expect(ipc.debugJvmMemoryFields).toHaveBeenCalledWith(ID, ref);
    expect(entry().nodes["2:7"]).toEqual({
      fields,
      referrers: null,
      loadingFields: false,
      loadingReferrers: false,
      error: null,
    });
  });

  it("keeps fields and referrers of one node apart", async () => {
    ipc.debugJvmMemoryFields.mockReturnValue(ok(fields));
    ipc.debugJvmMemoryReferrers.mockReturnValue(ok(referrers));
    await loadFields(ID, ref);
    await loadReferrers(ID, ref);
    expect(entry().nodes["2:7"]).toMatchObject({ fields, referrers });
  });

  it("records a failure on the node and keeps what it had", async () => {
    ipc.debugJvmMemoryFields.mockReturnValueOnce(ok(fields));
    await loadFields(ID, ref);
    ipc.debugJvmMemoryFields.mockReturnValueOnce(fail("boom"));
    await loadFields(ID, ref);
    expect(entry().nodes["2:7"]).toMatchObject({ fields, error: "boom", loadingFields: false });
  });

  it("does nothing without an open list", async () => {
    closeInstances(ID);
    await loadFields(ID, ref);
    expect(ipc.debugJvmMemoryFields).not.toHaveBeenCalled();
    expect(useInstances.getState().bySession[ID]).toBeUndefined();
  });

  it("ignores a second request for the same node while it is loading", async () => {
    const pending = later();
    ipc.debugJvmMemoryFields.mockReturnValueOnce(pending.promise);
    const first = loadFields(ID, ref);
    expect(entry().nodes["2:7"]!.loadingFields).toBe(true);
    await loadFields(ID, ref);
    expect(ipc.debugJvmMemoryFields).toHaveBeenCalledTimes(1);
    pending.release(fields);
    await first;
    expect(entry().nodes["2:7"]!.fields).toEqual(fields);
  });

  it("a timed-out node can be retried", async () => {
    const timedOut: JvmFieldsResult = { status: "unavailable", reason: { kind: "timedOut" } };
    ipc.debugJvmMemoryFields.mockReturnValueOnce(ok(timedOut));
    await loadFields(ID, ref);
    expect(entry().nodes["2:7"]).toMatchObject({ fields: timedOut, loadingFields: false });

    ipc.debugJvmMemoryFields.mockReturnValueOnce(ok(fields));
    await loadFields(ID, ref);
    expect(entry().nodes["2:7"]).toMatchObject({ fields, loadingFields: false });
  });
});

describe("loadReferrers", () => {
  beforeEach(async () => {
    ipc.debugJvmMemoryInstances.mockReturnValue(ok(instances()));
    await showInstances(ID, CLASS);
  });

  it("loadReferrers asks for 50", async () => {
    ipc.debugJvmMemoryReferrers.mockReturnValue(ok(referrers));
    await loadReferrers(ID, ref);
    expect(ipc.debugJvmMemoryReferrers).toHaveBeenCalledWith(ID, ref, 50);
    expect(entry().nodes["2:7"]).toMatchObject({ referrers, loadingReferrers: false, error: null });
  });

  it("a timed-out node can be retried", async () => {
    const timedOut: JvmReferrersResult = { status: "unavailable", reason: { kind: "timedOut" } };
    ipc.debugJvmMemoryReferrers.mockReturnValueOnce(ok(timedOut));
    await loadReferrers(ID, ref);
    ipc.debugJvmMemoryReferrers.mockReturnValueOnce(ok(referrers));
    await loadReferrers(ID, ref);
    expect(entry().nodes["2:7"]).toMatchObject({ referrers, loadingReferrers: false });
  });
});

describe("staleness and cleanup", () => {
  it("is outdated once another stop happened", async () => {
    setStops(2);
    ipc.debugJvmMemoryInstances.mockReturnValue(ok(instances()));
    await showInstances(ID, CLASS);
    expect(instancesOutdated(entry(), 2)).toBe(false);
    expect(instancesOutdated(entry(), 3)).toBe(true);
  });

  it("closing a list removes it", async () => {
    ipc.debugJvmMemoryInstances.mockReturnValue(ok(instances()));
    await showInstances(ID, CLASS);
    closeInstances(ID);
    expect(useInstances.getState().bySession[ID]).toBeUndefined();
  });
});

describe("debug events", () => {
  it("capabilities event reloads capabilities; jvmBackend event is stored", async () => {
    adoptSession(ID, { adapter: "java-debug" });
    await Promise.resolve();
    ipc.debugCapabilities.mockClear();
    const caps = { jvmInstances: true };
    ipc.debugCapabilities.mockResolvedValue({ status: "ok", data: caps });

    handleDebugEvent(ID, { kind: "capabilities" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ipc.debugCapabilities).toHaveBeenCalledWith(ID);
    expect(useDebug.getState().sessions[ID]!.caps).toEqual(caps);

    handleDebugEvent(ID, { kind: "jvmBackend", state: { kind: "degraded", detail: "forwarding only" } });
    expect(useDebug.getState().sessions[ID]!.jvmBackend).toEqual({ kind: "degraded", detail: "forwarding only" });
  });
});
