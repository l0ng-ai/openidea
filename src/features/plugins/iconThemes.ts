/**
 * File icon themes contributed by plugins (`iconThemes`). The selection is the
 * `appearance.fileIconTheme` setting (Settings › Appearance, or the plugin's
 * details page); the mapping and the sanitised SVGs are fetched from the
 * backend only when a theme is selected, so installed icon themes cost
 * nothing at start-up.
 */
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { validateIconThemeOptions } from "@/platform/iconThemeOptions";
import { useProject } from "@/platform/project";
import type { FileIconThemeOptions } from "@/bindings";
import { addContributedIconTheme, type IconThemeDetails } from "@/platform/themes";
import { registerExternalIcons, setFileIconTheme } from "@/ui";
import { setIconAppearance } from "@/ui/iconAppearance";
import { pluginsBackend } from "./backend";
import { iconResolver, type IconThemeMap } from "./iconThemeResolver";

export { iconResolver } from "./iconThemeResolver";

export interface IconThemeRef {
  pluginId: string;
  id: string;
  label: string;
  /** The plugin's name. */
  origin?: string;
  settingsPage?: string;
}

interface IconThemesState {
  /** `<pluginId>/<themeId>` → theme. */
  available: ReadonlyMap<string, IconThemeRef>;
  /** Without a backend (tests, browser preview): the selection for this session. */
  override: string | null | undefined;
  /** The theme whose icons are registered. */
  applied: string | null;
}

export const useIconThemes = create<IconThemesState>(() => ({
  available: new Map(),
  override: undefined,
  applied: null,
}));

const fromSettings = (s: ReturnType<typeof useProject.getState>) =>
  (s.settings?.appearance as { fileIconTheme?: unknown } | undefined)?.fileIconTheme;

const optionsFromSettings = (s: ReturnType<typeof useProject.getState>) =>
  (s.settings?.appearance as { fileIconThemeOptions?: unknown } | undefined)?.fileIconThemeOptions;

type ProjectState = ReturnType<typeof useProject.getState>;

function optionsChanged(key: string, s: ProjectState, prev: ProjectState): boolean {
  if (optionsFromSettings(s) === optionsFromSettings(prev)) return false;
  return JSON.stringify(optionsOf(s, key)) !== JSON.stringify(optionsOf(prev, key));
}

function optionsOf(state: ProjectState, key: string): FileIconThemeOptions {
  const own = (optionsFromSettings(state) as Record<string, unknown> | undefined)?.[key];
  return validateIconThemeOptions(own);
}

function themeOptions(key: string): FileIconThemeOptions {
  return optionsOf(useProject.getState(), key);
}

/** The selected icon theme (`<pluginId>/<themeId>`), or null for the built-in icons. */
export function selectedIconTheme(): string | null {
  const { override } = useIconThemes.getState();
  if (override !== undefined) return override;
  const v = fromSettings(useProject.getState());
  return typeof v === "string" && v ? v : null;
}

export function useSelectedIconTheme(): string | null {
  useIconThemes((s) => s.override);
  useProject((s) => fromSettings(s));
  return selectedIconTheme();
}

export const iconThemeKey = (pluginId: string, id: string) => `${pluginId}/${id}`;

async function loadDetails(theme: IconThemeRef): Promise<IconThemeDetails | null> {
  const id = `iconTheme/${theme.id}/settings`;
  const assets = await pluginsBackend().assets(theme.pluginId, id);
  const json = assets.find(([asset]) => asset === id)?.[1];
  return json ? (JSON.parse(json) as IconThemeDetails) : null;
}

/** Called by the `iconThemes` projection: the theme can be selected while its plugin is live. */
export function addIconTheme(theme: IconThemeRef): () => void {
  const key = iconThemeKey(theme.pluginId, theme.id);
  useIconThemes.setState((s) => ({ available: new Map(s.available).set(key, theme) }));
  const unlist = addContributedIconTheme({
    id: key,
    label: theme.label,
    origin: theme.origin,
    settingsPage: theme.settingsPage,
    details: () => loadDetails(theme),
  });
  return () => {
    unlist();
    useIconThemes.setState((s) => {
      const available = new Map(s.available);
      available.delete(key);
      return { available };
    });
  };
}

export async function selectIconTheme(key: string | null) {
  if (!isTauri()) {
    useIconThemes.setState({ override: key });
    return;
  }
  try {
    useProject.setState({
      settings: await call(commands.settingsSet("global", "appearance.fileIconTheme", JSON.stringify(key ?? ""))),
    });
  } catch (e) {
    console.warn("cannot select the file icon theme", e);
  }
}

let undo: (() => void) | null = null;
let loading: string | null = null;

interface Loaded {
  key: string;
  map: IconThemeMap;
  iconName: (icon: string) => string;
  names: ReadonlySet<string>;
}

let loaded: Loaded | null = null;

const HIDDEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>';

function install(theme: Loaded) {
  const options = themeOptions(theme.key);
  const hidden = theme.iconName("__hidden");
  setFileIconTheme(
    iconResolver(theme.map, theme.iconName, (n) => theme.names.has(n) || n === hidden, { hidden, options }),
  );
  setIconAppearance(options);
}

async function apply(key: string | null) {
  const theme = key ? useIconThemes.getState().available.get(key) : undefined;
  if (!key || !theme) {
    undo?.();
    undo = null;
    useIconThemes.setState({ applied: null });
    return;
  }
  if (useIconThemes.getState().applied === key || loading === key) return;
  loading = key;
  try {
    const prefix = `iconTheme/${theme.id}/`;
    const assets = await pluginsBackend().assets(theme.pluginId, prefix);
    if (loading !== key) return;
    const mapJson = assets.find(([id]) => id === `${prefix}map`)?.[1];
    if (!mapJson) throw new Error(`icon theme ${key} has no mapping`);
    const map = JSON.parse(mapJson) as IconThemeMap;
    const svgPrefix = `${prefix}svg/`;
    const iconName = (icon: string) => `ext:${key}/${icon}`;
    const icons = assets
      .filter(([id]) => id.startsWith(svgPrefix))
      .map(([id, svg]) => [iconName(id.slice(svgPrefix.length)), svg] as const);
    const names = new Set(icons.map(([n]) => n));
    undo?.();
    const unregister = registerExternalIcons([...icons, [iconName("__hidden"), HIDDEN_SVG]]);
    const current: Loaded = { key, map, iconName, names };
    loaded = current;
    install(current);
    undo = () => {
      loaded = null;
      setFileIconTheme(null);
      setIconAppearance(null);
      unregister();
    };
    useIconThemes.setState({ applied: key });
  } catch (e) {
    console.warn("could not load the file icon theme", e);
  } finally {
    if (loading === key) loading = null;
  }
}

/** Keeps the registered icons in line with the selection and the available themes. */
export function trackIconTheme(): () => void {
  const sync = () => {
    const selected = selectedIconTheme();
    void apply(selected && useIconThemes.getState().available.has(selected) ? selected : null);
  };
  sync();
  const unsubscribe = [
    useIconThemes.subscribe((s, prev) => {
      if (s.override !== prev.override || s.available !== prev.available) sync();
    }),
    // Settings are shared by every window: a choice made in one shows in all.
    useProject.subscribe((s, prev) => {
      if (fromSettings(s) !== fromSettings(prev)) sync();
      else if (loaded && optionsChanged(loaded.key, s, prev)) install(loaded);
    }),
  ];
  return () => {
    unsubscribe.forEach((u) => u());
    undo?.();
    undo = null;
    useIconThemes.setState({ applied: null });
  };
}
