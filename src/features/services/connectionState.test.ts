import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  snapshot: vi.fn(),
  events: vi.fn(),
  cancel: vi.fn(),
  settings: vi.fn(),
  saveSettings: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: {
    dockerSettings: backend.settings,
    dockerSnapshot: backend.snapshot,
    dockerEvents: backend.events,
    cancelRequest: backend.cancel,
    dockerSaveSettings: backend.saveSettings,
    dockerDisconnect: backend.disconnect,
  },
}));
import {
  connectConnection,
  connectionState,
  disconnectConnection,
  refresh,
  removeConnection,
  saveConnection,
  useServices,
  watch,
} from "./store";

const ready = { availability: { kind: "ready", context: null }, errors: [] };
const ok = <T>(data: T) => ({ status: "ok" as const, data });

beforeEach(() => {
  for (const f of Object.values(backend)) f.mockReset();
  backend.snapshot.mockResolvedValue(ok(ready));
  backend.events.mockReturnValue(new Promise(() => {}));
  backend.saveSettings.mockResolvedValue(ok(null));
  backend.disconnect.mockResolvedValue(ok(null));
  backend.settings.mockResolvedValue(
    ok({ connections: [{ id: "box", name: "Box", endpoint: { kind: "default" } }], registries: [] }),
  );
  useServices.setState({
    settings: { connections: [{ id: "box", name: "Box", endpoint: { kind: "default" } }], registries: [] } as never,
    conns: {},
  });
});

describe("Docker connections", () => {
  it("skips a saved disconnected connection on startup and during polling", async () => {
    vi.resetModules();
    const { connectionState, watch } = await import("./store");
    const paused = { id: "paused", name: "Paused", endpoint: { kind: "ssh", config: "build" }, disconnected: true };
    const active = { id: "active", name: "Active", endpoint: { kind: "tcp", host: "build:2376" } };
    backend.settings.mockResolvedValueOnce(ok({ connections: [paused, active], registries: [] }));
    backend.snapshot.mockResolvedValue(ok({ availability: { kind: "daemonDown", message: "Offline" }, errors: [] }));

    vi.useFakeTimers();
    const stop = watch();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(backend.snapshot.mock.calls).toEqual([[active.endpoint]]);
      expect(connectionState(paused.id)).toMatchObject({ disconnected: true, snapshot: null });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(backend.snapshot.mock.calls).toEqual([[active.endpoint], [active.endpoint]]);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("stop talking to the daemon while disconnected, and connect again on Connect", async () => {
    const stop = watch();
    await vi.waitFor(() => expect(connectionState("box").snapshot).not.toBeNull());
    expect(backend.events).toHaveBeenCalledOnce();

    await disconnectConnection("box");
    expect(backend.cancel).toHaveBeenCalledOnce();
    expect(connectionState("box")).toMatchObject({ snapshot: null, disconnected: true });
    expect(backend.saveSettings).toHaveBeenLastCalledWith({
      connections: [expect.objectContaining({ id: "box", disconnected: true })],
      registries: [],
    });
    backend.snapshot.mockClear();
    await refresh("box");
    expect(backend.snapshot).not.toHaveBeenCalled();

    await connectConnection("box");
    expect(backend.snapshot).toHaveBeenCalledOnce();
    expect(connectionState("box")).toMatchObject({ disconnected: false, snapshot: ready });
    expect(backend.saveSettings).toHaveBeenLastCalledWith({
      connections: [expect.objectContaining({ id: "box", disconnected: false })],
      registries: [],
    });
    stop();
  });

  it("preserves the saved disconnect when editing the connection concurrently", async () => {
    const edited = { id: "box", name: "Edited box", endpoint: { kind: "default" } } as const;
    await Promise.all([disconnectConnection("box"), saveConnection(edited)]);
    expect(backend.saveSettings).toHaveBeenLastCalledWith({
      connections: [{ ...edited, disconnected: true }],
      registries: [],
    });
  });

  describe("over SSH", () => {
    const box = { id: "box", name: "Box", endpoint: { kind: "ssh", config: "build" } };
    const twin = { id: "twin", name: "Box again", endpoint: { kind: "ssh", config: "build" } };
    const local = { id: "local", name: "Local", endpoint: { kind: "default" } };
    const connect = (...connections: object[]) =>
      useServices.setState({ settings: { connections, registries: [] } as never, conns: {} });

    it("closes the tunnel on Disconnect, after a snapshot in flight", async () => {
      connect(box, local);
      let finish!: () => void;
      backend.snapshot.mockReturnValueOnce(new Promise((resolve) => (finish = () => resolve(ok(ready)))));
      const reading = refresh("box");
      await disconnectConnection("box");
      await Promise.resolve();
      expect(backend.disconnect).not.toHaveBeenCalled();
      finish();
      await reading;
      await vi.waitFor(() => expect(backend.disconnect).toHaveBeenCalledExactlyOnceWith(box.endpoint));
      expect(connectionState("box")).toMatchObject({ snapshot: null, disconnected: true });
    });

    it("keeps the tunnel when Connect comes before the snapshot in flight ends", async () => {
      connect(box);
      let finish!: () => void;
      backend.snapshot.mockReturnValueOnce(new Promise((resolve) => (finish = () => resolve(ok(ready)))));
      const reading = refresh("box");
      const disconnecting = disconnectConnection("box");
      const connecting = connectConnection("box");
      finish();
      await Promise.all([reading, disconnecting, connecting]);
      await vi.waitFor(() => expect(connectionState("box").snapshot).toEqual(ready));
      expect(backend.disconnect).not.toHaveBeenCalled();
    });

    it("keeps a tunnel another connected connection uses, until that one disconnects too", async () => {
      connect(box, twin);
      await disconnectConnection("box");
      await new Promise((r) => setTimeout(r, 0));
      expect(backend.disconnect).not.toHaveBeenCalled();
      await disconnectConnection("twin");
      await vi.waitFor(() => expect(backend.disconnect).toHaveBeenCalledExactlyOnceWith(box.endpoint));
    });

    it("closes the tunnel of a removed connection", async () => {
      connect(box, local);
      await removeConnection("box");
      await vi.waitFor(() => expect(backend.disconnect).toHaveBeenCalledExactlyOnceWith(box.endpoint));
      expect(useServices.getState().conns.box).toBeUndefined();
    });

    it("leaves other endpoints alone: they keep nothing open", async () => {
      connect(local);
      await disconnectConnection("local");
      await removeConnection("local");
      await new Promise((r) => setTimeout(r, 0));
      expect(backend.disconnect).not.toHaveBeenCalled();
    });

    it("matches the configuration as the backend does, ignoring surrounding spaces", async () => {
      connect(box, { ...twin, endpoint: { kind: "ssh", config: " build " } });
      await disconnectConnection("box");
      await new Promise((r) => setTimeout(r, 0));
      expect(backend.disconnect).not.toHaveBeenCalled();
    });

    it("closes the old tunnel when a connection moves to another configuration", async () => {
      connect(box, local);
      await saveConnection({ ...box, endpoint: { kind: "ssh", config: "staging" } } as never);
      await vi.waitFor(() => expect(backend.disconnect).toHaveBeenCalledExactlyOnceWith(box.endpoint));
    });

    it("waits for a close in progress before Connect reads the daemon again", async () => {
      connect(box);
      let closed!: () => void;
      backend.disconnect.mockReturnValueOnce(new Promise((resolve) => (closed = () => resolve(ok(null)))));
      await disconnectConnection("box");
      await vi.waitFor(() => expect(backend.disconnect).toHaveBeenCalledOnce());
      backend.snapshot.mockClear();
      const connecting = connectConnection("box");
      await new Promise((r) => setTimeout(r, 0));
      expect(backend.snapshot).not.toHaveBeenCalled();
      closed();
      await connecting;
      expect(backend.snapshot).toHaveBeenCalledOnce();
    });
  });
});
