import { shortcutLabel } from "@/platform/keymap";
import { IconButton, type MenuItem } from "@/ui";
import { useProject } from "@/platform/project";
import { userScopes } from "@/platform/scopes";
import { VIEW_MODES, setScopeView, setViewMode, setViewOption, useProjectTree, type ViewOptions } from "./store";
import type { SortKey } from "./model";

/** The title's "Project ▾" pane switcher (IDEA: Project / Project Files / Open Files / …). */
export function useProjectTitleMenu(): { label: string; items: MenuItem[] } {
  const mode = useProjectTree((s) => s.mode);
  const scope = useProjectTree((s) => s.scope);
  const unity = useProjectTree((s) => s.unity);
  // User scopes (Settings › Scopes) follow the built-in panes, as in IDEA.
  const scopes = userScopes(useProject((s) => (s.settings as { scopes?: unknown } | null)?.scopes));
  const items: MenuItem[] = VIEW_MODES.filter(([id]) => id !== "unity" || unity).map(([id, label]) => ({
    id,
    label,
    checked: id === mode,
    run: () => setViewMode(id),
  }));
  if (scopes.length) {
    items.push({ kind: "separator" });
    for (const s of scopes)
      items.push({
        id: `scope:${s.name}`,
        label: s.name,
        checked: mode === "scope" && scope === s.name,
        run: () => setScopeView(s.name),
      });
  }
  return {
    label: mode === "scope" ? (scope ?? "Project") : (VIEW_MODES.find(([id]) => id === mode)?.[1] ?? "Project"),
    items,
  };
}

/** The on / off view options. */
export type ToggleOption = {
  [K in keyof ViewOptions]-?: ViewOptions[K] extends boolean ? K : never;
}[keyof ViewOptions];

const APPEARANCE_OPTIONS: Array<[ToggleOption, string]> = [
  ["showHidden", "Show Hidden Files"],
  ["showExcluded", "Show Excluded Files"],
  ["showMembers", "Show Members"],
  ["showRootPaths", "Show Root Paths"],
  ["horizontalScroll", "Horizontal Scrolling"],
  ["compact", "Compact Middle Packages"],
];

const FOLDERS_FIRST: [ToggleOption, string] = ["foldersFirst", "Sort Folders First"];

const BEHAVIOR_OPTIONS: Array<[ToggleOption, string]> = [
  ["autoscrollFromSource", "Always Select Opened File"],
  ["autoscrollToSource", "Autoscroll to Source"],
  ["singleClickOpen", "Open Files with Single Click"],
  ["singleClickExpand", "Expand Directories with Single Click"],
  ["previewTab", "Enable Preview Tab"],
];

export const OPTION_LABELS = [...APPEARANCE_OPTIONS, FOLDERS_FIRST, ...BEHAVIOR_OPTIONS];

/** Header controls of the Project tool window (IDEA: Locate, Expand/Collapse All). */
export function ProjectHeaderActions() {
  // IDEA hides Select Opened File while Always Select Opened File keeps the tree in sync.
  const alwaysSelect = useProjectTree((s) => s.options.autoscrollFromSource);
  return (
    <>
      {!alwaysSelect && (
        <IconButton
          icon="locate"
          action="navigate.selectInProjectView"
          title="Select Opened File"
          shortcut={shortcutLabel("navigate.selectInProjectView")}
          size="small"
        />
      )}
      <IconButton icon="expand-all" action="project.expandAll" title="Expand All" size="small" />
      <IconButton icon="collapse-all" action="project.collapseAll" title="Collapse All" size="small" />
    </>
  );
}

export const SORT_LABELS: Array<[key: SortKey, actionLabel: string, menuLabel: string]> = [
  ["name", "Sort by Name", "Name"],
  ["type", "Sort by Type", "Type"],
  ["modified", "Sort by Modification Time", "Modification Time"],
];

/** Project view options in the header's "⋮" menu. */
export function useProjectHeaderMenu(): MenuItem[] {
  const options = useProjectTree((s) => s.options);
  const unity = useProjectTree((s) => s.mode === "unity");
  return [
    {
      label: "Behavior",
      submenu: BEHAVIOR_OPTIONS.map(([key, label]) => option(key, label, options)),
    },
    {
      label: "Appearance",
      submenu: [
        ...(unity
          ? [
              option("showUnityMeta", "Show Meta Files", options),
              option("showUnityGenerated", "Show Generated Files", options),
            ]
          : []),
        ...APPEARANCE_OPTIONS.map(([key, label]) => option(key, label, options)),
      ],
    },
    {
      label: "Sort By",
      submenu: [
        ...SORT_LABELS.map(([sortBy, , label]): MenuItem => ({
          id: `sort.${sortBy}`,
          label,
          checked: options.sortBy === sortBy,
          run: () => setViewOption("sortBy", sortBy),
        })),
        { kind: "separator" },
        option(...FOLDERS_FIRST, options),
      ],
    },
  ];
}

function option(key: ToggleOption, label: string, options: ViewOptions): MenuItem {
  return { id: key, label, checked: options[key], run: () => setViewOption(key, !options[key]) };
}
