import type { LibraryGroup } from "@/bindings";

/** Merge shared SDKs and package groups without losing different module roots. */
export function mergeLibraryGroups(groups: readonly LibraryGroup[]): LibraryGroup[] {
  const merged: LibraryGroup[] = [];
  for (const group of groups) {
    const existing = merged.find((g) => g.kind === group.kind && g.name === group.name);
    if (!existing) {
      merged.push({ ...group, roots: [...group.roots] });
      continue;
    }
    for (const root of group.roots) {
      if (!existing.roots.some((r) => r.path === root.path)) existing.roots.push(root);
    }
  }
  return merged;
}
