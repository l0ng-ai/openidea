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
import { getAction, isActionEnabled, executeAction } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { shortcutLabel } from "@/platform/keymap";
import { Icon, type IconName } from "./icons";
import { Popup, type PopupAnchor } from "./Popup";
import type { Placement } from "@floating-ui/react-dom";
import styles from "./Menu.module.css";
import { tx } from "@/platform/i18n";

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
        run: () => void executeAction(item.action, item.arg),
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
  const setOpenSub = (i: number | null) => {
    setSubAnchor(i === null ? null : (itemRefs.current[i] ?? null));
    setOpenSubIndex(i);
  };

  useLayoutEffect(() => {
    if (active >= 0 && openSub === null) itemRefs.current[active]?.focus({ preventScroll: false });
  }, [active, openSub]);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const move = (delta: number, from = active) => {
    const n = resolved.length;
    if (!n) return;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n;
      if (selectable(resolved[i])) {
        setActive(i);
        return;
      }
    }
  };

  const activate = (i: number) => {
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

  const onKeyDown = (e: ReactKeyboardEvent) => {
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
              setActive(i);
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
    <div role="menu" aria-label={aria["aria-label"]} className={styles.menu} onKeyDown={onKeyDown}>
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
              onPointerEnter={() => {
                if (r.disabled) return;
                setActive(i);
                clearTimeout(hoverTimer.current);
                hoverTimer.current = setTimeout(() => setOpenSub(hasSub ? i : null), hasSub ? 120 : 200);
              }}
              onClick={() => activate(i)}
            >
              <span className={styles.icon} data-menu-icon={!r.checked && r.icon ? "" : undefined}>
                {r.checked ? <Icon name="check" size={13} /> : r.icon ? <Icon name={r.icon} size={14} /> : null}
              </span>
              <span className={styles.label}>{r.label}</span>
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
                <MenuList
                  items={r.submenu!}
                  onDone={onDone}
                  onCloseLevel={() => {
                    setOpenSub(null);
                    itemRefs.current[i]?.focus();
                  }}
                />
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
