/**
 * Window › Tool Window Layouts (IDEA's ToolWindowLayoutManager): named
 * snapshots of the tool window layout (visible windows, sizes, placements),
 * shared by every project and kept in localStorage.
 */
import { create } from "zustand";
import {
  applyToolWindowLayout,
  defaultLayoutSnapshot,
  sanitizeLayoutSnapshot,
  toolWindowLayoutSnapshot,
  type ToolWindowLayoutSnapshot,
} from "./store";

const STORAGE_KEY = "openidea.toolWindowLayouts.v1";

interface LayoutsState {
  /** Saved layouts by name, in save order. */
  layouts: ReadonlyArray<{ name: string; layout: ToolWindowLayoutSnapshot }>;
  /** Name of the layout last saved or restored (shown checked). */
  active: string | null;
}

function read(): LayoutsState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { layouts: [], active: null };
    const r = raw as { layouts?: unknown; active?: unknown };
    const layouts = Array.isArray(r.layouts)
      ? r.layouts
          .filter((l): l is { name: string; layout: unknown } => !!l && typeof l.name === "string" && !!l.name.trim())
          .map((l) => ({ name: l.name, layout: sanitizeLayoutSnapshot(l.layout) }))
      : [];
    const active = typeof r.active === "string" && layouts.some((l) => l.name === r.active) ? r.active : null;
    return { layouts, active };
  } catch {
    return { layouts: [], active: null };
  }
}

export const useToolWindowLayouts = create<LayoutsState>(read);

function write(next: LayoutsState) {
  useToolWindowLayouts.setState(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

export function layoutNames(): string[] {
  return useToolWindowLayouts.getState().layouts.map((l) => l.name);
}

/** Save Current Layout as…: replaces a layout of the same name. */
export function saveLayout(name: string) {
  const n = name.trim();
  if (!n) return;
  const { layouts } = useToolWindowLayouts.getState();
  const entry = { name: n, layout: toolWindowLayoutSnapshot() };
  const i = layouts.findIndex((l) => l.name === n);
  write({ layouts: i >= 0 ? layouts.map((l, j) => (j === i ? entry : l)) : [...layouts, entry], active: n });
}

export function restoreLayout(name: string): boolean {
  const s = useToolWindowLayouts.getState();
  const found = s.layouts.find((l) => l.name === name);
  if (!found) return false;
  applyToolWindowLayout(found.layout);
  write({ ...s, active: name });
  return true;
}

/** Restore Current Layout: the active saved layout again, or the default one when none is active. */
export function restoreCurrentLayout() {
  const { active } = useToolWindowLayouts.getState();
  if (!active || !restoreLayout(active)) restoreDefaultLayout();
}

/** Save Changes in Current Layout: the active saved layout takes the windows as they are now. */
export function saveCurrentLayout(): boolean {
  const { active } = useToolWindowLayouts.getState();
  if (!active) return false;
  saveLayout(active);
  return true;
}

export function restoreDefaultLayout() {
  applyToolWindowLayout(defaultLayoutSnapshot());
  write({ ...useToolWindowLayouts.getState(), active: null });
}

/** Renames `from`; false when `to` is empty or taken by another layout. */
export function renameLayout(from: string, to: string): boolean {
  const n = to.trim();
  const s = useToolWindowLayouts.getState();
  if (!n || (n !== from && s.layouts.some((l) => l.name === n))) return false;
  write({
    layouts: s.layouts.map((l) => (l.name === from ? { ...l, name: n } : l)),
    active: s.active === from ? n : s.active,
  });
  return true;
}

export function deleteLayout(name: string) {
  const s = useToolWindowLayouts.getState();
  write({ layouts: s.layouts.filter((l) => l.name !== name), active: s.active === name ? null : s.active });
}

/** Test helper: re-reads storage. */
export function _reloadLayouts() {
  useToolWindowLayouts.setState(read());
}
