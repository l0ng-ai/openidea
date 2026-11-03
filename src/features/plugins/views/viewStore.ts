/**
 * Client state of plugin views: a revision per (plugin, view) that bumps when
 * the plugin asks for a refresh (`viewChanged`), and the messages its code
 * sends to the script of an `html` body (`viewMessage`).
 */
import { create } from "zustand";

export const viewKey = (pluginId: string, view: string) => `${pluginId}/${view}`;

export const useViewRevisions = create<{ revisions: Record<string, number> }>(() => ({ revisions: {} }));

/** The plugin's view content changed: rendered views fetch it again. */
export function bumpView(pluginId: string, view: string) {
  const key = viewKey(pluginId, view);
  useViewRevisions.setState((s) => ({ revisions: { ...s.revisions, [key]: (s.revisions[key] ?? 0) + 1 } }));
}

export function useViewRevision(pluginId: string, view: string): number {
  return useViewRevisions((s) => s.revisions[viewKey(pluginId, view)] ?? 0);
}

type MessageListener = (message: string) => void;
const messageListeners = new Map<string, Set<MessageListener>>();

/** Delivers a plugin's message to the frames of its view. */
export function deliverViewMessage(pluginId: string, view: string, message: string) {
  for (const l of messageListeners.get(viewKey(pluginId, view)) ?? []) l(message);
}

export function onViewMessage(pluginId: string, view: string, listener: MessageListener): () => void {
  const key = viewKey(pluginId, view);
  const set = messageListeners.get(key) ?? new Set();
  set.add(listener);
  messageListeners.set(key, set);
  return () => {
    set.delete(listener);
    if (!set.size) messageListeners.delete(key);
  };
}
