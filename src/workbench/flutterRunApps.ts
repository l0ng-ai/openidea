/**
 * Flutter apps started by Run (`flutter run --machine`), by Run tab. The Run feature keeps them;
 * the DevTools windows connect to them as they do to the apps of Debug sessions.
 */
import { create } from "zustand";

export interface FlutterRunApp {
  /** The Run tab's session id. */
  session: string;
  name: string;
  appId: string | null;
  device: string | null;
  /** `app.started` came: the app takes hot reloads, when it `supportsRestart`. */
  started: boolean;
  supportsRestart: boolean;
  vmServiceUri?: string;
  /** Its process still runs. */
  live: boolean;
  startedAt: number;
}

export const useFlutterRunApps = create<Record<string, FlutterRunApp>>(() => ({}));
