/**
 * Tool window layout state, IDEA semantics: each side (left / right / bottom)
 * has a primary and a split area, each showing at most one window; showing
 * another window in the same area replaces it. Layout (visible windows,
 * sizes, split ratios, placements) is persisted per project root in localStorage.
 */
import { create } from "zustand";
import { setContext } from "@/platform/context";
import {
  useContributions,
  type ToolWindowAnchor,
  type ToolWindowContribution,
  type ToolWindowService,
} from "../contributions";
import { focusEditor } from "../focus";

export const ANCHORS: readonly ToolWindowAnchor[] = ["left", "bottom", "right"];

/** Where a window docks: a side's primary area, or its split area (IDEA's `isSplit`). */
export type ToolWindowSlot = ToolWindowAnchor | `${ToolWindowAnchor}-split`;
export const SLOTS: readonly ToolWindowSlot[] = [
  "left",
  "left-split",
  "bottom",
  "bottom-split",
  "right",
  "right-split",
];
export type SlotRecord = Record<ToolWindowSlot, string | null>;

export const DEFAULT_SIZES: Record<ToolWindowAnchor, number> = { left: 240, right: 300, bottom: 280 };
/** Share of a side taken by its primary area when both areas show (IDEA's sideWeight). */
export const DEFAULT_SPLIT = 0.5;
const DEFAULT_SPLITS: Record<ToolWindowAnchor, number> = {
  left: DEFAULT_SPLIT,
  right: DEFAULT_SPLIT,
  bottom: DEFAULT_SPLIT,
};
const NONE: SlotRecord = {
  left: null,
  "left-split": null,
  bottom: null,
  "bottom-split": null,
  right: null,
  "right-split": null,
};
const DEFAULT_VISIBLE: SlotRecord = { ...NONE, left: "project" };
const STORAGE_PREFIX = "openidea.layout.v1:";
/** Stored layout format: 1 = one area per side (no `v` field), 2 = primary + split areas. */
const LAYOUT_VERSION = 2;

/** User placement of a tool window (dragged on the stripes / "Move To"), overriding the contribution. */
export interface ToolWindowPlacement {
  anchor: ToolWindowAnchor;
  /** Split area; unset: the contribution's `secondary` when on its own side, else primary. */
  split?: boolean;
  order?: number;
}

export function slotOf(tw: Pick<ToolWindowContribution, "anchor" | "secondary">): ToolWindowSlot {
  return tw.secondary ? `${tw.anchor}-split` : tw.anchor;
}

export function slotAnchor(slot: ToolWindowSlot): ToolWindowAnchor {
  return slot.replace("-split", "") as ToolWindowAnchor;
}

export function isSplitSlot(slot: ToolWindowSlot): boolean {
  return slot.endsWith("-split");
}

export interface ToolWindowLayoutState {
  scope: string;
  visible: SlotRecord;
  sizes: Record<ToolWindowAnchor, number>;
  /** Per side: the primary area's share when both areas show. */
  splits: Record<ToolWindowAnchor, number>;
  maximized: ToolWindowAnchor | null;
  /** Tool window containing DOM focus. */
  focused: string | null;
  /** Most recently activated window (target of Shift+Escape). */
  lastActive: string | null;
  /** Windows shown at least once; kept mounted while hidden in their area. */
  mounted: ReadonlySet<string>;
  /** Bumped to ask a panel to take focus. */
  focusRequest: { id: string; seq: number } | null;
  /** Visible set stashed by "Hide All" so pressing it again restores. */
  stashed: SlotRecord | null;
  /** Per-window placement overrides (persisted). */
  placements: Readonly<Record<string, ToolWindowPlacement>>;
  /** User choice of stripe buttons (opened → added, "Hide" → removed); persisted. */
  stripeButtons: Readonly<Record<string, boolean>>;
  /** Layout before Distraction Free Mode; restored on exit and persisted in place of `visible` meanwhile. */
  distractionFreeStash: SlotRecord | null;
}

const initial = (): ToolWindowLayoutState => ({
  scope: "",
  visible: { ...DEFAULT_VISIBLE },
  sizes: { ...DEFAULT_SIZES },
  splits: { ...DEFAULT_SPLITS },
  maximized: null,
  focused: null,
  lastActive: null,
  mounted: new Set(Object.values(DEFAULT_VISIBLE).filter((v): v is string => !!v)),
  focusRequest: null,
  stashed: null,
  placements: {},
  stripeButtons: {},
  distractionFreeStash: null,
});

export const useToolWindowLayout = create<ToolWindowLayoutState>(initial);

let focusSeq = 0;

/** The contribution with the user's placement applied. */
export function placed(
  tw: ToolWindowContribution,
  placements: Readonly<Record<string, ToolWindowPlacement>>,
): ToolWindowContribution {
  const p = placements[tw.id];
  if (!p) return tw;
  const secondary = p.split ?? (p.anchor === tw.anchor && !!tw.secondary);
  return { ...tw, anchor: p.anchor, secondary, order: p.order ?? tw.order };
}

/** The area a registered window docks in, with the user's placement applied. */
export function slotOfId(id: string): ToolWindowSlot | undefined {
  const tw = useContributions.getState().toolWindows.get(id);
  return tw && slotOf(placed(tw, useToolWindowLayout.getState().placements));
}

export function anchorOf(id: string): ToolWindowAnchor | undefined {
  const slot = slotOfId(id);
  return slot && slotAnchor(slot);
}

/** The other area of the same side. */
function partnerSlot(slot: ToolWindowSlot): ToolWindowSlot {
  return isSplitSlot(slot) ? slotAnchor(slot) : `${slot as ToolWindowAnchor}-split`;
}

const byOrder = (a: ToolWindowContribution, b: ToolWindowContribution) =>
  (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title);

/**
 * Moves a tool window to an area (stripe group / "Move To"), before `before`
 * (or last). Orders of the target area are renumbered so the drop position
 * sticks. A visible window stays visible in its new area (replacing what was
 * shown there).
 */
export function moveToolWindow(id: string, slot: ToolWindowSlot, before: string | null = null) {
  const contributions = useContributions.getState().toolWindows;
  if (!contributions.has(id)) return;
  const s = useToolWindowLayout.getState();
  const oldSlot = slotOfId(id)!;
  const wasVisible = s.visible[oldSlot] === id;
  const members = [...contributions.values()]
    .map((w) => placed(w, s.placements))
    .filter((w) => w.id !== id && slotOf(w) === slot)
    .sort(byOrder);
  const at = before ? members.findIndex((w) => w.id === before) : -1;
  const ids = members.map((w) => w.id);
  ids.splice(at >= 0 ? at : ids.length, 0, id);
  const placements: Record<string, ToolWindowPlacement> = { ...s.placements };
  ids.forEach((wid, i) => {
    const order = (i + 1) * 10;
    placements[wid] =
      wid === id
        ? { anchor: slotAnchor(slot), split: isSplitSlot(slot), order }
        : { ...(s.placements[wid] ?? { anchor: contributions.get(wid)!.anchor }), order };
  });
  const visible = { ...s.visible };
  if (wasVisible && oldSlot !== slot) {
    visible[oldSlot] = null;
    visible[slot] = id;
  }
  const oldAnchor = slotAnchor(oldSlot);
  update({
    placements,
    visible,
    maximized: wasVisible && s.maximized === oldAnchor && oldAnchor !== slotAnchor(slot) ? null : s.maximized,
  });
}

/** Forgets every placement override and stripe button choice ("Restore Default Layout"). */
export function resetToolWindowPlacements() {
  const s = useToolWindowLayout.getState();
  const visible = { ...s.visible };
  // Windows shown in an area they no longer belong to are hidden.
  for (const slot of SLOTS) {
    const tw = visible[slot] ? useContributions.getState().toolWindows.get(visible[slot]!) : undefined;
    if (tw && slotOf(tw) !== slot) visible[slot] = null;
  }
  update({ placements: {}, stripeButtons: {}, visible });
}

function storageKey(scope: string) {
  return STORAGE_PREFIX + scope;
}

function readStorage(scope: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function persist() {
  const {
    scope,
    visible: current,
    sizes,
    splits,
    placements,
    stripeButtons,
    distractionFreeStash,
  } = useToolWindowLayout.getState();
  // Distraction Free Mode is not saved: the layout to restore is.
  const visible = distractionFreeStash ?? current;
  try {
    localStorage.setItem(
      storageKey(scope),
      JSON.stringify({ v: LAYOUT_VERSION, visible, sizes, splits, placements, stripeButtons }),
    );
  } catch {
    /* storage unavailable */
  }
}

function sanitizeSizes(sizes: unknown): Record<ToolWindowAnchor, number> {
  const out = { ...DEFAULT_SIZES };
  if (sizes && typeof sizes === "object") {
    for (const a of ANCHORS) {
      const v = (sizes as Record<string, unknown>)[a];
      if (typeof v === "number" && isFinite(v) && v >= 80 && v <= 4000) out[a] = Math.round(v);
    }
  }
  return out;
}

export const MIN_SPLIT = 0.1;
export const MAX_SPLIT = 0.9;

function sanitizeSplits(splits: unknown): Record<ToolWindowAnchor, number> {
  const out = { ...DEFAULT_SPLITS };
  if (splits && typeof splits === "object") {
    for (const a of ANCHORS) {
      const v = (splits as Record<string, unknown>)[a];
      if (typeof v === "number" && v >= MIN_SPLIT && v <= MAX_SPLIT) out[a] = v;
    }
  }
  return out;
}

/**
 * Stored placements. Format 1 had no split areas: `secondary` only picked the
 * lower group of the right stripe, which is now the Right Bottom area; on the
 * left and bottom it meant nothing, so the contribution's default applies.
 */
export function sanitizePlacements(raw: unknown, version = LAYOUT_VERSION): Record<string, ToolWindowPlacement> {
  const out: Record<string, ToolWindowPlacement> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = v as { anchor?: unknown; split?: unknown; secondary?: unknown; order?: unknown } | null;
    if (!p || !ANCHORS.includes(p.anchor as ToolWindowAnchor)) continue;
    const anchor = p.anchor as ToolWindowAnchor;
    const split =
      version >= 2
        ? typeof p.split === "boolean"
          ? p.split
          : undefined
        : anchor === "right" && p.secondary
          ? true
          : undefined;
    out[id] = {
      anchor,
      ...(split !== undefined ? { split } : {}),
      ...(typeof p.order === "number" && isFinite(p.order) ? { order: p.order } : {}),
    };
  }
  return out;
}

function sanitizeStripeButtons(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (raw && typeof raw === "object")
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "boolean") out[id] = v;
  return out;
}

function sanitizeVisible(raw: unknown): SlotRecord {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_VISIBLE };
  const out = { ...NONE };
  for (const slot of SLOTS) {
    const v = (raw as Record<string, unknown>)[slot];
    out[slot] = typeof v === "string" ? v : null;
  }
  return out;
}

/**
 * Moves visible windows recorded in an area they don't dock in (a layout
 * saved before a window became split, or before split areas existed) to
 * their area, unless that area already shows another window. Null: no change.
 */
function reconcile(visible: SlotRecord, placements: Readonly<Record<string, ToolWindowPlacement>>): SlotRecord | null {
  const windows = useContributions.getState().toolWindows;
  let out: SlotRecord | null = null;
  for (const slot of SLOTS) {
    const id = visible[slot];
    const tw = id ? windows.get(id) : undefined;
    if (!tw) continue;
    const home = slotOf(placed(tw, placements));
    if (home === slot) continue;
    out ??= { ...visible };
    out[slot] = null;
    if (!out[home]) out[home] = id;
  }
  return out;
}

/** Loads the layout saved for `scope` (a project root; "" without a project). */
export function loadToolWindowLayout(scope: string) {
  const saved = readStorage(scope);
  const version = typeof saved?.v === "number" ? saved.v : 1;
  const placements = sanitizePlacements(saved?.placements, version);
  let visible = sanitizeVisible(saved?.visible);
  visible = reconcile(visible, placements) ?? visible;
  useToolWindowLayout.setState({
    ...initial(),
    scope,
    visible,
    sizes: sanitizeSizes(saved?.sizes),
    splits: sanitizeSplits(saved?.splits),
    placements,
    stripeButtons: sanitizeStripeButtons(saved?.stripeButtons),
    mounted: new Set(Object.values(visible).filter((v): v is string => !!v)),
  });
  publishVisibility();
}

/**
 * Keeps the layout in step with tool window registrations: windows that
 * register after the layout loaded get their visibility context, and a
 * visible window recorded in the wrong area moves to its own.
 */
export function installToolWindowLayoutSync(): () => void {
  return useContributions.subscribe((c, prev) => {
    if (c.toolWindows === prev.toolWindows) return;
    const s = useToolWindowLayout.getState();
    const visible = reconcile(s.visible, s.placements);
    if (visible) {
      const mounted = new Set(s.mounted);
      for (const id of Object.values(visible)) if (id) mounted.add(id);
      update({ visible, mounted }, !!s.scope && !s.distractionFreeStash);
    } else publishVisibility();
  });
}

function publishVisibility() {
  const { visible, placements } = useToolWindowLayout.getState();
  for (const tw of useContributions.getState().toolWindows.values()) {
    setContext(`toolWindow.${tw.id}.visible`, visible[slotOf(placed(tw, placements))] === tw.id);
  }
}

function update(patch: Partial<ToolWindowLayoutState>, save = true) {
  useToolWindowLayout.setState(patch);
  publishVisibility();
  if (save) persist();
}

export function isToolWindowVisible(id: string): boolean {
  const slot = slotOfId(id);
  return !!slot && useToolWindowLayout.getState().visible[slot] === id;
}

/** Last shown or focused tool window, kept after it is hidden (Jump to Last Tool Window). */
let lastUsed: string | null = null;

export function lastUsedToolWindow(): string | null {
  return lastUsed && anchorOf(lastUsed) ? lastUsed : null;
}

/** F12: focus the last used tool window, reopening it if it was hidden. */
export function jumpToLastToolWindow() {
  const id = lastUsedToolWindow() ?? (anchorOf("project") ? "project" : null);
  if (id) focusToolWindow(id);
}

export function showToolWindow(id: string, focus = false) {
  const slot = slotOfId(id);
  if (!slot) return;
  const a = slotAnchor(slot);
  lastUsed = id;
  const s = useToolWindowLayout.getState();
  const mounted = s.mounted.has(id) ? s.mounted : new Set(s.mounted).add(id);
  update({
    visible: { ...s.visible, [slot]: id },
    // Opening a window puts its button on the stripe (IDEA).
    stripeButtons: s.stripeButtons[id] ? s.stripeButtons : { ...s.stripeButtons, [id]: true },
    mounted,
    lastActive: id,
    stashed: null,
    maximized: s.maximized && s.maximized !== a ? null : s.maximized,
    focusRequest: focus ? { id, seq: ++focusSeq } : s.focusRequest,
  });
}

export function hideToolWindow(id: string) {
  const slot = slotOfId(id);
  const s = useToolWindowLayout.getState();
  if (!slot || s.visible[slot] !== id) return;
  const hadFocus = s.focused === id || isFocusWithinToolWindow(id);
  // The side stays maximized while its other area still shows a window.
  const sideEmpty = !s.visible[partnerSlot(slot)];
  update({
    visible: { ...s.visible, [slot]: null },
    maximized: s.maximized === slotAnchor(slot) && sideEmpty ? null : s.maximized,
    lastActive: s.lastActive === id ? null : s.lastActive,
  });
  if (hadFocus) focusEditor();
}

/** Whether `tw` has a stripe button: the user's choice, else its default. */
export function hasStripeButton(tw: ToolWindowContribution, stripeButtons: Readonly<Record<string, boolean>>): boolean {
  return stripeButtons[tw.id] ?? tw.stripe !== "onUse";
}

/** Stripe button context menu "Hide": closes the window and removes its button (back under "…"). */
export function removeFromStripe(id: string) {
  hideToolWindow(id);
  const s = useToolWindowLayout.getState();
  update({ stripeButtons: { ...s.stripeButtons, [id]: false } });
}

export function toggleToolWindow(id: string) {
  if (isToolWindowVisible(id)) hideToolWindow(id);
  else showToolWindow(id, true);
}

/**
 * The `toolwindow.<id>` action: hidden → show + focus; visible but unfocused
 * → focus; visible and focused → hide (IDEA behaviour).
 */
export function activateToolWindow(id: string) {
  if (!isToolWindowVisible(id)) showToolWindow(id, true);
  else if (useToolWindowLayout.getState().focused !== id && !isFocusWithinToolWindow(id)) focusToolWindow(id);
  else hideToolWindow(id);
}

export function focusToolWindow(id: string) {
  if (!isToolWindowVisible(id)) return showToolWindow(id, true);
  update({ focusRequest: { id, seq: ++focusSeq }, lastActive: id }, false);
}

/** Hides every visible window; called again with nothing visible, restores them. */
export function hideAllToolWindows() {
  const s = useToolWindowLayout.getState();
  const anyVisible = SLOTS.some((slot) => s.visible[slot]);
  if (anyVisible) {
    const hadFocus = !!s.focused;
    update({ stashed: { ...s.visible }, visible: { ...NONE }, maximized: null });
    if (hadFocus) focusEditor();
  } else if (s.stashed) {
    update({ visible: { ...s.stashed }, stashed: null });
  }
}

/**
 * Entering Distraction Free Mode: remembers the visible windows and hides
 * them. Windows can still be opened meanwhile (by shortcut); exiting
 * restores the remembered layout. No-op without a project layout loaded.
 */
export function enterDistractionFreeLayout() {
  const s = useToolWindowLayout.getState();
  if (!s.scope || s.distractionFreeStash) return;
  const hadFocus = !!s.focused;
  update({
    distractionFreeStash: { ...s.visible },
    visible: { ...NONE },
    maximized: null,
    stashed: null,
  });
  if (hadFocus) focusEditor();
}

export function exitDistractionFreeLayout() {
  const s = useToolWindowLayout.getState();
  if (!s.distractionFreeStash) return;
  const visible = { ...s.distractionFreeStash };
  const mounted = new Set(s.mounted);
  for (const id of Object.values(visible)) if (id) mounted.add(id);
  update({ visible, mounted, distractionFreeStash: null, maximized: null, stashed: null });
  if (s.focused && !Object.values(visible).includes(s.focused)) focusEditor();
}

export function hideActiveToolWindow() {
  const s = useToolWindowLayout.getState();
  const id = s.focused ?? s.lastActive;
  if (id) hideToolWindow(id);
}

export function setToolWindowSize(anchor: ToolWindowAnchor, px: number) {
  const s = useToolWindowLayout.getState();
  const v = Math.round(px);
  if (s.maximized === anchor || v < 80 || s.sizes[anchor] === v) return;
  update({ sizes: { ...s.sizes, [anchor]: v } });
}

export type ResizeDirection = "left" | "right" | "up" | "down";

/** Pixels per Resize Tool Window step. */
export const RESIZE_STEP = 24;

/** Size change of a window docked at `anchor` for an arrow: moving its inner edge outwards grows it. */
export function resizeDelta(anchor: ToolWindowAnchor, dir: ResizeDirection): number {
  const grow = { left: "right", right: "left", bottom: "up" } as const;
  const shrink = { left: "left", right: "right", bottom: "down" } as const;
  return dir === grow[anchor] ? RESIZE_STEP : dir === shrink[anchor] ? -RESIZE_STEP : 0;
}

/** Window › Resize Tool Window: moves the inner edge of the active tool window by one step. */
export function resizeActiveToolWindow(dir: ResizeDirection) {
  const s = useToolWindowLayout.getState();
  const id = s.focused ?? s.lastActive;
  const anchor = id && isToolWindowVisible(id) ? anchorOf(id) : undefined;
  if (!anchor) return;
  const delta = resizeDelta(anchor, dir);
  if (!delta) return;
  const room = (anchor === "bottom" ? window.innerHeight : window.innerWidth) - 160;
  setToolWindowSize(anchor, Math.min(room, s.sizes[anchor] + delta));
}

/** Share of `anchor`'s side given to its primary area when both areas show. */
export function setToolWindowSplit(anchor: ToolWindowAnchor, ratio: number) {
  const s = useToolWindowLayout.getState();
  const v = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, Math.round(ratio * 1000) / 1000));
  if (!isFinite(v) || s.splits[anchor] === v) return;
  update({ splits: { ...s.splits, [anchor]: v } });
}

export function toggleMaximizeToolWindow(id: string) {
  const a = anchorOf(id);
  if (!a) return;
  if (!isToolWindowVisible(id)) showToolWindow(id, true);
  const s = useToolWindowLayout.getState();
  update({ maximized: s.maximized === a ? null : a }, false);
}

export function setFocusedToolWindow(id: string | null) {
  const s = useToolWindowLayout.getState();
  if (s.focused === id) return;
  if (id) lastUsed = id;
  useToolWindowLayout.setState({ focused: id, lastActive: id ?? s.lastActive });
  setContext("toolWindowFocus", !!id);
  setContext("activeToolWindow", id ?? "");
}

function isFocusWithinToolWindow(id: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement?.closest?.("[data-toolwindow]");
  return el?.getAttribute("data-toolwindow") === id;
}

export const toolWindowServiceImpl: ToolWindowService = {
  show: (id, focus) => showToolWindow(id, focus),
  hide: hideToolWindow,
  toggle: toggleToolWindow,
  isVisible: isToolWindowVisible,
};

/** What Window › Tool Window Layouts saves and restores. */
export interface ToolWindowLayoutSnapshot {
  visible: SlotRecord;
  sizes: Record<ToolWindowAnchor, number>;
  splits: Record<ToolWindowAnchor, number>;
  placements: Record<string, ToolWindowPlacement>;
  stripeButtons: Record<string, boolean>;
}

export function toolWindowLayoutSnapshot(): ToolWindowLayoutSnapshot {
  const s = useToolWindowLayout.getState();
  return {
    visible: { ...(s.distractionFreeStash ?? s.visible) },
    sizes: { ...s.sizes },
    splits: { ...s.splits },
    placements: { ...s.placements },
    stripeButtons: { ...s.stripeButtons },
  };
}

/** Validates a stored snapshot (unknown shape: from storage). */
export function sanitizeLayoutSnapshot(raw: unknown): ToolWindowLayoutSnapshot {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    visible: sanitizeVisible(r.visible),
    sizes: sanitizeSizes(r.sizes),
    splits: sanitizeSplits(r.splits),
    placements: sanitizePlacements(r.placements),
    stripeButtons: sanitizeStripeButtons(r.stripeButtons),
  };
}

/** The layout of a fresh project (Restore Default Layout). */
export function defaultLayoutSnapshot(): ToolWindowLayoutSnapshot {
  return sanitizeLayoutSnapshot(null);
}

/** Applies a saved layout to this project (and persists it as the project's layout). */
export function applyToolWindowLayout(snapshot: ToolWindowLayoutSnapshot) {
  const s = useToolWindowLayout.getState();
  const placements = { ...snapshot.placements };
  // Windows registered later keep their saved area; unknown ones simply never show.
  const visible = reconcile(snapshot.visible, placements) ?? { ...snapshot.visible };
  const mounted = new Set(s.mounted);
  for (const id of Object.values(visible)) if (id) mounted.add(id);
  const hadFocus = !!s.focused && !Object.values(visible).includes(s.focused);
  update({
    visible,
    sizes: { ...snapshot.sizes },
    splits: { ...snapshot.splits },
    placements,
    stripeButtons: { ...snapshot.stripeButtons },
    mounted,
    maximized: null,
    stashed: null,
    distractionFreeStash: null,
  });
  if (hadFocus) focusEditor();
}

/** Test helper. */
export function resetToolWindowLayout() {
  lastUsed = null;
  useToolWindowLayout.setState(initial());
}
