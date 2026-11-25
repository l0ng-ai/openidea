/**
 * Customize Main Toolbar: which widgets (project, VCS, run…) and actions the
 * title bar shows on each side, in which order. Stored in
 * `appearance.mainToolbar` (global settings); unset = the default toolbar.
 */
import type { MainToolbarSettings } from "@/bindings";
import { getAction } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { TitleItemContribution } from "./contributions";

export const PROJECT_WIDGET = "project";
/** Shown as "Version Control ▾" while the project has no repository. */
export const VCS_WIDGET = "vcs.branch";
export const ACTION_PREFIX = "action:";
export const SEARCH_ENTRY = `${ACTION_PREFIX}navigate.searchEverywhere`;

export interface ToolbarLayout {
  left: string[];
  /** Centred in the toolbar, as IDEA's Center group; empty by default. */
  center: string[];
  right: string[];
  hidden: string[];
}

export type ToolbarSide = "left" | "center" | "right";
export const TOOLBAR_SIDES: readonly ToolbarSide[] = ["left", "center", "right"];

/** The entries shown, per group. */
export type ShownToolbar = Omit<ToolbarLayout, "hidden">;

export const isActionEntry = (id: string) => id.startsWith(ACTION_PREFIX);
export const entryAction = (id: string) => id.slice(ACTION_PREFIX.length);

const byPriority = (a: TitleItemContribution, b: TitleItemContribution) =>
  a.priority - b.priority || a.id.localeCompare(b.id);

/** Widgets in their default place (built-ins included), by side. */
function defaultWidgets(items: Iterable<TitleItemContribution>): { left: string[]; right: string[] } {
  const all = [...items];
  const left = all
    .filter((i) => i.align === "left")
    .sort(byPriority)
    .map((i) => i.id);
  const right = all
    .filter((i) => i.align === "right")
    .sort(byPriority)
    .map((i) => i.id);
  return { left: [PROJECT_WIDGET, ...(left.includes(VCS_WIDGET) ? [] : [VCS_WIDGET]), ...left], right };
}

export function defaultToolbar(items: Iterable<TitleItemContribution>): ToolbarLayout {
  const { left, right } = defaultWidgets(items);
  return { left, center: [], right: [...right, SEARCH_ENTRY], hidden: [] };
}

/**
 * The entries to show per side: the saved order, plus widgets registered since
 * (not listed, not removed) at their default side's end.
 */
export function resolveToolbar(
  saved: MainToolbarSettings | null | undefined,
  items: Iterable<TitleItemContribution>,
): ShownToolbar {
  const list = [...items];
  if (!saved) {
    const d = defaultToolbar(list);
    return { left: d.left, center: d.center, right: d.right };
  }
  const left = [...(saved.left ?? [])];
  const center = [...(saved.center ?? [])];
  const right = [...(saved.right ?? [])];
  const known = new Set([...left, ...center, ...right, ...(saved.hidden ?? [])]);
  const d = defaultWidgets(list);
  for (const id of d.left) if (!known.has(id)) left.push(id);
  for (const id of d.right) if (!known.has(id)) right.push(id);
  return { left, center, right };
}

/** The full editable layout (Customize Main Toolbar dialog). */
export function editableToolbar(
  saved: MainToolbarSettings | null | undefined,
  items: Iterable<TitleItemContribution>,
): ToolbarLayout {
  const list = [...items];
  return { ...resolveToolbar(saved, list), hidden: saved ? [...(saved.hidden ?? [])] : [] };
}

export function widgetTitle(id: string, items: ReadonlyMap<string, TitleItemContribution>): string {
  if (id === PROJECT_WIDGET) return "Project Widget";
  if (id === VCS_WIDGET && !items.has(id)) return "VCS Widget";
  if (isActionEntry(id)) return getAction(entryAction(id))?.title ?? entryAction(id);
  return items.get(id)?.title ?? id;
}

/** Shows or removes a widget, keeping the rest of the layout. */
export function toggleWidget(layout: ToolbarLayout, id: string, defaultSide: "left" | "right"): ToolbarLayout {
  const shown = TOOLBAR_SIDES.some((side) => layout[side].includes(id));
  if (shown)
    return {
      left: layout.left.filter((x) => x !== id),
      center: layout.center.filter((x) => x !== id),
      right: layout.right.filter((x) => x !== id),
      hidden: [...layout.hidden.filter((x) => x !== id), ...(isActionEntry(id) ? [] : [id])],
    };
  return { ...layout, [defaultSide]: [...layout[defaultSide], id], hidden: layout.hidden.filter((x) => x !== id) };
}

export function useMainToolbarSettings(): MainToolbarSettings | null | undefined {
  return useProject((s) => s.settings?.appearance?.mainToolbar);
}

/** Saves `layout`; `null` restores the default toolbar. */
export async function saveToolbar(layout: ToolbarLayout | null): Promise<void> {
  if (!isTauri()) return;
  const settings = await call(commands.settingsSet("global", "appearance.mainToolbar", JSON.stringify(layout)));
  useProject.setState({ settings });
}
