/**
 * File icon themes contributed by plugins (`iconThemes`). The selection is the
 * `appearance.fileIconTheme` setting (Settings › Appearance, or the plugin's
 * details page); the mapping and the sanitised SVGs are fetched from the
 * backend only when a theme is selected, so installed icon themes cost
 * nothing at start-up.
 */
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { addContributedIconTheme } from "@/platform/themes";
import { registerExternalIcons, setFileIconTheme, type FileIconTheme } from "@/ui";
import { pluginsBackend } from "./backend";

export interface IconThemeRef {
  pluginId: string;
  id: string;
  label: string;
  /** The plugin's name. */
  origin?: string;
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

/** Called by the `iconThemes` projection: the theme can be selected while its plugin is live. */
export function addIconTheme(theme: IconThemeRef): () => void {
  const key = iconThemeKey(theme.pluginId, theme.id);
  useIconThemes.setState((s) => ({ available: new Map(s.available).set(key, theme) }));
  const unlist = addContributedIconTheme({ id: key, label: theme.label, origin: theme.origin });
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
    }),
  ];
  return () => {
    unsubscribe.forEach((u) => u());
    undo?.();
    undo = null;
    useIconThemes.setState({ applied: null });
  };
}
