/**
 * Projection of plugin UI contributions onto the workbench's own `register*`
 * functions (docs/plugin_plan.md 4.1).
 *
 * The backend validated every declaration completely (Rust extension points);
 * a projection maps one onto an existing registration and returns its
 * disposer. Projections must not fail: an exception is a defect, logged, and
 * that one item is skipped — nothing is half-registered.
 *
 * Adding a UI contribution type = a Rust extension point + one
 * `defineUiPoint` here; the kernel (this file, the store, the bridge) is not
 * touched.
 */
import type { ComponentType } from "react";
import type { PluginInfo, UiContribution } from "@/bindings";

export interface UiItem<T = Record<string, unknown>> {
  pluginId: string;
  point: string;
  key: string;
  decl: T;
}

export interface ProjectionContext {
  plugin: PluginInfo;
}

export interface UiPointDefinition<T = Record<string, unknown>> {
  /** Makes one item take effect; returns its disposer. */
  project?: (item: UiItem<T>, ctx: ProjectionContext) => (() => void) | void;
  /** Optional section in Settings › Plugins › details for this point's items. */
  Details?: ComponentType<{ plugin: PluginInfo; items: UiItem<T>[] }>;
  /** Section title for the details page (defaults to the point id). */
  title?: string;
}

const points = new Map<string, UiPointDefinition<never>>();
const live = new Map<string, { sig: string; dispose: () => void }>();
const warned = new Set<string>();
let lastItems: readonly UiContribution[] = [];
let lastPlugins: readonly PluginInfo[] = [];

const itemKey = (c: UiContribution) => `${c.pluginId}\u0000${c.point}\u0000${c.key}`;

/** Registers the client side of an extension point. */
export function defineUiPoint<T>(point: string, def: UiPointDefinition<T>): () => void {
  if (points.has(point)) throw new Error(`UI point "${point}" is already defined`);
  points.set(point, def as UiPointDefinition<never>);
  // Items that arrived before the definition (lazy features) are projected now.
  syncUiContributions(lastItems, lastPlugins);
  return () => {
    for (const [key, entry] of live) {
      if (key.split("\u0000")[1] === point) {
        safeDispose(entry.dispose);
        live.delete(key);
      }
    }
    points.delete(point);
  };
}

export function uiPoint(point: string): UiPointDefinition<never> | undefined {
  return points.get(point);
}

function safeDispose(dispose: () => void) {
  try {
    dispose();
  } catch (e) {
    console.error("plugin contribution disposer failed", e);
  }
}

/**
 * Brings the registrations in line with `items` (the backend's snapshot):
 * removed or changed items are disposed, new or changed ones projected.
 */
export function syncUiContributions(items: readonly UiContribution[], plugins: readonly PluginInfo[]) {
  lastItems = items;
  lastPlugins = plugins;
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const next = new Map<string, { item: UiContribution; sig: string }>();
  for (const item of items) {
    if (!points.get(item.point)?.project) {
      if (!points.has(item.point) && !warned.has(item.point)) {
        warned.add(item.point);
        console.warn(`plugin UI point "${item.point}" has no client projection`);
      }
      continue;
    }
    if (!byId.has(item.pluginId)) continue;
    next.set(itemKey(item), { item, sig: JSON.stringify(item.decl) });
  }
  for (const [key, entry] of live) {
    if (next.get(key)?.sig !== entry.sig) {
      safeDispose(entry.dispose);
      live.delete(key);
    }
  }
  for (const [key, { item, sig }] of next) {
    if (live.has(key)) continue;
    const def = points.get(item.point)!;
    const plugin = byId.get(item.pluginId)!;
    try {
      const dispose = def.project!(item as UiItem<never>, { plugin }) ?? (() => {});
      live.set(key, { sig, dispose });
    } catch (e) {
      // The backend validated the declaration: a failing projection is a defect.
      console.error(`projecting ${item.point} "${item.key}" of plugin ${item.pluginId} failed`, e);
    }
  }
}

/** Disposes every projected registration (shutdown, tests). */
export function clearUiContributions() {
  for (const entry of live.values()) safeDispose(entry.dispose);
  live.clear();
  lastItems = [];
  lastPlugins = [];
}

/** Items of one point, optionally of one plugin. */
export function itemsOf<T = Record<string, unknown>>(
  items: readonly UiContribution[],
  point: string,
  pluginId?: string,
): UiItem<T>[] {
  return items.filter((c) => c.point === point && (!pluginId || c.pluginId === pluginId)) as UiItem<T>[];
}
