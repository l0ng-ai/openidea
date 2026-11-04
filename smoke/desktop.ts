/**
 * The frontend's view of the desktop app, with a real backend: the window's Tauri runtime
 * (callbacks, `Channel`s, the event plugin) in-process, and every app command sent to an
 * `openidea-server` through the route remote development uses (`src/platform/tauriCore.ts`).
 */
import { setInvokeRoute } from "@/platform/tauriCore";
import { encodeArgs } from "@/platform/remote";
import { Server } from "./server";

type Callback = (message: unknown) => void;

// One runtime per page, as in the app: the frontend registers its event listeners once
// (`src/platform/ipc.ts`), so they outlive the servers connected one after another.
const callbacks = new Map<number, Callback>();
const listeners: { event: string; handler: number }[] = [];
const channels = new Map<number, { onmessage: (data: unknown) => void }>();
let nextCallback = 1;
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const internals = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback(cb: Callback) {
      const id = nextCallback++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc: (path: string) => path,
    // Only the window's own plugins reach this: app commands take the route below.
    async invoke(cmd: string, args: Record<string, unknown> = {}) {
      if (cmd === "plugin:event|listen") {
        listeners.push({ event: args.event as string, handler: args.handler as number });
        return listeners.length;
      }
      if (cmd === "plugin:window|get_all_windows") return [];
      if (cmd.startsWith("plugin:")) return null;
      throw { kind: "unavailable", message: `${cmd} has no route`, detail: null };
    },
  };
  Object.assign(window, {
    __TAURI_INTERNALS__: internals,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  });
}

/** Connects this page's frontend to `server`; returns a function that disconnects it. */
export function connectDesktop(server: Server): () => void {
  install();
  channels.clear();
  server.onChannel = (id, data) => channels.get(id)?.onmessage(data);
  server.onEvent = (target, event) => {
    if (target !== null && target !== "main") return;
    for (const l of listeners) {
      if (l.event === "ide://event") callbacks.get(l.handler)?.({ event: l.event, id: 0, payload: event });
    }
  };
  setInvokeRoute((cmd, args) => {
    if (cmd.startsWith("plugin:")) return null;
    const { json, channels: used } = encodeArgs(args);
    for (const [id, channel] of used) channels.set(id, channel as unknown as { onmessage: (data: unknown) => void });
    return server.invoke(cmd, JSON.parse(json));
  });
  return () => {
    setInvokeRoute(null);
    server.onChannel = () => {};
    server.onEvent = () => {};
  };
}
