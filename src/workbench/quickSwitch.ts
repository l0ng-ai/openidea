/**
 * Theme / color scheme / keymap / view mode switches shared by the main
 * toolbar's gear menu and View › Quick Switch Scheme… (⌃`).
 */
import { call, commands, isTauri } from "@/platform/ipc";
import { listSchemes } from "@/platform/colorScheme";
import { editorPrefs } from "@/platform/editorSettings";
import { PRESET_TITLES, useKeymap } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { showContextMenu, useContextMenuStore, type MenuItem } from "@/ui";
import { themeGroups, type ThemeChoiceId } from "@/platform/themes";
import { currentThemeChoice, previewTheme, setTheme } from "./theme";

async function setGlobal(key: string, value: unknown, what: string) {
  if (!isTauri()) return;
  try {
    useProject.setState({ settings: await call(commands.settingsSet("global", key, JSON.stringify(value))) });
  } catch (e) {
    console.warn(`cannot switch ${what}`, e);
  }
}

export const selectKeymap = (id: string) => setGlobal("keymap", id, "keymap");

/** How long a theme stays under the pointer or keyboard before Quick Switch shows it (IDEA's delay). */
export const THEME_PREVIEW_DELAY = 500;

/**
 * IDEA's instant theme switch (`ide.instant.theme.switch`): in Quick Switch
 * the active theme shows after a moment, in this window only; choosing one
 * selects it, and closing the menu without a choice brings the selected
 * theme back.
 */
export interface ThemePreview {
  preview(id: ThemeChoiceId): void;
  /** Back to the selected theme (another Quick Switch entry became active). */
  restore(): void;
  choose(id: ThemeChoiceId): void;
  /** The menu closed. */
  end(): void;
}

export function themePreview(): ThemePreview {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shown: ThemeChoiceId | null = null;
  let chosen = false;
  const restore = () => {
    clearTimeout(timer);
    if (shown !== null && !chosen) previewTheme(null);
    shown = null;
  };
  return {
    preview(id) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        shown = id;
        previewTheme(id);
      }, THEME_PREVIEW_DELAY);
    },
    restore,
    choose(id) {
      clearTimeout(timer);
      chosen = true;
      // Shown right away; selecting it then changes nothing visible.
      if (shown !== id) previewTheme(id);
      void setTheme(id);
    },
    end: restore,
  };
}

/** The built-in themes, then each plugin's, a separator between them (as IDEA's Theme list). */
export function themeItems(themeId: string = currentThemeChoice(), preview?: ThemePreview): MenuItem[] {
  return themeGroups().flatMap<MenuItem>((group, i) => [
    ...(i > 0 ? [{ kind: "separator" as const }] : []),
    ...group.themes.map<MenuItem>((c) => ({
      id: `theme.${c.id}`,
      label: c.label,
      // Plugin themes keep their own names.
      verbatim: !!c.origin,
      checked: c.id === themeId,
      onActive: preview && (() => preview.preview(c.id)),
      run: () => (preview ? preview.choose(c.id) : void setTheme(c.id)),
    })),
  ]);
}

export function keymapItems(keymapId: string, customKeymaps: string[]): MenuItem[] {
  return [...Object.keys(PRESET_TITLES), ...customKeymaps].map<MenuItem>((id) => ({
    id: `keymap.${id}`,
    label: PRESET_TITLES[id] ?? id,
    verbatim: !PRESET_TITLES[id],
    checked: id === keymapId,
    run: () => void selectKeymap(id),
  }));
}

export function colorSchemeItems(current: string | undefined): MenuItem[] {
  const schemes = listSchemes(editorPrefs().customSchemes);
  const value = current && schemes.some((s) => s.id === current) ? current : "theme-default";
  return [
    {
      id: "scheme.theme-default",
      label: "Theme default",
      checked: value === "theme-default",
      run: () => void setGlobal("editor.colorScheme", "theme-default", "color scheme"),
    },
    ...schemes.map<MenuItem>((s) => ({
      id: `scheme.${s.id}`,
      label: s.name,
      checked: s.id === value,
      run: () => void setGlobal("editor.colorScheme", s.id, "color scheme"),
    })),
  ];
}

/** The existing view modes: Distraction Free Mode and Full Screen. */
export const VIEW_MODE_ITEMS: MenuItem[] = [
  { kind: "action", action: "editor.toggleZen" },
  { kind: "action", action: "window.toggleFullScreen" },
];

/** The keymap in effect and the user's custom keymaps. */
export function keymapState(): { keymapId: string; customs: string[] } {
  const settings = useProject.getState().settings;
  const customs = settings?.customKeymaps;
  return {
    keymapId: typeof settings?.keymap === "string" ? settings.keymap : useKeymap.getState().preset,
    customs: customs && typeof customs === "object" ? Object.keys(customs) : [],
  };
}

/** View › Quick Switch Scheme…: IDEA's popup of the switchable schemes, its themes previewed. */
export function quickSwitchItems(preview?: ThemePreview): MenuItem[] {
  const { keymapId, customs } = keymapState();
  const restore = preview && (() => preview.restore());
  return [
    {
      id: "qs.scheme",
      label: "Editor Color Scheme",
      onActive: restore,
      submenu: colorSchemeItems(useProject.getState().settings?.editor?.colorScheme),
    },
    { id: "qs.keymap", label: "Keymap", onActive: restore, submenu: keymapItems(keymapId, customs) },
    { id: "qs.viewMode", label: "View Mode", onActive: restore, submenu: VIEW_MODE_ITEMS },
    { id: "qs.theme", label: "Theme", submenu: themeItems(undefined, preview) },
  ];
}

/** Opens Quick Switch Scheme; a theme previewed there goes away with the menu unless chosen. */
export function showQuickSwitch(at: { x: number; y: number }) {
  const preview = themePreview();
  showContextMenu(at, quickSwitchItems(preview));
  const menu = useContextMenuStore.getState().menu;
  const unsubscribe = useContextMenuStore.subscribe((s) => {
    if (s.menu === menu) return;
    unsubscribe();
    // A chosen item runs right after the menu closes: let it choose first.
    queueMicrotask(() => preview.end());
  });
}
