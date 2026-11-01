import { create } from "zustand";
import { IconButton } from "@/ui";
import type { Usage } from "./usages";
import styles from "./UsageAccessFilter.module.css";

export interface UsageAccessOptions {
  read: boolean;
  write: boolean;
}
const STORAGE_KEY = "openidea.usages.accessFilter.v1";

export function loadAccessOptions(): UsageAccessOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as UsageAccessOptions | null;
    if (saved && typeof saved.read === "boolean" && typeof saved.write === "boolean" && (saved.read || saved.write))
      return saved;
  } catch {
    /* unavailable or invalid storage: show everything */
  }
  return { read: true, write: true };
}

export const useUsageAccessOptions = create<UsageAccessOptions>(() => loadAccessOptions());

export function toggleUsageAccess(which: keyof UsageAccessOptions) {
  const next = { ...useUsageAccessOptions.getState() };
  next[which] = !next[which];
  if (!next.read && !next.write) next[which === "read" ? "write" : "read"] = true;
  useUsageAccessOptions.setState(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* session-only */
  }
}

export function filterUsageAccess(items: readonly Usage[], options: UsageAccessOptions): Usage[] {
  return items.filter((u) => {
    // Old categories and ordinary LSP locations are unclassified. Never infer
    // access from an accessor name/category or silently hide unknown entries.
    if (!u.access || u.access === "unknown" || u.access === "readWrite") return true;
    return u.access === "read" ? options.read : options.write;
  });
}

export const supportsUsageAccess = (items: readonly Usage[]) => items.some((u) => u.access && u.access !== "unknown");

export function UsageAccessFilter({ items }: { items: readonly Usage[] }) {
  const options = useUsageAccessOptions();
  if (!supportsUsageAccess(items)) return null;
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Usage access filters">
      <IconButton
        icon="show-read-access"
        size="small"
        iconSize={16}
        title="Show read accesses"
        pressed={options.read}
        onClick={() => toggleUsageAccess("read")}
      />
      <IconButton
        icon="show-write-access"
        size="small"
        iconSize={16}
        title="Show write accesses"
        pressed={options.write}
        onClick={() => toggleUsageAccess("write")}
      />
    </div>
  );
}
