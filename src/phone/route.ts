/**
 * On the phone every command runs on the paired desktop: the phone's own backend only
 * pairs and forwards (`mobile/src/lib.rs`). Routing happens below the generated
 * bindings, so features call `commands.*` as usual.
 */
import { Channel, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { invokeRuntime, setInvokeRoute, setMachineRoute, type InvokeRoute } from "@/platform/tauriCore";
import type { ChannelFrame } from "@/platform/ipc";
import { encodeArgs } from "@/platform/remote";
import { tx } from "@/platform/i18n";

/** A connection to the desktop (`PhoneSession` of `mobile/src/lib.rs`). */
export interface PhoneSession {
  desktop: string;
  commands: string[];
  os: string;
  home: string;
}

export interface PhoneStatus {
  desktop: string | null;
  connected: boolean;
}

/** The phone backend's own commands and Tauri's (`plugin:…`) run on the phone. */
function runsOnPhone(cmd: string): boolean {
  return cmd.startsWith("plugin:") || cmd.startsWith("phone_") || cmd === "remote_invoke";
}

let served = new Set<string>();

async function desktopInvoke(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<unknown> {
  const { json, channels } = encodeArgs(args);
  const onChannel = new Channel<ChannelFrame>();
  onChannel.onmessage = (frame) => channels.get(frame.id)?.onmessage(JSON.parse(frame.data));
  const result = await invokeRuntime<string>("remote_invoke", { cmd, args: json, onChannel }, options);
  return JSON.parse(result);
}

/** Sends this window's commands to the desktop of `session` from now on. */
export function routeToDesktop(session: PhoneSession) {
  served = new Set(session.commands);
  const route: InvokeRoute = (cmd, args, options) => {
    if (runsOnPhone(cmd)) return null;
    if (!served.has(cmd)) {
      return Promise.reject({ kind: "unavailable", message: tx`${cmd} is not available on the phone`, data: null });
    }
    return desktopInvoke(cmd, args, options);
  };
  // The phone's own backend only pairs and forwards: "this machine" is the desktop too.
  setInvokeRoute(route);
  setMachineRoute(route);
}

export const phoneStatus = () => invokeRuntime<PhoneStatus>("phone_status");
export const phonePair = (code: string) => invokeRuntime<PhoneSession>("phone_pair", { code });
export const phoneConnect = () => invokeRuntime<PhoneSession>("phone_connect");
export const phoneForget = () => invokeRuntime<null>("phone_forget");
