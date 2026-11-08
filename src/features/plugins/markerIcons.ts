import { pluginsBackend } from "./backend";
import { pluginIconName } from "./pluginIcon";

export interface MarkerIconDecl {
  id: string;
  icon: string;
}

const icons = new Map<string, Promise<string | null>>();
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
  icons.set(id, pending);
  changed();
  return () => {
    if (icons.get(id) === pending) {
      icons.delete(id);
      changed();
    }
  };
}

export async function resolveMarkerIcon(pluginId: string, icon: string | null): Promise<string | null> {
  if (!icon) return null;
  return (await icons.get(key(pluginId, icon))) ?? icon;
}
