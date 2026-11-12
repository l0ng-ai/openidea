/**
 * The window's Tauri runtime as the frontend sees it (callbacks, `Channel`s, the event
 * plugin, path resolution), with every app command handed to `window.__openideaForward`:
 * a real `openidea-server` on the other end (`smoke/desktop.ts` in jsdom, `evals/` in
 * Chromium). Self-contained: Playwright serialises this function into the page, so it
 * may use nothing from outside its body.
 */

export interface ShimConfig {
  /** `BaseDirectory` values (`@tauri-apps/api/path`) the frontend resolves. */
  directories: Record<number, string>;
  sep: "/" | "\\";
}

/** What the host side calls to deliver the server's notifications. */
export interface ShimBridge {
  /** A value streamed to the `Channel` with this id. */
  channel(id: number, data: unknown): void;
  /** An `IdeEvent` for a window (`null`: every window). */
  event(window: string | null, event: unknown): void;
  /** Forgets the channels of an earlier server. */
  reset(): void;
}

export interface ShimWindow {
  __openideaShim: ShimBridge;
  /** Runs an app command on the server; rejects with its `IdeError`. */
  __openideaForward?: (cmd: string, args: unknown) => Promise<unknown>;
}

export function installTauriShim(config: ShimConfig) {
  type Callback = (message: unknown) => void;
  const w = window as unknown as ShimWindow & Record<string, unknown>;
  if (w.__openideaShim) return;
  // One runtime per page, there from the start as in the app: the frontend registers its
  // event listener once (`src/platform/ipc.ts`), possibly before a server is connected,
  // and keeps it across the servers connected one after another.
  const callbacks = new Map<number, Callback>();
  const listeners: { event: string; handler: number }[] = [];
  const channels = new Map<number, { onmessage: (data: unknown) => void }>();
  let nextCallback = 1;

  const join = (paths: string[]) => {
    const absolute = paths[0]?.startsWith(config.sep) ?? false;
    const parts: string[] = [];
    for (const p of paths.join(config.sep).split(/[\\/]+/)) {
      if (p === "" || p === ".") continue;
      if (p === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push(p);
    }
    return (absolute ? config.sep : "") + parts.join(config.sep);
  };

  /** The arguments with each `Channel` replaced by `{ $channel: id }`, as remote development sends them. */
  const encode = (args: Record<string, unknown>) => {
    const plain: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      const tag =
        v && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function"
          ? (v as { toJSON(): unknown }).toJSON()
          : null;
      if (typeof tag === "string" && tag.startsWith("__CHANNEL__:")) {
        const id = Number(tag.slice("__CHANNEL__:".length));
        channels.set(id, v as { onmessage: (data: unknown) => void });
        plain[k] = { $channel: id };
      } else {
        plain[k] = v;
      }
    }
    return JSON.parse(JSON.stringify(plain)) as unknown;
  };

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
    async invoke(cmd: string, args: Record<string, unknown> = {}) {
      if (cmd === "plugin:event|listen") {
        listeners.push({ event: args.event as string, handler: args.handler as number });
        return listeners.length;
      }
      if (cmd === "plugin:window|get_all_windows") return [];
      // This machine's directories (`@tauri-apps/api/path`), as on the desktop.
      if (cmd === "plugin:path|resolve_directory") return config.directories[args.directory as number] ?? null;
      if (cmd === "plugin:path|join") return join(args.paths as string[]);
      if (cmd.startsWith("plugin:")) return null;
      const forward = w.__openideaForward;
      if (!forward) throw { kind: "unavailable", message: `${cmd} has no route`, detail: null };
      return forward(cmd, encode(args));
    },
  };
  w.__TAURI_INTERNALS__ = internals;
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  w.__openideaShim = {
    channel: (id, data) => channels.get(id)?.onmessage(data),
    event(target, event) {
      if (target !== null && target !== "main") return;
      for (const l of listeners) {
        if (l.event === "ide://event") callbacks.get(l.handler)?.({ event: l.event, id: 0, payload: event });
      }
    },
    reset: () => channels.clear(),
  };
}
