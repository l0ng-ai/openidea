import type { TabStripHandle } from "@/ui/Tabs";

/** Content tab strips rendered in each tool window's header (Run sessions, Find tabs, terminals…). */
const strips = new Map<string, Set<TabStripHandle>>();
const registries = new Map<string, (handle: TabStripHandle) => () => void>();

/** The `TabStripRegistry` value for tool window `id` (stable per id). */
export function contentTabRegistry(id: string): (handle: TabStripHandle) => () => void {
  let fn = registries.get(id);
  if (!fn) {
    fn = (handle) => {
      let set = strips.get(id);
      if (!set) strips.set(id, (set = new Set()));
      set.add(handle);
      return () => void set.delete(handle);
    };
    registries.set(id, fn);
  }
  return fn;
}

/** Pins or unpins the selected content tab of tool window `id`; false when it has none that can be pinned. */
export function togglePinSelectedContent(id: string): boolean {
  for (const strip of strips.get(id) ?? []) if (strip.togglePinSelected()) return true;
  return false;
}

/** Closes the selected content tab of tool window `id`; false when it has none that can be closed. */
export function closeSelectedContent(id: string): boolean {
  for (const strip of strips.get(id) ?? []) if (strip.closeSelected()) return true;
  return false;
}
