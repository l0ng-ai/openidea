import { create } from "zustand";

/** Snapshots of the host's bounded, read-only output channels. */
export const usePluginOutput = create<{ channels: Map<string, string> }>(() => ({ channels: new Map() }));
export const outputKey = (pluginId: string, channel: string) => JSON.stringify([pluginId, channel]);
export function setPluginOutput(pluginId: string, channel: string, text: string | null) {
  usePluginOutput.setState((s) => {
    const channels = new Map(s.channels);
    if (text === null) channels.delete(outputKey(pluginId, channel));
    else channels.set(outputKey(pluginId, channel), text);
    return { channels };
  });
}
