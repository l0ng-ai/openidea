/** Main menu for the frameless title bar, with hamburger and persistent title modes. */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { useProject } from "@/platform/project";
import { lookup, t, useI18n } from "@/platform/i18n";
import { commands, type MenuNode } from "@/platform/ipc";
import { usePlatform } from "@/platform/platformInfo";
import { Icon, MenuList, Popup, type MenuItem } from "@/ui";
import menuStyles from "@/ui/Menu.module.css";
import { isDistractionFree } from "./distractionFree";
import styles from "./TitleBar.module.css";

function label(id: string, fallback: string): string {
  const key = `menu.${id}`;
  if (lookup(key) === undefined) return fallback;
  return t(key, { os: usePlatform.getState().os, distractionFree: isDistractionFree() ? "on" : "off" });
}

type Submenu = Extract<MenuNode, { kind: "submenu" }>;
const isSubmenu = (n: MenuNode): n is Submenu => n.kind === "submenu";

export function menuItems(nodes: MenuNode[]): MenuItem[] {
  return nodes.map((n): MenuItem => {
    switch (n.kind) {
      case "separator":
        return { kind: "separator" };
      case "placeholder":
        return { id: n.id, label: label(n.id, n.label), disabled: true };
      case "submenu":
        return { id: n.id, label: label(n.id, n.label), submenu: menuItems(n.children) };
      case "action":
        return { kind: "action", action: n.id, arg: n.arg ?? undefined, label: n.arg ? n.label : label(n.id, n.label) };
    }
  });
}

/**
 * Calls `onAlt` when Alt is pressed and released with nothing else in between
 * (no other key, no click): Alt+1, Alt+Enter or Alt+click never open the menu.
 */
export function onLoneAlt(target: Window, onAlt: () => void): () => void {
  let armed = false;
  const down = (e: globalThis.KeyboardEvent) => {
    armed = e.key === "Alt" && !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey;
  };
  const up = (e: globalThis.KeyboardEvent) => {
    const fire = armed && e.key === "Alt";
    armed = false;
    if (!fire) return;
    e.preventDefault();
    onAlt();
  };
  const cancel = () => {
    armed = false;
  };
  target.addEventListener("keydown", down, true);
  target.addEventListener("keyup", up, true);
  target.addEventListener("pointerdown", cancel, true);
  target.addEventListener("blur", cancel);
  return () => {
    target.removeEventListener("keydown", down, true);
    target.removeEventListener("keyup", up, true);
    target.removeEventListener("pointerdown", cancel, true);
    target.removeEventListener("blur", cancel);
  };
}

async function loadMenus(): Promise<Submenu[]> {
  const model: MenuNode[] = await commands.menuModel().catch(() => []);
  return model.filter(isSubmenu);
}

type MainMenuProps = { onExpandedChange?: (expanded: boolean) => void };

export function MainMenu(props: MainMenuProps) {
  const merged = useProject((s) => s.settings?.appearance?.mainMenuStyle === "merged");
  return <MainMenuBar key={String(merged)} merged={merged} {...props} />;
}

function MainMenuBar({ merged, onExpandedChange }: MainMenuProps & { merged: boolean }) {
  useI18n((s) => s.locale);
  const [menus, setMenus] = useState<Submenu[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [focused, setFocused] = useState(0);
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  const slot = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const hamburger = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [fits, setFits] = useState(false);
  const pressedTitle = useRef(false);
  const persistent = merged && fits;
  const showTitles = persistent || (!merged && expanded);

  useEffect(() => {
    let disposed = false;
    if (merged)
      void loadMenus().then((top) => {
        if (!disposed) setMenus(top);
      });
    return () => {
      disposed = true;
    };
  }, [merged]);
  useEffect(() => {
    if (!merged || open === null) return;
    let disposed = false;
    void loadMenus().then((top) => {
      if (!disposed && top.length) setMenus(top);
    });
    return () => {
      disposed = true;
    };
  }, [merged, open]);
  useEffect(() => {
    onExpandedChange?.(!merged && expanded);
    return () => onExpandedChange?.(false);
  }, [merged, expanded, onExpandedChange]);

  // The invisible copy keeps the natural flex basis even while the slot shrinks.
  // Measuring the allocated slot includes all neighbouring toolbar/caption controls.
  useLayoutEffect(() => {
    if (!merged || !slot.current || !measure.current) return;
    const update = () => {
      const next = menus.length > 0 && slot.current!.clientWidth >= measure.current!.scrollWidth;
      setFits(next);
      // Each presentation's menu closes with it, and must not reopen when it returns.
      if (next) setExpanded(false);
      else setOpen(null);
    };
    const observer = new ResizeObserver(update);
    observer.observe(slot.current);
    observer.observe(measure.current);
    update();
    return () => observer.disconnect();
  }, [merged, menus]);

  const close = () => {
    setOpen(null);
    setExpanded(false);
  };
  const expand = async () => {
    const top = await loadMenus();
    if (!top.length) return;
    setMenus(top);
    setExpanded(true);
    setOpen(0);
  };
  const focusTitle = (i: number) => {
    setFocused(i);
    (bar?.children[i] as HTMLElement | undefined)?.focus();
  };
  const onMenuClose = (reason?: string) => {
    if (reason !== "outside") {
      if (reason === "escape" && persistent) focusTitle(open ?? focused);
      return close();
    }
    setTimeout(() => {
      if (pressedTitle.current) pressedTitle.current = false;
      else close();
    });
  };
  useEffect(() =>
    onLoneAlt(window, () => {
      if (open !== null || expanded) {
        close();
        if (persistent) focusTitle(focused);
      } else if (persistent) {
        if (bar?.contains(document.activeElement)) previousFocus.current?.focus();
        else {
          previousFocus.current = document.activeElement as HTMLElement;
          focusTitle(0);
        }
      } else void expand();
    }),
  );
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (!menus.length) return;
      e.preventDefault();
      const next = ((open ?? focused) + (e.key === "ArrowRight" ? 1 : -1) + menus.length) % menus.length;
      if (open !== null) setOpen(next);
      else focusTitle(next);
    } else if (e.key === "ArrowDown" && open === null) {
      e.preventDefault();
      setOpen(focused);
    } else if (e.key === "Escape" && open === null) {
      close();
      previousFocus.current?.focus();
    }
  };

  const button = (
    <button
      ref={hamburger}
      type="button"
      className={styles.mainMenuButton}
      aria-label={t("menu.mainMenu")}
      title={t("menu.mainMenu")}
      aria-haspopup="menu"
      aria-expanded={expanded}
      onClick={() => {
        if (expanded) close();
        else void expand();
      }}
    >
      <Icon name="main-menu" size={16} />
    </button>
  );
  const titles = (
    <div ref={setBar} role="menubar" className={styles.menuBar} onKeyDown={onKeyDown}>
      {menus.map((m, i) => (
        <button
          key={m.id}
          type="button"
          role="menuitem"
          tabIndex={focused === i ? 0 : -1}
          aria-haspopup="menu"
          aria-expanded={open === i}
          className={clsx(styles.menuTitle, open === i && styles.menuTitleOpen)}
          onFocus={() => setFocused(i)}
          onPointerDown={() => {
            pressedTitle.current = true;
            setTimeout(() => {
              pressedTitle.current = false;
            });
          }}
          onPointerEnter={() => {
            if (open !== null) setOpen(i);
          }}
          onClick={() => {
            if (open === i) close();
            else setOpen(i);
          }}
        >
          {label(m.id, m.label)}
        </button>
      ))}
      {open !== null && menus[open] && bar?.children[open] && (
        <Popup
          key={menus[open].id}
          open
          anchor={bar.children[open]}
          placement="bottom-start"
          offset={2}
          role="presentation"
          autoFocus={false}
          restoreFocus={!persistent}
          onClose={onMenuClose}
          className={menuStyles.popup}
        >
          <MenuList
            items={menuItems(menus[open].children)}
            onDone={close}
            aria-label={label(menus[open].id, menus[open].label)}
          />
        </Popup>
      )}
    </div>
  );
  if (!merged) return showTitles ? titles : button;
  return (
    <div ref={slot} className={styles.mainMenuSlot}>
      <div ref={measure} className={clsx(styles.menuBar, styles.menuMeasure)} aria-hidden="true" inert>
        {menus.map((m) => (
          <span key={m.id} className={styles.menuTitle}>
            {label(m.id, m.label)}
          </span>
        ))}
      </div>
      <div className={styles.menuPresentation}>{showTitles ? titles : button}</div>
      {!showTitles && expanded && (
        <Popup
          open
          anchor={hamburger}
          onClose={close}
          placement="bottom-start"
          role="presentation"
          autoFocus={false}
          className={menuStyles.popup}
        >
          <MenuList items={menuItems(menus)} onDone={close} aria-label={t("menu.mainMenu")} />
        </Popup>
      )}
    </div>
  );
}
