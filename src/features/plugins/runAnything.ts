/**
 * `[[contributes.runAnything]]` (API 1.18): Run Anything lines whose first word is a plugin's
 * prefix (`task build`) are suggested and run by its `run-anything-provider` export.
 *
 * Suggestions are asked while the user types and arrive later: the provider keeps the answer
 * for the latest text and tells the popup to ask again (`subscribe`); an answer for older text
 * is dropped. Running a line the plugin claims never falls back to the shell, even when the
 * plugin fails — only a line it explicitly leaves (`false`) goes on to the other providers.
 */
import type { RunAnythingItem } from "@/bindings";
import { tx } from "@/platform/i18n";
import { notifications, registerRunAnythingProvider, type RunAnythingItem as Entry } from "@/workbench/contributions";
import { pluginsBackend } from "./backend";
import { usePlugins } from "./store";

export interface RunAnythingDecl {
  prefix: string;
  title?: string | null;
}

/** Whether `text` asks for the prefix's entries: it starts with the prefix as a word, or is the start of it. */
export function wantsPrefix(prefix: string, text: string): boolean {
  if (!text) return false;
  const first = text.split(/\s/, 1)[0]!;
  return /\s/.test(text) ? first === prefix : prefix.startsWith(text);
}

/** Whether `line` is one for this prefix: its first word is the prefix. */
export function claimsLine(prefix: string, line: string): boolean {
  return line.trim().split(/\s+/, 1)[0] === prefix;
}

const MAX_ITEMS = 100;

/** Run Anything entries for the plugin's prefix, answered by its code. */
export function projectRunAnything(pluginId: string, decl: RunAnythingDecl): () => void {
  const { prefix } = decl;
  const group = decl.title || usePlugins.getState().plugins.find((p) => p.id === pluginId)?.name || pluginId;
  const listeners = new Set<() => void>();
  let answered: { text: string; items: RunAnythingItem[] } | null = null;
  let asking: string | null = null;

  const run = async (line: string): Promise<boolean> => {
    try {
      return await pluginsBackend().runAnythingRun(pluginId, prefix, line);
    } catch (e) {
      // Claimed: the line is the plugin's, so it doesn't run in the shell instead.
      notifications().notify({
        group: "plugins",
        level: "error",
        title: tx`${group} could not run ${line}`,
        body: e instanceof Error ? e.message : String(e),
      });
      return true;
    }
  };

  const ask = (text: string) => {
    if (asking === text) return;
    asking = text;
    pluginsBackend()
      .runAnythingSuggest(pluginId, prefix, text)
      .then(
        (items) => {
          if (asking !== text) return; // the user typed on
          answered = { text, items: items.slice(0, MAX_ITEMS) };
          for (const l of listeners) l();
        },
        () => {
          if (asking === text) answered = { text, items: [] };
        },
      )
      .finally(() => {
        if (asking === text) asking = null;
      });
  };

  return registerRunAnythingProvider({
    id: `plugin.${pluginId}.${prefix}`,
    group,
    order: 60,
    items(query) {
      if (!wantsPrefix(prefix, query)) return [];
      if (answered?.text !== query) ask(query);
      // Until the new answer arrives, the previous one stays (filtered by the popup as the user types).
      return (answered?.items ?? []).map((item, i): Entry => ({
        key: `${i}:${item.line ?? item.label}`,
        label: item.label,
        detail: item.detail ?? undefined,
        icon: "run",
        completion: item.line ?? item.label,
        run: () => void run(item.line ?? item.label),
      }));
    },
    accepts: (line) => claimsLine(prefix, line),
    execute: (line) => (claimsLine(prefix, line) ? run(line.trim()) : false),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  });
}
