/** Which status bar widgets are shown: per-widget defaults, overridden in `appearance.statusBarWidgets`. */
import type { MenuItem } from "@/ui";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useContributions, type StatusItemContribution } from "./contributions";

export type WidgetOverrides = Partial<Record<string, boolean>>;

export function isStatusItemVisible(
  item: Pick<StatusItemContribution, "id" | "title" | "defaultVisible">,
  overrides: WidgetOverrides | undefined,
): boolean {
  if (!item.title) return true;
  return overrides?.[item.id] ?? item.defaultVisible !== false;
}

export interface StatusWidgetRow {
  id: string;
  title: string;
  /** Plugin widgets are named by their plugin, not translated. */
  verbatim: boolean;
  visible: boolean;
}

/** Every titled widget of `items` (in bar order) with its visibility: the rows users can switch. */
export function statusWidgetRows(
  items: StatusItemContribution[],
  overrides: WidgetOverrides | undefined,
): StatusWidgetRow[] {
  return items
    .filter((i) => i.title)
    .map((i) => ({
      id: i.id,
      title: i.title!,
      verbatim: i.id.startsWith("plugin."),
      visible: isStatusItemVisible(i, overrides),
    }));
}

/** The status bar context menu: every titled widget with a checkmark, in bar order. */
export function statusBarMenu(
  items: StatusItemContribution[],
  overrides: WidgetOverrides | undefined,
  set: (id: string, visible: boolean) => void = (id, v) => void setStatusWidgetVisible(id, v),
): MenuItem[] {
  return statusWidgetRows(items, overrides).map((row) => ({
    id: row.id,
    label: row.title,
    verbatim: row.verbatim,
    checked: row.visible,
    run: () => set(row.id, !row.visible),
  }));
}

/** Persists the choice in the global settings (the whole map, since widget ids contain dots). */
export async function setStatusWidgetVisible(id: string, visible: boolean): Promise<void> {
  const current = useProject.getState().settings?.appearance?.statusBarWidgets ?? {};
  const next = { ...current, [id]: visible };
  const settings = await call(commands.settingsSet("global", "appearance.statusBarWidgets", JSON.stringify(next)));
  useProject.setState({ settings });
}

/** Flips one widget by id (View › Appearance › Status Bar Widgets); untitled or unknown widgets stay as they are. */
export async function toggleStatusWidget(id: string): Promise<void> {
  const item = useContributions.getState().statusItems.get(id);
  if (!item?.title) return;
  const visible = isStatusItemVisible(item, useProject.getState().settings?.appearance?.statusBarWidgets);
  await setStatusWidgetVisible(id, !visible);
}

export function useStatusWidgetOverrides(): WidgetOverrides | undefined {
  return useProject((s) => s.settings?.appearance?.statusBarWidgets);
}
