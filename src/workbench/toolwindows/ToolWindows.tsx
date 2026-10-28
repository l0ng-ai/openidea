import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import clsx from "clsx";
import { create } from "zustand";
import { call, commands } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { dragRequiresAlt, Icon, IconButton, Menu, showContextMenu, tooltipAttrs, type MenuItem, T } from "@/ui";
import { FOCUSABLE } from "@/ui/popupState";
import { TabStripRegistry } from "@/ui/Tabs";
import { useContributions, type ToolWindowAnchor, type ToolWindowContribution } from "../contributions";
import { useDistractionFree } from "../distractionFree";
import {
  hideToolWindow,
  MAX_SPLIT,
  MIN_SPLIT,
  moveToolWindow,
  placed,
  resetToolWindowPlacements,
  hasStripeButton,
  removeFromStripe,
  setToolWindowSize,
  setToolWindowSplit,
  showToolWindow,
  SLOTS,
  slotOf,
  toggleMaximizeToolWindow,
  toggleToolWindow,
  useToolWindowLayout,
  type SlotRecord,
  type ToolWindowSlot,
} from "./store";
import { contentTabRegistry } from "./content";
import styles from "./ToolWindows.module.css";
import { tx } from "@/platform/i18n";

function byOrder(a: ToolWindowContribution, b: ToolWindowContribution) {
  return (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title);
}

/** Registered tool windows available in the current state (project open or not). */
export function useToolWindows(): ToolWindowContribution[] {
  const map = useContributions((s) => s.toolWindows);
  const placements = useToolWindowLayout((s) => s.placements);
  const hasProject = useProject((s) => !!s.project);
  return useMemo(
    () =>
      [...map.values()]
        .filter((t) => hasProject || t.requiresProject === false)
        .map((t) => placed(t, placements))
        .sort(byOrder),
    [map, hasProject, placements],
  );
}

/** Visible window per area, ignoring ids that aren't registered (yet) or don't dock there. */
export function useEffectiveVisible(windows: ToolWindowContribution[]): SlotRecord {
  const visible = useToolWindowLayout((s) => s.visible);
  return useMemo(() => {
    const out = {} as SlotRecord;
    for (const slot of SLOTS) {
      const id = visible[slot];
      out[slot] = id && windows.some((w) => w.id === id && slotOf(w) === slot) ? id : null;
    }
    return out;
  }, [visible, windows]);
}

// ---------------------------------------------------------------------------
// Stripes

/** IDEA's Move To anchors (New UI: no top). */
const MOVE_TARGETS: Array<[ToolWindowSlot, string]> = [
  ["left", "Left Top"],
  ["left-split", "Left Bottom"],
  ["bottom", "Bottom Left"],
  ["bottom-split", "Bottom Right"],
  ["right-split", "Right Bottom"],
  ["right", "Right Top"],
];

/** "Move to" submenu (IDEA: tool window options › Move To). */
export function moveToMenu(tw: ToolWindowContribution): MenuItem {
  const current = slotOf(tw);
  return {
    label: "Move To",
    submenu: [
      ...MOVE_TARGETS.map(([slot, label]): MenuItem => ({
        id: slot,
        label,
        checked: slot === current ? true : undefined,
        disabled: slot === current,
        run: () => moveToolWindow(tw.id, slot),
      })),
      { kind: "separator" },
      { label: "Restore Default Layout", run: resetToolWindowPlacements },
    ],
  };
}

/** Stripe button context menu, as in IDEA: Hide (removes the button), Move to, Show Tool Window Names. */
function stripeButtonMenu(tw: ToolWindowContribution, showNames: boolean): MenuItem[] {
  return [
    { label: "Hide", run: () => removeFromStripe(tw.id) },
    { kind: "separator" },
    moveToMenu(tw),
    { kind: "separator" },
    {
      label: "Show Tool Window Names",
      checked: showNames,
      run: () => {
        resetStripeNames();
        void setShowToolWindowNames(!showNames);
      },
    },
  ];
}

async function setShowToolWindowNames(on: boolean) {
  const settings = await call(commands.settingsSet("global", "appearance.showToolWindowNames", JSON.stringify(on)));
  useProject.setState({ settings });
}

/** Stripe button widths: icons only, and the range with names. */
const STRIPE_ICONS = 32;
const STRIPE_MIN = 44;
const STRIPE_DEFAULT = 56;
const STRIPE_MAX = 96;
const STRIPE_KEY = "openidea.stripes.v1";

type StripeSide = "left" | "right";
/** Per stripe: button width with names, and names shown or hidden by a drag (unset: the setting decides). */
interface StripeSize {
  width: number;
  names?: boolean;
}

function readStripes(): Record<StripeSide, StripeSize> {
  const out: Record<StripeSide, StripeSize> = { left: { width: STRIPE_DEFAULT }, right: { width: STRIPE_DEFAULT } };
  try {
    const raw = JSON.parse(localStorage.getItem(STRIPE_KEY) ?? "null");
    for (const side of ["left", "right"] as const) {
      const v = raw?.[side];
      if (typeof v?.width === "number") out[side].width = Math.min(STRIPE_MAX, Math.max(STRIPE_MIN, v.width));
      if (typeof v?.names === "boolean") out[side].names = v.names;
    }
  } catch {
    /* storage unavailable */
  }
  return out;
}

const useStripes = create<Record<StripeSide, StripeSize>>(readStripes);

function setStripe(side: StripeSide, size: StripeSize) {
  useStripes.setState({ [side]: size });
  try {
    localStorage.setItem(STRIPE_KEY, JSON.stringify(useStripes.getState()));
  } catch {
    /* storage unavailable */
  }
}

/** "Show Tool Window Names" (menu or settings) applies to both stripes again. */
function resetStripeNames() {
  const s = useStripes.getState();
  if (s.left.names === undefined && s.right.names === undefined) return;
  setStripe("left", { width: s.left.width });
  setStripe("right", { width: s.right.width });
}

/**
 * Resize handle on a stripe's inner edge. Dragging sets the stripe's button width;
 * narrower than halfway to the named minimum shows icons only.
 */
function StripeHandle({
  side,
  names,
  width,
  frameRef,
  onPreview,
  onCommit,
}: {
  side: StripeSide;
  names: boolean;
  width: number;
  frameRef: RefObject<HTMLDivElement | null>;
  onPreview: (names: boolean) => void;
  onCommit: (names: boolean, width: number) => void;
}) {
  const sign = side === "left" ? 1 : -1;
  // The stripe follows the pointer; names show from STRIPE_MIN (truncated), icons only below it.
  const resolve = (raw: number) => {
    const px = Math.round(Math.min(STRIPE_MAX, Math.max(STRIPE_ICONS, raw)));
    return px < STRIPE_MIN ? { names: false, width, px } : { names: true, width: px, px };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const stripe = frameRef.current?.querySelector<HTMLElement>(`[data-stripe-side="${side}"]`);
    if (e.button !== 0 || !stripe) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const origin = e.clientX;
    const start = names ? width : STRIPE_ICONS;
    const cursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    let next = { names, width, px: start };
    const move = (ev: globalThis.PointerEvent) => {
      const r = resolve(start + sign * (ev.clientX - origin));
      if (r.names !== next.names) onPreview(r.names);
      next = r;
      stripe.style.setProperty("--stripe-drag", `${r.px}px`);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      document.body.style.cursor = cursor;
      stripe.style.removeProperty("--stripe-drag");
      onCommit(next.names, next.width);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = ["ArrowLeft", "ArrowRight"].indexOf(e.key);
    if (dir < 0) return;
    e.preventDefault();
    const step = sign * (dir ? 1 : -1) * 8;
    // One step crosses between icons only and the narrowest named width.
    if (!names) {
      if (step > 0) onCommit(true, STRIPE_MIN);
    } else if (width + step < STRIPE_MIN) onCommit(false, width);
    else onCommit(true, Math.min(STRIPE_MAX, width + step));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize tool window bar" : "Resize right tool window bar"}
      tabIndex={0}
      className={clsx(styles.stripeHandle, side === "right" && styles.stripeHandleRight)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

// Stripe button drag. Pointer events rather than HTML5 drag and drop: with the window's native
// file drop enabled, the webview never sees dragover / drop for drags that start inside it.

type StripeDrop = { slot: ToolWindowSlot; before: string | null };

const useStripeDrag = create<{ id: string | null; drop: StripeDrop | null }>(() => ({ id: null, drop: null }));

/** Movement before a press on a stripe button becomes a drag, px. */
const DRAG_THRESHOLD = 4;
/** Set when a drag ends on its own button, so the click that follows doesn't toggle the window. */
let dragEnded = false;

/**
 * Stripe groups (IDEA New UI): each stripe's upper group holds its side,
 * primary windows then split ones (a separator marks the boundary while dragging); the lower group of the
 * left stripe holds Bottom Left, that of the right stripe Bottom Right.
 */
function lowerSlot(side: StripeSide): ToolWindowSlot {
  return side === "left" ? "bottom" : "bottom-split";
}

const middle = (r: DOMRect) => r.top + r.height / 2;

/** Drop position under the pointer: an area and the button to insert before (null: at the end). */
function stripeDropAt(x: number, y: number): StripeDrop | null {
  const nav = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-stripe-side]");
  const side = nav?.dataset.stripeSide;
  if (!nav || (side !== "left" && side !== "right")) return null;
  const spacer = nav.querySelector<HTMLElement>("[data-stripe-spacer]")?.getBoundingClientRect();
  const separator = nav.querySelector<HTMLElement>("[data-stripe-separator]")?.getBoundingClientRect();
  const slot: ToolWindowSlot =
    spacer && y > middle(spacer) ? lowerSlot(side) : separator && y > middle(separator) ? `${side}-split` : side;
  let before: string | null = null;
  for (const b of nav.querySelectorAll<HTMLElement>(`[data-stripe-slot="${slot}"] [data-stripe-button]`)) {
    if (y < middle(b.getBoundingClientRect())) {
      before = b.dataset.stripeButton!;
      break;
    }
  }
  return { slot, before };
}

function startStripeDrag(e: PointerEvent<HTMLButtonElement>, id: string) {
  if (e.button !== 0 || (dragRequiresAlt() && !e.altKey)) return;
  const button = e.currentTarget;
  const start = { x: e.clientX, y: e.clientY };
  let ghost: HTMLElement | null = null;
  const place = (x: number, y: number) => {
    if (ghost) ghost.style.transform = `translate(${x - start.x}px, ${y - start.y}px)`;
  };
  const onMove = (ev: globalThis.PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      const r = button.getBoundingClientRect();
      ghost = button.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-stripe-button");
      ghost.className = clsx(button.className, styles.stripeGhost);
      Object.assign(ghost.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      document.body.appendChild(ghost);
      useStripeDrag.setState({ id, drop: null });
    }
    place(ev.clientX, ev.clientY);
    const drop = stripeDropAt(ev.clientX, ev.clientY);
    const cur = useStripeDrag.getState().drop;
    if (drop?.slot !== cur?.slot || drop?.before !== cur?.before) useStripeDrag.setState({ drop });
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    if (!ghost) return;
    ghost.remove();
    const { drop } = useStripeDrag.getState();
    useStripeDrag.setState({ id: null, drop: null });
    dragEnded = true;
    setTimeout(() => (dragEnded = false));
    if (commit && drop && drop.before !== id) moveToolWindow(id, drop.slot, drop.before);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (ev: globalThis.KeyboardEvent) => {
    if (ev.key !== "Escape" || !ghost) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}

function StripeBadge({ useBadge }: { useBadge: () => number | string | null }) {
  const value = useBadge();
  if (value === null || value === 0 || value === "") return null;
  return <span className={styles.badge}>{typeof value === "number" && value > 99 ? "99+" : value}</span>;
}

function StripeButton({
  tw,
  active,
  focused,
  side,
  showName,
}: {
  tw: ToolWindowContribution;
  active: boolean;
  focused: boolean;
  side: "left" | "right";
  showName: boolean;
}) {
  const shortcut = shortcutLabel(`toolwindow.${tw.id}`);
  const dragged = useStripeDrag((s) => s.id === tw.id);
  return (
    <button
      type="button"
      className={clsx(
        styles.stripeButton,
        showName && styles.stripeNamed,
        active && styles.stripeActive,
        active && focused && styles.stripeFocused,
        side === "right" && styles.stripeRight,
        dragged && styles.stripeDragged,
      )}
      aria-label={tx(tw.title)}
      aria-pressed={active}
      aria-keyshortcuts={shortcut}
      data-stripe-button={tw.id}
      onPointerDown={(e) => startStripeDrag(e, tw.id)}
      onClick={() => {
        if (!dragEnded) toggleToolWindow(tw.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, stripeButtonMenu(tw, showName));
      }}
      {...tooltipAttrs(tw.title, shortcut)}
    >
      <span className={styles.stripeIcon}>
        <Icon name={tw.icon} size={18} />
        {tw.useBadge && <StripeBadge useBadge={tw.useBadge} />}
      </span>
      {showName && (
        <span className={clsx(styles.stripeLabel, !/\s/.test(tw.title) && styles.stripeLabelWord)} aria-hidden="true">
          <T>{tw.title}</T>
        </span>
      )}
    </button>
  );
}

/** Stripe "…": tool windows without a stripe button; opening one adds its button (IDEA). */
function StripeMore({ windows }: { windows: ToolWindowContribution[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const items = useMemo<MenuItem[]>(
    () =>
      [...windows]
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((w) => ({
          id: w.id,
          label: w.title,
          icon: w.icon,
          shortcut: shortcutLabel(`toolwindow.${w.id}`),
          run: () => showToolWindow(w.id, true),
        })),
    [windows],
  );
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={clsx(styles.stripeButton, styles.stripeMore)}
        aria-label={tx("More Tool Windows")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        {...tooltipAttrs("More Tool Windows")}
      >
        <Icon name="more-horizontal" size={18} />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        items={items}
        placement="right-start"
        aria-label="Tool windows"
      />
    </>
  );
}

function onStripeKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
  buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  e.preventDefault();
}

export function ToolWindowStripe({
  side,
  windows,
  visible,
  showNames = false,
  buttonWidth,
}: {
  side: StripeSide;
  windows: ToolWindowContribution[];
  visible: SlotRecord;
  /** Tool window names under the icons (IDEA "Show Tool Window Names"). */
  showNames?: boolean;
  /** Button width with names, px. */
  buttonWidth?: number;
}) {
  const isActive = (w: ToolWindowContribution) => visible[slotOf(w)] === w.id;
  const stripeButtons = useToolWindowLayout((s) => s.stripeButtons);
  const onStripe = windows.filter((w) => hasStripeButton(w, stripeButtons) || isActive(w));
  const inSlot = (slot: ToolWindowSlot) => onStripe.filter((w) => slotOf(w) === slot);
  const primary = inSlot(side);
  const split = inSlot(`${side}-split`);
  const lower = inSlot(lowerSlot(side));
  const moreWindows = windows.filter((w) => !onStripe.includes(w));
  const focused = useToolWindowLayout((s) => s.focused);
  const drop = useStripeDrag((s) => s.drop);
  // The separator between primary and split windows only shows while a button is dragged, as a drop target.
  const dragging = useStripeDrag((s) => !!s.id);

  const indicator = (slot: ToolWindowSlot, before: string | null) =>
    drop && drop.slot === slot && drop.before === before ? (
      <div className={styles.stripeDrop} aria-hidden="true" />
    ) : null;
  const renderGroup = (slot: ToolWindowSlot, list: ToolWindowContribution[]) => (
    <div className={styles.stripeGroup} data-stripe-slot={slot}>
      {list.map((w) => (
        <div key={w.id} className={styles.stripeSlot}>
          {indicator(slot, w.id)}
          <StripeButton tw={w} active={isActive(w)} focused={focused === w.id} side={side} showName={showNames} />
        </div>
      ))}
      <div className={styles.stripeSlot}>{indicator(slot, null)}</div>
    </div>
  );

  return (
    <nav
      aria-label={side === "left" ? "Tool windows" : "Right tool windows"}
      role="toolbar"
      aria-orientation="vertical"
      data-stripe-side={side}
      style={buttonWidth ? ({ "--stripe-button-w": `${buttonWidth}px` } as CSSProperties) : undefined}
      className={clsx(
        styles.stripe,
        showNames && styles.stripeWithNames,
        side === "right" ? styles.stripeSideRight : styles.stripeSideLeft,
      )}
      onKeyDown={onStripeKeyDown}
    >
      {renderGroup(side, primary)}
      {dragging && <div className={styles.stripeSeparator} data-stripe-separator="" role="separator" />}
      {(split.length > 0 || dragging) && renderGroup(`${side}-split`, split)}
      {side === "left" && <StripeMore windows={moreWindows} />}
      <div className={styles.stripeSpacer} data-stripe-spacer="" />
      {renderGroup(lowerSlot(side), lower)}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Panels

const NO_ITEMS: MenuItem[] = [];
const staticMenus = new WeakMap<MenuItem[], (id: string) => MenuItem[]>();
function staticHeaderMenu(items: MenuItem[] | undefined): (id: string) => MenuItem[] {
  if (!items) return () => NO_ITEMS;
  let f = staticMenus.get(items);
  if (!f) staticMenus.set(items, (f = () => items));
  return f;
}

const noTitleMenu = (): { label: string; items: MenuItem[] } | null => null;

function ToolWindowView({ tw, hidden }: { tw: ToolWindowContribution; hidden: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const focusRequest = useToolWindowLayout((s) => s.focusRequest);
  const maximized = useToolWindowLayout((s) => s.maximized === tw.anchor);
  const [moreOpen, setMoreOpen] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const Content = tw.component;
  const Actions = tw.headerActions;
  const Tabs = tw.headerContent;

  useEffect(() => {
    if (!focusRequest || focusRequest.id !== tw.id || hidden) return;
    const raf = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root) return;
      const body = root.querySelector<HTMLElement>("[data-toolwindow-body]");
      // Like IDEA, activation focuses the content (a field, list or tree), never a button or
      // link: a scripted focus on one draws its focus ring (an empty view's "New…" link).
      const content = [...(body?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find(
        (el) => !el.matches('button, a[href], [role="button"], [role="link"]'),
      );
      if (body && !content && !body.hasAttribute("tabindex")) body.tabIndex = -1;
      const target = body?.querySelector<HTMLElement>("[data-autofocus]") ?? content ?? body ?? root;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [focusRequest, tw.id, hidden]);

  const useHeaderMenu = typeof tw.headerMenu === "function" ? tw.headerMenu : staticHeaderMenu(tw.headerMenu);
  const own = useHeaderMenu(tw.id);
  const useTitleMenu = tw.titleMenu ?? noTitleMenu;
  const titleMenu = useTitleMenu(tw.id);
  const titleItems = titleMenu?.items ?? own;
  const more: MenuItem[] = [
    ...own,
    ...(own.length ? [{ kind: "separator" } as MenuItem] : []),
    moveToMenu(tw),
    {
      label: maximized ? "Restore Size" : "Maximize",
      icon: maximized ? "minimize" : "maximize",
      run: () => toggleMaximizeToolWindow(tw.id),
    },
    { kind: "separator" },
    { label: "Hide", icon: "hide", shortcut: shortcutLabel("toolwindow.hideActive"), run: () => hideToolWindow(tw.id) },
  ];

  return (
    <section
      ref={ref}
      className={styles.window}
      data-toolwindow={tw.id}
      aria-label={tx(tw.title)}
      hidden={hidden}
      tabIndex={-1}
    >
      <header
        className={clsx(styles.header, Tabs && styles.headerTabbed)}
        onDoubleClick={(e) => e.target === e.currentTarget && toggleMaximizeToolWindow(tw.id)}
      >
        {Tabs && tw.tabsReplaceTitle ? null : titleItems.length > 0 ? (
          <>
            <button
              ref={titleRef}
              type="button"
              className={styles.titleButton}
              aria-haspopup="menu"
              aria-expanded={titleOpen}
              onClick={() => setTitleOpen((v) => !v)}
            >
              <span className={styles.title}>
                <T>{titleMenu?.label ?? tw.title}</T>
              </span>
              <Icon name="chevron-down" size={12} className={styles.titleChevron} />
            </button>
            <Menu
              open={titleOpen}
              onClose={() => setTitleOpen(false)}
              anchor={titleRef}
              items={titleItems}
              aria-label={titleMenu ? tx`${tw.title} views` : tx`${tw.title} view options`}
            />
          </>
        ) : (
          <span className={clsx(styles.title, styles.titlePlain)}>
            <T>{tw.title}</T>
          </span>
        )}
        {Tabs && (
          <div className={clsx(styles.headerContent, tw.tabsReplaceTitle && styles.headerContentOnly)}>
            <TabStripRegistry.Provider value={contentTabRegistry(tw.id)}>
              <Tabs id={tw.id} />
            </TabStripRegistry.Provider>
          </div>
        )}
        <div className={styles.headerSpacer} />
        <div className={styles.headerActions}>
          {Actions && <Actions id={tw.id} />}
          <IconButton
            ref={moreRef}
            icon="more"
            title="Options"
            size="small"
            iconSize={16}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          />
          <IconButton
            icon="minus"
            title="Hide"
            shortcut={shortcutLabel("toolwindow.hideActive")}
            size="small"
            iconSize={16}
            onClick={() => hideToolWindow(tw.id)}
          />
        </div>
        <Menu
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          anchor={moreRef}
          items={more}
          placement="bottom-end"
          aria-label={tx`${tw.title} options`}
        />
      </header>
      <div className={styles.body} data-toolwindow-body="">
        <Content id={tw.id} />
      </div>
    </section>
  );
}

const MIN: Record<ToolWindowAnchor, number> = { left: 140, right: 160, bottom: 90 };
const MAXIMIZED: Record<ToolWindowAnchor, string> = { left: "82%", right: "82%", bottom: "88%" };
/** The editor keeps at least this much room when a tool window is resized (see the grid template). */
const EDITOR_MIN = { width: 200, height: 60 };
/** Smallest area when a side is split: stacked (left / right) and side by side (bottom). */
const SPLIT_MIN = { stacked: 60, sideBySide: 120 };
const KEY_STEP = 10;

/**
 * Splitter between the primary and split areas of a side: horizontal on the
 * left and right (areas stacked), vertical at the bottom (side by side).
 * Moves the areas' flex-grow while dragging; the ratio is stored on release.
 */
function SplitHandle({ anchor, hidden }: { anchor: ToolWindowAnchor; hidden: boolean }) {
  const stacked = anchor !== "bottom";
  const measure = (el: HTMLElement) => {
    const first = el.previousElementSibling as HTMLElement | null;
    const second = el.nextElementSibling as HTMLElement | null;
    if (!first || !second) return null;
    const size = (e: HTMLElement) => (stacked ? e.offsetHeight : e.offsetWidth);
    const total = size(first) + size(second);
    if (total <= 0) return null;
    const min = Math.min(stacked ? SPLIT_MIN.stacked : SPLIT_MIN.sideBySide, total / 2);
    return {
      areas: [first, second] as const,
      first: size(first),
      total,
      clamp: (px: number) => Math.min(total - min, Math.max(min, px)),
    };
  };
  const apply = ([first, second]: readonly [HTMLElement, HTMLElement], ratio: number) => {
    first.style.flexGrow = String(ratio);
    second.style.flexGrow = String(1 - ratio);
  };
  const ratioOf = (px: number, total: number) => Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, px / total));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const m = measure(el);
    if (e.button !== 0 || !m) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const origin = stacked ? e.clientY : e.clientX;
    const cursor = document.body.style.cursor;
    document.body.style.cursor = stacked ? "row-resize" : "col-resize";
    let ratio: number | null = null;
    const move = (ev: globalThis.PointerEvent) => {
      ratio = ratioOf(m.clamp(m.first + (stacked ? ev.clientY : ev.clientX) - origin), m.total);
      apply(m.areas, ratio);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      document.body.style.cursor = cursor;
      if (ratio !== null) setToolWindowSplit(anchor, ratio);
      // Back to the store's value (unchanged when the ratio was clamped to it).
      apply(m.areas, useToolWindowLayout.getState().splits[anchor]);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = (stacked ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"]).indexOf(e.key);
    const m = measure(e.currentTarget);
    if (dir < 0 || !m) return;
    e.preventDefault();
    setToolWindowSplit(anchor, ratioOf(m.clamp(m.first + (dir ? 1 : -1) * KEY_STEP), m.total));
  };

  return (
    <div
      role="separator"
      aria-orientation={stacked ? "horizontal" : "vertical"}
      aria-label={`Resize ${anchor} tool window split`}
      tabIndex={0}
      hidden={hidden}
      className={clsx(styles.gap, styles.splitGap)}
      data-split-handle={anchor}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * One side's tool windows: the primary area and the split area, each an
 * island; with both showing they share the side at the stored ratio.
 */
function SidePanel({
  anchor,
  windows,
  visible,
}: {
  anchor: ToolWindowAnchor;
  windows: ToolWindowContribution[];
  visible: SlotRecord;
}) {
  const mounted = useToolWindowLayout((s) => s.mounted);
  const split = !!visible[anchor] && !!visible[`${anchor}-split`];
  // A lone area takes the whole side: flex-grow below 1 would leave the rest empty.
  const ratio = useToolWindowLayout((s) => s.splits[anchor]);
  const area = (slot: ToolWindowSlot, grow: number) => {
    const visibleId = visible[slot];
    const list = windows.filter((w) => slotOf(w) === slot && (mounted.has(w.id) || w.id === visibleId));
    if (!list.length) return null;
    return (
      <div
        className={clsx(styles.island, styles.anchor)}
        // The stored ratio; SplitHandle moves it directly while dragging.
        style={{ flexGrow: grow }}
        data-slot={slot}
        hidden={!visibleId}
      >
        {list.map((w) => (
          <ToolWindowView key={w.id} tw={w} hidden={w.id !== visibleId} />
        ))}
      </div>
    );
  };
  return (
    <div className={clsx(styles.side, anchor === "bottom" && styles.sideRow)} data-anchor={anchor}>
      {area(anchor, split ? ratio : 1)}
      <SplitHandle anchor={anchor} hidden={!split} />
      {area(`${anchor}-split`, split ? 1 - ratio : 1)}
    </div>
  );
}

/** Windows shown on side `a`, primary area first. */
function visibleOn(visible: SlotRecord, a: ToolWindowAnchor): string[] {
  return [visible[a], visible[`${a}-split`]].filter((id): id is string => !!id);
}

const sideVisible = (visible: SlotRecord, a: ToolWindowAnchor) => !!(visible[a] || visible[`${a}-split`]);

/** Writes the grid's track variables from the store; the grid itself squeezes tracks when the window is small. */
function syncTracks(grid: HTMLElement, visible: SlotRecord) {
  const s = useToolWindowLayout.getState();
  for (const a of ["left", "right", "bottom"] as const) {
    const shown = sideVisible(visible, a);
    const size = !shown ? "0px" : s.maximized === a ? MAXIMIZED[a] : `${s.sizes[a]}px`;
    grid.style.setProperty(`--tw-${a}`, size);
    grid.style.setProperty(`--gap-${a}`, shown ? "var(--island-gap)" : "0px");
  }
}

/**
 * Resize handle in the gap next to a side's islands. Moves only a CSS variable
 * while dragging; the remembered size is stored on release.
 */
function GapHandle({
  anchor,
  visibleIds,
  gridRef,
  editorRef,
  sync,
}: {
  anchor: ToolWindowAnchor;
  /** Windows shown on this side (primary and split area). */
  visibleIds: string[];
  gridRef: RefObject<HTMLDivElement | null>;
  editorRef: RefObject<HTMLDivElement | null>;
  sync: () => void;
}) {
  const vertical = anchor !== "bottom";
  const sign = anchor === "left" ? 1 : -1;
  const measure = () => {
    const island = gridRef.current?.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`);
    const editor = editorRef.current;
    if (!island || !editor) return null;
    const size = vertical ? island.offsetWidth : island.offsetHeight;
    const spare = vertical ? editor.offsetWidth - EDITOR_MIN.width : editor.offsetHeight - EDITOR_MIN.height;
    return { size, max: size + Math.max(0, spare) };
  };
  const clamp = (raw: number, max: number) => Math.min(max, Math.max(MIN[anchor], raw));
  const commit = (px: number) => {
    const s = useToolWindowLayout.getState();
    if (visibleIds[0] && s.maximized === anchor) toggleMaximizeToolWindow(visibleIds[0]);
    setToolWindowSize(anchor, px);
    sync();
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const grid = gridRef.current;
    const m = measure();
    if (e.button !== 0 || !grid || !m || !visibleIds.length) return;
    // No focus (and so no focus ring) or text selection from a mouse drag.
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const origin = vertical ? e.clientX : e.clientY;
    const cursor = document.body.style.cursor;
    document.body.style.cursor = vertical ? "col-resize" : "row-resize";
    let next = m.size;
    const move = (ev: globalThis.PointerEvent) => {
      const raw = m.size + sign * ((vertical ? ev.clientX : ev.clientY) - origin);
      // Dragged past half the minimum: collapse, as IDEA does.
      next = raw < MIN[anchor] / 2 ? 0 : clamp(raw, m.max);
      grid.style.setProperty(`--tw-${anchor}`, `${next}px`);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      document.body.style.cursor = cursor;
      if (next === 0) visibleIds.forEach(hideToolWindow);
      else if (next !== m.size) commit(next);
      else sync();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = vertical ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const dir = keys.indexOf(e.key);
    const m = measure();
    if (dir < 0 || !m) return;
    e.preventDefault();
    commit(clamp(m.size + sign * (dir ? 1 : -1) * KEY_STEP, m.max));
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={`Resize ${anchor} tool window`}
      tabIndex={0}
      hidden={!visibleIds.length}
      className={styles.gap}
      data-gap={anchor}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

/** Settings › Appearance › Tool Windows (raw settings: the workbench does not depend on the settings feature). */
function useToolWindowAppearance() {
  const a = useProject((s) => s.settings?.appearance);
  const distractionFree = useDistractionFree((s) => s.active);
  return {
    bars: a?.showToolWindowBars !== false && !distractionFree,
    names: a?.showToolWindowNames === true,
    widescreen: a?.widescreenToolWindows === true,
  };
}

/**
 * The Islands frame below the title bar: stripes on the window background,
 * side tool windows and the editor as rounded islands in one row, bottom
 * tool windows as a full-width island underneath (or, with "Widescreen tool
 * window layout", between the side windows). Resize handles sit in the gaps
 * between islands. A CSS grid does the layout, so a window resize costs no script.
 */
export function ToolWindowLayout({ editor }: { editor: ReactNode }) {
  const windows = useToolWindows();
  const visible = useEffectiveVisible(windows);
  const appearance = useToolWindowAppearance();
  const { bars, widescreen } = appearance;
  const stripes = useStripes();
  const names = (side: StripeSide) => stripes[side].names ?? appearance.names;
  // A change of the setting (here or in Settings) overrides what stripe drags chose.
  const namesSetting = useProject((s) => s.settings?.appearance?.showToolWindowNames);
  const seenNamesSetting = useRef(namesSetting);
  useEffect(() => {
    const seen = seenNamesSetting.current;
    seenNamesSetting.current = namesSetting;
    if (seen !== undefined && seen !== namesSetting) resetStripeNames();
  }, [namesSetting]);
  const frameRef = useRef<HTMLDivElement>(null);
  const stripeHandle = (side: StripeSide) => (
    <StripeHandle
      side={side}
      names={names(side)}
      width={stripes[side].width}
      frameRef={frameRef}
      onPreview={(on) => useStripes.setState({ [side]: { ...stripes[side], names: on } })}
      onCommit={(on, width) => setStripe(side, { width, names: on === appearance.names ? undefined : on })}
    />
  );
  const stripe = (side: StripeSide) => (
    <ToolWindowStripe
      side={side}
      windows={windows}
      visible={visible}
      showNames={names(side)}
      buttonWidth={stripes[side].width}
    />
  );
  const sizes = useToolWindowLayout((s) => s.sizes);
  const maximized = useToolWindowLayout((s) => s.maximized);
  const stripeButtons = useToolWindowLayout((s) => s.stripeButtons);
  // The right stripe holds the right side's windows and Bottom Right.
  const hasRight = windows.some((w) => {
    const slot = slotOf(w);
    return (
      (w.anchor === "right" || slot === "bottom-split") && (hasStripeButton(w, stripeButtons) || visible[slot] === w.id)
    );
  });
  // While a stripe button is dragged, an empty right stripe shows as a drop target.
  const dragging = useStripeDrag((s) => !!s.id);
  const rightStripe = bars && (hasRight || dragging);
  const gridRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const sync = () => {
    if (gridRef.current) syncTracks(gridRef.current, visible);
  };
  useLayoutEffect(sync, [visible, sizes, maximized]);

  const gap = (anchor: ToolWindowAnchor) => (
    <GapHandle
      anchor={anchor}
      visibleIds={visibleOn(visible, anchor)}
      gridRef={gridRef}
      editorRef={editorRef}
      sync={sync}
    />
  );
  return (
    <div
      ref={frameRef}
      className={clsx(styles.frame, !rightStripe && styles.frameNoRight, !bars && styles.frameNoLeft)}
    >
      {bars && stripe("left")}
      {bars && stripeHandle("left")}
      <div ref={gridRef} className={clsx(styles.grid, widescreen && styles.widescreen)}>
        <SidePanel anchor="left" windows={windows} visible={visible} />
        {gap("left")}
        <div ref={editorRef} className={clsx(styles.island, styles.editorIsland)}>
          {editor}
        </div>
        {gap("right")}
        <SidePanel anchor="right" windows={windows} visible={visible} />
        {gap("bottom")}
        <SidePanel anchor="bottom" windows={windows} visible={visible} />
      </div>
      {rightStripe && stripeHandle("right")}
      {rightStripe && stripe("right")}
    </div>
  );
}
