/**
 * Native menu ↔ action system.
 *
 * The backend emits `openidea://menu` `{ action, arg }` to the focused window when
 * an IDE menu item is clicked; we run `executeAction(action, arg)`. In the
 * other direction we push localised labels (`menu.*` catalog keys) and the
 * native accelerator of every keymap binding, which the macOS menu shows as a key
 * equivalent while the JS keymap stays the only dispatcher (see src-tauri/src/menu.rs).
 */
import { executeActionFrom, getAction, isActionEnabled, useActions } from "@/platform/actions";
import { getContext, useContextKeys } from "@/platform/context";
import { keysWithPrefix, t, tx, useI18n } from "@/platform/i18n";
import { commands, isTauri, type DynamicItem, type MenuConfig, type MenuNode } from "@/platform/ipc";
import {
  effectiveBindings,
  isMouseBinding,
  normalizeBinding,
  parseDoubleModifier,
  primaryKeyBinding,
  useKeymap,
} from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { useContributions, useMenuSlotItems, useStandaloneEditor } from "@/workbench/contributions";
import { isDistractionFree, useDistractionFree } from "@/workbench/distractionFree";
import { orderStatusItems } from "@/workbench/StatusBar";
import { statusWidgetRows } from "@/workbench/statusBarWidgets";
import { useToolWindowLayouts } from "@/workbench/toolwindows/layouts";
import { hostOs, type HostOs } from "./host";

export const MENU_EVENT = "openidea://menu";

export interface MenuRoute {
  action: string;
  arg?: string | null;
  /** The window in front when the item was chosen, if it is not this one (this window's Settings). */
  returnTo?: string;
}

export function isMenuRoute(v: unknown): v is MenuRoute {
  return typeof v === "object" && v !== null && typeof (v as MenuRoute).action === "string";
}

/** Runs the action a menu item stands for. Returns whether it ran. */
export function routeMenuEvent(
  payload: unknown,
  run = (id: string, arg?: unknown) => executeActionFrom("menu", id, arg),
): Promise<boolean> {
  if (!isMenuRoute(payload) || !payload.action) return Promise.resolve(false);
  return run(payload.action, payload.arg ?? undefined);
}

/** How long an action chosen from the menu may take to open its dialog or popup. */
const OPEN_DELAY_MS = 300;

const layersClosed = () =>
  new Promise<void>((resolve) => {
    if (!getContext().popupOpen) return resolve();
    const off = useContextKeys.subscribe((ctx) => {
      if (ctx.popupOpen) return;
      off();
      resolve();
    });
  });

/**
 * After an item chosen in this window's Settings window ran here (the backend brought this window
 * forward): once the dialog or popup it opened closes, or right away if it opened none, Settings comes
 * back to the front, as IDEA's Settings dialog stays under the dialogs opened from the menu. Not when
 * focus has moved on (a new window, a native dialog).
 */
export async function returnFocusAfterMenu(
  ran: Promise<boolean>,
  focusWindow: () => Promise<void>,
  delay = OPEN_DELAY_MS,
): Promise<void> {
  await ran;
  await new Promise((r) => setTimeout(r, delay));
  await layersClosed();
  if (document.hasFocus()) await focusWindow();
}

/**
 * Keymap key names a macOS key equivalent can show. Mirrors the names muda's accelerator
 * parser accepts: Tauri drops an accelerator it cannot parse, and the item shows no shortcut.
 */
const NATIVE_KEY =
  /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|[[\]`\\,./;'=-]|Space|Enter|Escape|Tab|Backspace|Delete|Up|Down|Left|Right|Home|End|PageUp|PageDown|Numpad(Add|Subtract|Multiply|Divide))$/;

/**
 * The binding as a native menu accelerator (`Shift+Meta+O`), or undefined when a menu
 * cannot show it: chords, double modifiers, mouse buttons and gestures, as in IDEA.
 */
export function menuAccelerator(binding: string): string | undefined {
  if (isMouseBinding(binding) || parseDoubleModifier(binding)) return undefined;
  const stroke = normalizeBinding(binding);
  if (stroke.includes(" ")) return undefined;
  return NATIVE_KEY.test(stroke.split("+").pop()!) ? stroke : undefined;
}

export function buildMenuConfig(os: HostOs): MenuConfig {
  const labels: Record<string, string> = {};
  // Per-window state some labels follow (View › Appearance › Enter / Exit Distraction Free Mode).
  const params = { os, distractionFree: isDistractionFree() ? "on" : "off" };
  for (const key of keysWithPrefix("menu.")) labels[key] = t(key, params);
  const accelerators: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [, id] of effectiveBindings()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const first = primaryKeyBinding(id);
    const accelerator = first && menuAccelerator(first);
    if (accelerator) accelerators[id] = accelerator;
  }
  return {
    locale: useI18n.getState().locale,
    labels,
    accelerators,
    dynamic: dynamicMenuItems(),
    checked: toggledActions(),
  };
}

/** Toggle actions that are on: their menu items show a check mark (View › Appearance). */
function toggledActions(): string[] {
  return [...useActions.getState().actions.values()]
    .filter((a) => a.toggled?.())
    .map((a) => a.id)
    .sort();
}

/** View › Appearance › Status Bar Widgets: the status bar's context menu, in bar order. */
function statusBarWidgetItems(): DynamicItem[] {
  const { project, lightEdit, settings } = useProject.getState();
  // A LightEdit window's status bar has only the items that apply there (Workbench.tsx).
  const lightEditFrame = !project && (lightEdit || useStandaloneEditor.getState().title !== null);
  const items = [...useContributions.getState().statusItems.values()].filter((i) => !lightEditFrame || i.lightEdit);
  const { left, right } = orderStatusItems(items);
  const overrides = settings?.appearance?.statusBarWidgets;
  return statusWidgetRows([...left, ...right], overrides).map((row) => ({
    action: "view.toggleStatusBarWidget",
    arg: row.id,
    label: row.verbatim ? row.title : tx(row.title),
    checked: row.visible,
  }));
}

/** View › Tool Windows (every registered window, by title), View › Appearance › Status Bar Widgets and Window › Tool Window Layouts. */
export function dynamicMenuItems(): Record<string, DynamicItem[]> {
  const toolWindows = [...useContributions.getState().toolWindows.values()]
    .map((tw) => ({ action: `toolwindow.${tw.id}`, arg: null, label: tw.verbatim ? tw.title : tx(tw.title) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const layouts = useToolWindowLayouts
    .getState()
    .layouts.map((l) => ({ action: "layout.restore", arg: l.name, label: l.name }));
  const slots = Object.fromEntries(
    Object.entries(useMenuSlotItems.getState().slots).map(([slot, items]) => [
      slot,
      [...items]
        .map((i) => ({ action: i.action, arg: i.arg ?? null, label: i.verbatim ? i.label : tx(i.label) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ]),
  );
  return { ...slots, toolWindows, toolWindowLayouts: layouts, statusBarWidgets: statusBarWidgetItems() };
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
    const off = await getCurrentWebviewWindow().listen(MENU_EVENT, ({ payload }) => {
      const ran = routeMenuEvent(payload);
      const returnTo = isMenuRoute(payload) ? payload.returnTo : undefined;
      if (returnTo)
        void returnFocusAfterMenu(ran, async () => {
          const { Window } = await import("@tauri-apps/api/window");
          await (await Window.getByLabel(returnTo))?.setFocus();
        }).catch(() => {});
    });
    if (disposed) off();
    else unlisten = off;
  });

  // Enablement of the native items follows this window's context (IDEA greys out
  // what cannot run). Recomputed shortly after context changes, sent only when it changed.
  // Also once on blur: the menu still runs here while this window's Settings window is focused,
  // with nothing focused here (editor actions disabled). The backend ignores it for other windows.
  let ids: Set<string> | null = null;
  let lastDisabled = "";
  let forceEnablement = false;
  let afterBlur = false;
  let enableTimer: ReturnType<typeof setTimeout> | undefined;
  const pushEnablement = (force = false, blurred = false) => {
    forceEnablement ||= force;
    afterBlur ||= blurred;
    clearTimeout(enableTimer);
    enableTimer = setTimeout(() => {
      const unfocused = !document.hasFocus();
      if (!ids || disposed || (unfocused && !afterBlur)) return;
      afterBlur = false;
      const dynamic = Object.values(dynamicMenuItems()).flatMap((items) => items.map((d) => d.action));
      const disabled = disabledMenuActions(new Set([...ids, ...dynamic]));
      const key = disabled.join(",");
      if (!forceEnablement && key === lastDisabled) return;
      forceEnablement = false;
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
  // The menu bar is shared. A focused window re-pushes labels that can differ per window.
  // The backend edits only submenus whose visible items changed, so switching project
  // tabs does not redraw the macOS menu bar.
  window.addEventListener("focus", onFocus);
  const onBlur = () => pushEnablement(true, true);
  window.addEventListener("blur", onBlur);
  const unsubs = [
    useI18n.subscribe((s, prev) => {
      if (s.messages !== prev.messages) push();
    }),
    useKeymap.subscribe(push),
    useDistractionFree.subscribe((s, prev) => {
      if (s.active !== prev.active) push();
    }),
    useContributions.subscribe((s, prev) => {
      if (s.toolWindows !== prev.toolWindows || s.statusItems !== prev.statusItems) push();
    }),
    useToolWindowLayouts.subscribe(push),
    useMenuSlotItems.subscribe(push),
    useContextKeys.subscribe(() => pushEnablement()),
    useActions.subscribe(() => pushEnablement()),
    // Project membership and names also change the Open Recent list.
    useProject.subscribe((s, prev) => {
      if (s.project !== prev.project) void commands.menuRefresh();
      if (s.lightEdit !== prev.lightEdit) push();
      // View › Appearance check marks and Status Bar Widgets.
      if (s.settings?.appearance !== prev.settings?.appearance) push();
    }),
  ];
  return () => {
    disposed = true;
    clearTimeout(timer);
    clearTimeout(enableTimer);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    unlisten?.();
    unsubs.forEach((u) => u());
  };
}
