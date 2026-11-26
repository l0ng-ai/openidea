/**
 * Browser runtime bridge for `openidea-server --web`.
 *
 * When the page is served by `openidea-server --web` (indicated by `<meta name="openidea-web" content="1">`),
 * this module opens a WebSocket to `api/ws` (resolved relative to `window.location.href` so reverse-proxy
 * subpaths work automatically) and installs a lightweight `window.__TAURI_INTERNALS__` shim backed by that
 * WebSocket. All generated `commands.*`, streaming `Channel`s, and `onIdeEvent` subscriptions then run
 * unmodified against the remote Rust `Host`.
 */
import { create } from "zustand";

export type WebConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "superseded";

interface WebConnectionState {
  active: boolean;
  status: WebConnectionStatus;
  windowLabel: string;
  serverHome: string;
  serverOs: string;
}

export const useWebConnection = create<WebConnectionState>(() => ({
  active: false,
  status: "idle",
  windowLabel: "main",
  serverHome: "",
  serverOs: "linux",
}));

/** True when this page is connected to `openidea-server --web` in a regular browser. */
export function isWebMode(): boolean {
  return useWebConnection.getState().active;
}

let triggerTakeOver: (() => void) | null = null;

/** Reconnects and reclaims this window session after another browser tab took over. */
export function takeOverWebSession(): void {
  if (!useWebConnection.getState().active || !triggerTakeOver) return;
  triggerTakeOver();
}

const WINDOW_SESSION_KEY = "openidea.web.window";
const SERIALIZE_TO_IPC_FN = "__TAURI_TO_IPC_KEY__";
const CHANNEL_RE = /^__CHANNEL__:(\d+)$/;

interface ReadyMessage {
  type: "ready";
  window: string;
  instance: string;
  server: {
    version: string;
    protocol: number;
    os: string;
    arch: string;
    home: string;
  };
}

interface ResponseMessage {
  type: "response";
  id: number;
  ok: boolean;
  data?: unknown;
  error?: unknown;
}

interface ChannelFrameMessage {
  type: "channel";
  id: number;
  data: unknown;
}

interface ChannelEndFrameMessage {
  type: "channelEnd";
  id: number;
}

interface EventFrameMessage {
  type: "event";
  window: string | null;
  event: unknown;
}

interface PongMessage {
  type: "pong";
}

interface SupersededMessage {
  type: "superseded";
}

type ServerMessage =
  | ReadyMessage
  | ResponseMessage
  | ChannelFrameMessage
  | ChannelEndFrameMessage
  | EventFrameMessage
  | PongMessage
  | SupersededMessage;

/** Resolves the WebSocket endpoint relative to `pageHref` (preserving any reverse-proxy subpath). */
export function resolveWebSocketUrl(pageHref: string): string {
  const url = new URL("api/ws", pageHref);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.hash = "";
  return url.toString();
}

/** Replaces Tauri `Channel` objects in command arguments with `{ $channel: id }` markers for the server. */
export function encodeWebArgs(value: unknown, channels?: number[]): unknown {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => encodeWebArgs(item, channels));
  const record = value as Record<string, unknown>;
  if (typeof record[SERIALIZE_TO_IPC_FN] === "function") {
    const serialized = (record[SERIALIZE_TO_IPC_FN] as () => unknown)();
    if (typeof serialized === "string") {
      const m = CHANNEL_RE.exec(serialized);
      if (m) {
        const id = Number(m[1]);
        channels?.push(id);
        return { $channel: id };
      }
    }
    return serialized;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v !== undefined) out[k] = encodeWebArgs(v, channels);
  }
  return out;
}

/** Detects whether the current page should boot the web server bridge. */
export function shouldActivateWebRuntime(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) return false;
  if (document.querySelector('meta[name="openidea-web"]')?.getAttribute("content") === "1") return true;
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("openidea-web")) return true;
  return false;
}

function allocateWindowLabel(): string {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("window")?.trim();
  if (explicit) {
    try {
      sessionStorage.setItem(WINDOW_SESSION_KEY, explicit);
    } catch {
      /* storage unavailable */
    }
    return explicit;
  }
  try {
    const saved = sessionStorage.getItem(WINDOW_SESSION_KEY);
    if (saved) return saved;
  } catch {
    /* storage unavailable */
  }
  const label = params.has("newWindow") ? `web-${Math.random().toString(36).slice(2, 10)}` : "main";
  try {
    sessionStorage.setItem(WINDOW_SESSION_KEY, label);
  } catch {
    /* storage unavailable */
  }
  return label;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Connects to `openidea-server --web` and installs the `window.__TAURI_INTERNALS__` shim.
 * Returns `false` when running in native Tauri desktop or standalone frontend dev/test mode.
 */
export async function initWebRuntime(): Promise<boolean> {
  if (!shouldActivateWebRuntime()) return false;

  const windowLabel = allocateWindowLabel();
  const requestedProject = new URLSearchParams(window.location.search).get("project");
  const wsUrl = resolveWebSocketUrl(window.location.href);

  let nextCallbackId = 1;
  let nextEventId = 1;
  let nextInvokeId = 1;
  let serverHome = "";
  let serverInstance: string | null = null;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;

  const callbacks = new Map<number, { fn: (payload: unknown) => void; once: boolean }>();
  const channelSeq = new Map<number, number>();
  const activeChannels = new Set<number>();
  const eventListeners = new Map<string, Map<number, number>>();
  const pending = new Map<number, PendingCall>();

  const removeEventListener = (event: string, eventId: number) => {
    const map = eventListeners.get(event);
    if (!map) return;
    const callbackId = map.get(eventId);
    map.delete(eventId);
    if (map.size === 0) eventListeners.delete(event);
    if (callbackId !== undefined) {
      callbacks.delete(callbackId);
      channelSeq.delete(callbackId);
    }
  };

  const dispatchLocalEvent = (eventName: string, payload: unknown) => {
    const listeners = eventListeners.get(eventName);
    if (!listeners) return;
    for (const [id, callbackId] of [...listeners.entries()]) {
      const cb = callbacks.get(callbackId);
      if (!cb) continue;
      if (cb.once) removeEventListener(eventName, id);
      try {
        cb.fn({ event: eventName, id, payload });
      } catch (e) {
        console.error(`Error in event listener for ${eventName}`, e);
      }
    }
  };

  const deliverChannel = (id: number, data: unknown) => {
    const cb = callbacks.get(id);
    if (!cb) return;
    const index = channelSeq.get(id) ?? 0;
    channelSeq.set(id, index + 1);
    cb.fn({ index, message: data });
  };

  const endChannel = (id: number) => {
    activeChannels.delete(id);
    const cb = callbacks.get(id);
    const index = channelSeq.get(id) ?? 0;
    if (cb) {
      try {
        cb.fn({ index, end: true });
      } catch {
        /* ignore cleanup errors from listener */
      }
    }
    callbacks.delete(id);
    channelSeq.delete(id);
  };

  const endAllActiveChannels = () => {
    for (const id of [...activeChannels]) {
      endChannel(id);
    }
  };

  const rejectAllPending = (message: string) => {
    for (const [id, call] of pending.entries()) {
      pending.delete(id);
      call.reject({ kind: "io", message });
    }
  };

  const handlePluginCommand = (cmd: string, args: Record<string, unknown>): unknown => {
    switch (cmd) {
      case "plugin:event|listen": {
        const event = String(args.event ?? "");
        const handler = Number(args.handler ?? 0);
        const id = nextEventId++;
        let map = eventListeners.get(event);
        if (!map) {
          map = new Map();
          eventListeners.set(event, map);
        }
        map.set(id, handler);
        return id;
      }
      case "plugin:event|unlisten": {
        const event = String(args.event ?? "");
        const eventId = Number(args.eventId ?? 0);
        removeEventListener(event, eventId);
        return null;
      }
      case "plugin:event|emit":
      case "plugin:event|emit_to": {
        const event = String(args.event ?? "");
        dispatchLocalEvent(event, args.payload);
        return null;
      }
      case "plugin:window|set_title": {
        if (typeof args.title === "string") document.title = args.title;
        return null;
      }
      // One browser tab is one window with one webview.
      case "plugin:window|get_all_windows":
        return [windowLabel];
      case "plugin:webview|get_all_webviews":
        return [{ windowLabel, label: windowLabel }];
      case "plugin:window|is_fullscreen":
        return Boolean(document.fullscreenElement);
      case "plugin:window|is_maximized":
        return true;
      case "plugin:window|is_minimized":
        return false;
      case "plugin:window|is_focused":
        return document.hasFocus();
      case "plugin:window|is_visible":
        return !document.hidden;
      case "plugin:window|scale_factor":
        return window.devicePixelRatio || 1;
      case "plugin:window|inner_size":
      case "plugin:window|outer_size":
        return { width: window.innerWidth, height: window.innerHeight };
      case "plugin:window|inner_position":
      case "plugin:window|outer_position":
        return { x: 0, y: 0 };
      case "plugin:window|theme":
        return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      case "plugin:window|set_focus":
        window.focus();
        return null;
      case "plugin:path|resolve_directory": {
        const dir = Number(args.directory ?? 0);
        // BaseDirectory.Home = 21 in @tauri-apps/api/path
        if (dir === 21) return serverHome || "/";
        return serverHome || "/";
      }
      case "plugin:path|join": {
        const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
        return paths.join("/").replace(/\/+/g, "/");
      }
      default:
        if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) return null;
        return undefined;
    }
  };

  const invoke = (cmd: string, rawArgs?: Record<string, unknown>): Promise<unknown> => {
    const args = rawArgs ?? {};
    if (cmd.startsWith("plugin:")) {
      const local = handlePluginCommand(cmd, args);
      if (local !== undefined) return Promise.resolve(local);
    }
    const callChannels: number[] = [];
    const encoded = encodeWebArgs(args, callChannels);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      for (const cid of callChannels) endChannel(cid);
      return Promise.reject({ kind: "io", message: "Not connected to OpenIDEA server" });
    }
    const id = nextInvokeId++;
    for (const cid of callChannels) activeChannels.add(cid);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        ws!.send(JSON.stringify({ type: "invoke", id, cmd, args: encoded }));
      } catch (e) {
        pending.delete(id);
        for (const cid of callChannels) endChannel(cid);
        reject({ kind: "io", message: e instanceof Error ? e.message : String(e) });
      }
    });
  };

  const internals = {
    invoke,
    transformCallback: (callback?: (payload: unknown) => void, once = false) => {
      const id = nextCallbackId++;
      if (callback) callbacks.set(id, { fn: callback, once });
      return id;
    },
    unregisterCallback: (id: number) => {
      activeChannels.delete(id);
      callbacks.delete(id);
      channelSeq.delete(id);
    },
    convertFileSrc: (filePath: string) => filePath,
    metadata: {
      currentWindow: { label: windowLabel },
      currentWebview: { windowLabel, label: windowLabel },
      windows: [{ label: windowLabel }],
      webviews: [{ windowLabel, label: windowLabel }],
    },
  };

  const eventInternals = {
    unregisterListener: (event: string, eventId: number) => {
      removeEventListener(event, eventId);
    },
  };

  Object.assign(window, {
    __TAURI_INTERNALS__: internals,
    __TAURI_EVENT_PLUGIN_INTERNALS__: eventInternals,
  });

  useWebConnection.setState({ active: true, status: "connecting", windowLabel });

  const connect = (isInitial: boolean): Promise<void> =>
    new Promise((resolveInitial, rejectInitial) => {
      let settled = false;
      let superseded = false;
      const socket = new WebSocket(wsUrl);
      ws = socket;

      const initialTimer = isInitial
        ? window.setTimeout(() => {
            if (!settled) {
              settled = true;
              socket.close();
              rejectInitial(new Error(`Timed out connecting to OpenIDEA server at ${wsUrl}`));
            }
          }, 15_000)
        : null;

      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "hello",
            window: windowLabel,
            ...(isInitial && requestedProject ? { project: requestedProject } : {}),
          }),
        );
      });

      socket.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case "ready": {
            // A restarted server has none of this page's projects, terminals or runs: start over.
            // The unsaved-changes guard still asks before the page goes.
            if (serverInstance !== null && serverInstance !== msg.instance) {
              window.location.reload();
              return;
            }
            serverInstance = msg.instance;
            serverHome = msg.server.home;
            reconnectAttempt = 0;
            useWebConnection.setState({
              active: true,
              status: "connected",
              windowLabel: msg.window,
              serverHome: msg.server.home,
              serverOs: msg.server.os,
            });
            if (!settled) {
              settled = true;
              if (initialTimer !== null) window.clearTimeout(initialTimer);
              resolveInitial();
            }
            break;
          }
          case "response": {
            const call = pending.get(msg.id);
            if (!call) break;
            pending.delete(msg.id);
            if (msg.ok) call.resolve(msg.data ?? null);
            else call.reject(msg.error ?? { kind: "internal", message: "Command failed" });
            break;
          }
          case "channel": {
            deliverChannel(msg.id, msg.data);
            break;
          }
          case "channelEnd": {
            endChannel(msg.id);
            break;
          }
          case "event": {
            dispatchLocalEvent("ide://event", msg.event);
            break;
          }
          case "pong":
            break;
          case "superseded": {
            superseded = true;
            if (ws === socket) ws = null;
            if (reconnectTimer !== null) {
              window.clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
            rejectAllPending("Session opened in another browser tab");
            endAllActiveChannels();
            useWebConnection.setState({ status: "superseded" });
            socket.close();
            break;
          }
        }
      });

      socket.addEventListener("close", () => {
        if (ws === socket) ws = null;
        if (superseded) {
          if (!settled) {
            settled = true;
            if (initialTimer !== null) window.clearTimeout(initialTimer);
            rejectInitial(new Error("Session opened in another browser tab"));
          }
          return;
        }
        rejectAllPending("Connection to OpenIDEA server closed");
        endAllActiveChannels();
        if (!settled) {
          settled = true;
          if (initialTimer !== null) window.clearTimeout(initialTimer);
          rejectInitial(new Error(`Could not connect to OpenIDEA server at ${wsUrl}`));
          return;
        }
        useWebConnection.setState({ status: "reconnecting" });
        const delay = Math.min(5_000, 500 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          void connect(false).catch(() => {});
        }, delay);
      });

      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          if (initialTimer !== null) window.clearTimeout(initialTimer);
          rejectInitial(new Error(`WebSocket connection error for ${wsUrl}`));
        }
      });
    });

  triggerTakeOver = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempt = 0;
    useWebConnection.setState({ status: "connecting" });
    void connect(false).catch(() => {});
  };

  await connect(true);
  return true;
}
