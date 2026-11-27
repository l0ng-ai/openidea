/**
 * A synchronous cache of the "Edit configuration templates…" values, so the
 * run-context producers (gutter icons, ⌃⇧R) — which build configurations
 * synchronously — can apply them. `loadConfigs` refreshes it from disk; the
 * Edit Configurations dialog writes through it on save.
 */
import { call, commands, isTauri, type RunConfig } from "@/platform/ipc";

const cache = new Map<string, RunConfig>();

/** The stored template of `kind` ("Edit configuration templates…" › kind), if any. */
export function runTemplate(kind: string): RunConfig | undefined {
  return cache.get(kind);
}

/** Caches the stored templates (called with `runTemplates()`'s result). */
export function cacheRunTemplates(templates: readonly RunConfig[]): void {
  cache.clear();
  for (const t of templates) cache.set(t.kind, t);
}

/** Refreshes the cache from disk; a no-op off the desktop. */
export async function loadRunTemplates(): Promise<void> {
  if (!isTauri()) return;
  try {
    cacheRunTemplates(await call(commands.runTemplates()));
  } catch {
    /* keep the previous cache */
  }
}
