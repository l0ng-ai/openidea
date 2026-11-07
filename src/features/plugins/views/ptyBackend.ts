import { Channel } from "@tauri-apps/api/core";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { usePlugins } from "../store";
import type { PtyBackend } from "./ptyBridge";

/** Both frame terminals and log tabs use the backend's exact, pinned process grant. */
export function webPtyBackend(pluginId: string, view: string): PtyBackend {
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
      return call(commands.pluginWebPtySpawn(pluginId, view, command, channel));
    },
    write: (id, data) => call(commands.termWrite(id, data)),
    resize: (id, cols, rows) => call(commands.termResize(id, cols, rows)),
    kill: (id) => call(commands.termKill(id)),
    onExit: (listener) => onIdeEvent("terminalExited", (ev) => listener(ev.terminal, ev.code)),
  };
}
