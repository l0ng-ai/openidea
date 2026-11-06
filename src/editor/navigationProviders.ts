/** Optional, asynchronous navigation contributions. Results are versioned by
 * the editor text and provider epoch; hover and click share bounded requests. */
import type { EditorView } from "@codemirror/view";
import type { Location } from "@/platform/ipc";

export interface NavigationMatch {
  from: number;
  to: number;
  targets: Location[];
}
type Provider = (view: EditorView, offset: number) => Promise<NavigationMatch | null>;
const providers = new Set<Provider>();
let epoch = 0;
export function navigationEpoch() {
  return epoch;
}
const listeners = new Set<() => void>();
let notifyPending = false;
export function onNavigationProvidersChanged(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function invalidateNavigationProviders() {
  epoch++;
  if (!notifyPending) {
    notifyPending = true;
    queueMicrotask(() => {
      notifyPending = false;
      for (const listener of listeners) listener();
    });
  }
}
export function registerNavigationProvider(provider: Provider) {
  providers.add(provider);
  invalidateNavigationProviders();
  return () => {
    providers.delete(provider);
    invalidateNavigationProviders();
  };
}
const caches = new WeakMap<
  EditorView,
  {
    text: EditorView["state"]["doc"];
    epoch: number;
    pending: Map<number, Promise<NavigationMatch | null>>;
    hits: NavigationMatch[];
  }
>();
export async function contributedNavigation(view: EditorView, offset: number): Promise<NavigationMatch | null> {
  if (!providers.size) return null;
  const text = view.state.doc;
  let cache = caches.get(view);
  if (!cache || cache.text !== text || cache.epoch !== epoch) {
    cache = { text, epoch, pending: new Map(), hits: [] };
    caches.set(view, cache);
  }
  const hit = cache.hits.find((h) => h.from <= offset && offset < h.to);
  if (hit) return hit;
  const pending = cache.pending.get(offset);
  if (pending) return pending;
  const current = cache;
  const query = (async () => {
    for (const provider of providers) {
      const answer = await provider(view, offset);
      if (current.epoch !== epoch || view.state.doc !== text) return null;
      if (answer && answer.targets.length && answer.from >= 0 && answer.to <= text.length && answer.from < answer.to) {
        current.hits.push(answer);
        if (current.hits.length > 128) current.hits.shift();
        return answer;
      }
    }
    return null;
  })();
  if (cache.pending.size >= 128) cache.pending.delete(cache.pending.keys().next().value!);
  cache.pending.set(offset, query);
  try {
    return await query;
  } catch (error) {
    cache.pending.delete(offset);
    throw error;
  }
}
