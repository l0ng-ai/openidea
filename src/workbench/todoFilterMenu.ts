import { executeAction } from "@/platform/actions";
import { todoFilterKeywords, type TodoSettings } from "@/platform/todo";
import type { MenuItem } from "@/ui/Menu";

export function todoFilterChoices(
  settings: TodoSettings,
  selected: string | null,
  select: (id: string | null) => void,
  showAll = selected === null,
): MenuItem[] {
  return [
    { id: "all", label: "Show All", checked: showAll, run: () => select(null) },
    ...settings.filters.map(({ id, name }) => ({
      id,
      label: name,
      verbatim: true,
      checked: id === selected,
      disabled: todoFilterKeywords(settings, id)?.size === 0,
      run: () => select(id),
    })),
  ];
}

export const editTodoFiltersItem: MenuItem = {
  id: "edit-filters",
  label: "Edit Filters…",
  icon: "settings",
  run: () => void executeAction("file.settings", "editor.todo"),
};
