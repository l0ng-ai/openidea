/**
 * The phone's bottom bar is the user's: besides Editor and More it holds up to `MAX_TABS`
 * pages they pick (Agents, Git, Database or any tool window), in the order they drag them
 * to (More stays last). More lists the rest, the ones opened most first. Both are kept on
 * this device.
 */
import { create } from "zustand";
import type { MobilePage } from "./store";

/** A page the bar can hold. */
export type TabSlot = Exclude<MobilePage, "editor" | "more">;

/** An entry of the bar the user arranges: a page they picked, or the editor. */
export type BarItem = TabSlot | "editor";

export const MAX_TABS = 3;
export const DEFAULT_TABS: readonly BarItem[] = ["agents", "editor", "git", "database"];

/** Before anything is opened: the pages people reach for first. */
const DEFAULT_RANK: readonly TabSlot[] = [
  "agents",
  "git",
  "tool:project",
  "tool:terminal",
  "tool:run",
  "tool:problems",
  "database",
  "tool:debug",
  "tool:find",
  "tool:services",
  "tool:structure",
  "tool:notifications",
  "tool:bookmarks",
  "tool:todo",
];

const KEY = "openidea.mobile.tabs";

interface Saved {
  /** The bar's entries in order, the editor among them; More follows. */
  tabs: BarItem[];
  usage: Record<string, number>;
}

interface State extends Saved {
  /** More's Edit Tab Bar is on: tiles add and remove pages, the bar's tabs drag. */
  editing: boolean;
}

function load(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    let tabs = Array.isArray(saved?.tabs) ? saved.tabs : [...DEFAULT_TABS];
    if (!tabs.includes("editor")) tabs = [...tabs.slice(0, 1), "editor", ...tabs.slice(1)];
    return {
      tabs: tabs.filter((t) => t === "editor").length === 1 ? tabs.slice(0, MAX_TABS + 1) : [...DEFAULT_TABS],
      usage: saved?.usage && typeof saved.usage === "object" ? saved.usage : {},
    };
  } catch {
    return { tabs: [...DEFAULT_TABS], usage: {} };
  }
}

export const useMobileTabs = create<State>(() => ({ ...load(), editing: false }));

export function setEditingTabs(editing: boolean) {
  useMobileTabs.setState({ editing });
}

/** Moves the bar's entry at `from` to `to`. */
export function moveTab(from: number, to: number) {
  const tabs = [...useMobileTabs.getState().tabs];
  if (from === to || from < 0 || to < 0 || from >= tabs.length || to >= tabs.length) return;
  const [item] = tabs.splice(from, 1);
  tabs.splice(to, 0, item!);
  useMobileTabs.setState({ tabs });
}

useMobileTabs.subscribe((s, prev) => {
  if (s.tabs === prev.tabs && s.usage === prev.usage) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs: s.tabs, usage: s.usage }));
  } catch {
    // Storage full or unavailable: the bar still works for this session.
  }
});

export const isTabSlot = (page: MobilePage): page is TabSlot => page !== "editor" && page !== "more";

/** Adds `slot` to the bar or takes it off; false when the bar is full. */
export function toggleTab(slot: TabSlot): boolean {
  const { tabs } = useMobileTabs.getState();
  if (tabs.includes(slot)) {
    useMobileTabs.setState({ tabs: tabs.filter((t) => t !== slot) });
    return true;
  }
  if (tabs.length - 1 >= MAX_TABS) return false;
  useMobileTabs.setState({ tabs: [...tabs, slot] });
  return true;
}

export function recordPageUse(page: MobilePage) {
  if (!isTabSlot(page)) return;
  useMobileTabs.setState((s) => ({ usage: { ...s.usage, [page]: (s.usage[page] ?? 0) + 1 } }));
}

/** More's order: most opened first, then the usual favourites, then by name. */
export function compareSlots(usage: Record<string, number>, a: TabSlot, b: TabSlot, title: (s: TabSlot) => string) {
  const used = (usage[b] ?? 0) - (usage[a] ?? 0);
  if (used) return used;
  const rank = (s: TabSlot) => {
    const i = DEFAULT_RANK.indexOf(s);
    return i < 0 ? DEFAULT_RANK.length : i;
  };
  return rank(a) - rank(b) || title(a).localeCompare(title(b));
}
