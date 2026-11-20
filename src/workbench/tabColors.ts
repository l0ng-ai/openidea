/**
 * Per-project tab colour overrides, persisted per project root in localStorage
 * (like the tool window layout). A value is a preset slot "1"–"9" or "#rrggbb";
 * without one the tab keeps the name-hashed project colour.
 */
import { PROJECT_COLOR_COUNT, projectColorSlotVars, projectColorVars } from "./projectColor";

const KEY_PREFIX = "openidea.tabColor.v1:";
const HEX_COLOR = /^#[0-9a-f]{6}$/;

function valid(value: string | null): string | null {
  if (value === null) return null;
  if (HEX_COLOR.test(value)) return value;
  const slot = Number(value);
  return Number.isInteger(slot) && slot >= 1 && slot <= PROJECT_COLOR_COUNT ? value : null;
}

export function tabColorOverride(root: string): string | null {
  return valid(localStorage.getItem(KEY_PREFIX + root));
}

export function setTabColorOverride(root: string, value: string | null): void {
  if (value === null) localStorage.removeItem(KEY_PREFIX + root);
  else localStorage.setItem(KEY_PREFIX + root, value.toLowerCase());
  emit();
}

const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const listener of listeners) listener();
}

/** Bumped on every local or cross-window change; a useSyncExternalStore snapshot. */
export function tabColorsVersion(): number {
  return version;
}

export function subscribeTabColors(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(KEY_PREFIX)) emit();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function tabColorVars(name: string, override: string | null): Record<string, string> {
  if (override === null) return projectColorVars(name);
  if (override.startsWith("#")) return { "--project-color": override, "--project-color-end": override };
  return projectColorSlotVars(Number(override));
}
