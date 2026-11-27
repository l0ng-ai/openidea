import { pluginsBackend } from "./backend";
import { pluginIconName } from "./pluginIcon";

export interface MarkerIconDecl {
  id: string;
  icon: string;
  tooltip?: string | null;
}

export interface IndexedMarkerIcon {
  icon: string | null;
  tooltip: string | null;
}

const icons = new Map<string, Promise<string | null>>();
const declared = new Map<string, { icon: Promise<string | null>; tooltip: string | null }>();
const listeners = new Set<() => void>();

export function onMarkerIconsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function changed() {
  for (const listener of listeners) listener();
}
const key = (pluginId: string, path: string) => `${pluginId}\0${path}`;

/** Package paths are resolved only through declarations validated by the host. */
export function projectMarkerIcon(pluginId: string, decl: MarkerIconDecl): () => void {
  const pending = pluginsBackend()
    .assets(pluginId, `markerIcon/${decl.id}/`)
    .then((assets) => {
      const svg = (variant: string) => assets.find(([id]) => id === `markerIcon/${decl.id}/${variant}`)?.[1];
      const light = svg("light");
      return light ? pluginIconName(pluginId, { light, dark: svg("dark") ?? null }) : null;
    })
    .catch((e: unknown) => {
      console.warn(`plugin ${pluginId}: marker icon ${decl.id}`, e);
      return null;
    });
  const id = key(pluginId, decl.icon);
  const entry = { icon: pending, tooltip: decl.tooltip ?? null };
  const declId = key(pluginId, decl.id);
  icons.set(id, pending);
  declared.set(declId, entry);
  changed();
  return () => {
    const current = icons.get(id) === pending || declared.get(declId) === entry;
    if (icons.get(id) === pending) icons.delete(id);
    if (declared.get(declId) === entry) declared.delete(declId);
    if (current) changed();
  };
}

export async function resolveMarkerIcon(pluginId: string, icon: string | null): Promise<string | null> {
  if (!icon) return null;
  return (await icons.get(key(pluginId, icon))) ?? icon;
}

/** The icon and tooltip of the `markerIcons` declaration `id` that the host matched to an indexed marker. */
export async function resolveIndexedMarkerIcon(pluginId: string, id: string): Promise<IndexedMarkerIcon | undefined> {
  const entry = declared.get(key(pluginId, id));
  return entry && { icon: await entry.icon, tooltip: entry.tooltip };
}
