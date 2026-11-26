import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeWebArgs,
  initWebRuntime,
  isWebMode,
  resolveWebSocketUrl,
  shouldActivateWebRuntime,
  takeOverWebSession,
  useWebConnection,
} from "./webBridge";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  sent: unknown[] = [];
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, fn: (ev: unknown) => void) {
    let list = this.listeners.get(type);
    if (!list) {
      list = [];
      this.listeners.set(type, list);
    }
    list.push(fn);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  receive(msg: unknown) {
    this.emit("message", { data: JSON.stringify(msg) });
  }

  private emit(type: string, ev: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

describe("webBridge", () => {
  const originalWs = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    document.head.innerHTML = "";
    sessionStorage.clear();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
    useWebConnection.setState({
      active: false,
      status: "idle",
      windowLabel: "main",
      serverHome: "",
      serverOs: "linux",
    });
  });

  afterEach(() => {
    globalThis.WebSocket = originalWs;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves WebSocket URLs relative to direct and reverse-proxied page URLs", () => {
    expect(resolveWebSocketUrl("http://localhost:8080/")).toBe("ws://localhost:8080/api/ws");
    expect(resolveWebSocketUrl("https://host.example/user/proj/r/session/abc/")).toBe(
      "wss://host.example/user/proj/r/session/abc/api/ws",
    );
    expect(resolveWebSocketUrl("https://host.example/ide/?project=/workspace#top")).toBe(
      "wss://host.example/ide/api/ws",
    );
  });

  it("encodes Tauri Channel arguments into $channel objects", () => {
    const fakeChannel = { __TAURI_TO_IPC_KEY__: () => "__CHANNEL__:42" };
    expect(encodeWebArgs({ path: "/tmp/a", onEvent: fakeChannel, nested: [fakeChannel] })).toEqual({
      path: "/tmp/a",
      onEvent: { $channel: 42 },
      nested: [{ $channel: 42 }],
    });
  });

  it("activates only when the openidea-web meta tag is present and native Tauri is absent", () => {
    expect(shouldActivateWebRuntime()).toBe(false);
    const meta = document.createElement("meta");
    meta.name = "openidea-web";
    meta.content = "1";
    document.head.appendChild(meta);
    expect(shouldActivateWebRuntime()).toBe(true);

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(shouldActivateWebRuntime()).toBe(false);
  });

  it("installs Tauri internals over WebSocket, handles invoke, channels, events, and plugin shims", async () => {
    const meta = document.createElement("meta");
    meta.name = "openidea-web";
    meta.content = "1";
    document.head.appendChild(meta);

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const boot = initWebRuntime();
    await new Promise((r) => setTimeout(r, 0));
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.sent[0]).toEqual({ type: "hello", window: "main" });

    ws.receive({
      type: "ready",
      window: "main",
      instance: "a",
      server: { version: "0.1.38", protocol: 2, os: "linux", arch: "x86_64", home: "/home/dev" },
    });

    await expect(boot).resolves.toBe(true);
    expect(isWebMode()).toBe(true);

    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
          transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
        };
      }
    ).__TAURI_INTERNALS__;

    // Plugin shims work locally without hitting WebSocket.
    await internals.invoke("plugin:window|set_title", { title: "My Project" });
    expect(document.title).toBe("My Project");
    await expect(internals.invoke("plugin:path|resolve_directory", { directory: 21 })).resolves.toBe("/home/dev");
    await expect(internals.invoke("plugin:window|get_all_windows")).resolves.toEqual(["main"]);

    // Command invoke + response.
    const req = internals.invoke("app_info", {}) as Promise<unknown>;
    const sentInvoke = ws.sent[1] as { type: string; id: number; cmd: string };
    expect(sentInvoke.type).toBe("invoke");
    expect(sentInvoke.cmd).toBe("app_info");
    ws.receive({ type: "response", id: sentInvoke.id, ok: true, data: { version: "0.1.38" } });
    await expect(req).resolves.toEqual({ version: "0.1.38" });

    // Channel streaming delivers ordered frames and cleans up on channelEnd.
    const received: unknown[] = [];
    const cbId = internals.transformCallback((msg: unknown) => received.push(msg)) as number;
    const chObj = { __TAURI_TO_IPC_KEY__: () => `__CHANNEL__:${cbId}` };
    const streamReq = internals.invoke("terminal_spawn", { onOutput: chObj }) as Promise<unknown>;
    const sentStream = ws.sent[2] as { id: number; args: { onEvent?: unknown; onOutput: { $channel: number } } };
    expect(sentStream.args.onOutput).toEqual({ $channel: cbId });
    ws.receive({ type: "channel", id: cbId, data: "hello " });
    ws.receive({ type: "channel", id: cbId, data: "world" });
    ws.receive({ type: "response", id: sentStream.id, ok: true, data: 1 });
    await expect(streamReq).resolves.toBe(1);
    ws.receive({ type: "channelEnd", id: cbId });
    // Further frames after channelEnd are ignored because the callback was unregistered.
    ws.receive({ type: "channel", id: cbId, data: "late" });
    expect(received).toEqual([
      { index: 0, message: "hello " },
      { index: 1, message: "world" },
      { index: 2, end: true },
    ]);

    // Backend events reach ide://event listeners and unlisten removes the callback.
    const events: unknown[] = [];
    const evCb = internals.transformCallback((e: unknown) => events.push(e)) as number;
    const eventId = (await internals.invoke("plugin:event|listen", { event: "ide://event", handler: evCb })) as number;
    ws.receive({ type: "event", window: "main", event: { type: "settingsChanged", key: "appearance.theme" } });
    expect(events).toHaveLength(1);
    expect((events[0] as { payload: unknown }).payload).toEqual({ type: "settingsChanged", key: "appearance.theme" });
    await internals.invoke("plugin:event|unlisten", { event: "ide://event", eventId });
    ws.receive({ type: "event", window: "main", event: { type: "settingsChanged", key: "appearance.theme" } });
    expect(events).toHaveLength(1);

    // Dropping the socket enters reconnecting state.
    ws.close();
    expect(useWebConnection.getState().status).toBe("reconnecting");
  });

  it("handles superseded without auto-reconnecting and reconnects on takeOverWebSession", async () => {
    vi.useFakeTimers();

    const meta = document.createElement("meta");
    meta.name = "openidea-web";
    meta.content = "1";
    document.head.appendChild(meta);

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const boot = initWebRuntime();
    await Promise.resolve();
    const firstWs = FakeWebSocket.instances[0]!;
    firstWs.receive({
      type: "ready",
      window: "main",
      instance: "a",
      server: { version: "0.1.38", protocol: 2, os: "linux", arch: "x86_64", home: "/home/dev" },
    });
    await expect(boot).resolves.toBe(true);
    expect(useWebConnection.getState().status).toBe("connected");

    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;

    const pendingCall = internals.invoke("app_info", {});
    firstWs.receive({ type: "superseded" });

    await expect(pendingCall).rejects.toEqual({
      kind: "io",
      message: "Session opened in another browser tab",
    });
    expect(useWebConnection.getState().status).toBe("superseded");
    expect(firstWs.readyState).toBe(FakeWebSocket.CLOSED);

    // Must not schedule auto-reconnect after being superseded.
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(useWebConnection.getState().status).toBe("superseded");

    // Taking over opens a fresh WebSocket and returns to connected once ready arrives.
    takeOverWebSession();
    expect(useWebConnection.getState().status).toBe("connecting");
    expect(FakeWebSocket.instances).toHaveLength(2);

    await Promise.resolve();
    const secondWs = FakeWebSocket.instances[1]!;
    expect(secondWs.sent[0]).toEqual({ type: "hello", window: "main" });

    secondWs.receive({
      type: "ready",
      window: "main",
      instance: "a",
      server: { version: "0.1.38", protocol: 2, os: "linux", arch: "x86_64", home: "/home/dev" },
    });
    expect(useWebConnection.getState().status).toBe("connected");
  });

  it("reloads the page when it reconnects to a restarted server", async () => {
    vi.useFakeTimers();
    const meta = document.createElement("meta");
    meta.name = "openidea-web";
    meta.content = "1";
    document.head.appendChild(meta);
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as Location);
    const server = { version: "0.1.38", protocol: 2, os: "linux", arch: "x86_64", home: "/home/dev" };

    const boot = initWebRuntime();
    await Promise.resolve();
    FakeWebSocket.instances[0]!.receive({ type: "ready", window: "main", instance: "a", server });
    await expect(boot).resolves.toBe(true);

    // The same server again: the page keeps its state.
    FakeWebSocket.instances[0]!.close();
    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[1]!.receive({ type: "ready", window: "main", instance: "a", server });
    expect(reload).not.toHaveBeenCalled();
    expect(useWebConnection.getState().status).toBe("connected");

    // A restarted server: its projects and runs are gone, so the page starts over.
    FakeWebSocket.instances[1]!.close();
    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[2]!.receive({ type: "ready", window: "main", instance: "b", server });
    expect(reload).toHaveBeenCalledOnce();
  });
});
