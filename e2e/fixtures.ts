/** Shared helpers: open the workbench with the injected sample project and fail on page errors. */
import { expect, test as base, type Page } from "@playwright/test";

export const PROJECT = "acme-api";

export const test = base.extend<{ workbench: Page }>({
  // Every spec presses ⌘-shortcuts; CodeMirror picks Mod-key bindings from navigator.platform, not the user agent,
  // so without this they silently become Ctrl on the Linux CI.
  page: async ({ page }, provide) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
    await provide(page);
  },
  workbench: async ({ page }, provide) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await expect(page.getByRole("tree", { name: "Project" })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /acme-api/ })).toBeVisible();
    // The start-up splash swallows raw mouse presses until it has faded out.
    await expect(page.locator("#splash")).toHaveCount(0);
    await provide(page);
    expect(errors, "uncaught page errors").toEqual([]);
  },
});

export { expect };

/** What `stubDesktop` installs on `window.__ipc`; handlers are defined inside `page.evaluate`. */
export interface IpcStub {
  /** Command name as the backend registers it (`lsp_goto`) → its answer; throw `{ kind, message }` for an `IdeError`. */
  handlers: Record<string, (args: Record<string, unknown>) => unknown>;
  calls: { cmd: string; args: Record<string, unknown> }[];
  /** Sends one message down a `Channel` passed to a command. */
  send(channel: unknown, message: unknown): void;
  /** Emits an `IdeEvent` the way the backend does. */
  emit(event: { type: string } & Record<string, unknown>): void;
}

declare global {
  interface Window {
    __ipc: IpcStub;
  }
}

/**
 * Switches the page into desktop mode over a stubbed native layer: commands with a handler answer,
 * every other command fails as unavailable, the way a backend without that feature does. Documents
 * keep their in-memory backend; the project tree keeps its sample only while it isn't reloaded, so
 * open files from it before stubbing.
 */
export async function stubDesktop(page: Page) {
  await page.evaluate(async () => {
    // Documents stay in memory: the editor's backend is chosen once, on first use.
    const backendModule = "/src/editor/core/backend.ts";
    const { docBackend } = await import(/* @vite-ignore */ backendModule);
    docBackend();
    const callbacks = new Map<number, (message: unknown) => void>();
    const channelIndex = new Map<number, number>();
    const listeners: { event: string; handler: number }[] = [];
    let nextCallback = 1;
    const ipc: IpcStub = {
      // This window is the only one.
      handlers: { "plugin:window|get_all_windows": () => [] },
      calls: [],
      send(channel, message) {
        const id = (channel as { id: number }).id;
        const index = channelIndex.get(id) ?? 0;
        channelIndex.set(id, index + 1);
        callbacks.get(id)?.({ index, message });
      },
      emit(event) {
        for (const l of listeners)
          if (l.event === "ide://event") callbacks.get(l.handler)?.({ event: l.event, id: 0, payload: event });
      },
    };
    window.__ipc = ipc;
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      configurable: true,
      value: { unregisterListener: () => {} },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback(cb: (message: unknown) => void) {
          const id = nextCallback++;
          callbacks.set(id, cb);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        convertFileSrc: (path: string) => path,
        async invoke(cmd: string, args: Record<string, unknown> = {}) {
          ipc.calls.push({ cmd, args });
          if (cmd === "plugin:event|listen") {
            listeners.push({ event: args.event as string, handler: args.handler as number });
            return listeners.length;
          }
          const handler = ipc.handlers[cmd];
          // Tauri plugin calls (windows, events) succeed quietly; app commands are what tests stub.
          if (!handler && cmd.startsWith("plugin:")) return null;
          if (!handler) throw { kind: "unavailable", message: `${cmd} is not stubbed`, detail: null };
          return handler(args);
        },
      },
    });
    const ipcModule = "/src/platform/ipc.ts";
    const { ideEventsReady } = await import(/* @vite-ignore */ ipcModule);
    await ideEventsReady();
  });
}

/** The commands the page has invoked so far under `stubDesktop`, by name. */
export async function ipcCalls(page: Page, cmd: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((cmd) => window.__ipc.calls.filter((c) => c.cmd === cmd).map((c) => c.args), cmd);
}

/** Tool windows currently laid out (visible) in the workbench. */
export async function visibleToolWindows(page: Page): Promise<string[]> {
  return page
    .locator("section[aria-label]")
    .evaluateAll((els) =>
      els
        .filter((e) => (e as HTMLElement).offsetParent !== null && e.getBoundingClientRect().width > 0)
        .map((e) => e.getAttribute("aria-label") ?? ""),
    );
}

export async function doubleShift(page: Page) {
  await page.keyboard.press("Shift");
  await page.keyboard.press("Shift");
}

/** Opens a top-level sample file from the Project tree and waits for the editor. */
export async function openFromTree(page: Page, name: string) {
  await page.getByRole("treeitem", { name, exact: true }).dblclick();
  await expect(page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab", { name })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const editor = page.locator(".cm-editor").first();
  await expect(editor.locator(".cm-content")).not.toBeEmpty();
  return editor;
}
