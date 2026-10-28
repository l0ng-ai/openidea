import { shortcutLabel } from "@/platform/keymap";
import { IconButton, type MenuItem } from "@/ui";
import { VIEW_MODES, setViewMode, setViewOption, useProjectTree, type ViewOptions } from "./store";
import type { SortKey } from "./model";

/** The title's "Project ▾" pane switcher (IDEA: Project / Project Files / Open Files / …). */
export function useProjectTitleMenu(): { label: string; items: MenuItem[] } {
  const mode = useProjectTree((s) => s.mode);
  return {
    label: VIEW_MODES.find(([id]) => id === mode)?.[1] ?? "Project",
    items: VIEW_MODES.map(([id, label]) => ({ id, label, checked: id === mode, run: () => setViewMode(id) })),
  };
}

/** The on / off view options. */
export type ToggleOption = { [K in keyof ViewOptions]: ViewOptions[K] extends boolean ? K : never }[keyof ViewOptions];

export const OPTION_LABELS: Array<[ToggleOption, string]> = [
  ["showHidden", "Show Hidden Files"],
  ["showExcluded", "Show Excluded Files"],
  ["compact", "Compact Middle Packages"],
  ["foldersFirst", "Sort Folders First"],
  ["autoscrollToSource", "Autoscroll to Source"],
  ["autoscrollFromSource", "Autoscroll from Source"],
  ["singleClickOpen", "Open Files with Single Click"],
  ["singleClickExpand", "Expand Directories with Single Click"],
  ["previewTab", "Enable Preview Tab"],
];

/** Header controls of the Project tool window (IDEA: Locate, Expand/Collapse All). */
export function ProjectHeaderActions() {
  return (
    <>
      <IconButton
        icon="locate"
        action="navigate.selectInProjectView"
        title="Select Opened File"
        shortcut={shortcutLabel("navigate.selectInProjectView")}
        size="small"
      />
      <IconButton icon="expand-all" action="project.expandAll" title="Expand All" size="small" />
      <IconButton icon="collapse-all" action="project.collapseAll" title="Collapse All" size="small" />
    </>
  );
}

export const SORT_LABELS: Array<[SortKey, string]> = [
  ["name", "Sort by Name"],
  ["type", "Sort by Type"],
  ["modified", "Sort by Modification Time"],
];

/** View options in the header's "⋮" menu (IDEA: Project › Options › Appearance / Behavior). */
export function useProjectHeaderMenu(): MenuItem[] {
  const options = useProjectTree((s) => s.options);
  return [
    { kind: "header", label: "Appearance" },
    ...OPTION_LABELS.slice(0, 4).map(([key, label]) => option(key, label, options)),
    { kind: "separator" },
    ...SORT_LABELS.map(([sortBy, label]): MenuItem => ({
      id: `sort.${sortBy}`,
      label,
      checked: options.sortBy === sortBy,
      run: () => setViewOption("sortBy", sortBy),
    })),
    { kind: "separator" },
    { kind: "header", label: "Behavior" },
    ...OPTION_LABELS.slice(4).map(([key, label]) => option(key, label, options)),
  ];
}

function option(key: ToggleOption, label: string, options: ViewOptions): MenuItem {
  return { id: key, label, checked: options[key], run: () => setViewOption(key, !options[key]) };
}
