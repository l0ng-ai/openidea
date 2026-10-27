/**
 * `@tauri-apps/api/core` as the app imports it (a Vite alias points here):
 * the package itself, except that `invoke` asks the installed route first, so
 * a remote-development window can send commands to its server
 * (platform/remote.ts). `window.__TAURI_INTERNALS__.invoke` is read-only, so
 * this is the one place to hook.
 */
import { invoke as invokeLocal, type InvokeArgs, type InvokeOptions } from "../../node_modules/@tauri-apps/api/core.js";

export * from "../../node_modules/@tauri-apps/api/core.js";
export { invokeLocal };

/** Handles `cmd` elsewhere, or returns null to run it in this process. */
export type InvokeRoute = (cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<unknown> | null;

let route: InvokeRoute | null = null;

export function setInvokeRoute(next: InvokeRoute | null) {
  route = next;
}

export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  return (route?.(cmd, args, options) ?? invokeLocal<T>(cmd, args, options)) as Promise<T>;
}
