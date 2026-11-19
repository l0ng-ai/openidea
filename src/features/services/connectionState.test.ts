import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ snapshot: vi.fn(), events: vi.fn(), cancel: vi.fn(), settings: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: {
    dockerSettings: backend.settings,
    dockerSnapshot: backend.snapshot,
    dockerEvents: backend.events,
    cancelRequest: backend.cancel,
  },
}));
import { connectConnection, connectionState, disconnectConnection, refresh, useServices, watch } from "./store";

const ready = { availability: { kind: "ready", context: null }, errors: [] };
const ok = <T>(data: T) => ({ status: "ok" as const, data });

beforeEach(() => {
  for (const f of Object.values(backend)) f.mockReset();
  backend.snapshot.mockResolvedValue(ok(ready));
  backend.events.mockReturnValue(new Promise(() => {}));
  backend.settings.mockResolvedValue(
    ok({ connections: [{ id: "box", name: "Box", endpoint: { kind: "default" } }], registries: [] }),
  );
  useServices.setState({
    settings: { connections: [{ id: "box", name: "Box", endpoint: { kind: "default" } }], registries: [] } as never,
    conns: {},
  });
});

describe("Docker connections", () => {
  it("stop talking to the daemon while disconnected, and connect again on Connect", async () => {
    const stop = watch();
    await vi.waitFor(() => expect(connectionState("box").snapshot).not.toBeNull());
    expect(backend.events).toHaveBeenCalledOnce();

    disconnectConnection("box");
    expect(backend.cancel).toHaveBeenCalledOnce();
    expect(connectionState("box")).toMatchObject({ snapshot: null, disconnected: true });
    backend.snapshot.mockClear();
    await refresh("box");
    expect(backend.snapshot).not.toHaveBeenCalled();

    await connectConnection("box");
    expect(backend.snapshot).toHaveBeenCalledOnce();
    expect(connectionState("box")).toMatchObject({ disconnected: false, snapshot: ready });
    stop();
  });
});
