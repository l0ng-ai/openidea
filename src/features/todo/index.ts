/** TODO tool window, project TODO index and in-editor TODO highlighting. */
import { registerActions } from "@/platform/actions";
import { registerEditorContribution } from "@/editor/api";
import { registerSettingsPage, registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { hasIcon, lazyComponent } from "@/ui";
import { TodoHeaderActions, TodoTabs, TodoView, useTodoBadge, useTodoHeaderMenu, useTodoView } from "./TodoView";
import { todoEditorExtension } from "./highlight";
import { installTodoIndex, scanProject, syncTodoSettingsFromStorage } from "./store";

/** Settings › Editor › TODO (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: "editor.todo",
    title: "TODO",
    group: "Editor",
    order: 40,
    keywords: ["todo", "fixme", "hack", "pattern"],
    component: lazyComponent(() => import("./TodoSettingsPage").then((m) => m.TodoSettingsPage)),
  });
}

export function activate(): () => void {
  const disposers = [
    installTodoIndex(),
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
      headerActions: TodoHeaderActions,
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
