/** Which status bar widgets are shown: per-widget defaults, overridden in `appearance.statusBarWidgets`. */
import type { MenuItem } from "@/ui";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { StatusItemContribution } from "./contributions";

export type WidgetOverrides = Partial<Record<string, boolean>>;

export function isStatusItemVisible(
  item: Pick<StatusItemContribution, "id" | "title" | "defaultVisible">,
  overrides: WidgetOverrides | undefined,
): boolean {
  if (!item.title) return true;
  return overrides?.[item.id] ?? item.defaultVisible !== false;
}

/** The status bar context menu: every titled widget with a checkmark, in bar order. */
export function statusBarMenu(
  items: StatusItemContribution[],
  overrides: WidgetOverrides | undefined,
  set: (id: string, visible: boolean) => void = (id, v) => void setStatusWidgetVisible(id, v),
): MenuItem[] {
  return items
    .filter((i) => i.title)
    .map((i) => {
      const visible = isStatusItemVisible(i, overrides);
      // Plugin widgets are named by their plugin, not translated.
      return {
        id: i.id,
        label: i.title!,
        verbatim: i.id.startsWith("plugin."),
        checked: visible,
        run: () => set(i.id, !visible),
      };
    });
}

/** Persists the choice in the global settings (the whole map, since widget ids contain dots). */
export async function setStatusWidgetVisible(id: string, visible: boolean): Promise<void> {
  const current = useProject.getState().settings?.appearance?.statusBarWidgets ?? {};
  const next = { ...current, [id]: visible };
  const settings = await call(commands.settingsSet("global", "appearance.statusBarWidgets", JSON.stringify(next)));
  useProject.setState({ settings });
}

export function useStatusWidgetOverrides(): WidgetOverrides | undefined {
  return useProject((s) => s.settings?.appearance?.statusBarWidgets);
}
