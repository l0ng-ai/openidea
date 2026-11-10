/**
 * Settings window ↔ its project window.
 *
 * Settings live in a separate window `settings-<parent>` (see
 * src-tauri/src/windows.rs) that only runs the settings pages (a native
 * child of the parent on macOS/Linux; top-level on Windows so DWM paints
 * its shadow). The action
 * registry stays in the project window: it sends the settings window a
 * description of every action (Keymap page, links that run actions) and runs
 * the actions the settings window forwards.
 */
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { allActions, executeAction, getAction, registerAction, useActions, type Action } from "@/platform/actions";
import { isTauri } from "@/platform/ipc";

const SETTINGS_PREFIX = "settings-";
const REQUEST_ACTIONS = "openidea://settings/request-actions";
const ACTIONS = "openidea://settings/actions";
const EXEC = "openidea://settings/exec";

export type ActionInfo = Pick<
  Action,
  "id" | "title" | "category" | "description" | "icon" | "when" | "keywords" | "hidden"
>;

function currentLabel(): string | null {
  if (!isTauri()) return null;
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return null;
  }
}

/** The parent's label when this webview is a settings window. */
export function settingsWindowParent(label = currentLabel()): string | null {
  return label?.startsWith(SETTINGS_PREFIX) ? label.slice(SETTINGS_PREFIX.length) : null;
}

export function describeActions(actions: Iterable<Action> = allActions()): ActionInfo[] {
  return [...actions].map(({ id, title, category, description, icon, when, keywords, hidden }) => ({
    id,
    title,
    category,
    description,
    icon,
    when,
    keywords,
    hidden,
  }));
}

function listen<T>(event: string, handler: (payload: T) => void, onReady?: () => void): () => void {
  let disposed = false;
  let off: (() => void) | undefined;
  void getCurrentWebviewWindow()
    .listen<T>(event, ({ payload }) => handler(payload))
    .then((u) => {
      if (disposed) return u();
      off = u;
      onReady?.();
    });
  return () => {
    disposed = true;
    off?.();
  };
}

/** Project window side: serves the action list and runs forwarded actions. */
export function installSettingsHost(): () => void {
  const label = currentLabel();
  if (!label || settingsWindowParent(label)) return () => {};
  const target = SETTINGS_PREFIX + label;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = () => void emitTo(target, ACTIONS, describeActions()).catch(() => {});
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(send, 100);
  };
  const disposers = [
    listen<null>(REQUEST_ACTIONS, send),
    listen<{ id: string; arg?: unknown }>(EXEC, ({ id, arg }) => void executeAction(id, arg)),
    // Pushed on every change (and once now, for a settings window that outlived a reload of this one).
    useActions.subscribe((s, prev) => {
      if (s.actions !== prev.actions) schedule();
    }),
  ];
  schedule();
  return () => {
    clearTimeout(timer);
    disposers.forEach((d) => d());
  };
}

/**
 * Settings window side: mirrors the parent's actions as proxies that run in
 * the parent. Actions registered locally (e.g. `file.settings`) win.
 */
export function installActionProxies(parent: string): () => void {
  const proxies = new Map<string, () => void>();
  const sync = (infos: ActionInfo[]) => {
    proxies.forEach((dispose) => dispose());
    proxies.clear();
    for (const info of infos) {
      if (getAction(info.id)) continue;
      const proxy: Action = { ...info, run: ({ arg }) => void emitTo(parent, EXEC, { id: info.id, arg }) };
      proxies.set(info.id, registerAction(proxy));
    }
  };
  const off = listen<ActionInfo[]>(ACTIONS, sync, () => void emitTo(parent, REQUEST_ACTIONS, null).catch(() => {}));
  return () => {
    off();
    proxies.forEach((dispose) => dispose());
  };
}
