/**
 * Glue between backend plugins and the workbench: plugin commands become
 * actions, editor requests are applied to the active editor, the selected
 * theme becomes a stylesheet of CSS variables, notifications become balloons.
 */
import { EditorSelection } from "@codemirror/state";
import type { ActiveTheme, EditorContext, PluginEvent, PluginInfo } from "@/bindings";
import { activeEditor, useEditorRegistry } from "@/editor/api";
import { registerAction, type Action } from "@/platform/actions";
import { notifications, registerMenuGroup, type MenuGroupContext } from "@/workbench/contributions";
import { applyThemeAttributes, currentThemeId, syncWindowBackground, windowBackgroundHex } from "@/workbench/theme";
import type { MenuItem } from "@/ui/Menu";
import { pluginsBackend } from "./backend";
import { refreshPlugins, runPluginCommand, usePlugins } from "./store";
import { tx } from "@/platform/i18n";

export const pluginActionId = (pluginId: string, commandId: string) => `plugin.${pluginId}.${commandId}`;

/** The focused editor as plugin context: which file, and the 0-based caret line. */
function currentEditorContext(): EditorContext | null {
  const editor = activeEditor();
  if (!editor) return null;
  const { view } = editor;
  return {
    path: editor.ctx.path,
    line: view.state.doc.lineAt(view.state.selection.main.head).number - 1,
  };
}

/** Actions for every command of every running plugin. */
export function pluginActions(plugins: readonly PluginInfo[]): Action[] {
  return plugins
    .filter((p) => p.status === "active")
    .flatMap((p) =>
      p.commands.map((c): Action => ({
        id: pluginActionId(p.id, c.id),
        title: c.title,
        category: c.category ?? p.name,
        icon: "package",
        keywords: ["plugin", p.name, p.id],
        description: tx`From plugin ${p.name}`,
        run: async ({ arg }) => {
          await runPluginCommand(p.id, c.id, typeof arg === "string" ? arg : null, currentEditorContext());
        },
      })),
    );
}

/** File extension without the dot, lower-case; undefined without one. */
function extensionOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}

/**
 * Items a running plugin contributes to the editor menu (`[[contributes.menu-items]]`),
 * grouped into submenus by `group` (e.g. Editor › Arthas Command › Watch).
 */
export function pluginMenuItems(plugins: readonly PluginInfo[], ctx: MenuGroupContext): MenuItem[] {
  const path = ctx.paths.length === 1 ? ctx.paths[0]! : undefined;
  const extension = path ? extensionOf(path) : undefined;
  const entries: Array<{ group?: string; order: number; label: string; item: MenuItem }> = [];
  for (const p of plugins) {
    if (p.status !== "active") continue;
    for (const m of p.menuItems) {
      if (m.menu !== "editor") continue;
      const extensions = m.extensions ?? [];
      if (extensions.length && (!extension || !extensions.some((e) => e.toLowerCase() === extension))) continue;
      const label = m.label ?? p.commands.find((c) => c.id === m.command)?.title ?? m.command;
      entries.push({
        group: m.group ?? undefined,
        order: m.order ?? 0,
        label,
        item: {
          label,
          run: () => void runPluginCommand(p.id, m.command, null, { path: path ?? null, line: ctx.line ?? null }),
        },
      });
    }
  }
  if (!entries.length) return [];
  entries.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  const groups = new Map<string, MenuItem[]>();
  const flat: MenuItem[] = [];
  for (const e of entries) {
    if (e.group === undefined) flat.push(e.item);
    else groups.set(e.group, [...(groups.get(e.group) ?? []), e.item]);
  }
  return [...flat, ...[...groups].map(([label, submenu]): MenuItem => ({ label, submenu }))];
}

/** Keeps the action registry in sync with the plugin list; re-registers only changed actions. */
export function syncPluginActions(): () => void {
  const registered = new Map<string, { key: string; dispose: () => void }>();
  const apply = (plugins: readonly PluginInfo[]) => {
    const next = new Map(pluginActions(plugins).map((a) => [a.id, a]));
    for (const [id, entry] of registered) {
      if (!next.has(id)) {
        entry.dispose();
        registered.delete(id);
      }
    }
    for (const [id, action] of next) {
      const key = `${action.title}\u0000${action.category}`;
      const prev = registered.get(id);
      if (prev?.key === key) continue;
      prev?.dispose();
      registered.set(id, { key, dispose: registerAction(action) });
    }
  };
  apply(usePlugins.getState().plugins);
  const unsubscribe = usePlugins.subscribe((s, prev) => {
    if (s.plugins !== prev.plugins) apply(s.plugins);
  });
  return () => {
    unsubscribe();
    registered.forEach((e) => e.dispose());
    registered.clear();
  };
}

// --- theme ------------------------------------------------------------------

export const PLUGIN_THEME_STYLE_ID = "openidea-plugin-theme";

/** Stylesheet for a plugin theme. Its selector outranks every built-in theme block. */
export function pluginThemeCss(theme: ActiveTheme["theme"]): string {
  const kind = theme.kind === "light" ? "light" : "dark";
  const decls = [`  color-scheme: ${kind};`];
  for (const [name, value] of Object.entries(theme.tokens)) {
    // Backend validates; keep the guard so a malformed payload can't inject declarations.
    if (!/^--[a-z0-9-]+$/.test(name) || value == null || /[;{}<>\\]/.test(value)) continue;
    decls.push(`  ${name}: ${value};`);
  }
  return `:root[data-plugin-theme]:not([data-plugin-theme=""]) {\n${decls.join("\n")}\n}\n`;
}

/**
 * Applies a plugin theme (null restores the built-in one): its tokens as a
 * stylesheet over the built-in light or dark base named by its `kind`. A
 * stylesheet rather than inline styles, so the accent picked in Settings ›
 * Appearance and the editor colour scheme still layer on top.
 */
export function applyPluginTheme(theme: ActiveTheme | null, root: HTMLElement = document.documentElement) {
  const doc = root.ownerDocument;
  doc.getElementById(PLUGIN_THEME_STYLE_ID)?.remove();
  const had = root.dataset.pluginTheme !== undefined;
  if (!theme) {
    delete root.dataset.pluginTheme;
    delete root.dataset.pluginThemeKind;
    if (had) applyThemeAttributes(currentThemeId(), root);
  } else {
    const style = doc.createElement("style");
    style.id = PLUGIN_THEME_STYLE_ID;
    style.textContent = pluginThemeCss(theme.theme);
    doc.head.appendChild(style);
    root.dataset.pluginTheme = `${theme.pluginId}/${theme.theme.id}`;
    root.dataset.pluginThemeKind = theme.theme.kind === "light" ? "light" : "dark";
    applyThemeAttributes(currentThemeId(), root);
  }
  if (had || theme) syncWindowBackground();
}

/** localStorage key read by public/boot.js: the selected theme's stylesheet, applied before the app loads. */
export const PLUGIN_THEME_CACHE_KEY = "openidea.pluginTheme";

export interface CachedPluginTheme {
  /** `data-plugin-theme`: `<pluginId>/<themeId>`. */
  id: string;
  kind: "light" | "dark";
  css: string;
}

function cachePluginTheme(theme: ActiveTheme | null) {
  try {
    if (!theme) {
      localStorage.removeItem(PLUGIN_THEME_CACHE_KEY);
      return;
    }
    const cached: CachedPluginTheme = {
      id: `${theme.pluginId}/${theme.theme.id}`,
      kind: theme.theme.kind === "light" ? "light" : "dark",
      css: pluginThemeCss(theme.theme),
    };
    localStorage.setItem(PLUGIN_THEME_CACHE_KEY, JSON.stringify(cached));
  } catch {
    /* storage unavailable */
  }
}

let reportedFrame: string | undefined;

/**
 * Tells the backend the theme's resolved frame colour, which new windows open
 * in. Selecting a theme clears it there, so it is sent once per selection.
 */
function reportThemeFrame(theme: ActiveTheme | null) {
  const frame = theme ? windowBackgroundHex() : null;
  if (!theme || !frame) {
    reportedFrame = undefined;
    return;
  }
  const key = `${theme.pluginId}/${theme.theme.id}|${frame}`;
  if (key === reportedFrame) return;
  reportedFrame = key;
  void pluginsBackend()
    .setThemeFrame(frame)
    .catch(() => (reportedFrame = undefined));
}

/**
 * Applies the selected plugin theme and keeps it for the next start-up. Until
 * the first plugin list arrives, the theme public/boot.js restored stays.
 */
export function trackPluginTheme(): () => void {
  const sync = (s: ReturnType<typeof usePlugins.getState>) => {
    if (!s.activeTheme && (!s.loaded || s.error)) return;
    applyPluginTheme(s.activeTheme);
    cachePluginTheme(s.activeTheme);
    reportThemeFrame(s.activeTheme);
  };
  sync(usePlugins.getState());
  const unsubscribe = usePlugins.subscribe((s, prev) => {
    if (s.activeTheme !== prev.activeTheme || s.loaded !== prev.loaded) sync(s);
  });
  return () => {
    unsubscribe();
    applyPluginTheme(null);
  };
}

// --- editor -----------------------------------------------------------------

/** Inserts (`select: false`) or replaces-and-selects (`select: true`) at every selection range. */
export function applyTextToActiveEditor(text: string, select: boolean, pluginId: string): boolean {
  const editor = activeEditor();
  const name = usePlugins.getState().plugins.find((p) => p.id === pluginId)?.name ?? pluginId;
  if (!editor || editor.ctx.readOnly) {
    notifications().notify({
      group: "plugins",
      level: "warning",
      title: `${name}: ${editor ? "the editor is read-only" : "no editor to insert into"}`,
    });
    return false;
  }
  const { view } = editor;
  view.dispatch(
    view.state.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert: text },
      range: select
        ? EditorSelection.range(range.from, range.from + text.length)
        : EditorSelection.cursor(range.from + text.length),
    })),
    { scrollIntoView: true, userEvent: "input.plugin" },
  );
  view.focus();
  return true;
}

/** Reports the focused editor's file to the backend (`active-file` for plugins). */
function trackActiveFile(): () => void {
  let last: string | null | undefined;
  const report = (path: string | null) => {
    if (path === last) return;
    last = path;
    void pluginsBackend()
      .setActiveFile(path)
      .catch(() => {});
  };
  report(useEditorRegistry.getState().active?.ctx.path ?? null);
  return useEditorRegistry.subscribe((s) => report(s.active?.ctx.path ?? null));
}

// --- events -----------------------------------------------------------------

export function handlePluginEvent(e: PluginEvent) {
  switch (e.type) {
    case "commandsChanged":
      scheduleRefresh();
      break;
    case "notification": {
      const name = usePlugins.getState().plugins.find((p) => p.id === e.pluginId)?.name ?? e.pluginId;
      notifications().notify({ group: "plugins", level: e.level, title: e.title || name, body: e.body || undefined });
      break;
    }
    case "insertText":
      applyTextToActiveEditor(e.text, false, e.pluginId);
      break;
    case "replaceSelection":
      applyTextToActiveEditor(e.text, true, e.pluginId);
      break;
    case "writeClipboard":
      void navigator.clipboard?.writeText(e.text).catch(() => {
        const name = usePlugins.getState().plugins.find((p) => p.id === e.pluginId)?.name ?? e.pluginId;
        notifications().notify({
          group: "plugins",
          level: "warning",
          title: `${name}: could not copy to the clipboard`,
        });
      });
      break;
    case "themeChanged":
      usePlugins.setState({ activeTheme: e.theme });
      break;
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshPlugins();
  }, 30);
}

export function startPluginBridge(): () => void {
  const disposers = [
    pluginsBackend().onEvent(handlePluginEvent),
    syncPluginActions(),
    trackPluginTheme(),
    trackActiveFile(),
    // Plugin items join the editor menu (after the built-in groups).
    registerMenuGroup({
      id: "plugins.menuItems",
      menus: ["editor"],
      order: 200,
      items: (_menu, ctx) => pluginMenuItems(usePlugins.getState().plugins, ctx),
    }),
  ];
  return () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    disposers.reverse().forEach((d) => d());
  };
}
