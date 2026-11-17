import { create } from "zustand";

/** Stable built-in ids shared by settings, quick switch and editor schemes. */
export const BUILTIN_THEMES = [
  { id: "light", label: "Islands Light", kind: "light" },
  { id: "dark", label: "Islands Dark", kind: "dark" },
  { id: "dark-hc", label: "High Contrast", kind: "dark" },
  { id: "solarized-light", label: "Solarized Light", kind: "light" },
  { id: "solarized-dark", label: "Solarized Dark", kind: "dark" },
] as const;

export type BuiltinThemeId = (typeof BUILTIN_THEMES)[number]["id"];
export const BUILTIN_THEME_IDS: readonly BuiltinThemeId[] = BUILTIN_THEMES.map((t) => t.id);
export function isBuiltinTheme(value: unknown): value is BuiltinThemeId {
  return typeof value === "string" && (BUILTIN_THEME_IDS as readonly string[]).includes(value);
}
export function themeKind(id: BuiltinThemeId): "light" | "dark" {
  return BUILTIN_THEMES.find((t) => t.id === id)!.kind;
}

// --- themes contributed at runtime (plugins) ---------------------------------

/** A plugin theme as a theme setting value: `plugin:<pluginId>/<themeId>`. */
export type PluginThemeRef = `plugin:${string}`;
/** Any theme the settings can name: built-in or contributed. */
export type ThemeChoiceId = BuiltinThemeId | PluginThemeRef;

export interface ThemeChoice {
  id: ThemeChoiceId;
  label: string;
  kind: "light" | "dark";
  /** Who contributes it (a plugin's name); built-in themes have none. */
  origin?: string;
}

export const pluginThemeRef = (pluginId: string, themeId: string): PluginThemeRef => `plugin:${pluginId}/${themeId}`;

export function parsePluginThemeRef(value: unknown): { pluginId: string; themeId: string } | null {
  if (typeof value !== "string" || !value.startsWith("plugin:")) return null;
  const rest = value.slice("plugin:".length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { pluginId: rest.slice(0, slash), themeId: rest.slice(slash + 1) };
}

export function isThemeChoiceId(value: unknown): value is ThemeChoiceId {
  return isBuiltinTheme(value) || parsePluginThemeRef(value) !== null;
}

/** Themes of live plugins, offered next to the built-in ones. */
export const useContributedThemes = create<{ themes: readonly ThemeChoice[] }>(() => ({ themes: [] }));

const KINDS_KEY = "openidea.themeKinds";

function rememberedKinds(): Record<string, "light" | "dark"> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KINDS_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, "light" | "dark">) : {};
  } catch {
    return {};
  }
}

/** Offers a contributed theme until the returned function is called. */
export function addContributedTheme(theme: ThemeChoice): () => void {
  useContributedThemes.setState((s) => ({ themes: [...s.themes.filter((t) => t.id !== theme.id), theme] }));
  // Its kind outlives the plugin: a disabled plugin's theme falls back to the built-in of that kind.
  try {
    const kinds = rememberedKinds();
    if (kinds[theme.id] !== theme.kind)
      localStorage.setItem(KINDS_KEY, JSON.stringify({ ...kinds, [theme.id]: theme.kind }));
  } catch {
    /* storage unavailable */
  }
  return () => useContributedThemes.setState((s) => ({ themes: s.themes.filter((t) => t !== theme) }));
}

/** Themes of one origin: the built-in ones, or one plugin's. */
export interface ThemeGroup {
  /** The contributing plugin; none for the built-in themes. */
  pluginId?: string;
  /** The plugin's name. */
  origin?: string;
  themes: ThemeChoice[];
}

/** The selectable themes by origin: the built-in ones, then each plugin's by its name, themes by name. */
export function themeGroups(
  contributed: readonly ThemeChoice[] = useContributedThemes.getState().themes,
): ThemeGroup[] {
  const plugins = new Map<string, ThemeGroup>();
  for (const theme of contributed) {
    const pluginId = parsePluginThemeRef(theme.id)?.pluginId ?? "";
    const group = plugins.get(pluginId) ?? { pluginId, origin: theme.origin, themes: [] };
    plugins.set(pluginId, group);
    group.themes.push(theme);
  }
  const name = (g: ThemeGroup) => g.origin ?? g.pluginId ?? "";
  const groups = [...plugins.values()].sort(
    (a, b) => name(a).localeCompare(name(b)) || (a.pluginId ?? "").localeCompare(b.pluginId ?? ""),
  );
  for (const group of groups) group.themes.sort((a, b) => a.label.localeCompare(b.label));
  return [{ themes: [...BUILTIN_THEMES] }, ...groups];
}

/** Every theme that can be selected, in the order of `themeGroups`. */
export function themeChoices(
  contributed: readonly ThemeChoice[] = useContributedThemes.getState().themes,
): ThemeChoice[] {
  return themeGroups(contributed).flatMap((g) => g.themes);
}

/**
 * Shows a plugin theme in this window without selecting it, `null` none, or
 * `"selected"` the one selected again. The plugins feature provides it.
 */
export type PluginThemePreview = (theme: PluginThemeRef | null | "selected") => void;

let pluginThemePreview: PluginThemePreview | null = null;

export function providePluginThemePreview(preview: PluginThemePreview): () => void {
  pluginThemePreview = preview;
  return () => {
    if (pluginThemePreview === preview) pluginThemePreview = null;
  };
}

export function previewPluginTheme(theme: PluginThemeRef | null | "selected"): void {
  pluginThemePreview?.(theme);
}

/** Whether `id` can be applied now (a contributed theme's plugin may be off). */
export function isThemeAvailable(id: ThemeChoiceId): boolean {
  return isBuiltinTheme(id) || useContributedThemes.getState().themes.some((t) => t.id === id);
}

/**
 * The built-in theme under `id`: itself, or for a contributed theme the
 * light / dark default of its kind (the base its tokens apply over, and what
 * shows while its plugin is off).
 */
export function baseTheme(id: ThemeChoiceId, fallback: BuiltinThemeId = "light"): BuiltinThemeId {
  if (isBuiltinTheme(id)) return id;
  const kind = useContributedThemes.getState().themes.find((t) => t.id === id)?.kind ?? rememberedKinds()[id];
  return kind === "dark" ? "dark" : kind === "light" ? "light" : fallback;
}

// --- file icon themes (plugins) -------------------------------------------------

export interface IconThemePack {
  id: string;
  name: string;
  enabled: boolean;
}

export interface IconThemeVariant {
  id: string;
  name: string;
  default: string;
  options: readonly { id: string; name: string }[];
}

export type IconThemeSettingOption =
  | "hideFiles"
  | "hideFolders"
  | "hideUiIcons"
  | "hidePsiIcons"
  | "hollowFolders"
  | "groups"
  | "choice"
  | "accent"
  | "monochrome"
  | "saturation"
  | "opacity"
  | "iconSize"
  | "rowHeight";

export interface IconThemeSettingItem {
  option: IconThemeSettingOption;
  label?: string | null;
  hint?: string | null;
  invert?: boolean;
  choice?: string | null;
  columns?: number | null;
  default?: number | string | null;
}

export interface IconThemeSettingsSection {
  title: string;
  items: readonly IconThemeSettingItem[];
}

export interface IconThemeDetails {
  groups: readonly IconThemePack[];
  choices: readonly IconThemeVariant[];
  accent: boolean;
  settings: readonly IconThemeSettingsSection[];
}

export interface IconThemeChoice {
  /** `<pluginId>/<themeId>`: the `appearance.fileIconTheme` value. */
  id: string;
  label: string;
  origin?: string;
  settingsPage?: string;
  details?: () => Promise<IconThemeDetails | null>;
}

/** File icon themes of live plugins, for Settings › Appearance. */
export const useContributedIconThemes = create<{ themes: readonly IconThemeChoice[] }>(() => ({ themes: [] }));

export function addContributedIconTheme(theme: IconThemeChoice): () => void {
  useContributedIconThemes.setState((s) => ({ themes: [...s.themes.filter((t) => t.id !== theme.id), theme] }));
  return () => useContributedIconThemes.setState((s) => ({ themes: s.themes.filter((t) => t !== theme) }));
}
