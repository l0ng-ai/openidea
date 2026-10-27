/**
 * Native menu ↔ action system.
 *
 * The backend emits `openidea://menu` `{ action, arg }` to the focused window when
 * an IDE menu item is clicked; we run `executeAction(action, arg)`. In the
 * other direction we push localised labels (`menu.*` catalog keys) and the
 * shortcut text of every keymap binding, so the menu shows the JS keymap's
 * shortcuts without registering native accelerators (see src-tauri/src/menu.rs).
 */
import { executeAction, getAction, isActionEnabled, useActions } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { keysWithPrefix, t, tx, useI18n } from "@/platform/i18n";
import { commands, isTauri, type DynamicItem, type MenuConfig, type MenuNode } from "@/platform/ipc";
import { effectiveBindings, formatBinding, primaryKeyBinding, useKeymap } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { useContributions } from "@/workbench/contributions";
import { isDistractionFree, useDistractionFree } from "@/workbench/distractionFree";
import { useToolWindowLayouts } from "@/workbench/toolwindows/layouts";
import { hostOs, type HostOs } from "./host";

export const MENU_EVENT = "openidea://menu";

export interface MenuRoute {
  action: string;
  arg?: string | null;
}

export function isMenuRoute(v: unknown): v is MenuRoute {
  return typeof v === "object" && v !== null && typeof (v as MenuRoute).action === "string";
}

/** Runs the action a menu item stands for. Returns whether it ran. */
export function routeMenuEvent(payload: unknown, run = executeAction): Promise<boolean> {
  if (!isMenuRoute(payload) || !payload.action) return Promise.resolve(false);
  return run(payload.action, payload.arg ?? undefined);
}

/** Shortcut text for menus: macOS symbols, `Ctrl+Shift+O` style elsewhere. */
export function menuShortcut(binding: string, os: HostOs): string {
  return formatBinding(binding, os === "macos");
}

export function buildMenuConfig(os: HostOs): MenuConfig {
  const labels: Record<string, string> = {};
  // Per-window state some labels follow (View › Appearance › Enter / Exit Distraction Free Mode).
  const params = { os, distractionFree: isDistractionFree() ? "on" : "off" };
  for (const key of keysWithPrefix("menu.")) labels[key] = t(key, params);
  const shortcuts: Record<string, string> = {};
  for (const [, id] of effectiveBindings()) {
    if (id in shortcuts) continue;
    const first = primaryKeyBinding(id);
    if (first) shortcuts[id] = menuShortcut(first, os);
  }
  return { locale: useI18n.getState().locale, labels, shortcuts, dynamic: dynamicMenuItems() };
}

/** View › Tool Windows (every registered window, by title) and Window › Tool Window Layouts. */
export function dynamicMenuItems(): Record<string, DynamicItem[]> {
  const toolWindows = [...useContributions.getState().toolWindows.values()]
    .map((tw) => ({ action: `toolwindow.${tw.id}`, arg: null, label: tx(tw.title) ?? tw.title }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const layouts = useToolWindowLayouts
    .getState()
    .layouts.map((l) => ({ action: "layout.restore", arg: l.name, label: l.name }));
  return { toolWindows, toolWindowLayouts: layouts };
}

/** Action ids of every IDE item in a menu model. */
export function menuActionIds(nodes: readonly MenuNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.kind === "submenu") menuActionIds(n.children, out);
    else if (n.kind === "action") out.add(n.id);
  }
  return out;
}

/** The registered ones among `ids` that cannot run in the current context. */
export function disabledMenuActions(ids: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const action = getAction(id);
    if (action && !isActionEnabled(action)) out.push(id);
  }
  return out.sort();
}

export function installMenuBridge(): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const push = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void hostOs().then((os) => {
        if (!disposed) void commands.menuConfigure(buildMenuConfig(os));
      });
    }, 50);
  };

  void import("@tauri-apps/api/webviewWindow").then(async ({ getCurrentWebviewWindow }) => {
    // Window-scoped: a global `listen` would also receive other windows' menu events.
    const off = await getCurrentWebviewWindow().listen(MENU_EVENT, ({ payload }) => void routeMenuEvent(payload));
    if (disposed) off();
    else unlisten = off;
  });

  // Enablement of the native items follows this window's context (IDEA greys out
  // what cannot run). Recomputed shortly after context changes, sent only when it changed.
  let ids: Set<string> | null = null;
  let lastDisabled = "";
  let enableTimer: ReturnType<typeof setTimeout> | undefined;
  const pushEnablement = (force = false) => {
    clearTimeout(enableTimer);
    enableTimer = setTimeout(() => {
      if (!ids || disposed || !document.hasFocus()) return;
      const dynamic = Object.values(dynamicMenuItems()).flatMap((items) => items.map((d) => d.action));
      const disabled = disabledMenuActions(new Set([...ids, ...dynamic]));
      const key = disabled.join(",");
      if (!force && key === lastDisabled) return;
      lastDisabled = key;
      void commands.menuSetDisabled(disabled);
    }, 120);
  };
  void commands
    .menuModel()
    .then((model) => {
      ids = menuActionIds(model);
      pushEnablement(true);
    })
    .catch(() => {});

  push();
  const onFocus = () => {
    push();
    pushEnablement(true);
  };
  // The native menu bar is shared: a focused window re-pushes its own window-scoped labels.
  window.addEventListener("focus", onFocus);
  const unsubs = [
    useI18n.subscribe((s, prev) => {
      if (s.messages !== prev.messages) push();
    }),
    useKeymap.subscribe(push),
    useDistractionFree.subscribe((s, prev) => {
      if (s.active !== prev.active) push();
    }),
    useContributions.subscribe((s, prev) => {
      if (s.toolWindows !== prev.toolWindows) push();
    }),
    useToolWindowLayouts.subscribe(push),
    useContextKeys.subscribe(() => pushEnablement()),
    useActions.subscribe(() => pushEnablement()),
    // Opening / closing a project changes the Open Recent list.
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) void commands.menuRefresh();
    }),
  ];
  return () => {
    disposed = true;
    clearTimeout(timer);
    clearTimeout(enableTimer);
    window.removeEventListener("focus", onFocus);
    unlisten?.();
    unsubs.forEach((u) => u());
  };
}
