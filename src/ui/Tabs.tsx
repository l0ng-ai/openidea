/**
 * Tab strip with the design's accent underline. Roving focus (←/→ or ↑/↓ when
 * vertical, Home/End), closable tabs (button, middle click, Delete), wheel
 * scrolling and an overflow dropdown listing every tab when they don't fit.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./icons";
import { IconButton } from "./Button";
import { Menu, type MenuItem } from "./Menu";
import { tooltipAttrs } from "./Tooltip";
import { isOutsideWindow, registerDropTarget, startPointerDrag } from "./pointerDrag";
import { Given } from "./T";
import styles from "./Tabs.module.css";
import { tx, useGivenTx } from "@/platform/i18n";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Plain text used by the overflow menu and type-ahead when `label` isn't a string. */
  text?: string;
  icon?: IconName | (string & {});
  closable?: boolean;
  /** Unsaved changes marker. */
  modified?: boolean;
  /** CSS colour for the label (VCS status etc.), e.g. `var(--vcs-modified)`. */
  color?: string;
  /** CSS colour the tab background is tinted with (IDEA's data source / file colours). */
  tint?: string;
  italic?: boolean;
  tooltip?: string;
  /** Trailing content (counts, badges). */
  trailing?: ReactNode;
}

/**
 * Drag & drop of tabs. Strips sharing a `type` (a custom MIME type such as
 * `application/x-openidea-editor-tab`) accept each other's tabs; `onDrop`
 * receives the dragged tab's payload and the insertion index in this strip.
 */
export interface TabsDnd {
  type: string;
  payload: (id: string) => string;
  onDrop: (payload: string, index: number) => void;
  /**
   * A dragged tab released with no accepting target (the pointer left the
   * window): the editor uses it to detach the tab into a new window. Gets the
   * dragged tab's payload and the release point in client coordinates.
   */
  onDropOutside?: (payload: string, x: number, y: number) => void;
}

/**
 * Insertion index for a drop at (`x`, `y`) given the tabs' extents in reading
 * order, possibly wrapped into rows. Exported for tests.
 */
export function dropIndex(
  x: number,
  y: number,
  rects: ReadonlyArray<{ left: number; top: number; width: number; height: number }>,
): number {
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!first || !last) return 0;
  // Above or below the tabs counts as their first or last row.
  const py = Math.max(first.top, Math.min(y, last.top + last.height - 1));
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (py < r.top || (py < r.top + r.height && x < r.left + r.width / 2)) return i;
  }
  return rects.length;
}

/** Display position of each id with `id` moved to insertion `index` (as passed to `onDrop`). */
function previewOrder(ids: readonly string[], id: string, index: number): Map<string, number> | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const order = ids.filter((it) => it !== id);
  order.splice(index > from ? index - 1 : index, 0, id);
  return new Map(order.map((it, i) => [it, i]));
}

/** A tab strip as seen from its container: close the selected tab if it can be closed. */
export interface TabStripHandle {
  closeSelected(): boolean;
}

/**
 * Lets a container (a tool window header) reach the tab strips rendered inside
 * it: each `Tabs` registers itself with the nearest provided function.
 */
export const TabStripRegistry = createContext<((handle: TabStripHandle) => () => void) | null>(null);

export interface TabsProps {
  items: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  /** Alt+click on a close button (IDEA: close all other tabs). */
  onCloseOthers?: (id: string) => void;
  /** Shift+left-click a tab closes it (editor tabs; plain clicks still select). */
  closeOnShiftClick?: boolean;
  onDoubleClick?: (id: string) => void;
  onContextMenu?: (id: string, e: MouseEvent) => void;
  /** `editor`: 30px with separators (editor tabs); `compact`: 28px plain (popups, tool window sub-tabs). */
  variant?: "editor" | "compact";
  /** Content after the tabs (breadcrumbs, actions). */
  trailing?: ReactNode;
  className?: string;
  "aria-label"?: string;
  /** Tabpanel id prefix for `aria-controls`. */
  panelIdPrefix?: string;
  /** Enables drag & drop reordering (and moving between strips of the same type). */
  dnd?: TabsDnd;
  /** Tabs that don't fit: `scroll` the strip (default), `squeeze` them, or `wrap` into rows. */
  layout?: "scroll" | "squeeze" | "wrap";
  /** Side of the label the close button sits on. */
  closePosition?: "right" | "left";
  /** `vertical`: a column of tabs (editor tabs placed left / right); always scrolls, `layout` is ignored. */
  orientation?: "horizontal" | "vertical";
}

export function Tabs({
  items,
  activeId,
  onSelect,
  onClose,
  onCloseOthers,
  closeOnShiftClick,
  onDoubleClick,
  onContextMenu,
  variant = "editor",
  trailing,
  className,
  panelIdPrefix,
  dnd,
  layout = "scroll",
  closePosition = "right",
  orientation = "horizontal",
  ...aria
}: TabsProps) {
  const vertical = orientation === "vertical";
  const given = useGivenTx();
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [overflow, setOverflow] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const register = useContext(TabStripRegistry);
  const latest = useRef({ items, activeId, onClose });
  useLayoutEffect(() => {
    latest.current = { items, activeId, onClose };
  });
  useEffect(
    () =>
      register?.({
        closeSelected: () => {
          const { items, activeId, onClose } = latest.current;
          const item = items.find((it) => it.id === activeId);
          if (!item || !onClose || item.closable === false) return false;
          onClose(item.id);
          return true;
        },
      }),
    [register],
  );

  const stripRef = useRef<HTMLDivElement>(null);
  // Re-read on every drag event: items and handlers change while the strip stays registered.
  const dropState = useRef({ items, dnd, vertical });
  useLayoutEffect(() => {
    dropState.current = { items, dnd, vertical };
  });
  // Set when the drag starts, before the strip re-renders for the first `over`.
  const draggingRef = useRef<string | null>(null);
  const dndType = dnd?.type;
  useEffect(() => {
    const el = stripRef.current;
    if (!el || !dndType) return;
    const indexAt = (x: number, y: number) => {
      const { items, vertical } = dropState.current;
      // A tab of this strip is placed among the others as they are laid out now, around its slot.
      const others = items.filter((it) => it.id !== draggingRef.current);
      const rects = others.map((it) => {
        const r = tabRefs.current.get(it.id)?.parentElement?.getBoundingClientRect();
        const box = { left: r?.left ?? 0, top: r?.top ?? 0, width: r?.width ?? 0, height: r?.height ?? 0 };
        return vertical ? { left: box.top, top: box.left, width: box.height, height: box.width } : box;
      });
      const next = others[vertical ? dropIndex(y, x, rects) : dropIndex(x, y, rects)];
      return next ? items.indexOf(next) : items.length;
    };
    return registerDropTarget(el, {
      accepts: (type) => type === dropState.current.dnd?.type,
      over: (_, x, y) => setDrop(indexAt(x, y)),
      leave: () => setDrop(null),
      drop: (data, x, y) => {
        setDrop(null);
        dropState.current.dnd?.onDrop(data.payload, indexAt(x, y));
      },
    });
  }, [dndType]);

  // Bring a tab's whole slot (label + close button) into view. Narrowing the strip clips
  // the active tab's close button (#1740), and clicking the already-active tab doesn't
  // change `activeId`, so the strip must also reveal on clicks and resizes.
  const revealTab = useCallback(
    (id: string | null) => {
      const scroller = scrollRef.current;
      const tab = id ? tabRefs.current.get(id)?.parentElement : null;
      if (scroller && tab) (vertical ? revealVertically : revealHorizontally)(scroller, tab);
    },
    [vertical],
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A vertical strip shows its scrollbar instead of the overflow dropdown.
    const measure = () => {
      setOverflow(!vertical && el.scrollWidth > el.clientWidth + 1);
      // A resize (e.g. the editor area narrowing) must scroll the active tab back
      // into view instead of leaving its close button clipped until a tab switch.
      revealTab(latest.current.activeId);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length, revealTab, vertical]);

  useEffect(() => {
    // The whole tab (label + close button) into view, without scrolling any outer container.
    revealTab(activeId);
  }, [activeId, revealTab]);

  const focusTab = (index: number) => {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    onSelect(item.id);
    tabRefs.current.get(item.id)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, index: number, item: TabItem) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case vertical ? "ArrowDown" : "ArrowRight":
        focusTab(index + 1);
        break;
      case vertical ? "ArrowUp" : "ArrowLeft":
        focusTab(index - 1);
        break;
      case "Home":
        focusTab(0);
        break;
      case "End":
        focusTab(items.length - 1);
        break;
      case "Delete":
      case "Backspace":
        if (onClose && item.closable !== false) onClose(item.id);
        else return;
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const menuItems: MenuItem[] = items.map((t) => ({
    id: t.id,
    label: given(t.text ?? (typeof t.label === "string" ? t.label : t.id)),
    icon: t.icon,
    checked: t.id === activeId ? true : undefined,
    run: () => onSelect(t.id),
  }));

  // IDEA: a tab dragged within its strip leaves an empty slot the other tabs make room for;
  // a tab dragged in from another strip shows an insertion line instead.
  const order =
    dragging !== null && drop !== null
      ? previewOrder(
          items.map((it) => it.id),
          dragging,
          drop,
        )
      : null;
  const marker = dragging === null ? drop : null;

  return (
    <div
      className={clsx(
        styles.strip,
        styles[variant],
        vertical ? styles.vertical : layout !== "scroll" && styles[layout],
        closePosition === "left" && styles.closeLeft,
        className,
      )}
      ref={stripRef}
    >
      {vertical && trailing && <div className={styles.trailing}>{trailing}</div>}
      <div
        ref={scrollRef}
        role="tablist"
        aria-label={given(aria["aria-label"])}
        aria-orientation={vertical ? "vertical" : undefined}
        className={styles.scroller}
        onWheel={(e) => {
          const el = scrollRef.current;
          if (el && !vertical && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
        }}
      >
        {items.map((item, index) => {
          const selected = item.id === activeId;
          const closable = !!onClose && item.closable !== false;
          return (
            <div
              key={item.id}
              className={clsx(
                styles.tab,
                selected && styles.selected,
                closable && styles.closable,
                dragging === item.id && styles.dragging,
                marker === index && styles.dropBefore,
                marker === items.length && index === items.length - 1 && styles.dropAfter,
                item.tint && styles.tinted,
              )}
              style={{ "--tab-tint": item.tint, order: order?.get(item.id) } as CSSProperties}
              onPointerDown={
                dnd
                  ? (e) => {
                      if ((closeOnShiftClick && e.shiftKey) || (e.target as Element).closest("[data-tab-close]"))
                        return;
                      startPointerDrag(
                        e,
                        e.currentTarget,
                        { type: dnd.type, payload: dnd.payload(item.id) },
                        {
                          onStart: () => {
                            draggingRef.current = item.id;
                            setDragging(item.id);
                          },
                          onEnd: (dragged, drop) => {
                            draggingRef.current = null;
                            setDragging(null);
                            if (!dragged || !drop || drop.accepted) return;
                            const outside = dnd.onDropOutside;
                            if (!outside) return;
                            const el = document.documentElement;
                            const r = el.getBoundingClientRect();
                            // The ghost (fixed, translated from the tab) never
                            // covers the release point, so a miss outside the
                            // viewport means the pointer left the window.
                            const rect =
                              r.width || r.height
                                ? r
                                : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
                            if (isOutsideWindow(rect, drop.x, drop.y)) outside(dnd.payload(item.id), drop.x, drop.y);
                          },
                        },
                      );
                    }
                  : undefined
              }
              onMouseDown={(e) => {
                if (e.button === 1 && closable) {
                  e.preventDefault();
                  onClose!(item.id);
                }
              }}
              onContextMenu={onContextMenu ? (e) => onContextMenu(item.id, e) : undefined}
            >
              <button
                ref={(el) => {
                  if (el) tabRefs.current.set(item.id, el);
                  else tabRefs.current.delete(item.id);
                }}
                type="button"
                role="tab"
                id={panelIdPrefix ? `${panelIdPrefix}-tab-${item.id}` : undefined}
                aria-controls={panelIdPrefix ? `${panelIdPrefix}-panel-${item.id}` : undefined}
                aria-selected={selected}
                tabIndex={selected || (!activeId && index === 0) ? 0 : -1}
                className={styles.tabButton}
                style={item.color ? { color: item.color } : undefined}
                onClick={(e) => {
                  // Shift+click is mouse-only: a keyboard Enter with Shift held still selects.
                  if (closeOnShiftClick && e.shiftKey && e.detail > 0 && closable) {
                    e.preventDefault();
                    onClose!(item.id);
                    return;
                  }
                  onSelect(item.id);
                  // Revealing on every click: re-selecting the active tab doesn't change
                  // `activeId`, so the reveal effect wouldn't re-run (#1740).
                  revealTab(item.id);
                }}
                onDoubleClick={onDoubleClick ? () => onDoubleClick(item.id) : undefined}
                onKeyDown={(e) => onKeyDown(e, index, item)}
                {...tooltipAttrs(given(item.tooltip), undefined, true)}
              >
                {item.icon && <Icon name={item.icon} size={14} className={styles.tabIcon} />}
                <span className={clsx(styles.tabLabel, item.italic && styles.italic)}>
                  {typeof item.label === "string" ? <Given>{item.label}</Given> : item.label}
                </span>
                {item.trailing}
                {item.modified && !closable && <span className={styles.modified} aria-label={tx("Modified")} />}
              </button>
              {closable && (
                <span className={styles.closeSlot} data-tab-close>
                  {item.modified && <span className={styles.modified} aria-label={tx("Modified")} />}
                  <IconButton
                    icon="close"
                    title="Close Tab"
                    size="small"
                    iconSize={11}
                    tabIndex={-1}
                    className={styles.close}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.altKey && onCloseOthers) onCloseOthers(item.id);
                      else onClose!(item.id);
                    }}
                  />
                </span>
              )}
            </div>
          );
        })}
      </div>
      {overflow && (
        <>
          <IconButton
            ref={moreRef}
            icon="chevron-down"
            title="Show Hidden Tabs"
            size="small"
            iconSize={10}
            className={styles.more}
            onClick={() => setMenuOpen((v) => !v)}
          />
          <Menu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchor={moreRef}
            items={menuItems}
            placement="bottom-end"
            aria-label="Tabs"
          />
        </>
      )}
      {!vertical && trailing && <div className={styles.trailing}>{trailing}</div>}
    </div>
  );
}

/** Scrolls `scroller` horizontally just enough to show all of `child`. */
export function revealHorizontally(scroller: HTMLElement, child: HTMLElement) {
  const s = scroller.getBoundingClientRect();
  const c = child.getBoundingClientRect();
  if (c.left < s.left) scroller.scrollLeft -= s.left - c.left;
  else if (c.right > s.right) scroller.scrollLeft += Math.min(c.right - s.right, c.left - s.left);
}

/** Scrolls `scroller` vertically just enough to show all of `child`. */
export function revealVertically(scroller: HTMLElement, child: HTMLElement) {
  const s = scroller.getBoundingClientRect();
  const c = child.getBoundingClientRect();
  if (c.top < s.top) scroller.scrollTop -= s.top - c.top;
  else if (c.bottom > s.bottom) scroller.scrollTop += Math.min(c.bottom - s.bottom, c.top - s.top);
}
