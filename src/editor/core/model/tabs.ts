/**
 * Editor tabs and splits as pure state transitions (IDEA semantics):
 *  - one preview tab per pane (italic), replaced by the next preview, promoted
 *    to a regular tab when edited or opened explicitly, closed when another
 *    regular tab opens;
 *  - pinned tabs stay at the front and survive Close Others / Close Tabs to the
 *    Right / Close All but Pinned;
 *  - new tabs open right of the active tab; closing activates the left
 *    neighbour (or the right one / the most recently used, per settings);
 *  - splits form a tree of rows / columns; an emptied pane collapses away
 *    unless it is the last one.
 */
import type { EditorInput } from "@/workbench/contributions";

export interface Tab {
  id: string;
  input: EditorInput;
  preview: boolean;
  pinned: boolean;
}

export interface Pane {
  id: string;
  tabs: Tab[];
  active: string | null;
  /** Tab ids, most recently used first. */
  mru: string[];
}

export type LayoutNode =
  | { kind: "pane"; paneId: string }
  | { kind: "split"; id: string; dir: "row" | "column"; children: LayoutNode[] };

export interface ClosedTab {
  input: EditorInput;
  paneId: string;
  index: number;
  pinned: boolean;
}

export interface TabsState {
  layout: LayoutNode;
  panes: Record<string, Pane>;
  activePane: string;
  /** Most recently closed last (⌘⇧T pops). */
  closed: ClosedTab[];
}

const MAX_CLOSED = 50;

/** Editor Tabs › "When the current tab is closed, activate": set from settings by the controller. */
export const tabOptions: { activateOnClose: "mru" | "left" | "right" } = { activateOnClose: "left" };
let seq = 0;
const nextId = (p: string) => `${p}${++seq}`;

export function initialTabsState(): TabsState {
  const id = nextId("pane");
  return {
    layout: { kind: "pane", paneId: id },
    panes: { [id]: { id, tabs: [], active: null, mru: [] } },
    activePane: id,
    closed: [],
  };
}

export function paneOf(s: TabsState, paneId: string): Pane {
  const p = s.panes[paneId];
  if (!p) throw new Error(`no pane ${paneId}`);
  return p;
}

export function findTab(s: TabsState, key: string, paneId?: string): { paneId: string; tab: Tab } | null {
  const order = paneId ? [paneId, ...paneIds(s).filter((p) => p !== paneId)] : paneIds(s);
  for (const id of order) {
    const tab = s.panes[id]?.tabs.find((t) => t.input.key === key);
    if (tab) return { paneId: id, tab };
  }
  return null;
}

/** Pane ids in visual order (depth-first through the layout). */
export function paneIds(s: TabsState): string[] {
  const out: string[] = [];
  const walk = (n: LayoutNode) => (n.kind === "pane" ? out.push(n.paneId) : n.children.forEach(walk));
  walk(s.layout);
  return out;
}

/** Every distinct input key open in any pane. */
export function openKeys(s: TabsState): Set<string> {
  const keys = new Set<string>();
  for (const p of Object.values(s.panes)) for (const t of p.tabs) keys.add(t.input.key);
  return keys;
}

function withPane(s: TabsState, pane: Pane): TabsState {
  return { ...s, panes: { ...s.panes, [pane.id]: pane } };
}

function touch(pane: Pane, tabId: string): Pane {
  return { ...pane, active: tabId, mru: [tabId, ...pane.mru.filter((id) => id !== tabId)] };
}

function pinnedCount(pane: Pane) {
  let n = 0;
  while (n < pane.tabs.length && pane.tabs[n]!.pinned) n++;
  return n;
}

export interface OpenTabOptions {
  preview?: boolean;
  pinned?: boolean;
  /** Insert at this index instead of after the active tab. */
  index?: number;
  activate?: boolean;
}

export function openTab(
  s: TabsState,
  paneId: string,
  input: EditorInput,
  opts: OpenTabOptions = {},
): { state: TabsState; tabId: string } {
  let pane = paneOf(s, paneId);
  const activate = opts.activate ?? true;
  const existing = pane.tabs.find((t) => t.input.key === input.key);
  if (existing) {
    let tab = existing;
    if (!opts.preview && tab.preview) tab = { ...tab, preview: false, input };
    else if (tab.input !== input) tab = { ...tab, input: { ...tab.input, ...input } };
    pane = { ...pane, tabs: pane.tabs.map((t) => (t.id === existing.id ? tab : t)) };
    if (activate) pane = touch(pane, tab.id);
    return { state: { ...withPane(s, pane), activePane: activate ? paneId : s.activePane }, tabId: tab.id };
  }
  const tab: Tab = { id: nextId("tab"), input, preview: !!opts.preview && !opts.pinned, pinned: !!opts.pinned };
  const tabs = [...pane.tabs];
  const previewIdx = tab.preview ? tabs.findIndex((t) => t.preview) : -1;
  let mru = pane.mru;
  if (previewIdx >= 0) {
    // The preview slot is reused in place.
    mru = mru.filter((id) => id !== tabs[previewIdx]!.id);
    tabs[previewIdx] = tab;
  } else {
    const pins = pinnedCount(pane);
    let index: number;
    if (tab.pinned) index = pins;
    else if (opts.index !== undefined) index = Math.max(pins, Math.min(opts.index, tabs.length));
    else {
      const activeIdx = tabs.findIndex((t) => t.id === pane.active);
      index = Math.max(pins, activeIdx + 1);
    }
    tabs.splice(index, 0, tab);
  }
  let active = pane.active;
  if (!tab.preview && tabs.some((t) => t.preview)) {
    // A new regular editor closes the preview tab (IDEA trims previews on every open).
    const previews = new Set(tabs.filter((t) => t.preview).map((t) => t.id));
    tabs.splice(0, tabs.length, ...tabs.filter((t) => !previews.has(t.id)));
    mru = mru.filter((id) => !previews.has(id));
    if (active && previews.has(active)) active = null;
  }
  pane = { ...pane, tabs, active, mru: activate ? mru : [...mru, tab.id] };
  pane = activate ? touch(pane, tab.id) : { ...pane, active: pane.active ?? tab.id };
  return { state: { ...withPane(s, pane), activePane: activate ? paneId : s.activePane }, tabId: tab.id };
}

export function activateTab(s: TabsState, paneId: string, tabId: string): TabsState {
  const pane = paneOf(s, paneId);
  if (!pane.tabs.some((t) => t.id === tabId)) return s;
  if (pane.active === tabId && s.activePane === paneId && pane.mru[0] === tabId) return s;
  return { ...withPane(s, touch(pane, tabId)), activePane: paneId };
}

export function setActivePane(s: TabsState, paneId: string): TabsState {
  return s.panes[paneId] && s.activePane !== paneId ? { ...s, activePane: paneId } : s;
}

export function promoteTab(s: TabsState, paneId: string, tabId: string): TabsState {
  const pane = paneOf(s, paneId);
  const tab = pane.tabs.find((t) => t.id === tabId);
  if (!tab?.preview) return s;
  return withPane(s, { ...pane, tabs: pane.tabs.map((t) => (t.id === tabId ? { ...t, preview: false } : t)) });
}

export function togglePin(s: TabsState, paneId: string, tabId: string): TabsState {
  const pane = paneOf(s, paneId);
  const tab = pane.tabs.find((t) => t.id === tabId);
  if (!tab) return s;
  const rest = pane.tabs.filter((t) => t.id !== tabId);
  const updated: Tab = { ...tab, pinned: !tab.pinned, preview: false };
  const pins = rest.filter((t) => t.pinned).length;
  // Pinning moves the tab to the end of the pinned group; unpinning right after it.
  rest.splice(pins, 0, updated);
  return withPane(s, { ...pane, tabs: rest });
}

function removeTabs(s: TabsState, paneId: string, ids: Set<string>): TabsState {
  if (!ids.size) return s;
  let pane = paneOf(s, paneId);
  const closed: ClosedTab[] = [];
  pane.tabs.forEach((t, index) => {
    if (ids.has(t.id)) closed.push({ input: t.input, paneId, index, pinned: t.pinned });
  });
  const tabs = pane.tabs.filter((t) => !ids.has(t.id));
  const mru = pane.mru.filter((id) => !ids.has(id));
  let active = pane.active;
  if (active && ids.has(active)) {
    const at = pane.tabs.findIndex((t) => t.id === active);
    const left = pane.tabs
      .slice(0, at)
      .reverse()
      .find((t) => !ids.has(t.id));
    const right = pane.tabs.slice(at + 1).find((t) => !ids.has(t.id));
    const pick =
      tabOptions.activateOnClose === "left"
        ? (left ?? right)
        : tabOptions.activateOnClose === "right"
          ? (right ?? left)
          : undefined;
    active = pick?.id ?? mru[0] ?? tabs[0]?.id ?? null;
  }
  pane = { ...pane, tabs, mru, active };
  let next: TabsState = {
    ...withPane(s, pane),
    closed: [...s.closed, ...closed.reverse()].slice(-MAX_CLOSED),
  };
  if (!tabs.length && paneIds(next).length > 1) next = removePane(next, paneId);
  return next;
}

export function closeTab(s: TabsState, paneId: string, tabId: string): TabsState {
  return removeTabs(s, paneId, new Set([tabId]));
}

export function closeOthers(s: TabsState, paneId: string, tabId: string): TabsState {
  const pane = paneOf(s, paneId);
  const ids = new Set(pane.tabs.filter((t) => t.id !== tabId && !t.pinned).map((t) => t.id));
  const next = removeTabs(s, paneId, ids);
  return next.panes[paneId] ? activateTab(next, paneId, tabId) : next;
}

export function closeAll(s: TabsState, paneId: string, keepPinned = false): TabsState {
  const pane = paneOf(s, paneId);
  return removeTabs(s, paneId, new Set(pane.tabs.filter((t) => !keepPinned || !t.pinned).map((t) => t.id)));
}

export function closeToRight(s: TabsState, paneId: string, tabId: string): TabsState {
  const pane = paneOf(s, paneId);
  const idx = pane.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return s;
  return removeTabs(
    s,
    paneId,
    new Set(
      pane.tabs
        .slice(idx + 1)
        .filter((t) => !t.pinned)
        .map((t) => t.id),
    ),
  );
}

export function closeToLeft(s: TabsState, paneId: string, tabId: string): TabsState {
  const pane = paneOf(s, paneId);
  const idx = pane.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return s;
  return removeTabs(
    s,
    paneId,
    new Set(
      pane.tabs
        .slice(0, idx)
        .filter((t) => !t.pinned)
        .map((t) => t.id),
    ),
  );
}

/** IDEA "Close Unmodified Tabs": closes the unpinned tabs `modified` says no to. */
export function closeUnmodified(s: TabsState, paneId: string, modified: (t: Tab) => boolean): TabsState {
  const pane = paneOf(s, paneId);
  return removeTabs(s, paneId, new Set(pane.tabs.filter((t) => !t.pinned && !modified(t)).map((t) => t.id)));
}

/** Closes every tab showing `key` in all panes (file deleted, document closed). */
export function closeKey(s: TabsState, key: string): TabsState {
  let next = s;
  for (const id of paneIds(s)) {
    const pane = next.panes[id];
    if (!pane) continue;
    next = removeTabs(next, id, new Set(pane.tabs.filter((t) => t.input.key === key).map((t) => t.id)));
  }
  return next;
}

export function reopenClosed(s: TabsState): { state: TabsState; tabId: string; paneId: string } | null {
  const openNow = openKeys(s);
  const closed = [...s.closed];
  while (closed.length) {
    const entry = closed.pop()!;
    if (openNow.has(entry.input.key) && findTab(s, entry.input.key, entry.paneId)?.paneId === entry.paneId) continue;
    const paneId = s.panes[entry.paneId] ? entry.paneId : s.activePane;
    const { state, tabId } = openTab({ ...s, closed }, paneId, entry.input, {
      index: entry.index,
      pinned: entry.pinned,
    });
    return { state, tabId, paneId };
  }
  return null;
}

/**
 * Tab limit: closes tabs of `paneId` beyond `limit` (pinned, `keep` and
 * `isProtected` tabs excluded). `unchanged` closes the least recently used
 * unmodified tab first, `lru` the least recently used one.
 */
export function enforceTabLimit(
  s: TabsState,
  paneId: string,
  limit: number,
  policy: string,
  isDirty: (tab: Tab) => boolean,
  keep?: string,
  isProtected?: (tab: Tab) => boolean,
): TabsState {
  let next = s;
  for (;;) {
    const pane = next.panes[paneId];
    if (!pane || limit <= 0) return next;
    const closable = pane.tabs.filter((t) => !t.pinned && t.id !== keep && t.id !== pane.active && !isProtected?.(t));
    if (pane.tabs.filter((t) => !t.pinned).length <= limit || !closable.length) return next;
    const lruOrder = [...closable].sort((a, b) => rank(pane, b) - rank(pane, a));
    const victim = (policy === "unchanged" ? lruOrder.find((t) => !isDirty(t)) : undefined) ?? lruOrder[0]!;
    next = removeTabs(next, paneId, new Set([victim.id]));
  }
}

/** Larger = used longer ago (never activated counts as oldest). */
function rank(pane: Pane, tab: Tab): number {
  const i = pane.mru.indexOf(tab.id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/** Editor Tabs › Sort tabs alphabetically: orders the pinned and the other tabs of a pane by `title`. */
export function sortTabs(s: TabsState, paneId: string, title: (t: Tab) => string): TabsState {
  const pane = paneOf(s, paneId);
  const byTitle = (a: Tab, b: Tab) =>
    title(a).localeCompare(title(b), undefined, { sensitivity: "base" }) || title(a).localeCompare(title(b));
  const tabs = [
    ...pane.tabs.filter((t) => t.pinned).sort(byTitle),
    ...pane.tabs.filter((t) => !t.pinned).sort(byTitle),
  ];
  return tabs.every((t, i) => t === pane.tabs[i]) ? s : withPane(s, { ...pane, tabs });
}

export function cycleTab(s: TabsState, delta: number, paneId = s.activePane): TabsState {
  const pane = paneOf(s, paneId);
  if (pane.tabs.length < 2) return s;
  const idx = pane.tabs.findIndex((t) => t.id === pane.active);
  const next = pane.tabs[(idx + delta + pane.tabs.length) % pane.tabs.length]!;
  return activateTab(s, paneId, next.id);
}

/** Moves a tab (drag & drop) within or across panes. */
export function moveTab(s: TabsState, fromPane: string, tabId: string, toPane: string, index: number): TabsState {
  const src = paneOf(s, fromPane);
  const tab = src.tabs.find((t) => t.id === tabId);
  if (!tab) return s;
  if (fromPane === toPane) {
    const tabs = src.tabs.filter((t) => t.id !== tabId);
    const at = Math.max(0, Math.min(index > src.tabs.indexOf(tab) ? index - 1 : index, tabs.length));
    tabs.splice(at, 0, tab);
    return { ...withPane(s, touch({ ...src, tabs }, tabId)), activePane: toPane };
  }
  const dst = paneOf(s, toPane);
  const dup = dst.tabs.find((t) => t.input.key === tab.input.key);
  let next = removeTabs(s, fromPane, new Set([tabId]));
  next = { ...next, closed: s.closed };
  if (dup) return { ...activateTab(next, toPane, dup.id), activePane: toPane };
  const dstNow = paneOf(next, toPane);
  const tabs = [...dstNow.tabs];
  tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab);
  return { ...withPane(next, touch({ ...dstNow, tabs }, tab.id)), activePane: toPane };
}

// --- splits -----------------------------------------------------------------

function mapLayout(n: LayoutNode, f: (n: LayoutNode) => LayoutNode | null): LayoutNode | null {
  const mapped = f(n);
  if (mapped !== n || n.kind === "pane") return mapped;
  const children = n.children.map((c) => mapLayout(c, f)).filter((c): c is LayoutNode => !!c);
  if (!children.length) return null;
  if (children.length === 1) return children[0]!;
  // Flatten nested splits in the same direction.
  const flat = children.flatMap((c) => (c.kind === "split" && c.dir === n.dir ? c.children : [c]));
  return { ...n, children: flat };
}

/** Splits `paneId` and opens a copy of its active tab in the new pane. */
export function splitPane(s: TabsState, paneId: string, dir: "row" | "column"): { state: TabsState; paneId: string } {
  const src = paneOf(s, paneId);
  const id = nextId("pane");
  const active = src.tabs.find((t) => t.id === src.active);
  const tab: Tab | null = active ? { ...active, id: nextId("tab"), preview: false, pinned: false } : null;
  const pane: Pane = { id, tabs: tab ? [tab] : [], active: tab?.id ?? null, mru: tab ? [tab.id] : [] };
  const layout = mapLayout(s.layout, (n) => {
    if (n.kind === "pane" && n.paneId === paneId)
      return { kind: "split", id: nextId("split"), dir, children: [n, { kind: "pane", paneId: id }] };
    return n;
  })!;
  return { state: { ...s, layout, panes: { ...s.panes, [id]: pane }, activePane: id }, paneId: id };
}

export function removePane(s: TabsState, paneId: string): TabsState {
  if (paneIds(s).length <= 1) return s;
  const order = paneIds(s);
  const layout = mapLayout(s.layout, (n) => (n.kind === "pane" && n.paneId === paneId ? null : n))!;
  const panes = { ...s.panes };
  delete panes[paneId];
  let activePane = s.activePane;
  if (activePane === paneId) {
    const i = order.indexOf(paneId);
    activePane = order[i - 1] ?? order[i + 1] ?? Object.keys(panes)[0]!;
  }
  return { ...s, layout, panes, activePane };
}

/** Flips the split that directly holds `paneId` between side by side and stacked. */
export function changeSplitOrientation(s: TabsState, paneId: string): TabsState {
  let changed = false;
  const flipped = mapLayout(s.layout, (n) => {
    if (n.kind !== "split" || !n.children.some((c) => c.kind === "pane" && c.paneId === paneId)) return n;
    changed = true;
    const dir = n.dir === "row" ? "column" : "row";
    return { ...n, dir, children: n.children.flatMap((c) => (c.kind === "split" && c.dir === dir ? c.children : [c])) };
  })!;
  // The parent flattens a flipped split that now runs its way; the flipped one absorbs its children.
  return changed ? { ...s, layout: flipped } : s;
}

/** Removes every pane except `keepPane`. */
export function unsplitAll(s: TabsState, keepPane: string): TabsState {
  if (!s.panes[keepPane]) return s;
  return {
    ...s,
    layout: { kind: "pane", paneId: keepPane },
    panes: { [keepPane]: s.panes[keepPane] },
    activePane: keepPane,
  };
}

/** The pane right of / below `paneId`, if any (for "open to the side"). */
export function neighbourPane(s: TabsState, paneId: string): string | null {
  const order = paneIds(s);
  const i = order.indexOf(paneId);
  return order[i + 1] ?? order[i - 1] ?? null;
}

export type SplitEdge = "left" | "right" | "top" | "bottom";

/**
 * Drag & drop onto an editor edge: moves the tab into a new pane split off
 * `targetPane` on that side. The tab keeps its id (and editor state).
 */
export function moveTabToNewSplit(
  s: TabsState,
  fromPane: string,
  tabId: string,
  targetPane: string,
  edge: SplitEdge,
): { state: TabsState; paneId: string } | null {
  const src = s.panes[fromPane];
  const tab = src?.tabs.find((t) => t.id === tabId);
  if (!src || !tab || !s.panes[targetPane]) return null;
  if (fromPane === targetPane && src.tabs.length === 1) return null;
  const next = { ...removeTabs(s, fromPane, new Set([tabId])), closed: s.closed };
  // The source pane may have collapsed away; split the target if it survived, else the active pane.
  const anchor = next.panes[targetPane] ? targetPane : next.activePane;
  const moved: Tab = { ...tab, preview: false };
  return splitAtEdge(next, anchor, edge, { tabs: [moved], active: moved.id, mru: [moved.id] });
}

/** A new pane (empty unless `content` is given) at `edge` of `anchor`, made active. */
export function splitAtEdge(
  s: TabsState,
  anchor: string,
  edge: SplitEdge,
  content: Omit<Pane, "id"> = { tabs: [], active: null, mru: [] },
): { state: TabsState; paneId: string } {
  const id = nextId("pane");
  const dir = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  const layout = mapLayout(s.layout, (n) => {
    if (n.kind === "pane" && n.paneId === anchor) {
      const added: LayoutNode = { kind: "pane", paneId: id };
      return { kind: "split", id: nextId("split"), dir, children: before ? [added, n] : [n, added] };
    }
    return n;
  })!;
  return { state: { ...s, layout, panes: { ...s.panes, [id]: { id, ...content } }, activePane: id }, paneId: id };
}
