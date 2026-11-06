import type { PluginIcon } from "@/bindings";
import { registerExternalIcons } from "@/ui/icons";

// ponytail: never unregistered while listed; bounded by the number of plugins seen this session.
const registered = new Map<string, { icon: PluginIcon; unregister: () => void }>();

/** The icon name of a plugin's own icon (registered on first use or when it changed), else the generic one. */
export function pluginIconName(pluginId: string, icon: PluginIcon | null | undefined): string {
  if (!icon) return "plugin";
  const name = `ext:plugin/${pluginId}`;
  const known = registered.get(pluginId);
  if (known?.icon.light === icon.light && known.icon.dark === icon.dark) return name;
  known?.unregister();
  const unregister = registerExternalIcons(
    icon.dark
      ? [
          [name, icon.light],
          [`${name}_dark`, icon.dark],
        ]
      : [[name, icon.light]],
  );
  registered.set(pluginId, { icon, unregister });
  return name;
}
