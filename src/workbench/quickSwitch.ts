/**
 * Theme / color scheme / keymap / view mode switches shared by the main
 * toolbar's gear menu and View › Quick Switch Scheme… (⌃`).
 */
import { call, commands, isTauri } from "@/platform/ipc";
import { listSchemes } from "@/platform/colorScheme";
import { editorPrefs } from "@/platform/editorSettings";
import { PRESET_TITLES, useKeymap } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import type { MenuItem } from "@/ui";
import { currentThemeId, setTheme, THEME_CHOICES } from "./theme";

async function setGlobal(key: string, value: unknown, what: string) {
  if (!isTauri()) return;
  try {
    useProject.setState({ settings: await call(commands.settingsSet("global", key, JSON.stringify(value))) });
  } catch (e) {
    console.warn(`cannot switch ${what}`, e);
  }
}

export const selectKeymap = (id: string) => setGlobal("keymap", id, "keymap");

export function themeItems(themeId: string = currentThemeId()): MenuItem[] {
  return THEME_CHOICES.map<MenuItem>((c) => ({
    id: `theme.${c.id}`,
    label: c.label,
    checked: c.id === themeId,
    run: () => void setTheme(c.id),
  }));
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

/** View › Quick Switch Scheme…: IDEA's popup of the switchable schemes. */
export function quickSwitchItems(): MenuItem[] {
  const { keymapId, customs } = keymapState();
  return [
    {
      id: "qs.scheme",
      label: "Editor Color Scheme",
      submenu: colorSchemeItems(useProject.getState().settings?.editor?.colorScheme),
    },
    { id: "qs.keymap", label: "Keymap", submenu: keymapItems(keymapId, customs) },
    { id: "qs.viewMode", label: "View Mode", submenu: VIEW_MODE_ITEMS },
    { id: "qs.theme", label: "Theme", submenu: themeItems() },
  ];
}
