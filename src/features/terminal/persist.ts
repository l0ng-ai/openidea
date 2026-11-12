/**
 * Terminal tabs remembered per project: which tabs were open, each one's
 * working directory and rename, and how the tab groups were split. Shell
 * scrollback is not kept; a tab comes back as a new session in that directory.
 */
import type { GroupLayout, SplitOrientation } from "./store";

const STORAGE_PREFIX = "openidea.terminal.tabs.v1:";

interface StoredTab {
  id: string;
  name: string;
  customName: string | null;
  cwd: string;
  group: string;
  /** Predefined shell program. A one-shot command is not replayed. */
  shell: string | null;
}

export interface StoredTerminals {
  v: 1;
  tabs: StoredTab[];
  layout: GroupLayout;
  selected: Record<string, string>;
  activeTab: string | null;
}

const MAX_TABS = 32;

export function storageKey(root: string): string {
  return STORAGE_PREFIX + root;
}

export function readStored(root: string): StoredTerminals | null {
  try {
    return decode(JSON.parse(localStorage.getItem(storageKey(root)) ?? "null"));
  } catch {
    return null;
  }
}

export function writeStored(root: string, stored: StoredTerminals) {
  try {
    localStorage.setItem(storageKey(root), JSON.stringify(stored));
  } catch {
    /* storage unavailable or full: the tabs just aren't remembered */
  }
}

export function decode(raw: unknown): StoredTerminals | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (v.v !== 1 || !Array.isArray(v.tabs)) return null;
  const layout = decodeLayout(v.layout);
  if (!layout) return null;
  const groups = new Set(groupIds(layout));
  const fallback = groupIds(layout)[0];
  if (!fallback) return null;
  const tabs: StoredTab[] = [];
  const ids = new Set<string>();
  for (const item of v.tabs) {
    if (tabs.length >= MAX_TABS) break;
    const tab = decodeTab(item, groups, fallback);
    if (!tab || ids.has(tab.id)) continue;
    ids.add(tab.id);
    tabs.push(tab);
  }
  const selected: Record<string, string> = {};
  if (v.selected && typeof v.selected === "object") {
    for (const [group, id] of Object.entries(v.selected as Record<string, unknown>)) {
      if (groups.has(group) && typeof id === "string" && ids.has(id)) selected[group] = id;
    }
  }
  const activeTab = typeof v.activeTab === "string" && ids.has(v.activeTab) ? v.activeTab : null;
  return { v: 1, tabs, layout, selected, activeTab };
}

function decodeTab(item: unknown, groups: Set<string>, fallback: string): StoredTab | null {
  if (!item || typeof item !== "object") return null;
  const t = item as Record<string, unknown>;
  if (typeof t.id !== "string" || !t.id || typeof t.name !== "string" || !t.name.trim()) return null;
  if (typeof t.cwd !== "string" || !t.cwd) return null;
  const group = typeof t.group === "string" && groups.has(t.group) ? t.group : fallback;
  const customName = typeof t.customName === "string" && t.customName.trim() ? t.customName.trim() : null;
  const shell = typeof t.shell === "string" && t.shell ? t.shell : null;
  return { id: t.id, name: t.name.trim(), customName, cwd: t.cwd, group, shell };
}

function decodeLayout(raw: unknown): GroupLayout | null {
  if (typeof raw === "string") return raw || null;
  if (!raw || typeof raw !== "object") return null;
  const node = raw as Record<string, unknown>;
  if (typeof node.id !== "string" || !node.id) return null;
  if (node.orientation !== "horizontal" && node.orientation !== "vertical") return null;
  if (!Array.isArray(node.children) || node.children.length < 2) return null;
  const children: GroupLayout[] = [];
  for (const child of node.children) {
    const decoded = decodeLayout(child);
    if (!decoded) return null;
    children.push(decoded);
  }
  return { id: node.id, orientation: node.orientation as SplitOrientation, children };
}

function groupIds(node: GroupLayout): string[] {
  return typeof node === "string" ? [node] : node.children.flatMap(groupIds);
}
