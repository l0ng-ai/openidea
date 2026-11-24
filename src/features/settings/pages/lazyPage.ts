import type { ComponentType } from "react";
import { lazyComponent, type LazyComponent } from "@/ui";

const preloaders = new Map<string, Array<() => Promise<unknown>>>();

/**
 * Registers a built-in page component via `lazyComponent` and indexes its
 * preloader under `pageIds` so `preloadBuiltinPage` can warm it ahead of mount.
 */
export function lazyPage<P extends object = Record<string, never>>(
  pageIds: string | readonly string[],
  load: () => Promise<ComponentType<P>>,
): LazyComponent<P> {
  const Component = lazyComponent(load);
  const ids = typeof pageIds === "string" ? [pageIds] : pageIds;
  for (const id of ids) {
    const list = preloaders.get(id) ?? [];
    list.push(Component.preload);
    preloaders.set(id, list);
  }
  return Component;
}

/** Preloads any lazy component registered for `pageId` before revealing it. */
export function preloadBuiltinPage(pageId: string): Promise<void> | undefined {
  const list = preloaders.get(pageId);
  if (!list?.length) return undefined;
  return Promise.all(list.map((fn) => fn().catch(() => {}))).then(() => undefined);
}
