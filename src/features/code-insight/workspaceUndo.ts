import { onWorkspaceEditHistory, whenAllSynced, workspaceEditHistory } from "@/editor/api";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";

/** The notification follows the same history state as editor Undo/Redo. */
export function installWorkspaceEditUndo(): () => void {
  let current: { id: number; project: ReturnType<typeof useProject.getState>["project"]; undone: boolean } | null =
    null;
  const show = () => {
    if (!current) return;
    const entry = current;
    const { id, project, undone } = entry;
    notifications().notify({
      level: "info",
      title: undone ? "Refactoring undone" : "Refactoring applied",
      key: "refactor.workspaceEdit",
      actions: [
        {
          label: undone ? "Redo" : "Undo",
          run: async () => {
            try {
              await whenAllSynced();
              if (project !== useProject.getState().project)
                throw new Error("The project for this refactoring is no longer open");
              if (current !== entry || current.undone !== undone) return;
              if (undone) await workspaceEditHistory(id, true);
              else await workspaceEditHistory(id);
            } catch (error) {
              notifications().notify({
                level: "error",
                title: "Cannot undo refactoring",
                body: error instanceof Error ? error.message : String(error),
              });
            }
          },
        },
      ],
    });
  };
  const stopApplied = onIdeEvent("workspaceEditApplied", ({ id }) => {
    current = { id, project: useProject.getState().project, undone: false };
    show();
  });
  const stopHistory = onWorkspaceEditHistory(({ id, undone }) => {
    if (!current || current.id !== id || current.project !== useProject.getState().project) return;
    current = { ...current, undone };
    show();
  });
  return () => {
    stopApplied();
    stopHistory();
    current = null;
  };
}
