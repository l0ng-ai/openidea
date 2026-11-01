import { whenAllSynced, workspaceEditHistory } from "@/editor/api";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";

/** A single action restores every file of a workspace edit, including closed files. */
export function installWorkspaceEditUndo(): () => void {
  return onIdeEvent("workspaceEditApplied", ({ id }) => {
    const project = useProject.getState().project;
    notifications().notify({
      level: "info",
      title: "Refactoring applied",
      key: "refactor.workspaceEdit",
      actions: [
        {
          label: "Undo",
          run: async () => {
            try {
              await whenAllSynced();
              if (project !== useProject.getState().project)
                throw new Error("The project for this refactoring is no longer open");
              await workspaceEditHistory(id);
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
  });
}
