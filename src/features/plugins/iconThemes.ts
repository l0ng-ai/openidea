/**
 * File icon themes contributed by plugins (`iconThemes`). The selection is a
 * per-user preference kept in this browser profile; the mapping and the
 * sanitised SVGs are fetched from the backend only when a theme is selected,
 * so installed icon themes cost nothing at start-up.
 */
import { create } from "zustand";
import { registerExternalIcons, setFileIconTheme, type FileIconTheme } from "@/ui";
import { pluginsBackend } from "./backend";

export const ICON_THEME_KEY = "openidea.fileIconTheme";

export interface IconThemeRef {
  pluginId: string;
  id: string;
  label: string;
}

export interface IconThemeMap {
  file: string | null;
  folder?: string | null;
  folderExpanded?: string | null;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames?: Record<string, string>;
}

interface IconThemesState {
  /** `<pluginId>/<themeId>` → theme. */
  available: ReadonlyMap<string, IconThemeRef>;
  /** `<pluginId>/<themeId>` or null for the built-in icons. */
  selected: string | null;
  /** The theme whose icons are registered. */
  applied: string | null;
}

const readSelection = (): string | null => {
  try {
    return localStorage.getItem(ICON_THEME_KEY);
  } catch {
    return null;
  }
};

export const useIconThemes = create<IconThemesState>(() => ({
  available: new Map(),
  selected: readSelection(),
  applied: null,
}));

export const iconThemeKey = (pluginId: string, id: string) => `${pluginId}/${id}`;

/** Called by the `iconThemes` projection: the theme can be selected while its plugin is live. */
export function addIconTheme(theme: IconThemeRef): () => void {
  const key = iconThemeKey(theme.pluginId, theme.id);
  useIconThemes.setState((s) => ({ available: new Map(s.available).set(key, theme) }));
  return () =>
    useIconThemes.setState((s) => {
      const available = new Map(s.available);
      available.delete(key);
      return { available };
    });
}

export function selectIconTheme(key: string | null) {
  try {
    if (key) localStorage.setItem(ICON_THEME_KEY, key);
    else localStorage.removeItem(ICON_THEME_KEY);
  } catch {
    /* storage unavailable: the choice lasts for this window */
  }
  useIconThemes.setState({ selected: key });
}

/**
 * The theme's resolver. Files: exact name, then the longest matching
 * extension, then its default file icon. Folders: exact name, then its
 * default (expanded) folder icon.
 */
export function iconResolver(
  map: IconThemeMap,
  iconName: (icon: string) => string,
  has: (name: string) => boolean,
): FileIconTheme {
  const pick = (icon: string | undefined | null) => (icon && has(iconName(icon)) ? iconName(icon) : null);
  return {
    file(fileName) {
      const lower = fileName.toLowerCase();
      const named = pick(map.fileNames[lower]);
      if (named) return named;
      let rest = lower;
      for (let dot = rest.indexOf("."); dot >= 0; dot = rest.indexOf(".")) {
        rest = rest.slice(dot + 1);
        const byExt = pick(map.fileExtensions[rest]);
        if (byExt) return byExt;
      }
      return pick(map.file);
    },
    folder(folderName, expanded) {
      const named = pick(map.folderNames?.[folderName.toLowerCase()]);
      if (named) return named;
      return (expanded && pick(map.folderExpanded)) || pick(map.folder);
    },
  };
}

let undo: (() => void) | null = null;
let loading: string | null = null;

async function apply(key: string | null) {
  const theme = key ? useIconThemes.getState().available.get(key) : undefined;
  if (!theme) {
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
    const unregister = registerExternalIcons(icons);
    setFileIconTheme(iconResolver(map, iconName, (n) => names.has(n)));
    undo = () => {
      setFileIconTheme(null);
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
    const { selected, available } = useIconThemes.getState();
    void apply(selected && available.has(selected) ? selected : null);
  };
  sync();
  const unsubscribe = useIconThemes.subscribe((s, prev) => {
    if (s.selected !== prev.selected || s.available !== prev.available) sync();
  });
  // Another window (Settings) changed the selection.
  const onStorage = (e: StorageEvent) => {
    if (e.key === ICON_THEME_KEY) useIconThemes.setState({ selected: e.newValue });
  };
  window.addEventListener("storage", onStorage);
  return () => {
    unsubscribe();
    window.removeEventListener("storage", onStorage);
    undo?.();
    undo = null;
    useIconThemes.setState({ applied: null });
  };
}
