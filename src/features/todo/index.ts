/** TODO tool window, project TODO index and in-editor TODO highlighting. */
import { registerActions } from "@/platform/actions";
import { registerEditorContribution } from "@/editor/api";
import { registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { hasIcon } from "@/ui";
import { activateSettingsPages } from "./settingsPages";
import { installTodoReviews, TodoTabs, TodoView, useTodoBadge, useTodoHeaderMenu, useTodoView } from "./TodoView";
import { todoEditorExtension } from "./highlight";
import { syncTodoSettingsFromStorage } from "@/platform/todo";
import { installTodoIndex, scanProject } from "./store";

export function activate(): () => void {
  const disposers = [
    installTodoIndex(),
    installTodoReviews(),
    syncTodoSettingsFromStorage(),
    registerEditorContribution({ id: "todo.highlight", order: 120, extensions: todoEditorExtension }),
    registerToolWindow({
      id: "todo",
      title: "TODO",
      icon: hasIcon("toolwindow-todo") ? "toolwindow-todo" : "list",
      anchor: "bottom",
      order: 40,
      component: TodoView,
      headerContent: TodoTabs,
      headerMenu: useTodoHeaderMenu,
      useBadge: useTodoBadge,
    }),
    activateSettingsPages(),
    registerActions([
      {
        id: "todo.refresh",
        title: "Refresh TODO Items",
        category: "Tools",
        icon: "refresh",
        when: "projectOpen",
        run: () => void scanProject(),
      },
      {
        id: "todo.showCurrentFile",
        title: "Show TODO Items in Current File",
        category: "Tools",
        icon: "todo",
        when: "projectOpen",
        run: () => {
          useTodoView.getState().setTab("file");
          toolWindowService().show("todo", true);
        },
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
