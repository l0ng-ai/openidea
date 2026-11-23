/**
 * `@tauri-apps/api/core` as the app imports it (a Vite alias points here):
 * the package itself, except that `invoke` asks the installed route first, so
 * a remote-development window can send commands to its server
 * (platform/remote.ts). `window.__TAURI_INTERNALS__.invoke` is read-only, so
 * this is the one place to hook.
 */
import {
  invoke as invokeRuntime,
  type InvokeArgs,
  type InvokeOptions,
} from "../../node_modules/@tauri-apps/api/core.js";

export * from "../../node_modules/@tauri-apps/api/core.js";
/** This process's own Tauri runtime, wherever commands are routed. */
export { invokeRuntime };

/** Handles `cmd` elsewhere, or returns null to run it in this process. */
export type InvokeRoute = (cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<unknown> | null;

let route: InvokeRoute | null = null;
let machineRoute: InvokeRoute | null = null;

export function setInvokeRoute(next: InvokeRoute | null) {
  route = next;
}

/**
 * Where this machine's commands (`invokeLocal`) run when this process has no backend of its own:
 * the phone's runs on the paired desktop.
 */
export function setMachineRoute(next: InvokeRoute | null) {
  machineRoute = next;
}

/** Runs `cmd` on this machine rather than a remote-development server. */
export function invokeLocal<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  return (machineRoute?.(cmd, args, options) ?? invokeRuntime<T>(cmd, args, options)) as Promise<T>;
}

/** Whether commands have somewhere to go besides this process's Tauri runtime. */
export function hasInvokeRoute(): boolean {
  return route !== null;
}

export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  return (route?.(cmd, args, options) ?? invokeLocal<T>(cmd, args, options)) as Promise<T>;
}
