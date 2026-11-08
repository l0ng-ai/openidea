/**
 * Menus and context menus. Items are either ad-hoc (`{label, run}`) or bound
 * to registered actions (`{kind: "action", action: "editor.closeTab"}`), which
 * supplies title, shortcut and enablement from the action registry.
 */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import clsx from "clsx";
import { create } from "zustand";
import { getAction, isActionEnabled, executeActionFrom, actionToggled } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { shortcutLabel } from "@/platform/keymap";
import { Icon, type IconName } from "./icons";
import { Popup, type PopupAnchor } from "./Popup";
import type { Placement } from "@floating-ui/react-dom";
import styles from "./Menu.module.css";
import { tx } from "@/platform/i18n";
import { isSubmenuAim, type MenuPointer } from "./menuAim";

export type MenuItem =
  | { kind: "separator" }
  | { kind: "header"; label: string }
  | {
      kind: "action";
      action: string;
      arg?: unknown;
      label?: string;
      icon?: IconName | (string & {});
      disabled?: boolean;
    }
  | {
      kind?: "item";
      id?: string;
      label: string;
      /** User text (e.g. a past query): shown as is, never looked up in the catalog. */
      verbatim?: boolean;
      icon?: IconName | (string & {});
      shortcut?: string;
      disabled?: boolean;
      checked?: boolean;
      danger?: boolean;
      run?: () => void;
      /** The pointer or the keyboard made it the active item (not on opening the menu). */
      onActive?: () => void;
      submenu?: MenuItem[];
    };

interface Resolved {
  kind: "item" | "separator" | "header";
  key: string;
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  run?: () => void;
  onActive?: () => void;
  submenu?: MenuItem[];
}

export function resolveMenuItems(items: MenuItem[]): Resolved[] {
  const out: Resolved[] = [];
  items.forEach((item, i) => {
    if (item.kind === "separator") {
      if (out.length && out[out.length - 1]!.kind !== "separator")
        out.push({ kind: "separator", key: `sep${i}`, label: "" });
      return;
    }
    if (item.kind === "header") {
      out.push({ kind: "header", key: `h${i}`, label: tx(item.label) });
      return;
    }
    if (item.kind === "action") {
      const a = getAction(item.action);
      if (!a) return;
      out.push({
        kind: "item",
        key: item.action,
        label: tx(item.label) ?? a.title,
        icon: item.icon ?? a.icon,
        shortcut: shortcutLabel(item.action),
        disabled: !!item.disabled || !isActionEnabled(a),
        checked: actionToggled(a),
        run: () => void executeActionFrom("menu", item.action, item.arg),
      });
      return;
    }
    out.push({
      ...item,
      label: item.verbatim ? item.label : tx(item.label),
      kind: "item",
      key: item.id ?? `${i}:${item.label}`,
    });
  });
  while (out.length && out[out.length - 1]!.kind === "separator") out.pop();
  return out;
}

const selectable = (r: Resolved | undefined) => !!r && r.kind === "item" && !r.disabled;

interface MenuListProps {
  items: MenuItem[];
  /** Called after an item ran (closes the whole menu chain). */
  onDone: () => void;
  /** Close just this level (submenus). */
  onCloseLevel?: () => void;
  "aria-label"?: string;
  /** Focus the first item on mount. */
  autoFocusFirst?: boolean;
}

export function MenuList({ items, onDone, onCloseLevel, autoFocusFirst = true, ...aria }: MenuListProps) {
  // Action enablement follows the context keys: opening the menu moves focus
  // (e.g. editorTextFocus → popupOpen) right after the first render.
  useContextKeys();
  const resolved = resolveMenuItems(items);
  const [active, setActive] = useState(() => (autoFocusFirst ? resolved.findIndex(selectable) : -1));
  const [openSub, setOpenSubIndex] = useState<number | null>(null);
  const [subAnchor, setSubAnchor] = useState<HTMLElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const pointer = useRef<MenuPointer | null>(null);
  const previousPointer = useRef<MenuPointer | null>(null);
  const pendingAim = useRef<number | null>(null);
  // Pointer movement highlights a row without focusing it. Focusing on every
  // enter drops the hover paint in the Windows webview, so the menu looks frozen.
  const pointerHover = useRef(false);
  // Row the pointer last entered: pointerenter and mouseenter both report it.
  const hovered = useRef(-1);
  const setOpenSub = (i: number | null) => {
    setSubAnchor(i === null ? null : (itemRefs.current[i] ?? null));
    setOpenSubIndex(i);
  };

  useLayoutEffect(() => {
    if (pointerHover.current) {
      pointerHover.current = false;
      return;
    }
    if (active >= 0 && openSub === null) itemRefs.current[active]?.focus({ preventScroll: true });
  }, [active, openSub]);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const focusItem = (i: number) => {
    setActive(i);
    resolved[i]?.onActive?.();
  };

  const move = (delta: number, from = active) => {
    const n = resolved.length;
    if (!n) return;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n;
      if (selectable(resolved[i])) {
        focusItem(i);
        return;
      }
    }
  };

  const activate = (i: number) => {
    cancelHover();
    const item = resolved[i];
    if (!selectable(item)) return;
    if (item!.submenu) {
      setActive(i);
      setOpenSub(i);
      return;
    }
    onDone();
    item!.run?.();
  };

  const cancelHover = () => {
    clearTimeout(hoverTimer.current);
    pendingAim.current = null;
  };

  const applyHover = (i: number, immediate = false) => {
    cancelHover();
    if (i !== active) {
      pointerHover.current = true;
      focusItem(i);
    }
    const next = resolved[i]?.submenu ? i : null;
    if (immediate) setOpenSub(next);
    else hoverTimer.current = setTimeout(() => setOpenSub(next), next === null ? 200 : 120);
  };

  const recordPointer = (point: MenuPointer) => {
    if (pointer.current?.x === point.x && pointer.current.y === point.y) return false;
    previousPointer.current = pointer.current;
    pointer.current = point;
    return true;
  };

  const aiming = () => {
    const rect = submenuRef.current?.parentElement?.getBoundingClientRect();
    return !!rect && !!pointer.current && isSubmenuAim(previousPointer.current, pointer.current, rect);
  };

  const deferHover = (i: number) => {
    cancelHover();
    pendingAim.current = i;
    hoverTimer.current = setTimeout(() => applyHover(i, true), 300);
  };

  const pointerMove = (point: MenuPointer) => {
    if (!recordPointer(point) || pendingAim.current === null) return;
    const i = pendingAim.current;
    if (aiming()) deferHover(i);
    else applyHover(i);
  };

  const enterSubmenu = () => {
    cancelHover();
    hovered.current = -1;
    pointer.current = previousPointer.current = null;
    if (openSub !== null && active !== openSub) {
      pointerHover.current = true;
      setActive(openSub);
    }
  };

  // Track movement across the gap too; submenu portals are outside this level's DOM.
  useEffect(() => {
    if (openSub === null) return;
    const onMove = (e: PointerEvent) => {
      if (submenuRef.current?.parentElement?.contains(e.target as Node)) enterSubmenu();
      else pointerMove({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("pointermove", onMove);
    return () => document.removeEventListener("pointermove", onMove);
  });

  const hover = (i: number, point: MenuPointer) => {
    const item = resolved[i];
    if (!selectable(item) || hovered.current === i) return;
    hovered.current = i;
    recordPointer(point);
    if (openSub !== null && openSub !== i && aiming()) deferHover(i);
    else applyHover(i);
  };

  const leave = (i: number) => {
    // A compatibility mouseleave can follow pointerenter on the next row.
    if (hovered.current === i) hovered.current = -1;
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    cancelHover();
    pointer.current = previousPointer.current = null;
    switch (e.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1, active < 0 ? 0 : active);
        break;
      case "Home":
        move(1, -1);
        break;
      case "End":
        move(-1, 0);
        break;
      case "ArrowRight":
        if (resolved[active]?.submenu) setOpenSub(active);
        else return;
        break;
      case "ArrowLeft":
        if (onCloseLevel) onCloseLevel();
        else return;
        break;
      case "Enter":
      case " ":
        activate(active);
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          const n = resolved.length;
          for (let s = 1; s <= n; s++) {
            const i = (active + s + n) % n;
            const r = resolved[i]!;
            if (selectable(r) && r.label.toLowerCase().startsWith(ch)) {
              focusItem(i);
              break;
            }
          }
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      role="menu"
      aria-label={aria["aria-label"]}
      className={styles.menu}
      onKeyDown={onKeyDown}
      onPointerMove={(e) => {
        if (e.currentTarget.contains(e.target as Node)) pointerMove({ x: e.clientX, y: e.clientY });
      }}
    >
      {resolved.map((r, i) => {
        if (r.kind === "separator") return <div key={r.key} role="separator" className={styles.separator} />;
        if (r.kind === "header")
          return (
            <div key={r.key} role="presentation" className={styles.header}>
              {r.label}
            </div>
          );
        const hasSub = !!r.submenu;
        return (
          <Fragment key={r.key}>
            <button
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role={r.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={r.checked}
              aria-disabled={r.disabled || undefined}
              aria-haspopup={hasSub ? "menu" : undefined}
              aria-expanded={hasSub ? openSub === i : undefined}
              tabIndex={i === active ? 0 : -1}
              className={clsx(
                styles.item,
                i === active && styles.active,
                r.disabled && styles.disabled,
                r.danger && styles.danger,
              )}
              onPointerEnter={(e) => hover(i, { x: e.clientX, y: e.clientY })}
              onMouseEnter={(e) => hover(i, { x: e.clientX, y: e.clientY })}
              onPointerLeave={() => leave(i)}
              onMouseLeave={() => leave(i)}
              onClick={() => activate(i)}
            >
              <span className={styles.icon} data-menu-icon={!r.checked && r.icon ? "" : undefined}>
                {r.checked ? <Icon name="check" size={13} /> : r.icon ? <Icon name={r.icon} size={14} /> : null}
              </span>
              <span className={styles.label} title={r.label}>
                {r.label}
              </span>
              {r.shortcut && <span className={styles.shortcut}>{r.shortcut}</span>}
              {hasSub && <Icon name="chevron-right" size={14} className={styles.subArrow} />}
            </button>
            {hasSub && openSub === i && subAnchor && (
              <Popup
                open
                anchor={subAnchor}
                placement="right-start"
                offset={2}
                role="presentation"
                autoFocus={false}
                onClose={() => setOpenSub(null)}
                className={styles.popup}
              >
                <div ref={submenuRef} onPointerEnter={enterSubmenu}>
                  <MenuList
                    items={r.submenu!}
                    onDone={onDone}
                    onCloseLevel={() => {
                      setOpenSub(null);
                      itemRefs.current[i]?.focus();
                    }}
                  />
                </div>
              </Popup>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchor: PopupAnchor;
  items: MenuItem[];
  placement?: Placement;
  "aria-label"?: string;
}

/** A dropdown menu anchored to an element or point. */
export function Menu({ open, onClose, anchor, items, placement = "bottom-start", ...aria }: MenuProps) {
  return (
    <Popup
      open={open}
      onClose={onClose}
      anchor={anchor}
      placement={placement}
      role="presentation"
      autoFocus={false}
      className={styles.popup}
    >
      <MenuList items={items} onDone={onClose} aria-label={aria["aria-label"]} />
    </Popup>
  );
}

// ---------------------------------------------------------------------------
// Context menus

interface ContextMenuState {
  menu: { x: number; y: number; items: MenuItem[]; id: number } | null;
}

export const useContextMenuStore = create<ContextMenuState>(() => ({ menu: null }));
let menuSeq = 0;

export function showContextMenu(
  at: { clientX: number; clientY: number } | { x: number; y: number },
  items: MenuItem[],
) {
  const x = "clientX" in at ? at.clientX : at.x;
  const y = "clientY" in at ? at.clientY : at.y;
  useContextMenuStore.setState({ menu: { x, y, items, id: ++menuSeq } });
}

export function hideContextMenu() {
  useContextMenuStore.setState({ menu: null });
}

/** Renders the active context menu; mount once (the workbench does). */
export function ContextMenuHost() {
  const menu = useContextMenuStore((s) => s.menu);
  if (!menu) return null;
  return (
    <Popup
      key={menu.id}
      open
      anchor={{ x: menu.x, y: menu.y }}
      placement="bottom-start"
      offset={2}
      role="presentation"
      autoFocus={false}
      onClose={hideContextMenu}
      className={styles.popup}
    >
      <MenuList items={menu.items} onDone={hideContextMenu} aria-label="Context menu" />
    </Popup>
  );
}
