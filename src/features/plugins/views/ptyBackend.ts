import { Channel } from "@tauri-apps/api/core";
import { tx } from "@/platform/i18n";
import type { TerminalInfo, WebPtyCommand } from "@/bindings";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";
import { usePlugins } from "../store";
import type { PtyBackend } from "./ptyBridge";

/** Both frame terminals and log tabs use the backend's exact, pinned process grant. */
export function webPtyBackend(pluginId: string, view: string): PtyBackend {
  return pluginPtyBackend(pluginId, (command, channel) =>
    call(commands.pluginWebPtySpawn(pluginId, view, command, channel)),
  );
}

/**
 * A log tab the plugin's code opened: the host runs what it approved for `key`,
 * with the toggles in `on`; the command the tab builds only lends its size.
 */
export function logTabPtyBackend(pluginId: string, key: string, on: string[]): PtyBackend {
  return pluginPtyBackend(pluginId, (command, channel) => {
    if (isRemoteWindow())
      throw new Error(tx("Log tabs opened by plugin code are not available in remote projects yet."));
    return call(commands.pluginLogTabSpawn(pluginId, key, on, command.cols, command.rows, channel));
  });
}

function pluginPtyBackend(
  pluginId: string,
  start: (command: WebPtyCommand, channel: Channel<string>) => Promise<TerminalInfo>,
): PtyBackend {
  return {
    spawn: async (command, output) => {
      const current = usePlugins.getState().plugins.find((p) => p.id === pluginId);
      if (
        !isTauri() ||
        !current?.enabled ||
        !current.capabilities.some((c) => c.id === `process:${command.program}` && c.granted)
      )
        throw new Error(tx`Cannot start PTY: process:${command.program} capability not granted.`);
      const channel = new Channel<string>();
      channel.onmessage = output;
      return start(command, channel);
    },
    write: (id, data) => call(commands.termWrite(id, data)),
    resize: (id, cols, rows) => call(commands.termResize(id, cols, rows)),
    kill: (id) => call(commands.termKill(id)),
    onExit: (listener) => onIdeEvent("terminalExited", (ev) => listener(ev.terminal, ev.code)),
  };
}
