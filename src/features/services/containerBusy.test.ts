import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  snapshot: vi.fn(),
  op: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: {
    dockerSnapshot: backend.snapshot,
    dockerContainerOp: backend.op,
    dockerRemove: backend.remove,
  },
}));
import type { DockerContainer } from "@/platform/ipc";
import type { DockerTarget } from "./model";
import { canRestart, canStart, canStop, restart, start, targetBusy } from "./ops";
import { busyOp, containerOp, useServices } from "./store";

const ok = <T>(data: T) => ({ status: "ok" as const, data });
const box = { id: "box", name: "Box", endpoint: { kind: "default" } };
const container = { id: "c1", name: "web", state: "exited", status: "Exited (0)" } as DockerContainer;
const target: DockerTarget = { conn: "box", node: { kind: "container", key: "container:c1", container } };

beforeEach(() => {
  for (const f of Object.values(backend)) f.mockReset();
  backend.snapshot.mockResolvedValue(ok({ availability: { kind: "ready", context: null }, errors: [] }));
  useServices.setState({ settings: { connections: [box], registries: [] } as never, conns: {}, task: null });
});

describe("container operations in progress", () => {
  it("disable the container's actions until the snapshot after them has loaded", async () => {
    let finish!: () => void;
    backend.op.mockReturnValue(new Promise((resolve) => (finish = () => resolve(ok(null)))));
    const running = start(target);
    await vi.waitFor(() => expect(backend.op).toHaveBeenCalledTimes(1));

    expect(busyOp("box", ["c1"])).toBe("start");
    expect(targetBusy(target)).toBe("start");
    expect([canStart(target), canStop(target), canRestart(target)]).toEqual([false, false, false]);

    // A second click while the first runs does nothing.
    await restart(target);
    expect(backend.op).toHaveBeenCalledTimes(1);

    finish();
    await running;
    expect(backend.snapshot).toHaveBeenCalled();
    expect(busyOp("box", ["c1"])).toBeNull();
    expect(canStart(target)).toBe(true);
  });

  it("release the container when the operation fails", async () => {
    backend.op.mockRejectedValue(new Error("daemon gone"));
    expect(await containerOp("box", ["c1"], "stop")).toBe(false);
    expect(busyOp("box", ["c1"])).toBeNull();
  });
});
