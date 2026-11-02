/**
 * Links and markers per open file, as each provider reported them, merged per
 * file in provider order (editors subscribe to `files[path]`).
 */
import { create } from "zustand";
import type { FileNavigation } from "./model";

interface CodeNavigationState {
  /** path → provider id → what it reported. */
  results: Readonly<Record<string, Readonly<Record<string, FileNavigation>>>>;
  /** path → the providers' results merged; absent when nothing is known. */
  files: Readonly<Record<string, FileNavigation>>;
}

export const useCodeNavigation = create<CodeNavigationState>(() => ({ results: {}, files: {} }));

function merged(byProvider: Readonly<Record<string, FileNavigation>>): FileNavigation {
  const out: FileNavigation = { links: [], markers: [] };
  for (const id of Object.keys(byProvider).sort()) {
    const r = byProvider[id]!;
    out.links.push(...r.links);
    out.markers.push(...r.markers);
  }
  return out;
}

function update(change: (results: Record<string, Record<string, FileNavigation>>) => Set<string>): void {
  useCodeNavigation.setState((s) => {
    const results: Record<string, Record<string, FileNavigation>> = { ...s.results };
    const touched = change(results);
    if (!touched.size) return s;
    const files = { ...s.files };
    for (const path of touched) {
      const byProvider = results[path];
      if (byProvider && Object.keys(byProvider).length) files[path] = merged(byProvider);
      else {
        delete results[path];
        delete files[path];
      }
    }
    return { results, files };
  });
}

/** Replaces what `provider` knows about `path` (`null`: nothing any more). */
export function setFileNavigation(provider: string, path: string, nav: FileNavigation | null): void {
  update((results) => {
    const byProvider = { ...results[path] };
    if (nav) byProvider[provider] = nav;
    else if (provider in byProvider) delete byProvider[provider];
    else return new Set();
    results[path] = byProvider;
    return new Set([path]);
  });
}

/** Drops everything `provider` reported (it was disposed). */
export function clearProvider(provider: string): void {
  update((results) => {
    const touched = new Set<string>();
    for (const [path, byProvider] of Object.entries(results))
      if (provider in byProvider) {
        const rest = { ...byProvider };
        delete rest[provider];
        results[path] = rest;
        touched.add(path);
      }
    return touched;
  });
}

/** Drops everything known about `path` (its last editor closed). */
export function clearFile(path: string): void {
  update((results) => {
    if (!(path in results)) return new Set();
    results[path] = {};
    return new Set([path]);
  });
}

export function navigationFor(path: string): FileNavigation | null {
  return useCodeNavigation.getState().files[path] ?? null;
}
